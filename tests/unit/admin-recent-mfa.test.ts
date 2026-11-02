/**
 * G1: the 15-minute recent-code rule (change-password's) on the six Admin > Users actions that hand over, take away or lock a login:
 *   1 set someone's password       2 reset their two-step sign-in     3 e-mail a reset link
 *   4 create a user                5 give or take admin (PATCH)       6 disable / enable sign-in
 * With REQUIRE_ADMIN_MFA on: a code entered in the last 15 minutes -> allowed; a stale code -> 403 mfa_recent_required and NOTHING written
 * (no service-role write, no Auth write, no database function that changes anything); no aal2 -> the existing mfa_required; switch off ->
 * unchanged. The real routes, guard and requireRecentAal2 run against an in-memory fake of the service role and the caller's session.
 */
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ADMIN = "11111111-1111-4111-8111-111111111111";
const TARGET = "22222222-2222-4222-8222-222222222222";
const ORG_A = "44444444-4444-4444-8444-444444444444";
const ORG_B = "55555555-5555-4555-8555-555555555555";
const now = () => Math.floor(Date.now() / 1000);

type Row = Record<string, unknown>;
const WRITES = new Set(["update", "insert", "upsert", "delete"]);

const state = {
  /** What the caller's session says: the level and the amr list. */
  level: "aal2" as string,
  amr: [] as unknown[],
  /** Who the caller is (profile) and whether the session is signed in at all. */
  signedIn: true,
  support: false,
  members: [] as Row[],
  profiles: [] as Row[],
  banned: false,
  /** Every change attempted: service-role writes, Auth writes, and database functions that change something. */
  writes: [] as string[],
  /** Times the service-role client was created. */
  adminClients: 0,
};

function table(name: string): Row[] {
  return name === "organization_members" ? state.members : name === "user_profiles" ? state.profiles : [];
}

/** A tiny in-memory query builder: eq / neq / is / ilike filters, update patches, and writes recorded by name. */
function from(name: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let patch: Row | null = null;
  const run = () => {
    const rows = table(name).filter((row) => filters.every((f) => f(row)));
    if (patch) for (const row of rows) Object.assign(row, patch);
    return { data: rows, error: null };
  };
  const builder: Record<string, unknown> = new Proxy({}, {
    get: (_, prop: string) => {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(run());
      if (prop === "maybeSingle" || prop === "single") return async () => { const r = run(); return { data: r.data[0] ?? null, error: null }; };
      return (...args: unknown[]) => {
        if (WRITES.has(prop)) { state.writes.push(`${name}.${prop}`); if (prop === "update") patch = args[0] as Row; }
        if (prop === "eq") filters.push((row) => row[args[0] as string] === args[1]);
        if (prop === "neq") filters.push((row) => row[args[0] as string] !== args[1]);
        if (prop === "is") filters.push((row) => (row[args[0] as string] ?? null) === args[1]);
        if (prop === "ilike") filters.push((row) => String(row[args[0] as string] ?? "").toLowerCase() === String(args[1]).replace(/\\/g, "").toLowerCase());
        return builder;
      };
    },
  });
  return builder;
}

const admin = {
  from,
  rpc: async (fn: string) => { state.writes.push(`admin.rpc.${fn}`); return { data: null, error: null }; },
  auth: {
    admin: {
      getUserById: async (id: string) => ({ data: { user: { id, email: "target@example.test", banned_until: state.banned ? "2125-01-01T00:00:00Z" : null, app_metadata: state.banned ? { deactivation_ban: true, deactivation_ban_org: ORG_A } : {} } }, error: null }),
      updateUserById: async (_id: string, attrs: { ban_duration?: string }) => {
        state.writes.push("auth.updateUserById");
        if (attrs.ban_duration === "none") state.banned = false;
        else if (attrs.ban_duration) state.banned = true;
        return { data: { user: {} }, error: null };
      },
      createUser: async () => { state.writes.push("auth.createUser"); state.profiles.push({ id: "99999999-9999-4999-8999-999999999999", must_change_password: true }); return { data: { user: { id: "99999999-9999-4999-8999-999999999999" } }, error: null }; },
      deleteUser: async () => { state.writes.push("auth.deleteUser"); return { error: null }; },
      listUsers: async () => ({ data: { users: [] }, error: null }),
      mfa: {
        listFactors: async () => ({ data: { factors: [{ id: "f1", factor_type: "totp", status: "verified" }] }, error: null }),
        deleteFactor: async () => { state.writes.push("auth.deleteFactor"); return { error: null }; },
      },
    },
  },
};
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => { state.adminClients += 1; return admin; } }));

/** The caller's own client (their token): the assurance level and the database functions that run as them. */
const caller = {
  auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: state.level, nextLevel: "aal2", currentAuthenticationMethods: state.amr }, error: null }) } },
  rpc: async (fn: string, args: Record<string, unknown>) => {
    if (fn === "admin_login_is_protected") return { data: false, error: null };
    if (fn === "write_audit") return { data: null, error: null };
    state.writes.push(`rpc.${fn}`);
    if (fn === "set_member_access") {
      const row = state.members.find((m) => m.user_id === args.p_user && m.organization_id === ORG_A);
      if (row && args.p_role) row.role = args.p_role;
      if (row && args.p_secondary_role) row.secondary_role = args.p_secondary_role;
    }
    return { data: null, error: null };
  },
  from,
};

