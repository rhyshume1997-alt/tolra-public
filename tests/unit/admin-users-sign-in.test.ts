/**
 * Admin > Users, Disable / Enable sign-in (offboarding a leaver whose only company this is; 066 keeps every login's last company, so
 * Deactivate can't). Only for a login that belongs to this company alone (ownsIdentity), at aal2, never by support access. Disable sets
 * the app's own MARKED ban and leaves the membership as it is; Enable lifts only that marked ban. A ban the app didn't set (the
 * platform owner's) is never touched. The real banState / liftDeactivationBan run against a fake Auth admin API.
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ADMIN = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const ORG = "44444444-4444-4444-8444-444444444444";
const ELSEWHERE = "55555555-5555-4555-8555-555555555555";

type Membership = { user_id: string; organization_id: string; role: string; secondary_role: string | null; active: boolean; support: boolean };
type AuthUser = { banned_until: string | null; app_metadata: Record<string, unknown> };

const FOREVER = "2125-01-01T00:00:00Z";
const state = {
  guardDenied: false,
  aal: "aal2" as string,
  memberships: [] as Membership[],
  users: {} as Record<string, AuthUser>,
  /** Auth writes, in order. */
  authWrites: [] as Array<{ id: string; attrs: Record<string, unknown> }>,
  banError: null as { status: number } | null,
  banErrorAlsoApplies: false,
  membershipWrites: 0,
  audited: [] as Array<{ action: string; entityId: string; newData: Record<string, unknown>; oldData: Record<string, unknown> | null }>,
  /** 093: the platform owner list (only the database can read it), and whether admin_login_is_protected exists yet. */
  owners: new Set<string>(),
  rpcMissing: false,
};

const ordinary = (user_id: string, organization_id: string, extra: Partial<Membership> = {}): Membership =>
  ({ user_id, organization_id, role: "office", secondary_role: null, active: true, support: false, ...extra });

/** A fake query on organization_members: eq filters, then a list (await) or one row (maybeSingle). */
function membersQuery() {
  const filters: Array<[string, unknown]> = [];
  const lists: Array<[string, unknown[]]> = [];
  const rows = () => state.memberships.filter((m) => filters.every(([column, value]) => (m as Record<string, unknown>)[column] === value) && lists.every(([column, values]) => values.includes((m as Record<string, unknown>)[column])));
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => { filters.push([column, value]); return chain; },
    in: (column: string, values: unknown[]) => { lists.push([column, values]); return chain; },
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    update: () => { state.membershipWrites += 1; return chain; },
    then: (resolve: (value: { data: Membership[]; error: null }) => unknown) => resolve({ data: rows(), error: null }),
  };
  return chain;
}

const admin = {
  from: (table: string) => {
    if (table !== "organization_members") throw new Error(`unexpected table ${table}`);
    return membersQuery();
  },
  auth: {
    admin: {
      getUserById: async (id: string) => ({ data: { user: { id, ...(state.users[id] ?? { banned_until: null, app_metadata: {} }) } }, error: null }),
      updateUserById: async (id: string, attrs: { ban_duration?: string; app_metadata?: Record<string, unknown> }) => {
        state.authWrites.push({ id, attrs });
        if (!state.banError || state.banErrorAlsoApplies) {
          const user = state.users[id] ?? { banned_until: null, app_metadata: {} };
          const metadata = { ...user.app_metadata, ...(attrs.app_metadata ?? {}) };
          for (const [key, value] of Object.entries(metadata)) if (value === null) delete metadata[key];
          state.users[id] = { banned_until: attrs.ban_duration === "none" ? null : attrs.ban_duration ? FOREVER : user.banned_until, app_metadata: metadata };
        }
        return { error: state.banError };
      },
    },
  },
};

const supabase = {
  auth: { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: state.aal, nextLevel: "aal2" }, error: null }) } },
  // The caller's own client, answering admin_login_is_protected as 093 does (the caller administers ORG).
  rpc: async (fn: string, args: { p_user?: string }) => {
    if (fn !== "admin_login_is_protected") throw new Error(`unexpected caller rpc ${fn}`);
    if (state.rpcMissing) return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
    const id = String(args.p_user);
    const mine = state.memberships.some((m) => m.user_id === id && m.organization_id === ORG);
    return { data: !mine || state.owners.has(id) || state.memberships.some((m) => m.user_id === id && m.support), error: null };
  },
};

vi.mock("@/lib/server/admin-users", async () => {
  const actual = await vi.importActual<typeof import("@/lib/server/admin-users")>("@/lib/server/admin-users");
  return {
    ...actual,
    guard: async () => (state.guardDenied
      ? NextResponse.json({ error: "Support access can't manage users" }, { status: 403 })
      : { auth: { user: { id: ADMIN }, profile: { organization_id: ORG }, supabase }, admin }),
    audit: async (_ctx: unknown, action: string, entityId: string, newData: Record<string, unknown>, _request: Request, oldData: Record<string, unknown> | null = null) => {
      state.audited.push({ action, entityId, newData, oldData });
    },
  };
});

