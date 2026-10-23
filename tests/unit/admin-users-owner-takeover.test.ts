/**
 * 093 (external read-only audit, HIGH): a company admin must never take over the platform owner's login. The reported path: the
 * platform owner has no membership of their own, only a leftover support row in company A (036 never switches a support row off when
 * its window ends: active = TRUE, expires_at in the past). A's admin then counted that row as A "owning" the login: Set password
 * changed it, Reset two-step sign-in deleted the authenticator, and the admin could sign in as the owner, enrol a new one and reach
 * the platform. Also a platform owner who is an ordinary member of A (the service role can't see the platform owner list, so the
 * routes ask admin_login_is_protected with the caller's token).
 *
 * Audit item 4: Set password and Reset two-step sign-in need the second step (aal2) always, whatever REQUIRE_ADMIN_MFA and the
 * company's rule say; every other Admin > Users route keeps today's rule.
 *
 * The real guard, helpers and routes run against one fake world: the service-role client is PostgREST-shaped over in-memory rows,
 * the caller's client answers the RPCs as the database does. requireProfile is replaced by a signed-in admin of A (no env is read).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }), headers: async () => new Headers() }));

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN = "11111111-1111-4111-8111-111111111111";
/** Platform owner, no membership of their own, one leftover support row in A (window over, still active). */
const OWNER = "22222222-2222-4222-8222-222222222222";
/** Platform owner who is an ordinary office member of A only. */
const OWNER2 = "33333333-3333-4333-8333-333333333333";
/** Not on the platform list now, ordinary member of A, a leftover support row in B. */
const FORMER = "44444444-4444-4444-8444-444444444444";
/** An ordinary workshop member of A only: the legitimate target. */
const MEM = "55555555-5555-4555-8555-555555555555";

type Row = Record<string, unknown>;
const PAST = "2026-10-19T09:00:00Z";
const FUTURE = "2126-10-19T09:00:00Z";
const member = (user_id: string, organization_id: string, extra: Row = {}): Row =>
  ({ user_id, organization_id, role: "office", secondary_role: null, active: true, support: false, expires_at: null, hidden_sections: [], mfa_enrolment_required: false, ...extra });

const world = {
  memberships: [] as Row[],
  profiles: [] as Row[],
  owners: new Set<string>(),
  factors: {} as Record<string, string[]>,
  passwordWrites: [] as string[],
  factorDeletes: [] as string[],
  rpcCalls: [] as string[],
  aal: "aal2" as "aal1" | "aal2",
  /** The database has no admin_login_is_protected yet (093 not applied): PostgREST answers PGRST202. */
  rpcMissing: false,
};

function tableRows(table: string): Row[] {
  if (table === "organization_members") return world.memberships;
  if (table === "user_profiles") return world.profiles;
  if (table === "organizations") return [{ id: A, name: "A Ltd" }, { id: B, name: "B Ltd" }];
  throw new Error(`unexpected table ${table}`);
}

/** A PostgREST-shaped query over the fake tables: eq / neq / is filters, then a list, one row, or an update. */
function query(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let patch: Row | null = null;
  const rows = () => tableRows(table).filter((row) => filters.every((f) => f(row)));
  const result = () => {
    if (patch) { const hit = rows(); for (const row of hit) Object.assign(row, patch); return { data: hit.map((row) => ({ ...row })), error: null }; }
    return { data: rows().map((row) => ({ ...row })), error: null };
  };
  const chain = {
    select: () => chain,
    update: (row: Row) => { patch = row; return chain; },
    eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return chain; },
    neq: (column: string, value: unknown) => { filters.push((row) => row[column] !== value); return chain; },
    is: (column: string, value: unknown) => { filters.push((row) => (row[column] ?? null) === value); return chain; },
    limit: () => chain,
    maybeSingle: async () => { const r = result(); return { data: r.data[0] ?? null, error: null }; },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
  };
  return chain;
}

