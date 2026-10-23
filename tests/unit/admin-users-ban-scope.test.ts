/**
 * The app's sign-in ban is scoped to the company that set it (app_metadata.deactivation_ban_org next to deactivation_ban). Disable sign-in
 * writes this company's id; Enable, Reactivate (PATCH), Add (re-adding a former member) and per-company access (companies route) lift the
 * ban only when its marker names the company reactivating / enabling. A legacy marker (no company) is lifted only by a company that holds
 * every membership of the login. The last-admin rule counts only admins who can still sign in (no ban of any kind), and two admins
 * disabling each other at the same moment never both stay disabled.
 *
 * The real routes and the real helpers (banState, companyMayLift, liftDeactivationBan, ownsIdentity) run against one fake world: Auth
 * users (app_metadata merged as GoTrue does, null deletes a key), profiles and memberships, with the database functions faked as 066 has
 * them (set_member_access refuses a login's last company).
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const X = "aaaaaaaa-0000-4000-8000-00000000000a";
const Y = "bbbbbbbb-0000-4000-8000-00000000000b";
const AX = "11111111-1111-4111-8111-111111111111";
const AY = "22222222-2222-4222-8222-222222222222";
const A2 = "33333333-3333-4333-8333-333333333333";
const A3 = "44444444-4444-4444-8444-444444444444";
const LEAVER = "55555555-5555-4555-8555-555555555555";
const FOREVER = "2125-01-01T00:00:00Z";

type Membership = { user_id: string; organization_id: string; role: string; secondary_role: string | null; active: boolean; support: boolean; hidden_sections: string[]; mfa_enrolment_required: boolean };
type Profile = { id: string; email: string; username: string | null; full_name: string | null };
type AuthUser = { banned_until: string | null; app_metadata: Record<string, unknown> };
type Row = Record<string, unknown>;

const world = {
  memberships: [] as Membership[],
  profiles: [] as Profile[],
  users: {} as Record<string, AuthUser>,
  authWrites: [] as Array<{ id: string; attrs: Row }>,
};

const member = (user_id: string, organization_id: string, extra: Partial<Membership> = {}): Membership =>
  ({ user_id, organization_id, role: "office", secondary_role: null, active: true, support: false, hidden_sections: [], mfa_enrolment_required: false, ...extra });

function tableRows(table: string): Row[] {
  if (table === "organization_members") return world.memberships as unknown as Row[];
  if (table === "user_profiles") return world.profiles as unknown as Row[];
  if (table === "organizations") return [{ id: X, name: "X Ltd" }, { id: Y, name: "Y Ltd" }];
  throw new Error(`unexpected table ${table}`);
}

/** A PostgREST-shaped query over the fake tables: eq / neq / ilike / is filters, then a list, one row, or an update. */
function query(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let patch: Row | null = null;
  const rows = () => tableRows(table).filter((row) => filters.every((f) => f(row)));
  const result = () => {
    if (patch) { for (const row of rows()) Object.assign(row, patch); return { data: null, error: null }; }
    return { data: rows().map((row) => ({ ...row })), error: null };
  };
  const chain = {
    select: () => chain,
    update: (row: Row) => { patch = row; return chain; },
    eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return chain; },
    in: (column: string, values: unknown[]) => { filters.push((row) => values.includes(row[column])); return chain; },
    neq: (column: string, value: unknown) => { filters.push((row) => row[column] !== value); return chain; },
    is: (column: string, value: unknown) => { filters.push((row) => (row[column] ?? null) === value); return chain; },
    ilike: (column: string, value: string) => { const plain = value.replace(/\\(.)/g, "$1").toLowerCase(); filters.push((row) => String(row[column] ?? "").toLowerCase() === plain); return chain; },
    limit: () => chain,
    maybeSingle: async () => { const r = result(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : null, error: null }; },
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject),
  };
  return chain;
}

