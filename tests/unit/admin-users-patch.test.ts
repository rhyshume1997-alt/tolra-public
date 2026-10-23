/**
 * PATCH /api/admin/users with several edits at once (name + username + role), failure injected at each write.
 * Every input is validated before the first write; a write that fails after an earlier one succeeded names what was applied.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const USER = "22222222-2222-4222-8222-222222222222";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const ORG = "org-a";

const state = {
  writes: [] as string[],
  audited: [] as string[],
  owns: true,
  taken: false,
  accessError: null as { code?: string; message: string; hint?: string } | null,
  usernameError: null as { code?: string } | null,
  nameError: null as { code?: string } | null,
  nameRows: 1,
  banError: null as { status: number } | null,
  unbanError: false,
  // The membership as the database holds it. set_member_access really applies to it, so a write can commit and still report an error.
  member: { role: "office", secondary_role: "workshop" as string | null, active: true, hidden_sections: ["quotes"] as string[], support: false },
  /** The membership rollback commits on the server but its response is lost (an error is returned). */
  restoreErrorAlsoApplies: false,
  /** Membership reads fail once the edit and a rollback have been attempted (read-back). */
  readBackFails: false,
  rpcCalls: [] as Array<Record<string, unknown>>,
  restoreError: null as { code?: string; message: string } | null,
  // The user's real Auth state, as the server holds it. A call may change it and still report an error (network drop after success).
  auth: { banned: false, appBan: false },
  authErrorAlsoApplies: false,
  /** Auth reads fail once the ban call has been made (the network is down by then). */
  banReadFails: false,
  unbanErrorAlsoApplies: false,
};

const chain = (result: () => unknown) => {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "eq", "neq", "is", "ilike", "limit"]) c[m] = () => c;
  c.maybeSingle = async () => result();
  c.then = (resolve: (v: unknown) => unknown) => resolve(result());
  return c;
};

const admin = {
  auth: {
    admin: {
      updateUserById: async (_id: string, attrs: { ban_duration?: string; app_metadata?: Record<string, unknown> }) => {
        state.writes.push("admin:ban");
        const error = state.banError;
        if (!error || state.authErrorAlsoApplies) {
          if (attrs.ban_duration === "none") state.auth = { banned: false, appBan: false };
          else state.auth = { banned: true, appBan: attrs.app_metadata?.deactivation_ban === true };
        }
        return { error };
      },
    },
  },
  from(table: string) {
    if (table === "organization_members") {
      return chain(() => (state.readBackFails && state.rpcCalls.length >= 2
        ? { data: null, error: { code: "XX000" } }
        : { data: { ...state.member, hidden_sections: [...state.member.hidden_sections] }, error: null }));
    }
    return {
      select: (columns: string) => chain(() => ({ data: columns === "id" ? (state.taken ? { id: "someone-else" } : null) : { full_name: "Old Name" }, error: null })),
      update: (row: Record<string, unknown>) => ({
        eq: async () => {
          state.writes.push(`admin:${Object.keys(row)[0]}`);
          return { error: state.usernameError };
        },
      }),
    };
  },
};

const supabase = {
  rpc: async (fn: string, args: Record<string, unknown> = {}) => {
    state.writes.push(`rpc:${fn}`);
    state.rpcCalls.push(args);
    // The first call is the edit; any later call is a restore. A call that returns an error did not commit, unless it is marked as committed.
    const first = state.rpcCalls.length === 1;
    const error = first ? state.accessError : state.restoreError;
    if (!error || (!first && state.restoreErrorAlsoApplies)) {
      const m = state.member;
      if (args.p_role != null) m.role = args.p_role as string;
      if (args.p_active != null) m.active = args.p_active as boolean;
      if (args.p_clear_secondary === true) m.secondary_role = null;
      else if (args.p_secondary_role != null) m.secondary_role = args.p_secondary_role as string;
      if (args.p_hidden_sections != null) m.hidden_sections = [...(args.p_hidden_sections as string[])];
    }
    return { error };
  },
  from: () => ({
    update: () => ({
      eq: () => ({
        select: async () => {
          state.writes.push("caller:full_name");
          return { data: state.nameError ? null : Array.from({ length: state.nameRows }, () => ({ id: USER })), error: state.nameError };
        },
      }),
    }),
  }),
};

