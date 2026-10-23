/**
 * Username lookup failures on sign-in: a lookup that FAILED (database/network) is a 503 "try again" that records no failed
 * guess, while an unknown username keeps the existing fake-email path and the same 401 as a wrong password.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => undefined }), headers: async () => new Headers() }));

type Lookup = "found" | "missing" | "db-error" | "throws";
let lookup: Lookup;
const rpcCalls: string[] = [];
const signInEmails: string[] = [];

const adminStub = () => ({
  rpc: async (_fn: string, args: { p_bucket: string }) => { rpcCalls.push(args.p_bucket); return { data: true, error: null }; },
  from: () => ({
    select: (_cols: string, opts?: { head?: boolean }) => {
      const chain: unknown = new Proxy({}, {
        get: (_, prop) => {
          if (prop === "then") return opts?.head ? (resolve: (v: unknown) => void) => resolve({ count: 0, error: null }) : undefined;
          if (prop === "maybeSingle") {
            return async () => {
              if (lookup === "throws") throw new TypeError("fetch failed");
              if (lookup === "db-error") return { data: null, error: { code: "57P01" } };
              return { data: lookup === "found" ? { email: "Real.User@example.test" } : null, error: null };
            };
          }
          return () => chain;
        },
      });
      return chain;
    },
    update: () => ({ eq: () => Promise.resolve({ error: null }) }),
  }),
});

vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => adminStub() }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      signInWithPassword: async ({ email }: { email: string }) => {
        signInEmails.push(email);
        return { data: { user: null }, error: { name: "AuthApiError", status: 400, message: "Invalid login credentials" } };
      },
    },
  }),
}));

import { POST as signIn } from "@/app/api/auth/signin/route";
import { LoginLookupError, resolveLoginEmail } from "@/lib/server/login";

const post = (identifier: string) => new Request("https://app.test/api/auth/signin", { method: "POST", body: JSON.stringify({ identifier, password: "Wrong-pass-9" }), headers: { "x-real-ip": "203.0.113.9" } });
const failureWrites = () => rpcCalls.filter((bucket) => bucket.startsWith("signin_fail"));

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  lookup = "found";
  rpcCalls.length = 0;
  signInEmails.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("resolveLoginEmail", () => {
  it("returns the e-mail, null for no such username, and throws when the lookup fails", async () => {
    expect(await resolveLoginEmail(adminStub() as never, "real_user")).toBe("real.user@example.test");
    lookup = "missing";
    expect(await resolveLoginEmail(adminStub() as never, "real_user")).toBeNull();
    for (const mode of ["db-error", "throws"] as const) {
      lookup = mode;
      await expect(resolveLoginEmail(adminStub() as never, "real_user")).rejects.toBeInstanceOf(LoginLookupError);
    }
    await expect(resolveLoginEmail(null, "real_user")).rejects.toBeInstanceOf(LoginLookupError);
  });
  it("never needs the database for an e-mail or an invalid username", async () => {
    lookup = "db-error";
    expect(await resolveLoginEmail(null, "A@B.test")).toBe("a@b.test");
    expect(await resolveLoginEmail(null, "no spaces allowed")).toBeNull();
  });
});

describe("POST /api/auth/signin username lookup", () => {
  it.each(["db-error", "throws"] as const)("%s: 503 try-again, no sign-in call, no failed guess counted", async (mode) => {
    lookup = mode;
    const response = await signIn(post("real_user"));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(signInEmails).toEqual([]);
    expect(failureWrites()).toEqual([]);
  });

  it("unknown username and wrong password get byte-identical 401s, and both count as failures", async () => {
    lookup = "missing";
    const unknown = await signIn(post("real_user"));
    const unknownEmail = signInEmails.at(-1);
    const unknownWrites = failureWrites();
    rpcCalls.length = 0;
    lookup = "found";
    const wrong = await signIn(post("real_user"));
    expect(unknownEmail).toMatch(/^unknown-[0-9a-f]{24}@invalid\.invalid$/);
    expect(signInEmails.at(-1)).toBe("real.user@example.test");
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await unknown.text()).toBe(await wrong.text());
    expect([...unknown.headers].sort()).toEqual([...wrong.headers].sort());
    expect(unknownWrites).toEqual(["signin_fail_pair", "signin_fail_id"]);
    expect(failureWrites()).toEqual(["signin_fail_pair", "signin_fail_id"]);
  });
});