const admin = {
  from: (table: string) => query(table),
  rpc: async (fn: string, args: Row) => {
    if (fn !== "add_member") throw new Error(`unexpected service rpc ${fn}`);
    const profile = world.profiles.find((p) => p.email === args.p_email);
    if (!profile) return { data: null, error: { code: "P0002" } };
    const existing = world.memberships.find((m) => m.user_id === profile.id && m.organization_id === args.p_org);
    if (existing) Object.assign(existing, { active: true, role: args.p_role });
    else world.memberships.push(member(profile.id, String(args.p_org), { role: String(args.p_role) }));
    return { data: "member", error: null };
  },
  auth: {
    admin: {
      getUserById: async (id: string) => ({ data: { user: { id, ...(world.users[id] ?? { banned_until: null, app_metadata: {} }) } }, error: null }),
      updateUserById: async (id: string, attrs: { ban_duration?: string; app_metadata?: Row }) => {
        world.authWrites.push({ id, attrs });
        const user = world.users[id] ?? { banned_until: null, app_metadata: {} };
        // GoTrue merges app_metadata key by key; a null value removes the key.
        const metadata = { ...user.app_metadata, ...(attrs.app_metadata ?? {}) };
        for (const [key, value] of Object.entries(metadata)) if (value === null) delete metadata[key];
        world.users[id] = { banned_until: attrs.ban_duration === "none" ? null : attrs.ban_duration ? FOREVER : user.banned_until, app_metadata: metadata };
        return { error: null };
      },
      listUsers: async () => ({ data: { users: [] }, error: null }),
      mfa: { listFactors: async () => ({ data: { factors: [] }, error: null }) },
    },
  },
};

/** The caller's own client: set_member_access on the session's company, admin_set_company_access on any company they administer. */
function callerClient(org: string, caller: string) {
  const otherActive = (userId: string, except: string) =>
    world.memberships.some((m) => m.user_id === userId && m.organization_id !== except && m.active && !m.support);
  return {
    auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2", nextLevel: "aal2" }, error: null }) } },
    rpc: async (fn: string, args: Row = {}) => {
      if (fn === "my_admin_companies") return { data: [{ organization_id: X, name: "X Ltd" }, { organization_id: Y, name: "Y Ltd" }], error: null };
      // 093: TRUE unless one of the caller's people with no support membership (nobody here is on the platform owner list).
      if (fn === "admin_login_is_protected") {
        const id = String(args.p_user);
        const isAdminOf = (company: unknown) => world.memberships.some((m) => m.user_id === caller && m.organization_id === company && m.active && !m.support && (m.role === "admin" || m.secondary_role === "admin"));
        return { data: !world.memberships.some((m) => m.user_id === id && isAdminOf(m.organization_id)) || world.memberships.some((m) => m.user_id === id && m.support), error: null };
      }
      const target = fn === "admin_set_company_access" ? String(args.p_org) : org;
      const userId = String(args.p_user);
      const row = world.memberships.find((m) => m.user_id === userId && m.organization_id === target);
      if (!row) return { data: null, error: { code: "P0002", message: "not found" } };
      // 066: switching a login on in a company needs the caller to administer every company the login is in (or be the login).
      const adminOf = (company: string) => world.memberships.some((m) => m.user_id === caller && m.organization_id === company && m.active && !m.support && (m.role === "admin" || m.secondary_role === "admin"));
      if (fn === "admin_set_company_access" && args.p_active === true && !row.active && userId !== caller
          && world.memberships.some((m) => m.user_id === userId && !adminOf(m.organization_id))) {
        return { data: null, error: { code: "42501", hint: "other_company_login", message: "This login belongs to another company. An admin of that company must add it." } };
      }
      if (args.p_active === false && row.active && !otherActive(userId, target)) {
        return { data: null, error: { code: "23514", hint: "last_company", message: "This login must keep access to at least one company" } };
      }
      const wasActive = row.active;
      if (typeof args.p_active === "boolean") row.active = args.p_active;
      if (typeof args.p_role === "string") row.role = args.p_role;
      if (fn === "set_member_access") return { data: null, error: null };
      return { data: { changed: wasActive !== row.active, active: row.active, was_active: wasActive, reactivated: !wasActive && row.active }, error: null };
    },
  };
}

