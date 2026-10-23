/**
 * POST /api/admin/users when the username (or e-mail) already belongs to a login in another company: the login gets a membership in
 * the CURRENT company with the chosen role instead of "That username is already taken". Their password, e-mail, username and name are
 * never touched, nothing about the other company is returned, and the existing guards (admin only, already-a-member) still apply.
 * An existing login is added only when it is the caller, has no company, or the caller administers every company it is in: by default
 * the caller here administers both JNR and Marpet (as John does); a Marpet-only admin is refused with 403.
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG = "org-marpet";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const JOHN = "33333333-3333-4333-8333-333333333333";

const state = {
  guardDenied: false,
  /** profiles by id; a username is unique */
  profiles: [{ id: JOHN, email: "john@jnr.example", username: "john", full_name: "John Smith" }] as Array<{ id: string; email: string; username: string | null; full_name: string | null }>,
  /** membership of the login in the CURRENT company: undefined = none */
  here: undefined as { active: boolean } | undefined,
  /** John's memberships elsewhere (must never reach the response) */
  elsewhere: ["org-jnr"],
  calls: [] as Array<{ fn: string; args: unknown }>,
  writes: [] as string[],
  audits: [] as Array<{ action: string; entity: string; data: Record<string, unknown> }>,
  createdUsers: 0,
  enrolled: false as boolean | null,
  /** sign-in ban of the existing login (null = unreadable) */
  ban: { banned: false, appBan: false } as { banned: boolean; appBan: boolean } | null,
  lifts: 0,
  /** companies (besides this one) where the caller is an active admin; default: JNR too, as an admin of both */
  callerAdminOf: ["org-jnr"] as string[],
  /** the memberships could not be read */
  scopeUnreadable: false,
  /** 093: the login has a support membership (existingLoginScope) / admin_login_is_protected's answer (null: unanswerable). */
  loginSupport: false,
  protectedLogin: false as boolean | null,
};

const chain = (result: () => unknown, filters: Record<string, unknown> = {}) => {
  const c: Record<string, unknown> = {};
  for (const m of ["select", "neq", "is", "limit"]) c[m] = () => c;
  c.eq = (column: string, value: unknown) => chain(result, { ...filters, [column]: value });
  c.ilike = (column: string, value: unknown) => chain(result, { ...filters, [column]: String(value).toLowerCase() });
  c.maybeSingle = async () => result.call(filters);
  c.then = (resolve: (v: unknown) => unknown) => resolve(result.call(filters));
  return c;
};
const lookup = (table: string) =>
  function (this: Record<string, unknown>) {
    const f = this ?? {};
    if (table === "user_profiles") {
      const row = state.profiles.find((p) => (f.username !== undefined ? p.username === f.username : f.email !== undefined ? p.email === f.email : p.id === f.id));
      return { data: row ?? null, error: null };
    }
    if (table === "organization_members") {
      if (f.organization_id === ORG) return { data: state.here ? { ...state.here } : null, error: null };
      return { data: state.elsewhere.map((organization_id) => ({ organization_id })), error: null };
    }
    if (table === "organizations") return { data: { name: "Marpet Fabrications" }, error: null };
    return { data: null, error: null };
  };

const admin = {
  auth: {
    admin: {
      createUser: async () => { state.createdUsers += 1; state.writes.push("auth:createUser"); return { data: { user: { id: "new-user" } }, error: null }; },
      deleteUser: async () => ({ error: null }),
      getUserById: async () => ({ data: { user: { banned_until: null } }, error: null }),
      updateUserById: async () => { state.writes.push("auth:updateUser"); return { error: null }; },
      listUsers: async () => ({ data: { users: [] }, error: null }),
      mfa: { listFactors: async () => ({ data: { factors: [] }, error: null }), deleteFactor: async () => { state.writes.push("auth:deleteFactor"); return { error: null }; } },
    },
  },
  rpc: async (fn: string, args: unknown) => { state.calls.push({ fn, args }); return { data: "member", error: null }; },
  from(table: string) {
    return {
      select: () => chain(lookup(table)),
      update: (row: Record<string, unknown>) => {
        state.writes.push(`${table}:update:${Object.keys(row).join(",")}`);
        return chain(() => ({ error: null }));
      },
    };
  },
};