vi.mock("@/lib/server/admin-users", () => ({
  guard: async () => ({ auth: { user: { id: ADMIN }, profile: { organization_id: ORG }, supabase }, admin }),
  audit: async (_ctx: unknown, action: string) => { state.audited.push(action); },
  ownsIdentity: async () => state.owns,
  loginIsProtected: async () => false,
  banState: async () => (state.banReadFails && state.writes.includes("admin:ban") ? null : { ...state.auth, banOrg: state.auth.appBan ? ORG : null }),
  // Company scoping of the marker is covered by admin-users-ban-scope.test.ts; here every marked ban is this company's.
  companyMayLift: async (_admin: unknown, ban: { appBan: boolean }) => ban.appBan,
  deactivationBanMarker: (orgId: string | null) => ({ deactivation_ban: true, deactivation_ban_org: orgId }),
  liftDeactivationBan: async () => {
    if (!state.auth.banned || !state.auth.appBan) return { lifted: false, stillBanned: state.auth.banned };
    state.writes.push("admin:unban");
    if (state.unbanError && !state.unbanErrorAlsoApplies) return { lifted: false, stillBanned: true, error: true };
    state.auth = { banned: false, appBan: false };
    return state.unbanError ? { lifted: false, stillBanned: true, error: true } : { lifted: true, stillBanned: false };
  },
}));

const { PATCH } = await import("@/app/api/admin/users/route");

const call = (body: Record<string, unknown>) =>
  PATCH(new Request("http://localhost/api/admin/users", { method: "PATCH", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify({ user_id: USER, ...body }) }));
const all = { full_name: "Nia O'Brien", username: "nia.ob", role: "workshop" };

beforeEach(() => {
  Object.assign(state, { writes: [], audited: [], owns: true, taken: false, accessError: null, usernameError: null, nameError: null, nameRows: 1, banError: null, unbanError: false, member: { role: "office", secondary_role: "workshop", active: true, hidden_sections: ["quotes"], support: false }, restoreErrorAlsoApplies: false, readBackFails: false, rpcCalls: [], restoreError: null, auth: { banned: false, appBan: false }, authErrorAlsoApplies: false, banReadFails: false, unbanErrorAlsoApplies: false });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("validate everything before any write", () => {
  it("a bad display name alongside a good username and role writes nothing", async () => {
    const response = await call({ ...all, full_name: "x@y.test" });
    expect(response.status).toBe(400);
    expect(state.writes).toEqual([]);
  });
  it("a bad username alongside a good name writes nothing", async () => {
    const response = await call({ ...all, username: "Not Valid!" });
    expect(response.status).toBe(400);
    expect(state.writes).toEqual([]);
  });
  it("a username someone else owns is refused before the role or name is touched", async () => {
    state.taken = true;
    const response = await call(all);
    expect(response.status).toBe(409);
    expect(state.writes).toEqual([]);
  });
  it("a login shared with another company is refused before any write, for the name and for the username", async () => {
    state.owns = false;
    for (const body of [all, { full_name: "Nia" }, { username: "nia.ob", role: "viewer" }]) {
      const response = await call(body);
      expect(response.status).toBe(409);
    }
    expect(state.writes).toEqual([]);
  });
});

describe("combined name + username + role", () => {
  it("applies access, then username, then name, and reports all three", async () => {
    const response = await call(all);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ ok: true, applied: ["access", "username", "name"], user: { id: USER, username: "nia.ob", full_name: "Nia O'Brien" } });
    expect(state.writes).toEqual(["rpc:set_member_access", "admin:username", "caller:full_name"]);
  });

  it("access fails: nothing else is written and nothing is reported applied", async () => {
    state.accessError = { code: "23514", message: "At least one active admin is required." };
    const response = await call(all);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("active admin");
    expect(state.writes).toEqual(["rpc:set_member_access"]);
  });

  it("username fails (taken in a race): access is reported applied, the name is never attempted", async () => {
    state.usernameError = { code: "23505" };
    const response = await call(all);
    const body = await response.json();
    expect(response.status).toBe(409);
    expect(body).toMatchObject({ ok: false, failed: "username", applied: ["access"] });
    expect(state.writes).toEqual(["rpc:set_member_access", "admin:username"]);
  });

  it("name fails: access and username are reported applied", async () => {
    state.nameError = { code: "42501" };
    const response = await call(all);
    const body = await response.json();
    expect(response.status).toBe(403);
    expect(body).toMatchObject({ ok: false, failed: "name", applied: ["access", "username"] });
    expect(state.audited).toEqual(["UPDATE_USER_ACCESS", "UPDATE_USERNAME"]);
  });

  it("name matches no row (RLS): reported as failed, with what was applied before", async () => {
    state.nameRows = 0;
    const body = await (await call({ full_name: "Nia", role: "viewer" })).json();
    expect(body).toMatchObject({ ok: false, failed: "name", applied: ["access"] });
  });

  it("name alone failing reports an empty applied list", async () => {
    state.nameError = { code: "XX000" };
    const response = await call({ full_name: "Nia" });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ failed: "name", applied: [] });
  });
});

