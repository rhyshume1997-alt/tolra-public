/**
 * Sign-in and password reset FAIL SAFE when the rate limiter itself fails (pre-go-live hardening): the request is refused
 * with a clear "try again shortly" message and no sign-in or reset e-mail is attempted. It used to let the request through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => undefined }), headers: async () => new Headers() }));

type Failure = "none" | "rpc-error" | "rpc-throws" | "count-error" | "no-client";
let failure: Failure;
let hits: number;
const signInCalls: unknown[] = [];
const resetCalls: unknown[] = [];

const failing = (): never => {
  throw new TypeError("fetch failed");
};

const adminStub = () => ({
  rpc: async () => {
    if (failure === "rpc-throws") return failing();
    if (failure === "rpc-error") return { data: null, error: { code: "42883", message: "function does not exist" } };
    return { data: true, error: null };
  },
  from: () => {
    const c: unknown = new Proxy(() => undefined, {
      get: (_, prop) => {
        if (prop === "then") return undefined;
        if (prop === "maybeSingle") return async () => ({ data: { email: "someone@example.test" }, error: null });
        return () => c;
      },
      apply: () => c,
    });
    // select(..., {count}) resolves to a count result
    return {
      select: (_cols: string, opts?: { head?: boolean }) => {
        const result = failure === "count-error" ? { count: null, error: { code: "42P01" } } : { count: hits, error: null };
        const chain: unknown = new Proxy({}, {
          get: (_, prop) => {
            if (prop === "then") return opts?.head ? (resolve: (v: unknown) => void) => resolve(result) : undefined;
            if (prop === "maybeSingle") return async () => ({ data: { email: "someone@example.test" }, error: null });
            return () => chain;
          },
        });
        return chain;
      },
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    };
  },
});

vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => (failure === "no-client" ? null : adminStub()) }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      signInWithPassword: async (args: unknown) => { signInCalls.push(args); return { data: { user: { id: "u" } }, error: null }; },
    },
  }),
}));
vi.mock("@supabase/supabase-js", async (original) => {
  const real = await original<typeof import("@supabase/supabase-js")>();
  return { ...real, createClient: () => ({ auth: { resetPasswordForEmail: async (...args: unknown[]) => { resetCalls.push(args); return { error: null }; } } }) };
});

import { POST as reset } from "@/app/api/auth/reset/route";
import { POST as signIn } from "@/app/api/auth/signin/route";
import { LimiterUnavailableError, TRY_AGAIN_SHORTLY, recentHits, withinLimit } from "@/lib/server/login";

const post = (url: string, body: unknown) => new Request(`https://app.test${url}`, { method: "POST", body: JSON.stringify(body), headers: { "x-real-ip": "203.0.113.9" } });

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  failure = "none";
  hits = 0;
  signInCalls.length = 0;
  resetCalls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe("the limiter itself", () => {
  it("throws instead of answering 'allowed' when it can't be used", async () => {
    for (const mode of ["rpc-error", "rpc-throws", "no-client"] as const) {
      failure = mode;
      const client = mode === "no-client" ? null : (adminStub() as never);
      await expect(withinLimit(client, "signin_ip", "1.2.3.4", 60, 5)).rejects.toBeInstanceOf(LimiterUnavailableError);
    }
    failure = "count-error";
    await expect(recentHits(adminStub() as never, "signin_fail_id", "a", 60)).rejects.toBeInstanceOf(LimiterUnavailableError);
    failure = "none";
    await expect(withinLimit(adminStub() as never, "signin_ip", "1.2.3.4", 60, 5)).resolves.toBe(true);
    await expect(recentHits(adminStub() as never, "signin_fail_id", "a", 60)).resolves.toBe(0);
  });
});

describe("POST /api/auth/signin when the limiter fails", () => {
  it.each(["rpc-error", "rpc-throws", "count-error", "no-client"] as const)("%s: refused with 503 and 'try again shortly'; no sign-in attempted", async (mode) => {
    failure = mode;
    const response = await signIn(post("/api/auth/signin", { identifier: "someone@example.test", password: "Correct-horse-9" }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    expect(await response.json()).toEqual({ error: TRY_AGAIN_SHORTLY });
    expect(signInCalls).toEqual([]);
  });

  it("with a working limiter it still signs in, and still stops a blocked caller", async () => {
    const ok = await signIn(post("/api/auth/signin", { identifier: "someone@example.test", password: "Correct-horse-9" }));
    expect(ok.status).toBe(200);
    expect(signInCalls).toHaveLength(1);
    hits = 10;
    const blocked = await signIn(post("/api/auth/signin", { identifier: "someone@example.test", password: "Correct-horse-9" }));
    expect(blocked.status).toBe(429);
    expect(signInCalls).toHaveLength(1);
  });
});

describe("POST /api/auth/reset when the limiter fails", () => {
  it.each(["rpc-error", "rpc-throws", "no-client"] as const)("%s: refused with 503, no reset e-mail requested", async (mode) => {
    failure = mode;
    const response = await reset(post("/api/auth/reset", { identifier: "someone@example.test" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Password reset is temporarily unavailable. Try again shortly." });
    expect(resetCalls).toEqual([]);
  });

  it("with a working limiter it asks for the reset e-mail", async () => {
    const response = await reset(post("/api/auth/reset", { identifier: "someone@example.test" }));
    expect(response.status).toBe(200);
    expect(resetCalls).toHaveLength(1);
  });
});