const admin = {
  from: (table: string) => query(table),
  rpc: async (fn: string) => { throw new Error(`unexpected service rpc ${fn}`); },
  auth: {
    admin: {
      updateUserById: async (id: string, attrs: Row) => { if ("password" in attrs) world.passwordWrites.push(id); return { data: { user: { id } }, error: null }; },
      getUserById: async (id: string) => ({ data: { user: { id, banned_until: null, app_metadata: {} } }, error: null }),
      mfa: {
        listFactors: async ({ userId }: { userId: string }) => ({ data: { factors: (world.factors[userId] ?? []).map((id) => ({ id, factor_type: "totp", status: "verified" })) }, error: null }),
        deleteFactor: async ({ id, userId }: { id: string; userId: string }) => { world.factorDeletes.push(id); world.factors[userId] = (world.factors[userId] ?? []).filter((f) => f !== id); return { error: null }; },
      },
    },
  },
};

const adminOf = (caller: string, org: string) =>
  world.memberships.some((m) => m.user_id === caller && m.organization_id === org && m.active && !m.support && (m.role === "admin" || m.secondary_role === "admin"));

/** The caller's own client, answering as the database does (093's admin_login_is_protected; set_member_access on the session's company). */
const caller = {
  auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: world.aal, nextLevel: "aal2" }, error: null }) } },
  rpc: async (fn: string, args: Row = {}) => {
    world.rpcCalls.push(fn);
    if (fn === "write_audit") return { data: null, error: null };
    if (fn === "admin_login_is_protected") {
      if (world.rpcMissing) return { data: null, error: { code: "PGRST202", message: "Could not find the function public.admin_login_is_protected(p_user) in the schema cache" } };
      const id = String(args.p_user);
      const mine = world.memberships.some((m) => m.user_id === id && adminOf(ADMIN, String(m.organization_id)));
      return { data: !mine || world.owners.has(id) || world.memberships.some((m) => m.user_id === id && m.support), error: null };
    }
    if (fn === "set_member_access") {
      const row = world.memberships.find((m) => m.user_id === args.p_user && m.organization_id === A);
      if (!row) return { data: null, error: { code: "P0002", message: "User not found" } };
      if (typeof args.p_role === "string") row.role = args.p_role;
      if (typeof args.p_active === "boolean") row.active = args.p_active;
      return { data: null, error: null };
    }
    throw new Error(`unexpected caller rpc ${fn}`);
  },
};

vi.mock("@/lib/server/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/auth")>("@/lib/server/auth");
  return {
    ...actual,
    requireProfile: async () => ({ supabase: caller, user: { id: ADMIN }, profile: { id: ADMIN, role: "admin", secondary_role: null, organization_id: A, active: true, must_change_password: false }, session: null }),
  };
});
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => admin }));
vi.mock("@/lib/server/password-setup", () => ({ setMustChange: async () => true }));

const { ownsIdentity, guard } = await import("@/lib/server/admin-users");
const { POST: setPassword } = await import("@/app/api/admin/users/password/route");
const { POST: resetTwoStep } = await import("@/app/api/admin/users/mfa-reset/route");
const { PATCH } = await import("@/app/api/admin/users/route");
const { PROTECTED_CHECK_FAILED, PROTECTED_LOGIN } = await import("@/lib/company-access");