describe("ban/unban fails after the access change was applied", () => {
  const full = { role: "workshop", secondary_role: null, hidden_sections: ["jobs"] };

  it("reactivation: the unban fails, the previous (inactive) membership is restored in full", async () => {
    state.member.active = false;
    state.unbanError = true;
    state.auth = { banned: true, appBan: true };
    const body = await (await call({ ...full, active: true })).json();
    expect(body).toMatchObject({ ok: false, failed: "access", applied: [] });
    expect(state.rpcCalls[1]).toMatchObject({ p_role: "office", p_active: false, p_secondary_role: "workshop", p_hidden_sections: ["quotes"] });
  });

  it("deactivation never touches Auth: no ban, whatever the login holds elsewhere (066 keeps them one company)", async () => {
    const response = await call({ ...full, active: false });
    expect(response.status).toBe(200);
    expect(state.writes).toEqual(["rpc:set_member_access"]);
    expect(state.auth).toEqual({ banned: false, appBan: false });
    expect(state.audited).toEqual(["DEACTIVATE_USER"]);
  });

  it("Reactivate lifts only the app's own marked ban: a platform-owner ban survives, and the page is told the login is disabled", async () => {
    state.member.active = false;
    state.auth = { banned: true, appBan: false };
    const response = await call({ active: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, login_disabled: true });
    expect(state.auth).toEqual({ banned: true, appBan: false });
    expect(state.writes).not.toContain("admin:unban");
    expect(state.writes).not.toContain("admin:ban");
  });

  it("the restore fails too: access is reported as UNCERTAIN only (never applied and failed together); username/name are not attempted", async () => {
    state.member.active = false;
    state.auth = { banned: true, appBan: true };
    state.unbanError = true;
    state.restoreError = { code: "XX000", message: "down" };
    const response = await call({ ...all, active: true });
    const body = await response.json();
    expect(response.status).toBe(500);
    expect(body).toMatchObject({ ok: false, failed: null, applied: [], uncertain: ["access"] });
    expect(body.error).toMatch(/may not have been saved/i);
    expect(state.writes).not.toContain("admin:username");
    expect(state.writes).not.toContain("caller:full_name");
  });

  it("a step is never in two of applied / failed / uncertain, whatever fails", async () => {
    const scenarios: Array<Partial<typeof state>> = [
      { unbanError: true },
      { unbanError: true, restoreError: { message: "down" } },
      { unbanError: true, unbanErrorAlsoApplies: true },
      { unbanError: true, unbanErrorAlsoApplies: true, restoreError: { message: "down" } },
      { unbanError: true, readBackFails: true },
      { nameError: { code: "XX000" } },
      { usernameError: { code: "XX000" } },
    ];
    for (const scenario of scenarios) {
      Object.assign(state, { member: { role: "office", secondary_role: "workshop", active: false, hidden_sections: ["quotes"], support: false }, restoreErrorAlsoApplies: false, readBackFails: false, writes: [], rpcCalls: [], restoreError: null, unbanError: false, unbanErrorAlsoApplies: false, nameError: null, usernameError: null, auth: { banned: true, appBan: true } }, scenario);
      const body = await (await call({ ...all, active: true })).json();
      const lists = [body.applied ?? [], body.failed ? [body.failed] : [], body.uncertain ?? []].flat();
      expect(new Set(lists).size, JSON.stringify([scenario, body])).toBe(lists.length);
    }
  });
});

describe("an Auth call that errors may still have succeeded on the server", () => {
  it("unban applied server-side but reported as an error: membership restored to inactive AND the deactivation ban put back", async () => {
    state.member.active = false;
    state.unbanError = true;
    state.unbanErrorAlsoApplies = true;
    state.auth = { banned: true, appBan: true };
    const body = await (await call({ active: true })).json();
    expect(state.rpcCalls[1]).toMatchObject({ p_active: false });
    expect(state.auth).toEqual({ banned: true, appBan: true });
    expect(body).toMatchObject({ ok: false, failed: "access", applied: [], uncertain: [] });
  });

  it("unban applied server-side, error reported, and the rollback fails: Auth matches the new active access, save complete", async () => {
    state.member.active = false;
    state.unbanError = true;
    state.unbanErrorAlsoApplies = true;
    state.restoreError = { message: "down" };
    state.auth = { banned: true, appBan: true };
    const response = await call({ active: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, applied: ["access"] });
    expect(state.auth.banned).toBe(false);
  });
});