const supabase = { rpc: async (fn: string, args: unknown) => { state.calls.push({ fn, args }); return { error: null }; } };

vi.mock("@/lib/server/admin-users", () => ({
  guard: async () => (state.guardDenied ? NextResponse.json({ error: "Forbidden" }, { status: 403 }) : { auth: { user: { id: ADMIN }, profile: { organization_id: ORG }, supabase }, admin }),
  audit: async (_ctx: unknown, action: string, entity: string, data: Record<string, unknown>) => { state.audits.push({ action, entity, data }); },
  banState: async () => state.ban,
  enrolmentFlag: async () => true,
  existingLoginScope: async () => (state.scopeUnreadable ? null : { loginCompanies: [...(state.here ? [ORG] : []), ...state.elsewhere], loginSupport: state.loginSupport, callerAdminCompanies: [ORG, ...state.callerAdminOf] }),
  hasVerifiedTotp: async () => state.enrolled,
  liftDeactivationBan: async () => { state.lifts += 1; return { lifted: true, stillBanned: false }; },
  loginIsProtected: async () => state.protectedLogin,
  ownsIdentity: async () => true,
  requireAdminEnrolment: async (_a: unknown, org: string, user: string) => { state.writes.push(`enrol:${org}:${user}`); return true; },
}));
vi.mock("@/lib/server/password-setup", () => ({ setMustChange: async () => true }));

const { POST } = await import("@/app/api/admin/users/route");