const json = (url: string, method: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const password = (userId: string) => setPassword(json("/api/admin/users/password", "POST", { user_id: userId, password: "Correct-Horse-Battery-9", must_change_password: false }));
const twoStep = (userId: string) => resetTwoStep(json("/api/admin/users/mfa-reset", "POST", { userId }));
const patch = (body: Row) => PATCH(json("/api/admin/users", "PATCH", body));

beforeEach(() => {
  world.memberships = [
    member(ADMIN, A, { role: "admin" }),
    member(OWNER, A, { role: "admin", support: true, expires_at: PAST }),
    member(OWNER2, A),
    member(FORMER, A),
    member(FORMER, B, { role: "admin", support: true, expires_at: PAST }),
    member(MEM, A, { role: "workshop" }),
  ];
  world.profiles = [ADMIN, OWNER, OWNER2, FORMER, MEM].map((id) => ({ id, email: `${id.slice(0, 4)}@example.test`, username: null, full_name: "Someone", must_change_password: false }));
  world.owners = new Set([OWNER, OWNER2]);
  world.factors = { [OWNER]: ["f-owner"], [OWNER2]: ["f-owner2"], [FORMER]: ["f-former"], [MEM]: ["f-mem"] };
  world.passwordWrites = [];
  world.factorDeletes = [];
  world.rpcCalls = [];
  world.aal = "aal2";
  world.rpcMissing = false;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("ownsIdentity: a support row never makes a login the company's (093)", () => {
  it("the platform owner with only a leftover support row in A: not A's (it was: every row is A)", async () => {
    expect(await ownsIdentity(admin as never, OWNER, A)).toBe(false);
  });
  it("an open support window is no different", async () => {
    world.memberships.find((m) => m.user_id === OWNER)!.expires_at = FUTURE;
    expect(await ownsIdentity(admin as never, OWNER, A)).toBe(false);
  });
  it("an ordinary member of A alone still is A's; a login with no membership still isn't", async () => {
    expect(await ownsIdentity(admin as never, MEM, A)).toBe(true);
    expect(await ownsIdentity(admin as never, "66666666-6666-4666-8666-666666666666", A)).toBe(false);
  });
});

describe("Set password refuses a platform owner's login and one with a support row; an ordinary member still works", () => {
  it("the reported path: the owner's leftover support row in A -> 403, the password is never sent to Auth", async () => {
    const response = await password(OWNER);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(PROTECTED_LOGIN);
    expect(world.passwordWrites).toEqual([]);
  });
  it("a platform owner who is an ordinary member of A only -> 403 (asked with the caller's token)", async () => {
    const response = await password(OWNER2);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(PROTECTED_LOGIN);
    expect(world.rpcCalls).toContain("admin_login_is_protected");
    expect(world.passwordWrites).toEqual([]);
  });
  it("an ordinary member of A: 200, set", async () => {
    expect((await password(MEM)).status).toBe(200);
    expect(world.passwordWrites).toEqual([MEM]);
  });
});

describe("Reset two-step sign-in refuses a platform owner's login and one with a support row; an ordinary member still works", () => {
  it("the reported path: the owner's leftover support row in A -> 403, no factor deleted", async () => {
    const response = await twoStep(OWNER);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(PROTECTED_LOGIN);
    expect(world.factorDeletes).toEqual([]);
  });
  it("a platform owner who is an ordinary member of A only -> 403, no factor deleted", async () => {
    const response = await twoStep(OWNER2);
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(PROTECTED_LOGIN);
    expect(world.factorDeletes).toEqual([]);
  });
  it("an ordinary member of A: 200, their factor removed", async () => {
    const response = await twoStep(MEM);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, removed: 1 });
    expect(world.factorDeletes).toEqual(["f-mem"]);
  });
});

describe("the users PATCH refuses a platform owner's login and one with a support row, except switching it off", () => {
  it("a role change on the owner's support row in A -> 403, nothing written", async () => {
    const response = await patch({ user_id: OWNER, role: "office" });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(PROTECTED_LOGIN);
    expect(world.rpcCalls).not.toContain("set_member_access");
  });
  it("a username or a name for a platform owner who is an ordinary member of A -> 403, nothing written", async () => {
    for (const body of [{ user_id: OWNER2, username: "owner.two" }, { user_id: OWNER2, full_name: "Not The Owner" }, { user_id: OWNER2, role: "admin" }]) {
      const response = await patch(body);
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe(PROTECTED_LOGIN);
    }
    expect(world.profiles.find((p) => p.id === OWNER2)).toMatchObject({ username: null, full_name: "Someone" });
    expect(world.memberships.find((m) => m.user_id === OWNER2)).toMatchObject({ role: "office" });
  });
  it("a role change for a login with a support row in another company -> 403", async () => {
    expect((await patch({ user_id: FORMER, role: "admin" })).status).toBe(403);
    expect(world.memberships.find((m) => m.user_id === FORMER && m.organization_id === A)).toMatchObject({ role: "office" });
  });
  it("Revoke support access (switch the support row off, nothing else) still works; the role is untouched", async () => {
    expect((await patch({ user_id: OWNER, active: false })).status).toBe(200);
    expect(world.memberships.find((m) => m.user_id === OWNER)).toMatchObject({ active: false, role: "admin" });
    // Deactivating a platform owner's ordinary membership here is the same switch-off.
    expect((await patch({ user_id: OWNER2, active: false })).status).toBe(200);
    expect(world.memberships.find((m) => m.user_id === OWNER2)).toMatchObject({ active: false, role: "office" });
  });
  it("the exception only switches OFF: switching on, or off together with any other change, is refused and nothing is written", async () => {
    world.memberships.find((m) => m.user_id === OWNER)!.active = false;
    for (const body of [
      { user_id: OWNER, active: true },
      { user_id: OWNER, active: false, role: "office" },
      { user_id: OWNER, active: false, secondary_role: "office" },
      { user_id: OWNER, active: false, hidden_sections: ["quotes"] },
      { user_id: OWNER, active: false, full_name: "Someone Else" },
      { user_id: OWNER2, active: true },
      { user_id: OWNER2, active: false, role: "admin" },
    ]) {
      const response = await patch(body);
      expect(response.status, JSON.stringify(body)).toBe(403);
      expect((await response.json()).error).toBe(PROTECTED_LOGIN);
    }
    expect(world.rpcCalls).not.toContain("set_member_access");
    expect(world.memberships.find((m) => m.user_id === OWNER)).toMatchObject({ active: false, role: "admin" });
    expect(world.memberships.find((m) => m.user_id === OWNER2)).toMatchObject({ active: true, role: "office" });
  });
  it("an ordinary member of A: role change 200", async () => {
    expect((await patch({ user_id: MEM, role: "office" })).status).toBe(200);
    expect(world.memberships.find((m) => m.user_id === MEM)).toMatchObject({ role: "office" });
  });
});

describe("fail closed: when admin_login_is_protected can't be asked (093 not applied), nothing sensitive happens", () => {
  it("Set password, Reset two-step sign-in and a PATCH on another person are refused with the 093 message, even for an ordinary member", async () => {
    world.rpcMissing = true;
    for (const response of [await password(MEM), await twoStep(MEM), await patch({ user_id: MEM, role: "office" }), await patch({ user_id: MEM, username: "mem.one" })]) {
      expect(response.status).toBe(500);
      expect((await response.json()).error).toBe(PROTECTED_CHECK_FAILED);
    }
    expect(PROTECTED_CHECK_FAILED).toContain("the database needs its 093 update");
    expect(world.passwordWrites).toEqual([]);
    expect(world.factorDeletes).toEqual([]);
    expect(world.rpcCalls).not.toContain("set_member_access");
    expect(world.memberships.find((m) => m.user_id === MEM)).toMatchObject({ role: "workshop" });
    expect(world.profiles.find((p) => p.id === MEM)).toMatchObject({ username: null });
  });
  it("a support row is still refused as such without asking (403), and the caller's own edits never ask", async () => {
    world.rpcMissing = true;
    expect((await password(OWNER)).status).toBe(403);
    expect((await patch({ user_id: ADMIN, hidden_sections: [] })).status).toBe(200);
    expect(world.rpcCalls.filter((fn) => fn === "admin_login_is_protected")).toEqual([]);
  });
});

describe("audit item 4: Set password and Reset two-step sign-in need aal2 always", () => {
  it("at aal1 (REQUIRE_ADMIN_MFA unset: requireProfile lets the admin in) both are refused with mfa_required; nothing changes", async () => {
    world.aal = "aal1";
    for (const response of [await password(MEM), await twoStep(MEM)]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "mfa_required" });
    }
    expect(world.passwordWrites).toEqual([]);
    expect(world.factorDeletes).toEqual([]);
  });
  it("at aal2 both work", async () => {
    expect((await password(MEM)).status).toBe(200);
    expect((await twoStep(MEM)).status).toBe(200);
  });
  it("everything else keeps today's rule: the guard without the option and the users PATCH pass at aal1", async () => {
    world.aal = "aal1";
    expect(await guard(new Request("http://localhost/api/admin/users"))).not.toBeInstanceOf(Response);
    expect((await guard(new Request("http://localhost/api/admin/users"), { aal2: true })) as Response).toBeInstanceOf(Response);
    expect((await patch({ user_id: MEM, role: "office" })).status).toBe(200);
  });
});