vi.mock("@/lib/server/auth", async (original) => {
  const real = await original<typeof import("@/lib/server/auth")>();
  return {
    ...real,
    requireProfile: async () => {
      if (!state.signedIn) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      // The same refusal requireProfile gives an admin at aal1 while the switch is on.
      if (real.mfaRequired && process.env.REQUIRE_ADMIN_MFA === "true" && state.level !== "aal2") return real.mfaRequired();
      return { supabase: caller, user: { id: ADMIN, email: "admin@example.test" }, profile: { id: ADMIN, organization_id: ORG_A, role: "admin", secondary_role: null }, session: { support: state.support } };
    },
  };
});

const { POST: setPassword } = await import("@/app/api/admin/users/password/route");
const { POST: mfaReset } = await import("@/app/api/admin/users/mfa-reset/route");
const { POST: resetLink } = await import("@/app/api/admin/users/reset-link/route");
const { POST: createUser, PATCH: patchUser } = await import("@/app/api/admin/users/route");
const { POST: signIn } = await import("@/app/api/admin/users/sign-in/route");

const request = (url: string, method: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" }, body: JSON.stringify(body) });

type Action = { name: string; go: () => Promise<Response>; wrote: string };
const actions: Action[] = [
  { name: "set password", wrote: "auth.updateUserById", go: () => setPassword(request("/api/admin/users/password", "POST", { user_id: TARGET, password: "Correct-Horse-Battery-9", must_change_password: true })) },
  { name: "reset two-step", wrote: "auth.deleteFactor", go: () => mfaReset(request("/api/admin/users/mfa-reset", "POST", { userId: TARGET })) },
  { name: "reset link", wrote: "", go: () => resetLink(request("/api/admin/users/reset-link", "POST", { userId: TARGET })) },
  { name: "create user", wrote: "auth.createUser", go: () => createUser(request("/api/admin/users", "POST", { email: "new@example.test", full_name: "New Person", role: "office", password: "Correct-Horse-Battery-9", must_change_password: true })) },
  { name: "give admin", wrote: "rpc.set_member_access", go: () => patchUser(request("/api/admin/users", "PATCH", { user_id: TARGET, role: "admin" })) },
  { name: "disable sign-in", wrote: "auth.updateUserById", go: () => signIn(request("/api/admin/users/sign-in", "POST", { user_id: TARGET, enabled: false })) },
];

const ENV = ["REQUIRE_ADMIN_MFA", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const FRESH = () => [{ method: "password", timestamp: now() - 120 }, { method: "totp", timestamp: now() - 60 }];
const STALE = () => [{ method: "password", timestamp: now() - 3600 }, { method: "totp", timestamp: now() - 16 * 60 }];

function reset() {
  Object.assign(state, { level: "aal2", amr: FRESH(), signedIn: true, support: false, banned: false, writes: [], adminClients: 0 });
  state.members = [
    { user_id: ADMIN, organization_id: ORG_A, role: "admin", secondary_role: null, active: true, support: false },
    { user_id: TARGET, organization_id: ORG_A, role: "office", secondary_role: null, active: true, support: false, hidden_sections: [] },
  ];
  state.profiles = [{ id: TARGET, email: "target@example.test", username: null, full_name: "Target Person", must_change_password: false }];
}

beforeEach(() => {
  for (const key of ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.REQUIRE_ADMIN_MFA = "true";
  reset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const key of ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  vi.restoreAllMocks();
});

const isMfaRefusal = async (response: Response, code: string) => response.status === 403 && (await response.clone().json()).code === code;

for (const action of actions) {
  describe(`${action.name}`, () => {
    it("a code from the last 15 minutes: allowed (the request goes on and does its work)", async () => {
      const response = await action.go();
      expect(await isMfaRefusal(response, "mfa_recent_required")).toBe(false);
      expect(await isMfaRefusal(response, "mfa_required")).toBe(false);
      if (action.name === "reset link") {
        // The e-mail itself needs the Auth sender; here the request got past the gate and into the service-role reads.
        expect(state.adminClients).toBe(1);
      } else {
        expect([200, 201], await response.clone().text()).toContain(response.status);
        expect(state.writes).toContain(action.wrote);
      }
    });

    it("a code older than 15 minutes: 403 mfa_recent_required, nothing changed", async () => {
      state.amr = STALE();
      const response = await action.go();
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "mfa_recent_required" });
      expect(state.writes).toEqual([]);
      expect(state.members.find((m) => m.user_id === TARGET)).toMatchObject({ role: "office" });
      expect(state.banned).toBe(false);
    });

    it("no authenticator code in the session at all (amr has none): 403 mfa_recent_required, nothing changed", async () => {
      state.amr = [{ method: "password", timestamp: now() }];
      const response = await action.go();
      expect(await response.json()).toMatchObject({ code: "mfa_recent_required" });
      expect(state.writes).toEqual([]);
    });

    it("never passed the second step (aal1): the existing mfa_required, nothing changed", async () => {
      state.level = "aal1";
      state.amr = [{ method: "password", timestamp: now() }];
      const response = await action.go();
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "mfa_required" });
      expect(state.writes).toEqual([]);
    });

    it("switch off: a stale code is not asked about (unchanged behaviour), aal1 is still refused", async () => {
      process.env.REQUIRE_ADMIN_MFA = "false";
      state.amr = STALE();
      const stale = await action.go();
      expect(await isMfaRefusal(stale, "mfa_recent_required")).toBe(false);
      expect(await isMfaRefusal(stale, "mfa_required")).toBe(false);
      reset();
      state.level = "aal1";
      const aal1 = await action.go();
      expect(aal1.status).toBe(403);
      expect(await aal1.json()).toMatchObject({ code: "mfa_required" });
      expect(state.writes).toEqual([]);
    });

    it("an expired session is still 401", async () => {
      state.signedIn = false;
      expect((await action.go()).status).toBe(401);
      expect(state.writes).toEqual([]);
    });

    it("a code timestamp in the future (clock trick) or without a time does not count", async () => {
      state.amr = [{ method: "totp", timestamp: now() + 3600 }, { method: "totp" }];
      expect(await (await action.go()).json()).toMatchObject({ code: "mfa_recent_required" });
      expect(state.writes).toEqual([]);
    });
  });
}

