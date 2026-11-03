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
/** A login that belongs to the second company only (per-company access). */
const TARGET2 = "88888888-8888-4888-8888-888888888888";
const ORG_A = "44444444-4444-4444-8444-444444444444";
const ORG_B = "55555555-5555-4555-8555-555555555555";
/** A second company the caller also administers (per-company access). */
const ORG_C = "66666666-6666-4666-8666-666666666666";
const ADMIN_ORGS = [ORG_A, ORG_C];
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
  /** The database refuses set_member_access / admin_set_company_access with this hint (migration 136's trigger). */
  dbRefuses: null as string | null,
  /** Limits dbRefuses to one company (the p_org of admin_set_company_access). */
  dbRefusesOrg: null as string | null,
  /** The company switches the service role reads (organizations.require_admin_mfa). */
  orgs: [] as Row[],
  /** A table whose reads fail (a read error). */
  failTable: null as string | null,
  /** Times the service-role client was created. */
  adminClients: 0,
};

function table(name: string): Row[] {
  return name === "organization_members" ? state.members : name === "user_profiles" ? state.profiles : name === "organizations" ? state.orgs : [];
}

/** A tiny in-memory query builder: eq / neq / is / ilike filters, update patches, and writes recorded by name. */
function from(name: string, visible: (row: Row) => boolean = () => true) {
  const filters: Array<(row: Row) => boolean> = [visible];
  let patch: Row | null = null;
  const run = () => {
    if (state.failTable === name) return { data: null, error: { code: "XX000" } };
    const rows = table(name).filter((row) => filters.every((f) => f(row)));
    if (patch) for (const row of rows) Object.assign(row, patch);
    return { data: rows, error: null };
  };
  const builder: Record<string, unknown> = new Proxy({}, {
    get: (_, prop: string) => {
      if (prop === "then") return (resolve: (v: unknown) => void) => resolve(run());
      if (prop === "maybeSingle" || prop === "single") return async () => { const r = run(); return { data: (r.data ?? [])[0] ?? null, error: null }; };
      return (...args: unknown[]) => {
        if (WRITES.has(prop)) { state.writes.push(`${name}.${prop}`); if (prop === "update") patch = args[0] as Row; }
        if (prop === "eq") filters.push((row) => row[args[0] as string] === args[1]);
        if (prop === "in") filters.push((row) => (args[1] as unknown[]).includes(row[args[0] as string]));
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
  rpc: async (fn: string) => { state.writes.push(`admin.rpc.${fn}`); return { data: fn === "issue_password_change_ticket" ? "ticket-1" : null, error: null }; },
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
    if (state.dbRefuses && (fn === "set_member_access" || fn === "admin_set_company_access") && (!state.dbRefusesOrg || args.p_org === state.dbRefusesOrg)) return { data: null, error: { code: "42501", message: "x", hint: state.dbRefuses } };
    if (fn === "admin_login_is_protected") return { data: false, error: null };
    if (fn === "write_audit") return { data: null, error: null };
    if (fn !== "my_admin_companies" && !(fn === "admin_set_company_access" && !ADMIN_ORGS.includes(args.p_org as string))) state.writes.push(`rpc.${fn}`);
    if (fn === "set_member_access") {
      const row = state.members.find((m) => m.user_id === args.p_user && m.organization_id === ORG_A);
      if (row && args.p_role) row.role = args.p_role;
      if (row && args.p_secondary_role) row.secondary_role = args.p_secondary_role;
    }
    if (fn === "my_admin_companies") return { data: ADMIN_ORGS.map((organization_id) => ({ organization_id, name: "Company" })), error: null };
    if (fn === "admin_set_company_access") {
      // The database decides: only a company the caller administers; the change is applied to that membership.
      if (!ADMIN_ORGS.includes(args.p_org as string)) return { data: null, error: { code: "42501", message: "x", hint: "not_company_admin" } };
      const row = state.members.find((m) => m.user_id === args.p_user && m.organization_id === args.p_org);
      if (args.p_role && row) row.role = args.p_role;
      if (args.p_active !== null && row) row.active = args.p_active;
      return { data: { changed: true, action: "UPDATE_USER_ACCESS", active: args.p_active, was_active: true }, error: null };
    }
    return { data: null, error: null };
  },
  // Row-level security as the real database has it (007 / 131: "organization_members admins read org"): through the caller's own client an
  // admin sees the members of the SESSION company only (here A), not of the other companies they administer.
  from: (name: string) => from(name, (row) => row.organization_id === ORG_A),
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
const { POST: companies } = await import("@/app/api/admin/users/companies/route");
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
  { name: "give admin in another company", wrote: "rpc.admin_set_company_access", go: () => companies(request("/api/admin/users/companies", "POST", { user_id: TARGET2, changes: [{ organization_id: ORG_C, active: true, role: "admin", secondary_role: null }] })) },
  { name: "disable sign-in", wrote: "auth.updateUserById", go: () => signIn(request("/api/admin/users/sign-in", "POST", { user_id: TARGET, enabled: false })) },
];

const ENV = ["REQUIRE_ADMIN_MFA", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;
const saved: Record<string, string | undefined> = {};
const FRESH = () => [{ method: "password", timestamp: now() - 120 }, { method: "totp", timestamp: now() - 60 }];
const STALE = () => [{ method: "password", timestamp: now() - 3600 }, { method: "totp", timestamp: now() - 16 * 60 }];

function reset() {
  Object.assign(state, { level: "aal2", amr: FRESH(), signedIn: true, support: false, banned: false, writes: [], adminClients: 0, dbRefuses: null, dbRefusesOrg: null, failTable: null });
  state.members = [
    { user_id: ADMIN, organization_id: ORG_A, role: "admin", secondary_role: null, active: true, support: false },
    { user_id: TARGET, organization_id: ORG_A, role: "office", secondary_role: null, active: true, support: false, hidden_sections: [] },
    { user_id: ADMIN, organization_id: ORG_C, role: "admin", secondary_role: null, active: true, support: false },
    { user_id: TARGET2, organization_id: ORG_C, role: "office", secondary_role: null, active: true, support: false },
  ];
  state.orgs = [{ id: ORG_A, require_admin_mfa: true }, { id: ORG_C, require_admin_mfa: true }, { id: ORG_B, require_admin_mfa: true }];
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

    it("switch off (the app's and the company's own): a stale code is not asked about (unchanged behaviour), aal1 is still refused", async () => {
      process.env.REQUIRE_ADMIN_MFA = "false";
      const companySwitchesOff = () => { state.orgs = state.orgs.map((org) => ({ ...org, require_admin_mfa: false })); };
      companySwitchesOff();
      state.amr = STALE();
      const stale = await action.go();
      expect(await isMfaRefusal(stale, "mfa_recent_required")).toBe(false);
      expect(await isMfaRefusal(stale, "mfa_required")).toBe(false);
      reset();
      companySwitchesOff();
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
      { user_id: TARGET2, organization_id: ORG_B, role: "office", secondary_role: null, active: true, support: false },
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

describe("per-company access (POST /api/admin/users/companies): giving or taking admin in another company", () => {
  const change = (...changes: Array<Record<string, unknown>>) => companies(request("/api/admin/users/companies", "POST", { user_id: TARGET2, changes }));
  const inC = () => state.members.find((m) => m.user_id === TARGET2 && m.organization_id === ORG_C)!;

  it("giving admin with a stale code: refused before anything is sent, role unchanged", async () => {
    state.amr = STALE();
    const response = await change({ organization_id: ORG_C, active: true, role: "admin", secondary_role: null });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
    expect(inC().role).toBe("office");
  });
  it("giving admin as a second role with a stale code: refused", async () => {
    state.amr = STALE();
    expect(await (await change({ organization_id: ORG_C, active: true, role: "office", secondary_role: "admin" })).json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
  });
  it("giving admin with a fresh code: done", async () => {
    expect((await change({ organization_id: ORG_C, active: true, role: "admin", secondary_role: null })).status).toBe(200);
    expect(inC().role).toBe("admin");
  });
  it("taking admin away (a different role) with a stale code: refused, they stay admin", async () => {
    inC().role = "admin";
    state.amr = STALE();
    expect(await (await change({ organization_id: ORG_C, active: true, role: "office", secondary_role: null })).json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
    expect(inC().role).toBe("admin");
  });
  it("taking admin away with a fresh code: done", async () => {
    inC().role = "admin";
    expect((await change({ organization_id: ORG_C, active: true, role: "office", secondary_role: null })).status).toBe(200);
    expect(inC().role).toBe("office");
  });
  it("switching a switched-off admin back on with a stale code: refused", async () => {
    Object.assign(inC(), { role: "admin", active: false });
    state.amr = STALE();
    expect(await (await change({ organization_id: ORG_C, active: true, role: "admin", secondary_role: null })).json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
  });
  it("one admin change among several: the whole request waits for a fresh code, nothing is sent", async () => {
    state.amr = STALE();
    const response = await change({ organization_id: ORG_A, active: true, role: "workshop", secondary_role: null }, { organization_id: ORG_C, active: true, role: "admin", secondary_role: null });
    expect(await response.json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
  });
  it("an access change that is not about admin (an office person becomes workshop) is not asked for a recent code, and is applied", async () => {
    state.amr = STALE();
    const response = await change({ organization_id: ORG_C, active: true, role: "workshop", secondary_role: null });
    expect(response.status).toBe(200);
    expect(inC().role).toBe("workshop");
  });
  it("the stored memberships can't be read (service role): treated as an admin change (fails closed), nothing sent", async () => {
    state.amr = STALE();
    state.failTable = "organization_members";
    expect(await (await change({ organization_id: ORG_C, active: true, role: "workshop", secondary_role: null })).json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
  });
  it("company A against company B: an admin of A can't give admin in B even with a fresh code (the database refuses), nothing written", async () => {
    state.members.push({ user_id: TARGET2, organization_id: ORG_B, role: "office", secondary_role: null, active: true, support: false });
    const response = await change({ organization_id: ORG_B, active: true, role: "admin", secondary_role: null });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ ok: false, results: [{ organization_id: ORG_B, ok: false }] });
    expect(state.writes).toEqual([]);
    expect(state.members.find((m) => m.user_id === TARGET2 && m.organization_id === ORG_B)!.role).toBe("office");
  });
  it("company A against company B with a stale code: asked for the code first, nothing written", async () => {
    state.members.push({ user_id: TARGET2, organization_id: ORG_B, role: "office", secondary_role: null, active: true, support: false });
    state.amr = STALE();
    expect(await (await change({ organization_id: ORG_B, active: true, role: "admin", secondary_role: null })).json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
  });
});

describe("deactivating an admin is taking admin (G1)", () => {
  const deactivate = () => patchUser(request("/api/admin/users", "PATCH", { user_id: TARGET, active: false }));
  const deactivateInC = () => companies(request("/api/admin/users/companies", "POST", { user_id: TARGET2, changes: [{ organization_id: ORG_C, active: false }] }));

  it("PATCH: an admin switched off with a stale code is refused and stays active; with a fresh code it is done", async () => {
    state.members[1].role = "admin";
    state.amr = STALE();
    expect(await (await deactivate()).json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
    expect(state.members[1].active).toBe(true);
    state.amr = FRESH();
    expect((await deactivate()).status).toBe(200);
  });
  it("PATCH: switching a non-admin off does not ask for a recent code", async () => {
    state.amr = STALE();
    expect(await isMfaRefusal(await deactivate(), "mfa_recent_required")).toBe(false);
  });
  it("per-company access: an admin of C switched off with a stale code is refused, nothing sent; a non-admin is not asked", async () => {
    const row = state.members.find((m) => m.user_id === TARGET2 && m.organization_id === ORG_C)!;
    row.role = "admin";
    state.amr = STALE();
    expect(await (await deactivateInC()).json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
    expect(row.active).toBe(true);
    row.role = "office";
    expect(await isMfaRefusal(await deactivateInC(), "mfa_recent_required")).toBe(false);
  });
});

describe("the database's own recent-code refusal (migration 136) reaches the browser as mfa_recent_required", () => {
  it("PATCH: set_member_access refused with hint mfa_recent_required (the app's switch is off, the company's own is on): 403 with the code, not Forbidden", async () => {
    process.env.REQUIRE_ADMIN_MFA = "false";
    state.dbRefuses = "mfa_recent_required";
    const response = await patchUser(request("/api/admin/users", "PATCH", { user_id: TARGET, role: "admin" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mfa_recent_required" });
  });
  it("create user (a second role of admin goes through set_member_access): refused the same way, and the new login is rolled back", async () => {
    process.env.REQUIRE_ADMIN_MFA = "false";
    state.dbRefuses = "mfa_recent_required";
    const response = await createUser(request("/api/admin/users", "POST", { email: "new2@example.test", full_name: "New Two", role: "office", secondary_role: "admin", password: "Correct-Horse-Battery-9", must_change_password: true }));
    expect(await response.json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toContain("auth.deleteUser");
  });
  it("per-company access: refused the same way, once, before any later change is sent", async () => {
    process.env.REQUIRE_ADMIN_MFA = "false";
    state.dbRefuses = "mfa_recent_required";
    const response = await companies(request("/api/admin/users/companies", "POST", { user_id: TARGET2, changes: [{ organization_id: ORG_C, active: true, role: "workshop", secondary_role: null }] }));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mfa_recent_required" });
  });
  it("any other database refusal is still Forbidden / the company message, not the code dialog", async () => {
    state.dbRefuses = "not_company_admin";
    const response = await patchUser(request("/api/admin/users", "PATCH", { user_id: TARGET, role: "admin" }));
    expect(await isMfaRefusal(response, "mfa_recent_required")).toBe(false);
  });
});

describe("the exploit: an admin of A and C, session A, a stale code, changes for C (real row-level security shows the caller only A's members)", () => {
  const rowC = () => state.members.find((m) => m.user_id === TARGET2 && m.organization_id === ORG_C)!;
  const post = (...changes: Array<Record<string, unknown>>) => companies(request("/api/admin/users/companies", "POST", { user_id: TARGET2, changes }));
  beforeEach(() => {
    // C's own switch is OFF, so migration 136 would not ask either: the app's decision is the only gate.
    state.orgs = [{ id: ORG_A, require_admin_mfa: true }, { id: ORG_C, require_admin_mfa: false }, { id: ORG_B, require_admin_mfa: true }];
    rowC().role = "admin";
    state.amr = STALE();
  });
  const attempts: Array<[string, Record<string, unknown>, (row: Record<string, unknown>) => void]> = [
    ["switch the admin off", { organization_id: ORG_C, active: false }, () => undefined],
    ["demote the admin (active true, role office)", { organization_id: ORG_C, active: true, role: "office", secondary_role: null }, () => undefined],
    ["switch a switched-off admin back on, no role named", { organization_id: ORG_C, active: true }, (row) => { row.active = false; }],
  ];
  for (const [name, change, prepare] of attempts) {
    it(`${name}: 403 mfa_recent_required, nothing written`, async () => {
      prepare(rowC());
      const before = { role: rowC().role, active: rowC().active };
      const response = await post(change);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "mfa_recent_required" });
      expect(state.writes).toEqual([]);
      expect({ role: rowC().role, active: rowC().active }).toEqual(before);
    });
    it(`${name}: with a fresh code it is done`, async () => {
      prepare(rowC());
      state.amr = FRESH();
      expect((await post(change)).status).toBe(200);
      expect(state.writes).toContain("rpc.admin_set_company_access");
    });
  }
  it("a company that is not one of the caller's (an unknown id) counts as an admin change: the code first, nothing written", async () => {
    const response = await post({ organization_id: ORG_B, active: false });
    expect(await response.json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
  });
  it("the company switches can't be read: fails closed (the code first)", async () => {
    state.failTable = "organizations";
    expect(await (await post({ organization_id: ORG_C, active: false })).json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
  });
  it("a non-admin change in C is still not asked", async () => {
    rowC().role = "office";
    expect((await post({ organization_id: ORG_C, active: true, role: "workshop", secondary_role: null })).status).toBe(200);
  });
});

describe("one decision before the first write, counting each company's own switch (app switch off)", () => {
  const post = (...changes: Array<Record<string, unknown>>) => companies(request("/api/admin/users/companies", "POST", { user_id: TARGET2, changes }));
  beforeEach(() => {
    process.env.REQUIRE_ADMIN_MFA = "false";
    state.members.push({ user_id: TARGET2, organization_id: ORG_A, role: "office", secondary_role: null, active: true, support: false });
    state.amr = STALE();
  });
  const twoChanges = () => post({ organization_id: ORG_A, active: true, role: "workshop", secondary_role: null }, { organization_id: ORG_C, active: true, role: "admin", secondary_role: null });

  it("C's own switch is on: the whole request waits for the code, so A is NOT changed first", async () => {
    state.orgs = [{ id: ORG_A, require_admin_mfa: true }, { id: ORG_C, require_admin_mfa: true }];
    const response = await twoChanges();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
    expect(state.members.find((m) => m.user_id === TARGET2 && m.organization_id === ORG_A)!.role).toBe("office");
  });
  it("C's own switch is on and the code is fresh: both changes are made", async () => {
    state.orgs = [{ id: ORG_A, require_admin_mfa: true }, { id: ORG_C, require_admin_mfa: true }];
    state.amr = FRESH();
    expect((await twoChanges()).status).toBe(200);
    expect(state.writes.filter((w) => w === "rpc.admin_set_company_access")).toHaveLength(2);
  });
  it("neither switch is on: no recent code is asked (aal2 only), both changes are made", async () => {
    state.orgs = [{ id: ORG_A, require_admin_mfa: false }, { id: ORG_C, require_admin_mfa: false }];
    expect((await twoChanges()).status).toBe(200);
    expect(state.writes.filter((w) => w === "rpc.admin_set_company_access")).toHaveLength(2);
  });
  it("a race (the code ages out between the check and the call, so the database refuses C after A was changed): the answer says exactly what was applied, not 'nothing changed'", async () => {
    state.orgs = [{ id: ORG_A, require_admin_mfa: false }, { id: ORG_C, require_admin_mfa: false }];
    state.dbRefuses = "mfa_recent_required";
    state.dbRefusesOrg = ORG_C;
    const response = await twoChanges();
    const body = await response.json();
    expect(response.status).toBe(207);
    expect(body.code).toBeUndefined();
    expect(body.results[0]).toMatchObject({ organization_id: ORG_A, ok: true, changed: true });
    expect(body.results[1]).toMatchObject({ organization_id: ORG_C, ok: false });
    const { summariseCompanyResults } = await import("@/lib/company-access");
    const summary = summariseCompanyResults(body.results);
    expect(summary.tone).toBe("partial");
    expect(summary.text).toContain("Company access saved: Company.");
    expect(summary.text).toContain("fresh code");
  });
  it("207 partial success (simulated mid-operation failure: the database refuses the 2nd change after the 1st was applied): exact saved list, never 'nothing changed'", async () => {
    state.orgs = [{ id: ORG_A, require_admin_mfa: false }, { id: ORG_C, require_admin_mfa: false }];
    state.dbRefusesOrg = ORG_C;
    const { summariseCompanyResults } = await import("@/lib/company-access");
    for (const hint of ["mfa_recent_required", "last_company"]) {
      state.writes = [];
      state.members.find((m) => m.user_id === TARGET2 && m.organization_id === ORG_A)!.role = "office";
      state.dbRefuses = hint;
      const response = await twoChanges();
      const body = await response.json();
      expect(response.status, hint).toBe(207);
      expect(body.ok).toBe(false);
      expect(body.code).toBeUndefined();
      expect(body.error).toBe("Some company access changes were not saved.");
      // Exactly one change saved (A) and exactly one refused (C), in the order sent.
      expect(body.results).toHaveLength(2);
      expect(body.results[0]).toEqual({ organization_id: ORG_A, name: "Company", ok: true, changed: true, action: "UPDATE_USER_ACCESS", admin_mfa_onboarding: false });
      expect(body.results[1]).toMatchObject({ organization_id: ORG_C, name: "Company", ok: false });
      expect(body.results[1].changed).toBeUndefined();
      // What the database holds matches the answer: A changed, C not; one write was applied.
      expect(state.writes.filter((w) => w === "rpc.admin_set_company_access")).toHaveLength(1);
      expect(state.members.find((m) => m.user_id === TARGET2 && m.organization_id === ORG_A)!.role).toBe("workshop");
      const summary = summariseCompanyResults(body.results);
      expect(summary.tone).toBe("partial");
      expect(summary.text.startsWith("Company access saved: Company.")).toBe(true);
      expect(summary.text).not.toMatch(/nothing (was )?changed|no changes/i);
    }
  });
  it("the same race with nothing applied yet: the whole request is refused with the code (nothing was changed, so the dialog may say so)", async () => {
    state.orgs = [{ id: ORG_A, require_admin_mfa: false }, { id: ORG_C, require_admin_mfa: false }];
    state.dbRefuses = "mfa_recent_required";
    state.dbRefusesOrg = ORG_C;
    const response = await post({ organization_id: ORG_C, active: true, role: "admin", secondary_role: null }, { organization_id: ORG_A, active: true, role: "workshop", secondary_role: null });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
  });
});

describe("create user as admin with the app's switch off and the company's own switch on (add_member runs as the service role, which 136 exempts)", () => {
  const newAdmin = (extra: Record<string, unknown> = {}) =>
    createUser(request("/api/admin/users", "POST", { email: "boss@example.test", full_name: "New Boss", role: "admin", password: "Correct-Horse-Battery-9", must_change_password: true, ...extra }));
  beforeEach(() => { process.env.REQUIRE_ADMIN_MFA = "false"; });

  it("a stale code: 403 mfa_recent_required before anything is written (no login created, no add_member)", async () => {
    state.amr = STALE();
    const response = await newAdmin();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
  });
  it("admin as the second role with a stale code: refused the same way, before the login is created", async () => {
    state.amr = STALE();
    const response = await newAdmin({ role: "office", secondary_role: "admin" });
    expect(await response.json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
  });
  it("a fresh code: the admin is created", async () => {
    const response = await newAdmin();
    expect([200, 201], await response.clone().text()).toContain(response.status);
    expect(state.writes).toContain("auth.createUser");
    expect(state.writes).toContain("admin.rpc.add_member");
  });
  it("the company's own switch off too: a stale code is not asked about (unchanged behaviour)", async () => {
    state.orgs = state.orgs.map((org) => ({ ...org, require_admin_mfa: false }));
    state.amr = STALE();
    const response = await newAdmin();
    expect(await isMfaRefusal(response, "mfa_recent_required")).toBe(false);
    expect(state.writes).toContain("auth.createUser");
  });
  it("the company switch can't be read: counts as on (fails closed), nothing written", async () => {
    state.failTable = "organizations";
    state.amr = STALE();
    const response = await newAdmin();
    expect(await response.json()).toMatchObject({ code: "mfa_recent_required" });
    expect(state.writes).toEqual([]);
  });
  it("creating a non-admin with a stale code and the app's switch off: not asked (only giving admin is)", async () => {
    state.amr = STALE();
    const response = await newAdmin({ role: "office" });
    expect(await isMfaRefusal(response, "mfa_recent_required")).toBe(false);
  });
});
