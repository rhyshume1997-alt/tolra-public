/**
 * Audit Z7/C9: POST /api/auth/change-password took a new password from any signed-in session: no current password and no second
 * step. Now the current password is checked (a sign-in that is never stored) unless an admin set a temporary one (must change
 * password) or a reset or invite link signed the session in within the hour; and an admin needs aal2 when REQUIRE_ADMIN_MFA is on,
 * except while replacing a temporary password (the middleware sends them to set-up before /mfa). The breached-password check and
 * clearing must_change_password are unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => undefined }) }));

const USER = "11111111-1111-4111-8111-111111111111";
const EMAIL = "person@example.test";
const CURRENT = "Current-Password-123";
const NEW = "Brand-New-Password-456";
const now = () => Math.floor(Date.now() / 1000);

const state = {
  mustChange: false,
  profileError: false,
  memberships: [] as Array<{ role: string; secondary_role: string | null }>,
  membershipError: false,
  level: "aal1",
  amr: [] as unknown[],
  unreachable: false,
  checks: [] as string[],
  checkSignOuts: 0,
  updates: [] as string[],
};

const admin = {
  from: (table: string) => {
    if (table === "user_profiles") {
      return {
        select: () => ({ eq: () => ({ maybeSingle: async () => (state.profileError ? { data: null, error: { code: "XX000" } } : { data: { must_change_password: state.mustChange }, error: null }) }) }),
        update: (row: { must_change_password: boolean }) => ({ eq: () => ({ select: async () => { state.mustChange = row.must_change_password; return { data: [{ must_change_password: row.must_change_password }], error: null }; } }) }),
      };
    }
    if (table === "organization_members") {
      return { select: () => ({ eq: () => ({ eq: async () => (state.membershipError ? { data: null, error: { code: "XX000" } } : { data: state.memberships, error: null }) }) }) };
    }
    throw new Error(`unexpected table ${table}`);
  },
  auth: { admin: { updateUserById: async () => ({ error: null }) } },
};
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => admin }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: USER, email: EMAIL, app_metadata: {} } }, error: null }),
      updateUser: async ({ password }: { password: string }) => { state.updates.push(password); return { error: null }; },
      mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: state.level, nextLevel: state.level, currentAuthenticationMethods: state.amr }, error: null }) },
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

vi.mock("@supabase/supabase-js", async (original) => {
  const real = await original<typeof import("@supabase/supabase-js")>();
  return {
    ...real,
    createClient: (_url: string, _key: string, options: { auth?: { persistSession?: boolean } }) => ({
      auth: {
        signInWithPassword: async ({ email, password }: { email: string; password: string }) => {
          // The check never stores a session.
          expect(options.auth?.persistSession).toBe(false);
          state.checks.push(email);
          if (state.unreachable) return { data: { session: null, user: null }, error: Object.assign(new Error("fetch failed"), { name: "AuthRetryableFetchError", status: 0 }) };
          return password === CURRENT
            ? { data: { session: { access_token: "t" }, user: { id: USER } }, error: null }
            : { data: { session: null, user: null }, error: { name: "AuthApiError", status: 400, code: "invalid_credentials", message: "Invalid login credentials" } };
        },
        signOut: async () => { state.checkSignOuts += 1; return { error: null }; },
      },
    }),
  };
});

const { POST } = await import("@/app/api/auth/change-password/route");
const { recentLinkSignIn } = await import("@/lib/server/password-setup");

const change = (body: Record<string, unknown>) =>
  POST(new Request("http://localhost/api/auth/change-password", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" }, body: JSON.stringify(body) }));
const ENV = ["REQUIRE_ADMIN_MFA", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "BREACHED_PASSWORD_CHECK"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.BREACHED_PASSWORD_CHECK = "off";
  Object.assign(state, { mustChange: false, profileError: false, memberships: [{ role: "office", secondary_role: null }], membershipError: false, level: "aal1", amr: [{ method: "password", timestamp: now() - 60 }], unreachable: false, checks: [], checkSignOuts: 0, updates: [] });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  vi.restoreAllMocks();
});

describe("the current password is required for an ordinary change", () => {
  it("missing: 400, nothing changed", async () => {
    const response = await change({ password: NEW });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Enter your current password.");
    expect(state.updates).toEqual([]);
  });
  it("wrong: 400, nothing changed", async () => {
    const response = await change({ password: NEW, current_password: "Not-The-Password-1" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("Your current password is wrong.");
    expect(state.checks).toEqual([EMAIL]);
    expect(state.updates).toEqual([]);
  });
  it("right: changed; the check's own session is ended", async () => {
    const response = await change({ password: NEW, current_password: CURRENT });
    expect(response.status).toBe(200);
    expect(state.updates).toEqual([NEW]);
    expect(state.checkSignOuts).toBe(1);
  });
  it("the auth service can't be asked: 503, nothing changed (not 'wrong password')", async () => {
    state.unreachable = true;
    expect((await change({ password: NEW, current_password: CURRENT })).status).toBe(503);
    expect(state.updates).toEqual([]);
  });
  it("the password rules still come first", async () => {
    expect((await change({ password: "short", current_password: CURRENT })).status).toBe(400);
    expect(state.checks).toEqual([]);
  });
});

describe("no current password: a temporary password, or a reset or invite link followed within the hour", () => {
  it("must change password (an admin set it): changed without one, and the requirement is cleared", async () => {
    state.mustChange = true;
    const response = await change({ password: NEW });
    expect(response.status).toBe(200);
    expect(state.checks).toEqual([]);
    expect(state.updates).toEqual([NEW]);
    expect(state.mustChange).toBe(false);
  });
  it("a reset or invite link session (recovery, invite, otp, magiclink in amr) within the hour: changed without one", async () => {
    for (const method of ["recovery", "invite", "otp", "magiclink"]) {
      state.amr = [{ method, timestamp: now() - 300 }];
      expect((await change({ password: NEW })).status, method).toBe(200);
    }
    expect(state.checks).toEqual([]);
  });
  it("a link session older than an hour, or a password session, needs it", async () => {
    state.amr = [{ method: "recovery", timestamp: now() - 2 * 60 * 60 }];
    expect((await change({ password: NEW })).status).toBe(400);
    state.amr = [{ method: "password", timestamp: now() - 10 }, { method: "totp", timestamp: now() - 5 }];
    expect((await change({ password: NEW })).status).toBe(400);
    expect(state.updates).toEqual([]);
  });
  it("the profile can't be read: treated as no temporary password (the current one is asked for)", async () => {
    state.profileError = true;
    expect((await change({ password: NEW })).status).toBe(400);
  });
});

describe("an admin needs the second step when REQUIRE_ADMIN_MFA is on", () => {
  beforeEach(() => { state.memberships = [{ role: "office", secondary_role: "admin" }]; });

  it("on, at aal1: mfa_required, even with the right current password or from a reset link; nothing checked or changed", async () => {
    process.env.REQUIRE_ADMIN_MFA = "true";
    for (const body of [{ password: NEW, current_password: CURRENT }, { password: NEW }]) {
      state.amr = body.current_password ? [{ method: "password", timestamp: now() }] : [{ method: "recovery", timestamp: now() }];
      const response = await change(body);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "mfa_required" });
    }
    expect(state.checks).toEqual([]);
    expect(state.updates).toEqual([]);
  });
  it("on, at aal2: changed with the current password", async () => {
    process.env.REQUIRE_ADMIN_MFA = "true";
    state.level = "aal2";
    expect((await change({ password: NEW, current_password: CURRENT })).status).toBe(200);
  });
  it("on, while replacing a temporary password: no aal2 asked (set-up comes before /mfa), no current password", async () => {
    process.env.REQUIRE_ADMIN_MFA = "true";
    state.mustChange = true;
    expect((await change({ password: NEW })).status).toBe(200);
  });
  it("on, memberships unreadable: refused as if admin", async () => {
    process.env.REQUIRE_ADMIN_MFA = "true";
    state.membershipError = true;
    state.memberships = [];
    expect((await change({ password: NEW, current_password: CURRENT })).status).toBe(403);
  });
  it("off: aal1 is enough (with the current password); office staff are never asked for aal2", async () => {
    expect((await change({ password: NEW, current_password: CURRENT })).status).toBe(200);
    process.env.REQUIRE_ADMIN_MFA = "true";
    state.memberships = [{ role: "office", secondary_role: null }];
    expect((await change({ password: NEW, current_password: CURRENT })).status).toBe(200);
  });
});

describe("recentLinkSignIn", () => {
  const t = 1_800_000_000;
  it("a link method with a time within the hour", () => {
    expect(recentLinkSignIn([{ method: "recovery", timestamp: t - 3599 }], t)).toBe(true);
    expect(recentLinkSignIn([{ method: "password", timestamp: t - 10 }, { method: "otp", timestamp: t - 10 }], t)).toBe(true);
  });
  it("not: too old, from the future, a password or code sign-in, no time, or not a list", () => {
    expect(recentLinkSignIn([{ method: "recovery", timestamp: t - 3601 }], t)).toBe(false);
    expect(recentLinkSignIn([{ method: "recovery", timestamp: t + 3600 }], t)).toBe(false);
    expect(recentLinkSignIn([{ method: "password", timestamp: t }, { method: "totp", timestamp: t }], t)).toBe(false);
    expect(recentLinkSignIn(["recovery"], t)).toBe(false);
    expect(recentLinkSignIn(undefined, t)).toBe(false);
  });
});
