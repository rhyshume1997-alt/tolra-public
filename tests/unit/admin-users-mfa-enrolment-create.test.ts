import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG = "org-alpha";
const ADMIN = "11111111-1111-4111-8111-111111111111";
const EXISTING = "22222222-2222-4222-8222-222222222222";
const NEW_USER = "33333333-3333-4333-8333-333333333333";

const state = {
  enrolled: false as boolean | null,
  enrolError: null as { code?: string; message?: string } | null,
  profiles: [{ id: EXISTING, email: "existing@example.test", username: "existing", full_name: "Existing User" }],
  deletedAuthUsers: [] as string[],
  deletedMemberships: [] as Array<Record<string, unknown>>,
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
  audits: [] as Array<{ action: string; entity: string }>,
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

const admin = {
  auth: {
    admin: {
      createUser: async () => ({ data: { user: { id: NEW_USER } }, error: null }),
      deleteUser: async (id: string) => { state.deletedAuthUsers.push(id); return { error: null }; },
      getUserById: async () => ({ data: { user: { banned_until: null } }, error: null }),
      updateUserById: async () => ({ error: null }),
      listUsers: async () => ({ data: { users: [] }, error: null }),
      mfa: {
        listFactors: async () => {
          if (state.enrolled === null) return { data: null, error: { message: "auth down" } };
          return {
            data: { factors: state.enrolled ? [{ factor_type: "totp", status: "verified" }] : [] },
            error: null,
          };
        },
        deleteFactor: async () => ({ error: null }),
      },
    },
  },
  rpc: async (fn: string, args: unknown) => {
    state.rpcCalls.push({ fn, args });
    return { data: "member", error: null };
  },
  from(table: string) {
    return {
      select: () => chain(function (this: Record<string, unknown>) {
        const f = this ?? {};
        if (table === "user_profiles") {
          const row = state.profiles.find((p) => (f.username !== undefined ? p.username === f.username : f.email !== undefined ? p.email === f.email : p.id === f.id));
          return { data: row ?? null, error: null };
        }
        if (table === "organizations") return { data: { name: "Alpha Ltd" }, error: null };
        return { data: null, error: null };
      }),
      update: (row: Record<string, unknown>) => chain(() => {
        if (table === "organization_members" && "mfa_enrolment_required" in row) {
          return { error: state.enrolError };
        }
        return { error: null };
      }),
      delete: () => chain(function (this: Record<string, unknown>) {
        if (table === "organization_members") state.deletedMemberships.push({ ...this });
        return { error: null };
      }),
    };
  },
};

const supabase = { rpc: async () => ({ error: null }) };

vi.mock("@/lib/server/admin-users", async (original) => {
  const real = await original<typeof import("@/lib/server/admin-users")>();
  return {
    ...real,
    guard: async () => ({ auth: { user: { id: ADMIN }, profile: { organization_id: ORG }, supabase }, admin }),
    audit: async (_ctx: unknown, action: string, entity: string) => { state.audits.push({ action, entity }); },
    banState: async () => ({ banned: false, appBan: false, banOrg: null }),
    existingLoginScope: async () => ({ loginCompanies: ["org-other"], loginSupport: false, callerAdminCompanies: [ORG, "org-other"] }),
    loginIsProtected: async () => false,
    requireRecentAal2: async () => null,
  };
});
vi.mock("@/lib/server/password-setup", () => ({ setMustChange: async () => true }));

const { POST } = await import("@/app/api/admin/users/route");

const post = (body: Record<string, unknown>) =>
  POST(new Request("http://localhost/api/admin/users", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) }));

beforeEach(() => {
  state.enrolled = false;
  state.enrolError = null;
  state.deletedAuthUsers = [];
  state.deletedMemberships = [];
  state.rpcCalls = [];
  state.audits = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("POST /api/admin/users MFA enrolment enforcement (CR-031)", () => {
  it("rolls back and returns 500 instead of 201 when saving mfa_enrolment_required fails for a new admin", async () => {
    state.enrolError = { code: "08006", message: "connection failure" };
    const res = await post({
      email: "newadmin@example.test",
      full_name: "New Admin",
      role: "admin",
      password: "Str0ng-Passw0rd!",
    });
    expect(res.status).toBe(500);
    expect(state.deletedAuthUsers).toEqual([NEW_USER]);
    expect(state.audits).toHaveLength(0);
  });

  it("refuses with 500 before calling add_member when hasVerifiedTotp fails for an existing user added as admin", async () => {
    state.enrolled = null;
    const res = await post({ username: "existing", role: "admin" });
    expect(res.status).toBe(500);
    expect(state.rpcCalls).toEqual([]);
    expect(state.audits).toHaveLength(0);
  });

  it("reverts membership and returns 500 when saving mfa_enrolment_required fails for an existing user added as admin", async () => {
    state.enrolled = false;
    state.enrolError = { code: "57014", message: "statement timeout" };
    const res = await post({ username: "existing", role: "admin" });
    expect(res.status).toBe(500);
    expect(state.deletedMemberships).toEqual([{ organization_id: ORG, user_id: EXISTING }]);
    expect(state.audits).toHaveLength(0);
  });

  it("still allows pre-065 missing column (42703) with admin_mfa_onboarding: false", async () => {
    state.enrolError = { code: "42703", message: "column mfa_enrolment_required does not exist" };
    const res = await post({
      email: "newadmin@example.test",
      full_name: "New Admin",
      role: "admin",
      password: "Str0ng-Passw0rd!",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, admin_mfa_onboarding: false });
    expect(state.deletedAuthUsers).toEqual([]);
  });
});