describe("the 15-minute edge", () => {
  it("14 minutes old is allowed, 16 minutes old is not (set password)", async () => {
    state.amr = [{ method: "totp", timestamp: now() - 14 * 60 }];
    expect((await actions[0].go()).status).toBe(200);
    reset();
    state.amr = [{ method: "totp", timestamp: now() - 16 * 60 }];
    expect((await actions[0].go()).status).toBe(403);
  });
});

describe("role changes: giving or taking admin", () => {
  const patch = (body: Record<string, unknown>) => patchUser(request("/api/admin/users", "PATCH", { user_id: TARGET, ...body }));

  it("giving admin (role) with a stale code: refused, role unchanged", async () => {
    state.amr = STALE();
    expect(await (await patch({ role: "admin" })).json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
    expect(state.members[1].role).toBe("office");
  });
  it("giving admin as a second role with a stale code: refused", async () => {
    state.amr = STALE();
    expect(await (await patch({ secondary_role: "admin" })).json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
  });
  it("giving admin with a fresh code: done", async () => {
    expect((await patch({ role: "admin" })).status).toBe(200);
    expect(state.members[1].role).toBe("admin");
  });
  it("taking admin away with a stale code: refused, they stay admin", async () => {
    state.members[1].role = "admin";
    state.amr = STALE();
    expect(await (await patch({ role: "office" })).json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
    expect(state.members[1].role).toBe("admin");
  });
  it("taking admin away with a fresh code: done", async () => {
    state.members[1].role = "admin";
    expect((await patch({ role: "office" })).status).toBe(200);
    expect(state.members[1].role).toBe("office");
  });
  it("a change that is not about admin (page access) does not ask for a recent code", async () => {
    state.amr = STALE();
    const response = await patch({ hidden_sections: [] });
    expect(await isMfaRefusal(response, "mfa_recent_required")).toBe(false);
  });
});

describe("company isolation: an admin of company A and a user of company B", () => {
  beforeEach(() => {
    state.members = [
      { user_id: ADMIN, organization_id: ORG_A, role: "admin", secondary_role: null, active: true, support: false },
      { user_id: TARGET, organization_id: ORG_B, role: "office", secondary_role: null, active: true, support: false },
    ];
  });
  for (const action of actions.filter((a) => ["set password", "reset two-step", "reset link", "give admin", "disable sign-in"].includes(a.name))) {
    it(`${action.name}: refused even with a fresh code, nothing changed`, async () => {
      const response = await action.go();
      expect(response.status).toBe(404);
      expect(state.writes).toEqual([]);
    });
  }
});

describe("the helper itself", () => {
  it("requireRecentAal2 is null for a fresh code and answers the two codes otherwise", async () => {
    const { requireRecentAal2 } = await import("@/lib/server/admin-users");
    const auth = { supabase: caller } as unknown as Parameters<typeof requireRecentAal2>[0];
    expect(await requireRecentAal2(auth)).toBeNull();
    state.amr = STALE();
    const stale = await requireRecentAal2(auth, "do this");
    expect(stale?.status).toBe(403);
    expect(await stale!.json()).toMatchObject({ code: "mfa_recent_required", error: "For your security, enter a fresh code from your authenticator app to do this." });
    state.level = "aal1";
    expect(await (await requireRecentAal2(auth))!.json()).toMatchObject({ code: "mfa_required" });
  });
});