const post = (body: Record<string, unknown>) =>
  POST(new Request("http://localhost/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) }));

beforeEach(() => {
  Object.assign(state, {
    guardDenied: false,
    profiles: [{ id: JOHN, email: "john@jnr.example", username: "john", full_name: "John Smith" }],
    here: undefined, elsewhere: ["org-jnr"], calls: [], writes: [], audits: [], createdUsers: 0, enrolled: false, ban: { banned: false, appBan: false }, lifts: 0,
    callerAdminOf: ["org-jnr"], scopeUnreadable: false, loginSupport: false, protectedLogin: false,
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("existing login named by username", () => {
  it("adds a membership in this company with the chosen role, from the username alone (no e-mail typed)", async () => {
    const response = await post({ username: "john", role: "office", password: "ignored-Password-1!" });
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.existing_login).toBe(true);
    expect(state.createdUsers).toBe(0);
    // the same add_member path as the e-mail case, with the e-mail resolved on the server
    expect(state.calls.filter((c) => c.fn === "add_member")).toEqual([{ fn: "add_member", args: { p_org: ORG, p_email: "john@jnr.example", p_role: "office" } }]);
    expect(body.message).toBe("john already has a Tolra login; added to Marpet Fabrications as office. They sign in with their existing password.");
  });

  it("never changes the password, e-mail, display name or two-step factors, and ignores a typed password", async () => {
    await post({ username: "john", role: "office", password: "ignored-Password-1!", must_change_password: true });
    expect(state.writes.filter((w) => w.startsWith("auth:"))).toEqual([]);
    expect(state.writes.some((w) => /email|password|must_change/.test(w))).toBe(false);
    // the only profile write is the (no-op) username set to its own current value
    expect(state.writes.filter((w) => w.startsWith("user_profiles"))).toEqual(["user_profiles:update:username"]);
  });

  it("does not leak the login's e-mail or other companies in the response", async () => {
    const text = JSON.stringify(await (await post({ username: "john", role: "viewer" })).json());
    expect(text).not.toContain("john@jnr.example");
    expect(text).not.toContain("org-jnr");
    expect(text).not.toMatch(/JNR/i);
  });

  it("returns only what the admin typed: never the login's own name (set in another company), in the body or the message", async () => {
    const body = await (await post({ username: "john", role: "viewer" })).json();
    const text = JSON.stringify(body);
    expect(text).not.toContain("John Smith");
    expect(text).not.toMatch(/smith/i);
    expect(body.user).toEqual({ id: JOHN, role: "viewer", active: true });
    expect(body.message).toBe("john already has a Tolra login; added to Marpet Fabrications as viewer. They sign in with their existing password.");
    // the audit trail of this company does not receive the other company's name or e-mail either
    expect(JSON.stringify(state.audits)).not.toMatch(/John Smith|john@jnr/);
  });

  it("with a name typed, the typed name is echoed back (not the stored one); the message still uses the typed username", async () => {
    const body = await (await post({ username: "john", full_name: "Johnny", role: "viewer" })).json();
    expect(body.user.full_name).toBe("Johnny");
    expect(body.message).toMatch(/^john already has/);
    expect(JSON.stringify(body)).not.toContain("John Smith");
  });

  it("an e-mail-only add (no username) names only the typed name or e-mail, and returns no stored name", async () => {
    state.profiles = [{ id: JOHN, email: "john@jnr.example", username: null, full_name: "John Smith" }];
    const body = await (await post({ email: "john@jnr.example", role: "viewer" })).json();
    expect(body.message).toMatch(/^john@jnr\.example already has/);
    expect(JSON.stringify(body)).not.toContain("John Smith");
  });
});

describe("disabled (banned) existing login", () => {
  const added = () => state.calls.filter((c) => c.fn === "add_member");

  it("a login banned by the platform or another company is refused with 409: add_member not called, no membership, no ban lifted", async () => {
    state.ban = { banned: true, appBan: false };
    const response = await post({ username: "john", role: "office" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/disabled/);
    expect(added()).toEqual([]);
    expect(state.calls).toEqual([]);
    expect(state.lifts).toBe(0);
    expect(state.writes).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("an app deactivation ban (set when another company deactivated their last membership) is not lifted by an add from a company they never belonged to", async () => {
    state.ban = { banned: true, appBan: true };
    const response = await post({ username: "john", role: "office" });
    expect(response.status).toBe(409);
    expect(added()).toEqual([]);
    expect(state.lifts).toBe(0);
    expect(state.writes).toEqual([]);
  });

  it("the same refusal applies when the login is found by e-mail", async () => {
    state.ban = { banned: true, appBan: false };
    const response = await post({ email: "john@jnr.example", full_name: "J", role: "office" });
    expect(response.status).toBe(409);
    expect(added()).toEqual([]);
  });

  it("this company's own former member under a platform ban (not ours) is refused too", async () => {
    state.here = { active: false };
    state.ban = { banned: true, appBan: false };
    const response = await post({ username: "john", role: "office" });
    expect(response.status).toBe(409);
    expect(added()).toEqual([]);
    expect(state.lifts).toBe(0);
  });

  it("an unreadable ban state is refused (nothing written)", async () => {
    state.ban = null;
    const response = await post({ username: "john", role: "office" });
    expect(response.status).toBe(500);
    expect(added()).toEqual([]);
    expect(state.writes).toEqual([]);
  });

  it("reactivating this company's OWN former member whose ban is the app's deactivation ban still works, and lifts it", async () => {
    state.here = { active: false };
    state.ban = { banned: true, appBan: true };
    const response = await post({ username: "john", role: "office" });
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(added()).toHaveLength(1);
    expect(state.lifts).toBe(1);
    expect(body.login_disabled).toBe(false);
  });

  it("reactivating an own former member who is not banned works, without touching any ban", async () => {
    state.here = { active: false };
    const response = await post({ username: "john", role: "office" });
    expect(response.status).toBe(201);
    expect(added()).toHaveLength(1);
    expect(state.writes.filter((w) => w.startsWith("auth:"))).toEqual([]);
  });

  it("a login that is not banned is added as before, with login_disabled false", async () => {
    const body = await (await post({ username: "john", role: "office" })).json();
    expect(body.login_disabled).toBe(false);
    expect(added()).toHaveLength(1);
    expect(state.lifts).toBe(0);
  });
});

describe("existing login named by username (more)", () => {

  it("an admin e-mail typed alongside the right username works, and is returned as typed", async () => {
    const body = await (await post({ username: "john", email: "John@JNR.example", full_name: "J", role: "workshop" })).json();
    expect(body.existing_login).toBe(true);
    expect(body.user.email).toBe("john@jnr.example");
  });

  it("a username that belongs to a different login than the typed e-mail is refused as before", async () => {
    const response = await post({ username: "john", email: "someone.else@example.com", full_name: "X", role: "workshop", password: "Str0ng-Passw0rd!" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("That username is already taken");
    expect(state.calls).toEqual([]);
    expect(state.createdUsers).toBe(0);
  });

  it("adding an existing login as admin goes through the same enrolment path (migration 065), no bypass", async () => {
    const body = await (await post({ username: "john", role: "admin" })).json();
    expect(state.writes).toContain(`enrol:${ORG}:${JOHN}`);
    expect(body.admin_mfa_onboarding).toBe(true);
    expect(state.audits[0].action).toBe("CREATE_USER");
    expect(state.audits[0].data).toMatchObject({ role: "admin", existing_login: true, username: "john" });
  });

  it("an existing login that already enrolled in two-step sign-in is not asked again", async () => {
    state.enrolled = true;
    const body = await (await post({ username: "john", role: "admin" })).json();
    expect(state.writes.some((w) => w.startsWith("enrol:"))).toBe(false);
    expect(body.admin_mfa_onboarding).toBe(false);
  });

  it("is audited like any other add", async () => {
    await post({ username: "john", role: "office" });
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({ action: "CREATE_USER", entity: JOHN });
  });
});

describe("unchanged behaviour", () => {
  it("an active member of this company is refused with 409 already a member", async () => {
    state.here = { active: true };
    const response = await post({ username: "john", role: "office" });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toMatch(/already a member/);
    expect(state.calls).toEqual([]);
  });

  it("a non-admin (or an admin without the second step) is refused by the guard before anything is read or written", async () => {
    state.guardDenied = true;
    const response = await post({ username: "john", role: "office" });
    expect(response.status).toBe(403);
    expect(state.calls).toEqual([]);
    expect(state.writes).toEqual([]);
  });

  it("a brand-new username and e-mail still creates the login with the admin's password", async () => {
    const response = await post({ email: "new@example.com", full_name: "New Person", username: "newperson", role: "workshop", password: "Str0ng-Passw0rd!" });
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.existing_login).toBe(false);
    expect(body.message).toBeUndefined();
    expect(state.createdUsers).toBe(1);
  });

  it("a username alone that matches nobody is refused (a new login needs an e-mail and a name)", async () => {
    const response = await post({ username: "nobody", role: "workshop" });
    expect(response.status).toBe(400);
    expect(state.createdUsers).toBe(0);
  });

  it("a new login without a name is refused", async () => {
    const response = await post({ email: "new@example.com", role: "workshop", password: "Str0ng-Passw0rd!" });
    expect(response.status).toBe(400);
    expect(state.createdUsers).toBe(0);
  });
});

describe("only a login the caller may take: themself, no company, or every company theirs (Marpet-only admin vs a JNR login)", () => {
  const OTHER = "This login belongs to another company. An admin of that company must add it.";
  const nothingDone = () => {
    expect(state.calls).toEqual([]);
    expect(state.writes).toEqual([]);
    expect(state.audits).toEqual([]);
    expect(state.lifts).toBe(0);
  };

  it("a Marpet-only admin adding a JNR-only login by username is refused with 403; nothing is written", async () => {
    state.callerAdminOf = [];
    const response = await post({ username: "john", role: "office" });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(OTHER);
    nothingDone();
  });

  it("the same by e-mail", async () => {
    state.callerAdminOf = [];
    const response = await post({ email: "john@jnr.example", full_name: "J", role: "office" });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(OTHER);
    nothingDone();
  });

  it("enabling (re-adding) a former Marpet member who is now also in JNR is refused for a Marpet-only admin", async () => {
    state.callerAdminOf = [];
    state.here = { active: false };
    state.ban = { banned: true, appBan: true };
    const response = await post({ username: "john", role: "office" });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(OTHER);
    nothingDone();
  });

  it("a disabled JNR login is refused with the same 403 (its sign-in state is not revealed to Marpet)", async () => {
    state.callerAdminOf = [];
    state.ban = { banned: true, appBan: false };
    const response = await post({ username: "john", role: "office" });
    expect(response.status).toBe(403);
    nothingDone();
  });

  it("an admin of both JNR and Marpet adds the JNR login to Marpet", async () => {
    state.callerAdminOf = ["org-jnr"];
    const response = await post({ username: "john", role: "office" });
    expect(response.status).toBe(201);
    expect(state.calls.filter((c) => c.fn === "add_member")).toHaveLength(1);
  });

  it("a login also in a company the caller doesn't administer is refused even when the caller administers JNR", async () => {
    state.callerAdminOf = ["org-jnr"];
    state.elsewhere = ["org-jnr", "org-other"];
    const response = await post({ username: "john", role: "office" });
    expect(response.status).toBe(403);
    nothingDone();
  });

  it("093: a login with no company anywhere is refused like any login that isn't the caller's (403), nothing written", async () => {
    state.callerAdminOf = [];
    state.elsewhere = [];
    const response = await post({ username: "john", role: "office" });
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("This login belongs to another company. An admin of that company must add it.");
    expect(state.calls.filter((c) => c.fn === "add_member")).toEqual([]);
  });

  it("093: a platform owner's login (or one with a support membership) is refused with the same 403, even when every company is the caller's", async () => {
    for (const scenario of [{ protectedLogin: true, loginSupport: false }, { protectedLogin: false, loginSupport: true }]) {
      Object.assign(state, scenario, { calls: [], writes: [] });
      const response = await post({ username: "john", role: "office" });
      expect(response.status).toBe(403);
      expect((await response.json()).error).toBe("This login belongs to another company. An admin of that company must add it.");
      expect(state.calls).toEqual([]);
      expect(state.writes).toEqual([]);
    }
  });

  it("093: when the protected-login check can't be answered, 500 and nothing written", async () => {
    state.protectedLogin = null;
    const response = await post({ username: "john", role: "office" });
    expect(response.status).toBe(500);
    expect((await response.json()).error).toContain("the database needs its 093 update");
    expect(state.calls).toEqual([]);
  });

  it("the caller themself may be added (the rule never stops self)", async () => {
    state.callerAdminOf = [];
    state.profiles = [{ id: ADMIN, email: "admin@marpet.example", username: "marpetadmin", full_name: "Me" }];
    const response = await post({ username: "marpetadmin", role: "office" });
    expect(response.status).toBe(201);
  });

  it("memberships that can't be read are refused (500), nothing written", async () => {
    state.scopeUnreadable = true;
    const response = await post({ username: "john", role: "office" });
    expect(response.status).toBe(500);
    nothingDone();
  });

  it("the disabled-login rule (#118) still answers 409 for a login the caller may take", async () => {
    state.callerAdminOf = ["org-jnr"];
    state.ban = { banned: true, appBan: false };
    expect((await post({ username: "john", role: "office" })).status).toBe(409);
  });
});
