/**
 * POST /api/admin/users/companies (migration 066). Every change goes to public.admin_set_company_access with the CALLER's own client
 * (the database decides; the service role never does), each refusal comes back as a sentence naming the company, and the Auth sign-in
 * ban follows the memberships as PATCH /api/admin/users does it.
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ADMIN = "11111111-1111-4111-8111-111111111111";
const USER = "33333333-3333-4333-8333-333333333333";
const JNR = "44444444-4444-4444-8444-444444444444";
const MARPET = "55555555-5555-4555-8555-555555555555";

type RpcError = { code?: string; message: string; hint?: string };
const state = {
  guardDenied: false,
  callerRpc: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  serviceRpc: [] as string[],
  /** What admin_set_company_access answers, per company. */
  answers: {} as Record<string, { data?: Record<string, unknown>; error?: RpcError }>,
  activeLeft: 1,
  ban: { banned: false, appBan: false },
  lifted: [] as string[],
  banned: [] as string[],
  /** The filters of the service-role count of active memberships left. */
  countFilters: null as Record<string, unknown> | null,
};

const supabase = {
  rpc: async (fn: string, args: Record<string, unknown> = {}) => {
    state.callerRpc.push({ fn, args });
    if (fn === "my_admin_companies") return { data: [{ organization_id: JNR, name: "JNR Engineering" }, { organization_id: MARPET, name: "Marpet" }], error: null };
    const answer = state.answers[String(args.p_org)] ?? { data: { changed: true, action: "GRANT_COMPANY_ACCESS", active: true, was_active: false, mfa_enrolment_required: false } };
    return { data: answer.data ?? null, error: answer.error ?? null };
  },
};

const admin = {
  rpc: async (fn: string) => { state.serviceRpc.push(fn); return { data: null, error: null }; },
  from: (table: string) => {
    const filters: Record<string, unknown> = { table };
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => { filters[column] = value; return chain; },
      then: (resolve: (value: { count: number; error: null }) => unknown) => { state.countFilters = filters; return resolve({ count: state.activeLeft, error: null }); },
    };
    return chain;
  },
  auth: { admin: { updateUserById: async (id: string) => { state.banned.push(id); return { error: null }; } } },
};

vi.mock("@/lib/server/admin-users", () => ({
  guard: async () => (state.guardDenied ? NextResponse.json({ error: "Forbidden" }, { status: 403 }) : { auth: { user: { id: ADMIN }, profile: { organization_id: JNR }, supabase }, admin }),
  liftDeactivationBan: async (_admin: unknown, id: string) => { state.lifted.push(id); return { lifted: true, stillBanned: false }; },
  banState: async () => state.ban,
}));

const { POST } = await import("@/app/api/admin/users/companies/route");

