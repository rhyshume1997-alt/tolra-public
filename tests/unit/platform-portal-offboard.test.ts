/**
 * Platform portal offboarding route (go-live feature 5). The real route, requirePlatformOwner and the input checks run against a fake of
 * the caller's session and of the service role. Proves: non-platform users and password-only sessions are refused; a stale or missing
 * code is refused before the database is called; an empty reason or bad company id is refused; the database's refusals (read-only
 * support session, unknown company, nothing to remove, another company's hint) get fixed wording; success is exactly one RPC through
 * the caller's client with the service role never used; no database message reaches the caller.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG = "44444444-4444-4444-8444-444444444444";
const OTHER_ORG = "55555555-5555-4555-8555-555555555555";
const now = () => Math.floor(Date.now() / 1000);

const state = {
  signedIn: true,
  owner: true,
  level: "aal2",
  amr: [] as unknown[],
  rpcError: null as null | { code: string; message: string; hint?: string },
  rpcData: { removed_links: 3, removed_switch: true, organization_id: ORG } as unknown,
  calls: [] as Array<{ fn: string; args: unknown }>,
  adminUsed: 0,
};

const caller = {
  auth: {
    getUser: async () => ({ data: { user: state.signedIn ? { id: "u1" } : null }, error: null }),
    mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: state.level, currentAuthenticationMethods: state.amr }, error: null }) },
  },
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { active: true, must_change_password: false }, error: null }) }) }) }),
  rpc: async (fn: string, args?: unknown) => {
    state.calls.push({ fn, args });
    if (fn === "is_platform_admin") return { data: state.owner, error: null };
    if (fn === "platform_list_organizations") return { data: [], error: null };
    if (fn === "platform_offboard_document_customer_links") return state.rpcError ? { data: null, error: state.rpcError } : { data: state.rpcData, error: null };
    return { data: null, error: null };
  },
};
const adminProxy = new Proxy({}, { get: () => { state.adminUsed += 1; throw new Error("service role used"); } });

vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => adminProxy }));
vi.mock("@/lib/server/auth", async (original) => {
  const real = await original<typeof import("@/lib/server/auth")>();
  return { ...real, createSupabaseServerClient: async () => caller };
});

const { POST } = await import("@/app/api/platform/portal-offboard/route");

const FRESH = () => [{ method: "password", timestamp: now() - 120 }, { method: "totp", timestamp: now() - 60 }];
const STALE = () => [{ method: "password", timestamp: now() - 3600 }, { method: "totp", timestamp: now() - 16 * 60 }];
const post = (body: unknown) =>
  POST(new Request("http://localhost/api/platform/portal-offboard", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost" }, body: JSON.stringify(body) }));
const offboardCalls = () => state.calls.filter((c) => c.fn === "platform_offboard_document_customer_links");

beforeEach(() => {
  Object.assign(state, { signedIn: true, owner: true, level: "aal2", amr: FRESH(), rpcError: null, rpcData: { removed_links: 3, removed_switch: true, organization_id: ORG }, calls: [], adminUsed: 0 });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("POST /api/platform/portal-offboard", () => {
  it("refuses a signed-out caller", async () => {
    state.signedIn = false;
    expect((await post({ organizationId: ORG, reason: "left" })).status).toBe(401);
    expect(offboardCalls()).toHaveLength(0);
  });
  it("refuses a user who is not a platform owner", async () => {
    state.owner = false;
    expect((await post({ organizationId: ORG, reason: "left" })).status).toBe(403);
    expect(offboardCalls()).toHaveLength(0);
  });
  it("refuses a password-only session (aal1)", async () => {
    state.level = "aal1";
    const res = await post({ organizationId: ORG, reason: "left" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("mfa_required");
    expect(offboardCalls()).toHaveLength(0);
  });
  it("refuses a stale code with mfa_recent_required and calls nothing", async () => {
    state.amr = STALE();
    const res = await post({ organizationId: ORG, reason: "left" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("mfa_recent_required");
    expect(offboardCalls()).toHaveLength(0);
  });
  it("refuses a session with no code time at all", async () => {
    state.amr = [{ method: "password", timestamp: now() }];
    expect((await post({ organizationId: ORG, reason: "left" })).status).toBe(403);
    expect(offboardCalls()).toHaveLength(0);
  });
  it.each([["empty", ""], ["spaces", "   "], ["missing", undefined], ["too long", "x".repeat(501)]])("refuses a %s reason", async (_n, reason) => {
    const res = await post({ organizationId: ORG, reason });
    expect(res.status).toBe(400);
    expect(offboardCalls()).toHaveLength(0);
  });
  it.each([["not a uuid", "acme"], ["missing", undefined], ["number", 5]])("refuses a company id that is %s", async (_n, organizationId) => {
    expect((await post({ organizationId, reason: "left" })).status).toBe(400);
    expect(offboardCalls()).toHaveLength(0);
  });
  it("refuses unknown keys", async () => {
    expect((await post({ organizationId: ORG, reason: "left", delete: true })).status).toBe(400);
    expect(offboardCalls()).toHaveLength(0);
  });

  it("succeeds with exactly one RPC through the caller's client and never the service role", async () => {
    const res = await post({ organizationId: ORG.toUpperCase(), reason: "  Left the platform  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removedLinks: 3, removedSwitch: true, organizationId: ORG });
    expect(offboardCalls()).toEqual([{ fn: "platform_offboard_document_customer_links", args: { p_org: ORG, p_reason: "Left the platform" } }]);
    expect(state.adminUsed).toBe(0);
  });

  it("logs actor, company, action, timestamp and a reason category but no IP address or free-text reason", async () => {
    const info = vi.mocked(console.info);
    const res = await POST(new Request("http://localhost/api/platform/portal-offboard", { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost", "x-forwarded-for": "203.0.113.77", "x-real-ip": "203.0.113.78" }, body: JSON.stringify({ organizationId: ORG, reason: "Left the platform ZZ-MARKER-9137" }) }));
    expect(res.status).toBe(200);
    const logged = [...info.mock.calls, ...vi.mocked(console.error).mock.calls].map((c) => c.join(" ")).join("\n");
    expect(logged).not.toMatch(/203\.0\.113\.|"ip"|\b\d{1,3}(\.\d{1,3}){3}\b/);
    const record = JSON.parse(String(info.mock.calls.at(-1)?.[0]));
    expect(logged).not.toContain("ZZ-MARKER-9137");
    expect(Object.keys(record)).not.toContain("reason");
    expect(record).toMatchObject({ event: "platform.portal_offboarded", action: "portal_offboard", actor: "u1", organization_id: ORG, reason_category: "company_offboarding" });
    expect(Number.isNaN(Date.parse(record.at))).toBe(false);
    expect(Object.keys(record)).not.toContain("ip");
    expect(offboardCalls()[0].args).toEqual({ p_org: ORG, p_reason: "Left the platform ZZ-MARKER-9137" });
  });

  it("passes another company's id to the database, which is the one that decides (unknown company -> 404)", async () => {
    state.rpcError = { code: "P0002", message: "Company not found. secret-detail", hint: "company_not_found" };
    const res = await post({ organizationId: OTHER_ORG, reason: "left" });
    expect(res.status).toBe(404);
    expect(offboardCalls()[0].args).toEqual({ p_org: OTHER_ORG, p_reason: "left" });
  });
  it("answers a read-only support session with fixed wording", async () => {
    state.rpcError = { code: "42501", message: "Support access is read-only. internal", hint: "support_read_only" };
    const res = await post({ organizationId: ORG, reason: "left" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("A read-only support session cannot do this.");
  });
  it("hands a database mfa_recent_required back with its code so the browser asks for a code", async () => {
    state.rpcError = { code: "42501", message: "x", hint: "mfa_recent_required" };
    const body = await (await post({ organizationId: ORG, reason: "left" })).json();
    expect(body.code).toBe("mfa_recent_required");
  });
  it("answers nothing-to-remove with 409", async () => {
    state.rpcError = { code: "P0002", message: "x", hint: "nothing_to_offboard" };
    expect((await post({ organizationId: ORG, reason: "left" })).status).toBe(409);
  });
  it("does not leak a database message on an unexpected error or an unexpected result", async () => {
    state.rpcError = { code: "XX000", message: "relation public.document_customer_links violates something" };
    let res = await post({ organizationId: ORG, reason: "left" });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/relation|violates|document_customer_links/);
    state.rpcError = null;
    state.rpcData = { surprise: "row dump" };
    res = await post({ organizationId: ORG, reason: "left" });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/surprise|row dump/);
  });
  it("calls no other write function", async () => {
    await post({ organizationId: ORG, reason: "left" });
    expect(state.calls.map((c) => c.fn).filter((f) => !["is_platform_admin", "platform_list_organizations", "platform_offboard_document_customer_links"].includes(f))).toEqual([]);
  });
});
