/**
 * A successful sign-in starts a fresh idle clock (LOGOUT cause 2a / S4-F2): the HttpOnly `tolra_last_active` cookie outlives a normal
 * sign-out (the browser cannot delete it), so without this the middleware ended a sign-in made more than 12 hours after the last use at
 * its first page. Only a correct password resets the clock; a failed, blocked or unavailable attempt never touches the cookie.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LAST_ACTIVE_COOKIE, OFFICE_IDLE_TIMEOUT_MS, idleExceeded } from "@/lib/session-policy";

type CookieSet = { name: string; value: string; options: Record<string, unknown> };
const cookieSets: CookieSet[] = [];
let signInResult: "ok" | "wrong" | "unreachable";
let limiterOk: boolean;

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [],
    set: (name: string, value: string, options: Record<string, unknown> = {}) => { cookieSets.push({ name, value, options }); },
  }),
  headers: async () => new Headers(),
}));

const adminStub = () => ({
  rpc: async () => ({ data: limiterOk, error: null }),
  from: () => ({
    select: (_cols: string, opts?: { head?: boolean }) => {
      const chain: unknown = new Proxy({}, {
        get: (_, prop) => {
          if (prop === "then") return opts?.head ? (resolve: (v: unknown) => void) => resolve({ count: 0, error: null }) : undefined;
          if (prop === "maybeSingle") return async () => ({ data: { email: "office@example.test" }, error: null });
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
      signInWithPassword: async () => {
        if (signInResult === "ok") return { data: { user: { id: "u-1" } }, error: null };
        if (signInResult === "unreachable") return { data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0, message: "fetch failed" } };
        return { data: { user: null }, error: { name: "AuthApiError", status: 400, message: "Invalid login credentials" } };
      },
    },
  }),
}));

import { POST as signIn } from "@/app/api/auth/signin/route";

const post = () => new Request("https://app.test/api/auth/signin", { method: "POST", body: JSON.stringify({ identifier: "office_user", password: "Right-pass-9" }), headers: { "x-real-ip": "203.0.113.9" } });
const lastActiveSets = () => cookieSets.filter((c) => c.name === LAST_ACTIVE_COOKIE);

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  cookieSets.length = 0;
  signInResult = "ok";
  limiterOk = true;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("sign-in resets the idle clock", () => {
  it("a correct password sets tolra_last_active to now, so the old session's idleness cannot end the new sign-in", async () => {
    const before = Date.now();
    const res = await signIn(post());
    expect(res.status).toBe(200);
    const sets = lastActiveSets();
    expect(sets).toHaveLength(1);
    const at = Number(sets[0].value);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Date.now());
    // The middleware's own rule, at the first page straight after sign-in, now passes; with a 13-hour-old cookie it would not.
    expect(idleExceeded(sets[0].value, Date.now(), OFFICE_IDLE_TIMEOUT_MS)).toBe(false);
    expect(idleExceeded(String(before - 13 * 60 * 60 * 1000), Date.now(), OFFICE_IDLE_TIMEOUT_MS)).toBe(true);
  });

  it("uses the same cookie attributes as the middleware (HttpOnly, Lax, path /, 30 days)", async () => {
    await signIn(post());
    const { options } = lastActiveSets()[0];
    expect(options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
    expect(options.secure).toBe(process.env.NODE_ENV === "production");
    const middleware = readFileSync(join(process.cwd(), "middleware.ts"), "utf8");
    expect(middleware).toContain('response.cookies.set(LAST_ACTIVE_COOKIE, String(Date.now()), { httpOnly: true, sameSite: "lax", secure: SECURE_COOKIES, path: "/", maxAge: 60 * 60 * 24 * 30 });');
  });

  it("is Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      await signIn(post());
      expect(lastActiveSets()[0].options.secure).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a wrong password does not touch the cookie (401)", async () => {
    signInResult = "wrong";
    const res = await signIn(post());
    expect(res.status).toBe(401);
    expect(lastActiveSets()).toHaveLength(0);
  });

  it("an unreachable auth service does not touch the cookie (503)", async () => {
    signInResult = "unreachable";
    const res = await signIn(post());
    expect(res.status).toBe(503);
    expect(lastActiveSets()).toHaveLength(0);
  });

  it("a rate-limited attempt does not touch the cookie (429)", async () => {
    limiterOk = false;
    const res = await signIn(post());
    expect(res.status).toBe(429);
    expect(lastActiveSets()).toHaveLength(0);
  });

  it("a cross-origin request does not touch the cookie", async () => {
    const res = await signIn(new Request("https://app.test/api/auth/signin", { method: "POST", body: "{}", headers: { origin: "https://evil.test" } }));
    expect(res.status).toBe(403);
    expect(lastActiveSets()).toHaveLength(0);
  });
});