const post = (body: unknown) => POST(new Request("http://localhost/api/admin/users/companies", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
const setCalls = () => state.callerRpc.filter((c) => c.fn === "admin_set_company_access").map((c) => c.args);

beforeEach(() => {
  state.guardDenied = false;
  state.callerRpc = [];
  state.serviceRpc = [];
  state.answers = {};
  state.activeLeft = 1;
  state.ban = { banned: false, appBan: false };
  state.lifted = [];
  state.banned = [];
  state.countFilters = null;
});

describe("who may call it", () => {
  it("the admin guard's refusal is returned as it is and nothing is called", async () => {
    state.guardDenied = true;
    const response = await post({ user_id: USER, changes: [{ organization_id: MARPET, active: true, role: "office" }] });
    expect(response.status).toBe(403);
    expect(state.callerRpc).toEqual([]);
  });

  it.each([
    [{ user_id: "not-a-uuid", changes: [{ organization_id: MARPET, active: true }] }],
    [{ user_id: USER, changes: [] }],
    [{ user_id: USER, changes: [{ organization_id: MARPET, active: true, role: "owner" }] }],
    [{ user_id: USER, changes: [{ organization_id: MARPET, active: true }, { organization_id: MARPET, active: false }] }],
  ])("refuses a malformed request: %j", async (body) => {
    expect((await post(body)).status).toBe(400);
    expect(setCalls()).toEqual([]);
  });
});

describe("each change is the database's decision, made as the caller", () => {
  it("a grant sends the role and second role; a removal sends only active false; the service role is never asked", async () => {
    state.answers[JNR] = { data: { changed: true, action: "REMOVE_COMPANY_ACCESS", active: false, was_active: true } };
    const response = await post({ user_id: USER, changes: [
      { organization_id: MARPET, active: true, role: "office", secondary_role: "workshop" },
      { organization_id: JNR, active: false, role: "admin" },
    ] });
    expect(response.status).toBe(200);
    expect(setCalls()).toEqual([
      { p_org: MARPET, p_user: USER, p_role: "office", p_secondary_role: "workshop", p_clear_secondary: false, p_active: true },
      { p_org: JNR, p_user: USER, p_role: null, p_secondary_role: null, p_clear_secondary: false, p_active: false },
    ]);
    expect(state.serviceRpc).toEqual([]);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.results.map((r: { name: string; action: string }) => [r.name, r.action])).toEqual([["Marpet", "GRANT_COMPANY_ACCESS"], ["JNR Engineering", "REMOVE_COMPANY_ACCESS"]]);
  });

  it("a second role set to none clears it", async () => {
    await post({ user_id: USER, changes: [{ organization_id: MARPET, active: true, role: "viewer", secondary_role: null }] });
    expect(setCalls()[0]).toMatchObject({ p_secondary_role: null, p_clear_secondary: true });
  });

  it.each([
    [{ code: "42501", message: "x", hint: "not_company_admin" }, "You're not an admin of Marpet"],
    [{ code: "42501", message: "x", hint: "mfa_required" }, "Marpet requires two-step sign-in"],
    [{ code: "23514", message: "x", hint: "last_admin" }, "Marpet must keep at least one active admin"],
    [{ code: "23514", message: "x", hint: "self_demotion" }, "your own admin rights in Marpet"],
    [{ code: "23514", message: "x", hint: "self_removal" }, "your own access to Marpet"],
    [{ code: "23514", message: "x", hint: "last_company" }, "at least one company"],
    [{ code: "42501", message: "x", hint: "support_membership" }, "Tolra support access to Marpet"],
    [{ code: "42501", message: "x", hint: "unknown_login" }, "Add them to your company with New user first"],
    [{ code: "40P01", message: "deadlock detected" }, "Someone changed access to Marpet at the same time"],
  ])("a refusal (%j) comes back as a sentence; nothing else is touched", async (error, text) => {
    state.answers[MARPET] = { error };
    const response = await post({ user_id: USER, changes: [{ organization_id: MARPET, active: false }] });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.results[0].ok).toBe(false);
    expect(body.results[0].error).toContain(text);
    expect(state.lifted).toEqual([]);
    expect(state.banned).toEqual([]);
  });

  it("one refused and one saved: 207 with both outcomes", async () => {
    state.answers[JNR] = { error: { code: "23514", message: "x", hint: "last_admin" } };
    const response = await post({ user_id: USER, changes: [{ organization_id: MARPET, active: true, role: "office" }, { organization_id: JNR, active: false }] });
    expect(response.status).toBe(207);
    const body = await response.json();
    expect(body.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, false]);
  });

  it("given admin: reports that they set up an authenticator app (the database's flag, 065)", async () => {
    state.answers[MARPET] = { data: { changed: true, action: "GRANT_COMPANY_ACCESS", active: true, was_active: false, mfa_enrolment_required: true } };
    const body = await (await post({ user_id: USER, changes: [{ organization_id: MARPET, active: true, role: "admin" }] })).json();
    expect(body.results[0].admin_mfa_onboarding).toBe(true);
  });
});