const { GET, POST } = await import("@/app/api/admin/users/sign-in/route");

const post = (body: Record<string, unknown>) =>
  POST(new Request("http://localhost/api/admin/users/sign-in", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) }));
const disable = (user_id = USER) => post({ user_id, enabled: false });
const enable = (user_id = USER) => post({ user_id, enabled: true });
const platformBan = (id: string) => { state.users[id] = { banned_until: FOREVER, app_metadata: {} }; };
const ban = (id: string) => ({ banned: Boolean(state.users[id]?.banned_until), marked: state.users[id]?.app_metadata.deactivation_ban === true });

beforeEach(() => {
  state.guardDenied = false;
  state.aal = "aal2";
  state.memberships = [ordinary(ADMIN, ORG, { role: "admin" }), ordinary(USER, ORG)];
  state.users = {};
  state.authWrites = [];
  state.banError = null;
  state.banErrorAlsoApplies = false;
  state.membershipWrites = 0;
  state.audited = [];
  state.owners = new Set();
  state.rpcMissing = false;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("who may disable sign-in", () => {
  it("support access is refused by the guard; nothing is read or written", async () => {
    state.guardDenied = true;
    expect((await disable()).status).toBe(403);
    expect(state.authWrites).toEqual([]);
  });

  it("an admin session that hasn't passed the second step (aal1) is refused, whatever REQUIRE_ADMIN_MFA says", async () => {
    state.aal = "aal1";
    const response = await disable();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mfa_required" });
    expect(state.authWrites).toEqual([]);
  });

  it("nobody disables their own sign-in; a support membership, a deactivated member or a stranger is refused", async () => {
    expect((await disable(ADMIN)).status).toBe(409);
    state.memberships.push(ordinary(OTHER, ORG, { support: true, role: "admin" }));
    expect((await disable(OTHER)).status).toBe(403);
    state.memberships = state.memberships.filter((m) => m.user_id !== OTHER);
    state.memberships.push(ordinary(OTHER, ORG, { active: false }));
    expect((await disable(OTHER)).status).toBe(409);
    expect((await disable("66666666-6666-4666-8666-666666666666")).status).toBe(404);
    expect(state.authWrites).toEqual([]);
    expect(state.audited).toEqual([]);
  });

  it("a login with another company (active or not) is refused: it isn't this company's to stop", async () => {
    state.memberships.push(ordinary(USER, ELSEWHERE, { active: false }));
    const response = await disable();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("also uses Tolra with another company");
    expect(state.authWrites).toEqual([]);
    expect(state.audited).toEqual([]);
    // Enabling is refused the same way, even for a marked ban.
    state.users[USER] = { banned_until: FOREVER, app_metadata: { deactivation_ban: true } };
    expect((await enable()).status).toBe(409);
    expect(ban(USER)).toEqual({ banned: true, marked: true });
  });

  it("the last admin who can sign in can't be disabled", async () => {
    state.memberships = [ordinary(ADMIN, ORG, { role: "office", secondary_role: "admin" }), ordinary(USER, ORG, { role: "admin" })];
    // ADMIN still holds admin (second role): USER isn't the last.
    expect((await disable()).status).toBe(200);
    state.users = {};
    state.memberships = [ordinary(ADMIN, ORG, { role: "admin", active: false }), ordinary(USER, ORG, { role: "admin" })];
    const response = await disable();
    expect(response.status).toBe(409);
    expect(ban(USER).banned).toBe(false);
  });
});

describe("disable and enable", () => {
  it("disable: the app's MARKED ban, the membership untouched, audited; enable lifts it, audited", async () => {
    const off = await disable();
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ ok: true, changed: true, sign_in: "off" });
    expect(ban(USER)).toEqual({ banned: true, marked: true });
    expect(state.membershipWrites).toBe(0);
    expect(state.memberships.find((m) => m.user_id === USER)?.active).toBe(true);
    expect(state.audited).toEqual([{ action: "UPDATE_USER_ACCESS", entityId: USER, newData: { sign_in: "disabled" }, oldData: { sign_in: "enabled" } }]);

    // Again: nothing to do, nothing recorded.
    expect(await (await disable()).json()).toEqual({ ok: true, changed: false, sign_in: "off" });
    expect(state.audited).toHaveLength(1);

    const on = await enable();
    expect(await on.json()).toEqual({ ok: true, changed: true, sign_in: "on" });
    expect(ban(USER)).toEqual({ banned: false, marked: false });
    expect(state.audited[1]).toEqual({ action: "UPDATE_USER_ACCESS", entityId: USER, newData: { sign_in: "enabled" }, oldData: { sign_in: "disabled" } });
  });

  it("a login already banned by the platform owner (unmarked) is not touched by Disable", async () => {
    platformBan(USER);
    const response = await disable();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("already disabled by Tolra support");
    expect(state.authWrites).toEqual([]);
    expect(ban(USER)).toEqual({ banned: true, marked: false });
    expect(state.audited).toEqual([]);
  });

  it("a platform-owner ban survives Enable sign-in: refused, still banned, still unmarked", async () => {
    platformBan(USER);
    const response = await enable();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("only Tolra support can turn it back on");
    expect(state.authWrites).toEqual([]);
    expect(ban(USER)).toEqual({ banned: true, marked: false });
  });

  it("the Auth call reports an error but the ban landed: the read-back decides (done); it didn't land: nothing changed", async () => {
    state.banError = { status: 502 };
    state.banErrorAlsoApplies = true;
    expect((await disable()).status).toBe(200);
    expect(ban(USER)).toEqual({ banned: true, marked: true });
    state.users = {};
    state.audited = [];
    state.banErrorAlsoApplies = false;
    const failed = await disable();
    expect(failed.status).toBe(500);
    expect((await failed.json()).error).toContain("Nothing was changed");
    expect(state.audited).toEqual([]);
  });
});

