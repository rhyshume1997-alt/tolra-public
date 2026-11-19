/**
 * Turnstile on Forgot password and Change password (audit F1). Off by default: no site key = no token sent and the old behaviour.
 * On: the token reaches Supabase, a captcha refusal is its own 400 (never "wrong password", never account-dependent), and the
 * change-password check still goes through signInWithPassword (not replaced).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => undefined }), headers: async () => new Headers() }));

const USER = "11111111-1111-4111-8111-111111111111";
const calls: { fn: string; email: string; options: Record<string, unknown> }[] = [];
let known = true;
let captchaFails = false;
const updates: string[] = [];

const captchaError = { name: "AuthApiError", status: 400, code: "captcha_failed", message: "captcha verification process failed" };
const admin = {
  from: (table: string) => table === "user_profiles"
    ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { must_change_password: false, email: known ? "person@example.test" : null }, error: null }) }) }), update: (row: { must_change_password: boolean }) => ({ eq: () => ({ select: async () => ({ data: [{ must_change_password: row.must_change_password }], error: null }) }) }) }
    : { select: () => ({ eq: () => ({ eq: async () => ({ data: [{ role: "office", secondary_role: null }], error: null }) }) }) },
  auth: { admin: { updateUserById: async () => ({ error: null }) } },
  rpc: async (fn: string) => (fn === "issue_password_change_ticket" ? { data: "t1", error: null } : { data: true, error: null }),
};
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => admin }));
vi.mock("@/lib/server/login", async (original) => {
  const real = await original<typeof import("@/lib/server/login")>();
  return { ...real, withinLimit: async () => true, resolveLoginEmail: async () => (known ? "person@example.test" : null) };
});
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: USER, email: "person@example.test", app_metadata: {} } }, error: null }),
      updateUser: async ({ password }: { password: string }) => { updates.push(password); return { error: null }; },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1", currentAuthenticationMethods: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) - 60 }] }, error: null }) },
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock("@supabase/supabase-js", async (original) => {
  const real = await original<typeof import("@supabase/supabase-js")>();
  return {
    ...real,
    createClient: () => ({
      auth: {
        signInWithPassword: async ({ email, password, options }: { email: string; password: string; options?: Record<string, unknown> }) => {
          calls.push({ fn: "signInWithPassword", email, options: options ?? {} });
          if (captchaFails) return { data: { session: null, user: null }, error: captchaError };
          return password === "Current-Password-123" ? { data: { session: { access_token: "t" }, user: { id: USER } }, error: null } : { data: { session: null, user: null }, error: { name: "AuthApiError", status: 400, code: "invalid_credentials", message: "Invalid login credentials" } };
        },
        signOut: async () => ({ error: null }),
        resetPasswordForEmail: async (email: string, options: Record<string, unknown>) => {
          calls.push({ fn: "reset", email, options });
          return captchaFails ? { error: captchaError } : { error: null };
        },
      },
    }),
  };
});

const { POST: reset } = await import("@/app/api/auth/reset/route");
const { POST: change } = await import("@/app/api/auth/change-password/route");
const { CAPTCHA_REQUIRED_MESSAGE } = await import("@/lib/auth/turnstile");

const post = (url: string, body: Record<string, unknown>) =>
  new Request(`http://localhost${url}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost", "x-real-ip": "203.0.113.9" }, body: JSON.stringify(body) });
const asReset = (body: Record<string, unknown>) => reset(post("/api/auth/reset", body));
const asChange = (body: Record<string, unknown>) => change(post("/api/auth/change-password", body));

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.NEXT_PUBLIC_SITE_URL = "http://localhost";
  process.env.BREACHED_PASSWORD_CHECK = "off";
  calls.length = 0; updates.length = 0; known = true; captchaFails = false;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Forgot password with Turnstile", () => {
  it("passes the token to Supabase", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "0x4AAA");
    const res = await asReset({ identifier: "person", captchaToken: "tok" });
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ fn: "reset", email: "person@example.test", options: { captchaToken: "tok" } });
  });
  it("off: no token sent, and an unknown account makes no call (unchanged)", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    await asReset({ identifier: "person", captchaToken: "" });
    expect(calls[0].options).not.toHaveProperty("captchaToken");
    calls.length = 0; known = false;
    expect((await asReset({ identifier: "ghost" })).status).toBe(200);
    expect(calls).toEqual([]);
  });
  it("on: a refused token is the same 400 for a known and an unknown account", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "0x4AAA");
    captchaFails = true;
    const a = await asReset({ identifier: "person", captchaToken: "stale" });
    known = false;
    const b = await asReset({ identifier: "ghost", captchaToken: "stale" });
    expect(a.status).toBe(400); expect(b.status).toBe(400);
    expect(await a.json()).toEqual({ error: CAPTCHA_REQUIRED_MESSAGE, captcha: true });
    expect(await b.json()).toEqual({ error: CAPTCHA_REQUIRED_MESSAGE, captcha: true });
    expect(calls[1].email).toMatch(/@invalid\.invalid$/);
  });
  it("on: with a good token an unknown account gets the ordinary answer", async () => {
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "0x4AAA");
    known = false;
    const res = await asReset({ identifier: "ghost", captchaToken: "tok" });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toContain("If that account exists");
  });
});

describe("Change password with Turnstile", () => {
  const NEW = "Brand-New-Password-456";
  it("the current-password check still uses signInWithPassword and carries the token", async () => {
    const res = await asChange({ password: NEW, current_password: "Current-Password-123", captchaToken: "tok" });
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ fn: "signInWithPassword", options: { captchaToken: "tok" } });
    expect(updates).toEqual([NEW]);
  });
  it("no token (check off): no options, unchanged", async () => {
    await asChange({ password: NEW, current_password: "Current-Password-123", captchaToken: "" });
    expect(calls[0].options).toEqual({});
  });
  it("a captcha refusal is its own 400, not 'wrong password', and nothing changes", async () => {
    captchaFails = true;
    const res = await asChange({ password: NEW, current_password: "Current-Password-123", captchaToken: "stale" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: CAPTCHA_REQUIRED_MESSAGE, captcha: true });
    expect(updates).toEqual([]);
  });
  it("a wrong password with a good token is still 'wrong'", async () => {
    const res = await asChange({ password: NEW, current_password: "Nope-Nope-123", captchaToken: "tok" });
    expect((await res.json()).error).toBe("Your current password is wrong.");
  });
});