describe("the sign-in ban follows the memberships, as the add path does", () => {
  it("a company taking its own former member back (the database says reactivated) lifts the app's own deactivation ban", async () => {
    state.answers[MARPET] = { data: { changed: true, action: "GRANT_COMPANY_ACCESS", active: true, was_active: false, reactivated: true } };
    await post({ user_id: USER, changes: [{ organization_id: MARPET, active: true, role: "office" }] });
    expect(state.lifted).toEqual([USER]);
  });

  it("a login another company disabled (its deactivation ban) and granted into this company as NEW stays banned", async () => {
    // B deactivated them everywhere: the app's own marked ban. A's admin grants them a new membership in A.
    state.ban = { banned: true, appBan: true };
    state.answers[MARPET] = { data: { changed: true, action: "GRANT_COMPANY_ACCESS", active: true, was_active: false, reactivated: false } };
    const body = await (await post({ user_id: USER, changes: [{ organization_id: MARPET, active: true, role: "office" }] })).json();
    expect(state.lifted).toEqual([]);
    expect(state.banned).toEqual([]);
    expect(body).toMatchObject({ ok: true, login_disabled: true });
    // An older database answer without `reactivated` never lifts a ban either.
    state.answers[MARPET] = { data: { changed: true, action: "GRANT_COMPANY_ACCESS", active: true, was_active: false } };
    await post({ user_id: USER, changes: [{ organization_id: MARPET, active: true, role: "office" }] });
    expect(state.lifted).toEqual([]);
  });

  it("a role change or an unchanged grant lifts nothing", async () => {
    state.answers[MARPET] = { data: { changed: true, action: "CHANGE_COMPANY_ROLE", active: true, was_active: true } };
    await post({ user_id: USER, changes: [{ organization_id: MARPET, active: true, role: "viewer" }] });
    state.answers[MARPET] = { data: { changed: false, action: null, active: true, was_active: true } };
    await post({ user_id: USER, changes: [{ organization_id: MARPET, active: true, role: "viewer" }] });
    expect(state.lifted).toEqual([]);
  });

  it("a removal never touches the sign-in ban, even if no membership were left (the database keeps one: last_company)", async () => {
    state.answers[MARPET] = { data: { changed: true, action: "REMOVE_COMPANY_ACCESS", active: false, was_active: true } };
    state.activeLeft = 0;
    await post({ user_id: USER, changes: [{ organization_id: MARPET, active: false }] });
    expect(state.banned).toEqual([]);
    expect(state.lifted).toEqual([]);
    expect(state.countFilters).toBeNull();
  });
});

describe("a login that also belongs to a company the caller doesn't administer (other_company_login)", () => {
  const OTHER = { code: "42501", hint: "other_company_login", message: "This login belongs to another company. An admin of that company must add it." };

  it("a Marpet-only admin's grant is refused by the database: 403 with the plain sentence, no ban touched", async () => {
    state.answers[MARPET] = { error: OTHER };
    const response = await post({ user_id: USER, changes: [{ organization_id: MARPET, active: true, role: "office" }] });
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe(OTHER.message);
    expect(body.results[0]).toMatchObject({ organization_id: MARPET, ok: false, error: OTHER.message });
    expect(state.lifted).toEqual([]);
    expect(state.banned).toEqual([]);
  });

  it("refused in one company and saved in another: 207, each outcome listed", async () => {
    state.answers[MARPET] = { error: OTHER };
    const response = await post({ user_id: USER, changes: [{ organization_id: MARPET, active: true, role: "office" }, { organization_id: JNR, active: true, role: "office" }] });
    expect(response.status).toBe(207);
  });

  it("any other refusal keeps 409", async () => {
    state.answers[MARPET] = { error: { code: "23514", hint: "last_admin", message: "x" } };
    expect((await post({ user_id: USER, changes: [{ organization_id: MARPET, active: false }] })).status).toBe(409);
  });
});