describe("the list the page shows", () => {
  it("only active, ordinary members whose login belongs to this company alone, with their sign-in state; never the caller", async () => {
    const shared = "77777777-7777-4777-8777-777777777777";
    const support = "88888888-8888-4888-8888-888888888888";
    const platformBanned = "99999999-9999-4999-8999-999999999999";
    const gone = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    state.memberships.push(
      ordinary(shared, ORG), ordinary(shared, ELSEWHERE),
      ordinary(support, ORG, { support: true }),
      ordinary(platformBanned, ORG),
      ordinary(gone, ORG, { active: false }),
    );
    state.users[USER] = { banned_until: FOREVER, app_metadata: { deactivation_ban: true } };
    platformBan(platformBanned);
    const response = await GET(new Request("http://localhost/api/admin/users/sign-in"));
    expect(await response.json()).toEqual({ users: [{ user_id: USER, sign_in: "off" }, { user_id: platformBanned, sign_in: "off_platform" }], protected: [] });
  });

  it("093: a platform owner and a login with a support row elsewhere are listed as protected, never as switchable", async () => {
    const owner = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const former = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    state.memberships.push(ordinary(owner, ORG), ordinary(former, ORG), ordinary(former, ELSEWHERE, { support: true }));
    state.owners.add(owner);
    const body = await (await GET(new Request("http://localhost/api/admin/users/sign-in"))).json();
    expect(body).toEqual({ users: [{ user_id: USER, sign_in: "on" }], protected: [{ user_id: owner, state: "protected" }, { user_id: former, state: "protected" }] });
  });

  it("093: when the check can't be answered every row is check_unavailable and none is switchable (fail closed)", async () => {
    state.rpcMissing = true;
    const body = await (await GET(new Request("http://localhost/api/admin/users/sign-in"))).json();
    expect(body).toEqual({ users: [], protected: [{ user_id: USER, state: "check_unavailable" }] });
  });
});

describe("093: never the platform owner's login, nor one with a support membership; fail closed", () => {
  it("a platform owner who is an ordinary member of this company only: Disable and Enable refused (403), zero Auth writes", async () => {
    state.owners.add(USER);
    for (const response of [await disable(), await enable()]) {
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("This is a Tolra support login, so it can't be changed here.");
    }
    // Even a ban this company's own marker names is not lifted for them.
    state.users[USER] = { banned_until: FOREVER, app_metadata: { deactivation_ban: true, deactivation_ban_org: ORG } };
    expect((await enable()).status).toBe(403);
    expect(state.authWrites).toHaveLength(0);
    expect(state.audited).toEqual([]);
  });

  it("an ordinary member here with a (leftover) support row in another company: refused (403), zero Auth writes", async () => {
    state.memberships.push(ordinary(USER, ELSEWHERE, { support: true, role: "admin" }));
    const response = await disable();
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("This is a Tolra support login, so it can't be changed here.");
    expect(state.authWrites).toHaveLength(0);
  });

  it("admin_login_is_protected can't be asked (093 not applied): Disable and Enable refused (500, the 093 message), zero Auth writes", async () => {
    state.rpcMissing = true;
    state.users[OTHER] = { banned_until: FOREVER, app_metadata: { deactivation_ban: true, deactivation_ban_org: ORG } };
    state.memberships.push(ordinary(OTHER, ORG));
    for (const response of [await disable(), await enable(OTHER)]) {
      expect(response.status).toBe(500);
      expect((await response.json()).error).toContain("the database needs its 093 update");
    }
    expect(state.authWrites).toHaveLength(0);
  });

  it("an ordinary member of this company alone is still disabled (the marked ban) and enabled again", async () => {
    expect((await disable()).status).toBe(200);
    expect(ban(USER)).toEqual({ banned: true, marked: true });
    expect((await enable()).status).toBe(200);
    expect(ban(USER)).toEqual({ banned: false, marked: false });
    expect(state.authWrites).toHaveLength(2);
  });
});
