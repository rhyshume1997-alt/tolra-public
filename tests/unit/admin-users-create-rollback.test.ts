/**
 * Regression tests for CR-029 (verified Auth deletion on new-user creation rollback) and
 * CR-030 (compensating membership rollback when adding/reactivating an existing login partially fails).
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { CREATE_ROLLBACK_UNCERTAIN_MESSAGE } from "@/lib/server/admin-user-create-rollback";

const ORG = "org-marpet";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const EXISTING = "33333333-3333-4333-8333-333333333333";
const NEW_USER = "44444444-4444-4444-8444-444444444444";

type Membership = {
  user_id: string;
  organization_id: string;
  role: string;
  secondary_role: string | null;
  active: boolean;
  hidden_sections: string[];
};
type Row = Record<string, unknown>;

const world = {
  authUsers: new Map<string, { id: string; email: string; banned_until: string | null; app_metadata: Row }>(),
  profiles: [] as Array<{ id: string; email: string; username: string | null; full_name: string | null }>,
  memberships: [] as Membership[],
  addMemberError: null as { code?: string; message?: string } | null,
  setAccessError: null as { code?: string; message?: string } | null,
  mustChangeOk: true,
  usernameErrorCode: null as string | null,
  deleteUserMode: "ok" as "ok" | "error" | "silent-noop" | "verify-error",
  deleteMembershipFail: false,
  restoreMembershipFail: false,
  banBefore: { banned: false, appBan: false, banOrg: null as string | null },
  liftResult: { lifted: false, stillBanned: false, error: false },
  banRestores: [] as Array<{ id: string; attrs: Row }>,
};

function matches(row: Row, filters: Array<(r: Row) => boolean>) {
  return filters.every((f) => f(row));
}

function fromTable(table: string) {
  const filters: Array<(r: Row) => boolean> = [];
  let mode: "select" | "update" | "delete" = "select";
  let patch: Row | null = null;

  const list = (): Row[] => {
    if (table === "organization_members") return world.memberships as unknown as Row[];
    if (table === "user_profiles") return world.profiles as unknown as Row[];
    if (table === "organizations") return [{ id: ORG, name: "Marpet Fabrications" }];
    return [];
  };

  const run = () => {
    if (mode === "delete" && table === "organization_members") {
      if (world.deleteMembershipFail) return { data: null, error: { code: "50000", message: "delete failed" } };
      world.memberships = world.memberships.filter((row) => !matches(row as unknown as Row, filters));
      return { data: null, error: null };
    }
    if (mode === "update" && patch) {
      if (table === "user_profiles" && "username" in patch && world.usernameErrorCode) {
        return { data: null, error: { code: world.usernameErrorCode, message: "username failed" } };
      }
      if (table === "organization_members" && world.restoreMembershipFail) {
        return { data: null, error: { code: "50000", message: "restore failed" } };
      }
      for (const row of list()) {
        if (matches(row, filters)) Object.assign(row, patch);
      }
      return { data: null, error: null };
    }
    const found = list().filter((row) => matches(row, filters)).map((row) => ({ ...row }));
    return { data: found, error: null };
  };

  const chain: Record<string, unknown> = {
    select: () => chain,
    update: (row: Row) => { mode = "update"; patch = row; return chain; },
    delete: () => { mode = "delete"; return chain; },
    eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return chain; },
    neq: (col: string, val: unknown) => { filters.push((r) => r[col] !== val); return chain; },
    is: (col: string, val: unknown) => { filters.push((r) => (r[col] ?? null) === val); return chain; },
    ilike: (col: string, val: string) => {
      const clean = val.replace(/\\(.)/g, "$1").toLowerCase();
      filters.push((r) => String(r[col] ?? "").toLowerCase() === clean);
      return chain;
    },
    limit: () => chain,
    maybeSingle: async () => {
      const r = run();
      return { data: Array.isArray(r.data) ? r.data[0] ?? null : null, error: r.error };
    },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
  };
  return chain;
}

const admin = {
  from: (table: string) => fromTable(table),
  rpc: async (fn: string, args: Row) => {
    if (fn !== "add_member") throw new Error(`unexpected rpc ${fn}`);
    if (world.addMemberError) return { data: null, error: world.addMemberError };
    const email = String(args.p_email).toLowerCase();
    const user = [...world.authUsers.values()].find((u) => u.email === email);
    const id = user?.id ?? EXISTING;
    const existing = world.memberships.find((m) => m.user_id === id && m.organization_id === args.p_org);
    if (existing) {
      existing.active = true;
      existing.role = String(args.p_role);
    } else {
      world.memberships.push({
        user_id: id,
        organization_id: String(args.p_org),
        role: String(args.p_role),
        secondary_role: null,
        active: true,
        hidden_sections: [],
      });
    }
    return { data: "member", error: null };
  },
  auth: {
    admin: {
      createUser: async ({ email }: { email: string }) => {
        world.authUsers.set(NEW_USER, { id: NEW_USER, email: email.toLowerCase(), banned_until: null, app_metadata: {} });
        world.profiles.push({ id: NEW_USER, email: email.toLowerCase(), username: null, full_name: null });
        return { data: { user: { id: NEW_USER } }, error: null };
      },
      deleteUser: async (id: string) => {
        if (world.deleteUserMode === "error") return { data: { user: null }, error: { status: 500, message: "auth unavailable" } };
        if (world.deleteUserMode === "silent-noop") return { data: { user: null }, error: null };
        world.authUsers.delete(id);
        return { data: { user: null }, error: null };
      },
      getUserById: async (id: string) => {
        if (world.deleteUserMode === "verify-error") return { data: { user: null }, error: { status: 503, message: "gateway timeout" } };
        const user = world.authUsers.get(id);
        if (!user) return { data: { user: null }, error: { status: 404, code: "user_not_found", message: "User not found" } };
        return { data: { user }, error: null };
      },
      updateUserById: async (id: string, attrs: Row) => {
        world.banRestores.push({ id, attrs });
        return { error: null };
      },
      listUsers: async () => ({ data: { users: [...world.authUsers.values()] }, error: null }),
    },
  },
};

const supabase = {
  rpc: async (fn: string) => {
    if (fn === "set_member_access" && world.setAccessError) return { error: world.setAccessError };
    return { error: null };
  },
};

vi.mock("@/lib/server/admin-users", () => ({
  guard: async () => ({ auth: { user: { id: ADMIN }, profile: { organization_id: ORG }, supabase }, admin }),
  audit: async () => undefined,
  banState: async () => world.banBefore,
  enrolmentFlag: async () => false,
  existingLoginScope: async () => ({ loginCompanies: ["org-jnr"], loginSupport: false, callerAdminCompanies: [ORG, "org-jnr"] }),
  hasVerifiedTotp: async () => false,
  liftDeactivationBan: async () => world.liftResult,
  loginIsProtected: async () => false,
  ownsIdentity: async () => true,
  requireAdminEnrolment: async () => true,
  requireRecentAal2: async () => null,
}));
vi.mock("@/lib/server/password-setup", () => ({ setMustChange: async () => world.mustChangeOk }));

const { POST } = await import("@/app/api/admin/users/route");

const post = (body: Record<string, unknown>) =>
  POST(new Request("http://localhost/api/admin/users", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "http://localhost" },
    body: JSON.stringify(body),
  }));

beforeEach(() => {
  world.authUsers = new Map([[EXISTING, { id: EXISTING, email: "john@jnr.example", banned_until: null, app_metadata: {} }]]);
  world.profiles = [{ id: EXISTING, email: "john@jnr.example", username: null, full_name: "John Smith" }];
  world.memberships = [];
  world.addMemberError = null;
  world.setAccessError = null;
  world.mustChangeOk = true;
  world.usernameErrorCode = null;
  world.deleteUserMode = "ok";
  world.deleteMembershipFail = false;
  world.restoreMembershipFail = false;
  world.banBefore = { banned: false, appBan: false, banOrg: null };
  world.liftResult = { lifted: false, stillBanned: false, error: false };
  world.banRestores = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("CR-029: new-user creation rollback verifies Auth deletion and clears membership", () => {
  it("returns clean 500 when add_member fails and Auth deletion is confirmed", async () => {
    world.addMemberError = { code: "50000", message: "db error" };
    const res = await post({ email: "new@example.com", full_name: "New User", role: "office", password: "Str0ng-Passw0rd!" });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.uncertain).toBeUndefined();
    expect(world.authUsers.has(NEW_USER)).toBe(false);
  });

  it("reports uncertain state (500) if Auth deletion fails after add_member failure", async () => {
    world.addMemberError = { code: "50000", message: "db error" };
    world.deleteUserMode = "error";
    const res = await post({ email: "new@example.com", full_name: "New User", role: "office", password: "Str0ng-Passw0rd!" });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: CREATE_ROLLBACK_UNCERTAIN_MESSAGE, uncertain: true });
    expect(world.authUsers.has(NEW_USER)).toBe(true);
  });

  it("revokes unrestricted membership even if Auth deleteUser fails after set_member_access error", async () => {
    world.setAccessError = { code: "50000", message: "access rpc failed" };
    world.deleteUserMode = "error";
    const res = await post({
      email: "new@example.com",
      full_name: "New User",
      role: "office",
      hidden_sections: ["invoices"],
      password: "Str0ng-Passw0rd!",
    });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body).toEqual({ error: CREATE_ROLLBACK_UNCERTAIN_MESSAGE, uncertain: true });
    // Membership row MUST be cleared so the user cannot read hidden sections despite deleteUser failing.
    expect(world.memberships.find((m) => m.user_id === NEW_USER && m.organization_id === ORG)).toBeUndefined();
  });

  it("reports uncertain state when deleteUser returns no error but getUserById still sees the user or fails", async () => {
    world.mustChangeOk = false;
    world.deleteUserMode = "silent-noop";
    const resNoop = await post({ email: "new@example.com", full_name: "New User", role: "office", password: "Str0ng-Passw0rd!" });
    expect(resNoop.status).toBe(500);
    expect(await resNoop.json()).toEqual({ error: CREATE_ROLLBACK_UNCERTAIN_MESSAGE, uncertain: true });

    world.authUsers.delete(NEW_USER);
    world.memberships = [];
    world.deleteUserMode = "verify-error";
    const resUnverified = await post({ email: "new2@example.com", full_name: "New User 2", role: "office", password: "Str0ng-Passw0rd!" });
    expect(resUnverified.status).toBe(500);
    expect(await resUnverified.json()).toEqual({ error: CREATE_ROLLBACK_UNCERTAIN_MESSAGE, uncertain: true });
  });
});

describe("CR-030: existing-user membership creation rolls back partial writes", () => {
  it("deletes newly added membership when set_member_access fails so hidden_sections are never bypassed", async () => {
    world.setAccessError = { code: "50000", message: "access failed" };
    const res = await post({ email: "john@jnr.example", role: "office", hidden_sections: ["invoices"] });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body.uncertain).toBeUndefined();
    expect(world.memberships.find((m) => m.user_id === EXISTING && m.organization_id === ORG)).toBeUndefined();
    expect(world.authUsers.has(EXISTING)).toBe(true);
  });

  it("deletes newly added membership when setUsername fails with a conflict", async () => {
    world.usernameErrorCode = "23505";
    const res = await post({ email: "john@jnr.example", role: "office", username: "takenname" });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toBe("That username is already taken");
    expect(world.memberships.find((m) => m.user_id === EXISTING && m.organization_id === ORG)).toBeUndefined();
  });

  it("restores prior inactive membership when reactivating a former member fails at set_member_access", async () => {
    world.memberships.push({
      user_id: EXISTING,
      organization_id: ORG,
      role: "viewer",
      secondary_role: null,
      active: false,
      hidden_sections: ["invoices", "quotes"],
    });
    world.setAccessError = { code: "50000", message: "access failed" };
    const res = await post({ email: "john@jnr.example", role: "office", hidden_sections: ["invoices"] });
    expect(res.status).toBe(500);
    expect(world.memberships.find((m) => m.user_id === EXISTING && m.organization_id === ORG)).toEqual({
      user_id: EXISTING,
      organization_id: ORG,
      role: "viewer",
      secondary_role: null,
      active: false,
      hidden_sections: ["invoices", "quotes"],
    });
  });

  it("restores inactive membership and lifted deactivation ban if setUsername fails after reactivation", async () => {
    world.memberships.push({
      user_id: EXISTING,
      organization_id: ORG,
      role: "viewer",
      secondary_role: null,
      active: false,
      hidden_sections: ["invoices"],
    });
    world.banBefore = { banned: true, appBan: true, banOrg: ORG };
    world.liftResult = { lifted: true, stillBanned: false, error: false };
    world.usernameErrorCode = "23505";

    const res = await post({ email: "john@jnr.example", role: "office", username: "conflictname" });
    expect(res.status).toBe(409);
    expect(world.memberships.find((m) => m.user_id === EXISTING && m.organization_id === ORG)?.active).toBe(false);
    expect(world.banRestores).toEqual([
      {
        id: EXISTING,
        attrs: { ban_duration: "876000h", app_metadata: { deactivation_ban: true, deactivation_ban_org: ORG } },
      },
    ]);
  });

  it("returns uncertain 500 when existing-user membership rollback itself fails", async () => {
    world.setAccessError = { code: "50000", message: "access failed" };
    world.deleteMembershipFail = true;
    const res = await post({ email: "john@jnr.example", role: "office", hidden_sections: ["invoices"] });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: CREATE_ROLLBACK_UNCERTAIN_MESSAGE, uncertain: true });
  });
});