vi.mock("@/lib/server/admin-users", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/admin-users")>("@/lib/server/admin-users");
  return {
    ...actual,
    // The caller is named per request (x-test-caller / x-test-org), so two admins can call at the same moment.
    guard: async (request: Request) => {
      const id = request.headers.get("x-test-caller");
      const org = request.headers.get("x-test-org");
      if (!id || !org) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      return { auth: { user: { id }, profile: { organization_id: org }, supabase: callerClient(org, id), session: null }, admin };
    },
    audit: async () => undefined,
  };
});
vi.mock("@/lib/server/password-setup", () => ({ setMustChange: async () => true }));

const signIn = await import("@/app/api/admin/users/sign-in/route");
const users = await import("@/app/api/admin/users/route");
const companies = await import("@/app/api/admin/users/companies/route");

const as = (caller: string, org: string, url: string, method: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { "Content-Type": "application/json", origin: "http://localhost", "x-test-caller": caller, "x-test-org": org }, body: JSON.stringify(body) });
const setSignIn = (caller: string, org: string, user_id: string, enabled: boolean) => signIn.POST(as(caller, org, "/api/admin/users/sign-in", "POST", { user_id, enabled }));
const listSignIn = async (caller: string, org: string) =>
  (await (await signIn.GET(new Request("http://localhost/api/admin/users/sign-in", { headers: { "x-test-caller": caller, "x-test-org": org } }))).json()) as { users: Array<{ user_id: string; sign_in: string }> };
const patch = (caller: string, org: string, body: Row) => users.PATCH(as(caller, org, "/api/admin/users", "PATCH", body));
const add = (caller: string, org: string, body: Row) => users.POST(as(caller, org, "/api/admin/users", "POST", body));
const access = (caller: string, org: string, body: Row) => companies.POST(as(caller, org, "/api/admin/users/companies", "POST", body));

const ban = (id: string) => {
  const user = world.users[id];
  return { banned: Boolean(user?.banned_until), marker: user?.app_metadata.deactivation_ban ?? null, org: user?.app_metadata.deactivation_ban_org ?? null };
};
const canSignIn = (id: string) => !world.users[id]?.banned_until;
const unbans = () => world.authWrites.filter((w) => w.attrs.ban_duration === "none");