describe("never infer the membership from a response: read it back, then make Auth match it", () => {
  /** The invariant that must hold whenever the stored membership and Auth are both known: active <=> not banned (our own ban). */
  const agree = () => state.member.active === !state.auth.banned;

  it("(a) reactivation: the unban errors, the rollback commits but returns an error -> the inactive membership keeps its ban", async () => {
    state.member.active = false;
    state.unbanError = true;
    state.unbanErrorAlsoApplies = true; // the unban landed
    state.auth = { banned: true, appBan: true };
    state.restoreError = { message: "response lost" };
    state.restoreErrorAlsoApplies = true;
    const body = await (await call({ active: true })).json();
    expect(state.member.active).toBe(false);
    expect(state.auth).toEqual({ banned: true, appBan: true });
    expect(body).toMatchObject({ ok: false, failed: "access", applied: [] });
  });

  it("(b) the read-back of the membership fails: access is uncertain and Auth is not touched again", async () => {
    state.member.active = false;
    state.auth = { banned: true, appBan: true };
    state.unbanError = true;
    state.unbanErrorAlsoApplies = true; // Auth is unbanned now
    state.readBackFails = true;
    const body = await (await call({ active: true })).json();
    expect(body).toMatchObject({ ok: false, failed: null, applied: [], uncertain: ["access"] });
    expect(body.error).toMatch(/reload to check/i);
    expect(state.auth).toEqual({ banned: false, appBan: false });
    expect(state.writes.filter((w) => w === "admin:unban")).toHaveLength(1);
    expect(state.writes).not.toContain("admin:ban");
  });

  it("(b) a step that never reached Auth, read-back fails: uncertain, and no Auth write at all", async () => {
    state.readBackFails = true;
    state.restoreError = { message: "down" };
    state.member.active = false;
    state.auth = { banned: true, appBan: true };
    state.unbanError = true;
    const body = await (await call({ active: true })).json();
    expect(body).toMatchObject({ ok: false, failed: null, applied: [], uncertain: ["access"] });
    expect(state.writes).not.toContain("admin:ban");
  });

  it("never reports success with membership and Auth out of step, whatever commits and whatever errors", async () => {
    for (const unbanApplies of [false, true]) for (const restoreErr of [false, true]) for (const restoreCommits of [false, true]) for (const readBack of [false, true]) {
      Object.assign(state, {
        writes: [], rpcCalls: [], auth: { banned: true, appBan: true }, member: { role: "office", secondary_role: "workshop", active: false, hidden_sections: ["quotes"], support: false },
        unbanError: true, unbanErrorAlsoApplies: unbanApplies, restoreError: restoreErr ? { message: "x" } : null, restoreErrorAlsoApplies: restoreCommits, readBackFails: readBack,
      });
      const body = await (await call({ active: true })).json();
      const label = JSON.stringify({ unbanApplies, restoreErr, restoreCommits, readBack, body, member: state.member.active, auth: state.auth });
      if (body.ok === true) expect(agree(), label).toBe(true);
      const lists = [body.applied ?? [], body.failed ? [body.failed] : [], body.uncertain ?? []].flat();
      expect(new Set(lists).size, label).toBe(lists.length);
    }
  });
});

describe("Deactivate keeps a login's last company (066): the database's refusal in the per-company wording", () => {
  it("switching off someone's only company: 409 with the friendly sentence, nothing else written, no ban", async () => {
    state.accessError = { code: "23514", message: "This login must keep access to at least one company", hint: "last_company" };
    const response = await call({ active: false });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "They must keep access to at least one company, so this company can't be removed. If they're leaving, use Disable sign-in instead: it stops them signing in to Tolra." });
    expect(state.writes).toEqual(["rpc:set_member_access"]);
    expect(state.auth).toEqual({ banned: false, appBan: false });
    expect(state.audited).toEqual([]);
  });

  it.each([["40P01", "deadlock detected"], ["40001", "could not serialize access"]])("a clash with another change (%s) asks to reload and retry", async (code, message) => {
    state.accessError = { code, message };
    const response = await call({ active: false });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("Someone changed access to this company at the same time. Reload and try again.");
    expect(state.writes).toEqual(["rpc:set_member_access"]);
  });

  it("other refusals keep their existing answers", async () => {
    state.accessError = { code: "23514", message: "You cannot deactivate your own access" };
    expect((await (await call({ active: false })).json()).error).toBe("You cannot deactivate your own access");
    state.rpcCalls = [];
    state.accessError = { code: "42501", message: "Only admins can change member access" };
    expect((await call({ active: false })).status).toBe(403);
  });
});
