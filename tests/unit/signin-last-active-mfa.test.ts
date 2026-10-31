/**
 * The fresh idle clock that a correct password starts (signin route, tolra_last_active) is only the idle timer, not a credential: a
 * sign-in whose password is right but whose second step (MFA) is not done yet is still sent to /mfa on every page while that fresh
 * cookie is present, and only an aal2 session gets through. The sign-in route and the middleware run for real here; only Supabase is
 * faked.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LAST_ACTIVE_COOKIE } from "@/lib/session-policy";

const cookieSets: { name: string; value: string }[] = [];
let level: { currentLevel: string; nextLevel: string };
let role: string;
let platformAdmin: boolean;

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: (name: string, value: string) => { cookieSets.push({ name, value }); } }),
  headers: async () => new Headers(),
}));

const chain = (row: unknown) => {
  const c: unknown = new Proxy(() => undefined, {
    get: (_, prop) => {
      if (prop === "maybeSingle" || prop === "single") return () => Promise.resolve({ data: row, error: null });
      if (prop === "then") return undefined;
      return () => c;
    },
  });
  return c;
};

vi.mock("@/lib/server/supabase-admin", () => ({
  createSupabaseAdminClient: () => ({
    rpc: async () => ({ data: true, error: null }),
    from: () => ({
      select: (_cols: string, opts?: { head?: boolean }) => {
        const c: unknown = new Proxy({}, {
          get: (_, prop) => {
            if (prop === "then") return opts?.head ? (resolve: (v: unknown) => void) => resolve({ count: 0, error: null }) : undefined;
            if (prop === "maybeSingle") return async () => ({ data: { email: "admin@example.test" }, error: null });
            return () => c;
          },
        });
        return c;
      },
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  }),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      signInWithPassword: async () => ({ data: { user: { id: "user-1" } }, error: null }),
      getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }),
      signOut: async () => ({ error: null }),
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: level, error: null }) },
    },
    from: () => chain({ role, secondary_role: null, active: true, organization_id: "org-1", must_change_password: false }),
    rpc: async (name: string) => {
      if (name === "my_session") return { data: { user_id: "user-1", organization_id: "org-1", role, secondary_role: null, platform_admin: platformAdmin, organization_count: 1 }, error: null };
      if (name === "my_mfa_enrolment_required") return { data: false, error: null };
      return { data: null, error: null };
    },
  }),
}));

import { POST as signIn } from "@/app/api/auth/signin/route";
import { middleware } from "@/middleware";

const ENV = ["REQUIRE_ADMIN_MFA", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const saved: Record<string, string | undefined> = {};

/** Signs in with a correct password through the real route and returns the idle-clock cookie it set. */
async function signInFresh(): Promise<string> {
  cookieSets.length = 0;
  const res = await signIn(new Request("https://app.test/api/auth/signin", { method: "POST", body: JSON.stringify({ identifier: "admin", password: "Right-pass-9" }), headers: { "x-real-ip": "203.0.113.9" } }));
  expect(res.status).toBe(200);
  const set = cookieSets.find((c) => c.name === LAST_ACTIVE_COOKIE);
  expect(set).toBeDefined();
  return set!.value;
}

/** A page request carrying the given idle-clock value; returns where the middleware sends it (null = page opens). */
async function visit(path: string, lastActive: string) {
  const response = await middleware(new NextRequest(`https://app.test${path}`, { headers: { cookie: `sb-abcdefgh-auth-token=x; ${LAST_ACTIVE_COOKIE}=${lastActive}` } }));
  const location = response.headers.get("location");
  return location ? new URL(location).pathname + new URL(location).search : null;
}

beforeEach(() => {
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.REQUIRE_ADMIN_MFA = "true";
  role = "admin";
  platformAdmin = false;
  level = { currentLevel: "aal1", nextLevel: "aal2" };
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  vi.restoreAllMocks();
});

describe("the fresh idle clock from sign-in never skips the second step", () => {
  it("password right, MFA not done (aal1): every page goes to /mfa although the idle clock is fresh", async () => {
    const fresh = await signInFresh();
    for (const path of ["/dashboard", "/admin/users", "/invoices", "/settings"]) expect(await visit(path, fresh)).toBe("/mfa");
    // /mfa itself opens, so the code can be entered.
    expect(await visit("/mfa", fresh)).toBeNull();
  });

  it("the platform owner (MFA always required) is sent to /mfa the same way, even with REQUIRE_ADMIN_MFA off", async () => {
    delete process.env.REQUIRE_ADMIN_MFA;
    platformAdmin = true;
    const fresh = await signInFresh();
    expect(await visit("/dashboard", fresh)).toBe("/mfa");
  });

  it("only after the code is entered (aal2) does the same sign-in reach the page", async () => {
    const fresh = await signInFresh();
    expect(await visit("/dashboard", fresh)).toBe("/mfa");
    level = { currentLevel: "aal2", nextLevel: "aal2" };
    expect(await visit("/dashboard", fresh)).toBeNull();
  });

  it("the cookie is only the idle timer: a stale one ends the sign-in, a fresh one changes nothing else", async () => {
    const stale = String(Date.now() - 13 * 60 * 60 * 1000);
    expect(await visit("/dashboard", stale)).toBe("/login?expired=1");
    // A role that needs no second step is let through with the fresh clock, exactly as without it.
    role = "office";
    const fresh = await signInFresh();
    expect(await visit("/dashboard", fresh)).toBeNull();
  });
});