beforeEach(() => {
  world.memberships = [member(AX, X, { role: "admin" }), member(AY, Y, { role: "admin" }), member(LEAVER, X)];
  world.profiles = [
    { id: LEAVER, email: "leaver@x.test", username: "leaver", full_name: "Lee Ver" },
    { id: AX, email: "ax@x.test", username: "ax", full_name: "Admin X" },
    { id: AY, email: "ay@y.test", username: "ay", full_name: "Admin Y" },
  ];
  world.users = {};
  world.authWrites = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("the marker names the company that set it", () => {
  it("(a) X disables a leaver; Y adds them, deactivates and reactivates them (PATCH, re-add, per-company): X's ban stays", async () => {
    // Y's admin also administers X (adding or switching on a login that is also in X needs that); acting in Y, it still never lifts X's ban.
    world.memberships.push(member(AY, X, { role: "admin" }));
    expect((await setSignIn(AX, X, LEAVER, false)).status).toBe(200);
    expect(ban(LEAVER)).toEqual({ banned: true, marker: true, org: X });

    // Y adds the login by username as a NEW member: a disabled login is refused outright (#118) and X's ban is untouched.
    const added = await add(AY, Y, { username: "leaver", role: "office" });
    expect(added.status).toBe(409);
    expect(ban(LEAVER)).toEqual({ banned: true, marker: true, org: X });
    expect(world.memberships.some((m) => m.user_id === LEAVER && m.organization_id === Y)).toBe(false);

    // Y already held them before X's ban (an older Y membership): Y may switch its OWN membership off and on, never X's ban.
    world.memberships.push(member(LEAVER, Y));

    // Deactivate and Reactivate in Y (Admin > Users PATCH): X still holds them, so Y can switch its own membership off and on.
    expect((await patch(AY, Y, { user_id: LEAVER, active: false })).status).toBe(200);
    const back = await patch(AY, Y, { user_id: LEAVER, active: true });
    expect(back.status).toBe(200);
    expect((await back.json()).login_disabled).toBe(true);
    expect(ban(LEAVER)).toEqual({ banned: true, marker: true, org: X });

    // Re-adding a former member is a reactivation too.
    expect((await patch(AY, Y, { user_id: LEAVER, active: false })).status).toBe(200);
    const readded = await add(AY, Y, { username: "leaver", role: "office" });
    expect((await readded.json()).login_disabled).toBe(true);
    expect(ban(LEAVER)).toEqual({ banned: true, marker: true, org: X });

    // Per-company access: Y switches its membership off and on (the database says `reactivated` for Y).
    expect((await access(AY, Y, { user_id: LEAVER, changes: [{ organization_id: Y, active: false }] })).status).toBe(200);
    const granted = await access(AY, Y, { user_id: LEAVER, changes: [{ organization_id: Y, active: true, role: "office" }] });
    expect((await granted.json()).login_disabled).toBe(true);

    expect(ban(LEAVER)).toEqual({ banned: true, marker: true, org: X });
    expect(unbans()).toEqual([]);

    // Positive control: X itself reactivating them lifts its own ban.
    expect((await patch(AX, X, { user_id: LEAVER, active: false })).status).toBe(200);
    const xBack = await patch(AX, X, { user_id: LEAVER, active: true });
    expect((await xBack.json()).login_disabled).toBe(false);
    expect(ban(LEAVER)).toEqual({ banned: false, marker: null, org: null });
  });

  it("(b) a marker from another company is never lifted by Enable, nor re-marked by Disable; the page shows it as not ours", async () => {
    // The leaver once belonged to Y too (that membership is gone): Y's marker is still on the login.
    world.users[LEAVER] = { banned_until: FOREVER, app_metadata: { deactivation_ban: true, deactivation_ban_org: Y } };

    const enabled = await setSignIn(AX, X, LEAVER, true);
    expect(enabled.status).toBe(409);
    expect((await enabled.json()).error).toContain("only Tolra support can turn it back on");
    expect((await setSignIn(AX, X, LEAVER, false)).status).toBe(409);
    expect(world.authWrites).toEqual([]);
    expect(ban(LEAVER)).toEqual({ banned: true, marker: true, org: Y });
    expect((await listSignIn(AX, X)).users).toEqual([{ user_id: LEAVER, sign_in: "off_platform" }]);

    // Reactivation in X doesn't lift it either.
    world.memberships.push(member(LEAVER, Y, { active: true }));
    expect((await patch(AX, X, { user_id: LEAVER, active: false })).status).toBe(200);
    world.memberships = world.memberships.filter((m) => m.organization_id !== Y || m.user_id !== LEAVER);
    expect((await (await patch(AX, X, { user_id: LEAVER, active: true })).json()).login_disabled).toBe(true);
    expect(ban(LEAVER)).toEqual({ banned: true, marker: true, org: Y });
    expect(unbans()).toEqual([]);
  });

  it("a legacy marker (no company) is lifted only by a company that holds every membership of the login", async () => {
    world.users[LEAVER] = { banned_until: FOREVER, app_metadata: { deactivation_ban: true } };
    // Shared with Y (switched off there): neither company can be sure it set the ban.
    world.memberships.push(member(LEAVER, Y, { active: true }));
    expect((await patch(AY, Y, { user_id: LEAVER, active: false })).status).toBe(200);
    expect((await (await patch(AY, Y, { user_id: LEAVER, active: true })).json()).login_disabled).toBe(true);
    expect((await patch(AX, X, { user_id: LEAVER, active: false })).status).toBe(200);
    expect((await (await patch(AX, X, { user_id: LEAVER, active: true })).json()).login_disabled).toBe(true);
    expect(unbans()).toEqual([]);

    // X's alone: X's Enable lifts it (and lifts the whole marker).
    world.memberships = world.memberships.filter((m) => m.organization_id !== Y || m.user_id !== LEAVER);
    expect((await listSignIn(AX, X)).users).toEqual([{ user_id: LEAVER, sign_in: "off" }]);
    expect((await setSignIn(AX, X, LEAVER, true)).status).toBe(200);
    expect(ban(LEAVER)).toEqual({ banned: false, marker: null, org: null });
  });

  it("Enable by the company named in the marker lifts it and clears both keys", async () => {
    expect((await setSignIn(AX, X, LEAVER, false)).status).toBe(200);
    expect(world.users[LEAVER].app_metadata).toEqual({ deactivation_ban: true, deactivation_ban_org: X });
    expect((await setSignIn(AX, X, LEAVER, true)).status).toBe(200);
    expect(world.users[LEAVER].app_metadata).toEqual({});
    expect(canSignIn(LEAVER)).toBe(true);
  });
});

describe("(c) the last-admin rule counts only admins who can still sign in", () => {
  beforeEach(() => {
    world.memberships.push(member(A2, X, { role: "admin" }), member(A3, X, { role: "office", secondary_role: "admin" }));
  });

  it("disabled admins (this company's marked ban, the platform owner's ban) and the caller's own disabled login don't count", async () => {
    // A3 disabled by X; the caller AX disabled too (their session still open): only A2 can sign in.
    world.users[A3] = { banned_until: FOREVER, app_metadata: { deactivation_ban: true, deactivation_ban_org: X } };
    world.users[AX] = { banned_until: FOREVER, app_metadata: {} };
    const refused = await setSignIn(AX, X, A2, false);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe("At least one active admin must be able to sign in.");
    expect(canSignIn(A2)).toBe(true);
    expect(world.authWrites).toEqual([]);

    // Inactive and support admins never count either. (The caller is an ordinary admin whose own login is disabled: from 093 a caller
    // with only a support membership can't ask about anyone, admin_login_is_protected answers TRUE for them, as the guard refuses
    // support access anyway.)
    world.users = { [AX]: { banned_until: FOREVER, app_metadata: {} } };
    world.memberships = [member(AX, X, { role: "admin" }), member(LEAVER, X, { role: "admin", active: false }), member(A2, X, { role: "admin" }), member(A3, X, { role: "admin", support: true })];
    expect((await setSignIn(AX, X, A2, false)).status).toBe(409);
    expect(canSignIn(A2)).toBe(true);
  });

  it("an admin who can still sign in is enough", async () => {
    world.users[A3] = { banned_until: FOREVER, app_metadata: { deactivation_ban: true, deactivation_ban_org: X } };
    expect((await setSignIn(AX, X, A2, false)).status).toBe(200);
    expect(ban(A2)).toEqual({ banned: true, marker: true, org: X });
  });

  it("two admins disabling each other at the same moment: never both disabled", async () => {
    world.memberships = [member(AX, X, { role: "admin" }), member(A2, X, { role: "admin" }), member(LEAVER, X)];
    const [first, second] = await Promise.all([setSignIn(AX, X, A2, false), setSignIn(A2, X, AX, false)]);
    expect(canSignIn(AX) || canSignIn(A2)).toBe(true);
    // Whoever's ban was undone was told so.
    for (const [response, target] of [[first, A2], [second, AX]] as const) {
      expect(response.status === 200 ? !canSignIn(target) : canSignIn(target)).toBe(true);
    }
  });
});
