// Portal staff: admin's own client only, exact function and argument names, fixed messages from hints, stale code mapping, nothing logged.
import { readFileSync } from "fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ allowed: true, origin: true, rpc: vi.fn(), json: undefined as unknown, jsonOk: true }));
vi.mock("@/lib/server/auth", () => ({
  requireProfile: vi.fn(async (roles?: string[]) => (state.allowed ? { supabase: { rpc: state.rpc }, roles } : new Response("", { status: 401 }))),
  isErrorResponse: (v: unknown) => v instanceof Response,
  sameOrigin: () => state.origin,
  forbiddenOrigin: () => new Response("", { status: 403 }),
  jsonError: (error: string, status: number) => Response.json({ error }, { status }),
  mfaRecentRequired: (action: string) => Response.json({ error: `fresh code to ${action}`, code: "mfa_recent_required" }, { status: 403 }),
  readJson: async () => (state.jsonOk ? { ok: true, data: state.json } : { ok: false, response: Response.json({ error: "Invalid request" }, { status: 400 }) }),
}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => { throw new Error("service role must not be used"); } }));

import { GET as statusGet, POST as statusPost } from "@/app/api/portal/staff/status/route";
import { GET as contactsGet, POST as contactsPost } from "@/app/api/portal/staff/contacts/route";
import { POST as revokePost } from "@/app/api/portal/staff/contacts/[id]/revoke/route";
import { requireProfile } from "@/lib/server/auth";
import { mapStaffError } from "@/lib/portal/staff";

const C = "11111111-1111-4111-8111-111111111111";
const K = "22222222-2222-4222-8222-222222222222";
const req = (url = "https://t.test/x") => new Request(url, { method: "POST" });
const invite = { customerId: C, email: "pat@secret.example", name: "Pat Secret", permissions: ["quotes", "jobs"], reason: "Because secret" };
let logs: string[];
beforeEach(() => {
  state.allowed = true; state.origin = true; state.jsonOk = true; state.json = undefined;
  state.rpc.mockReset();
  vi.mocked(requireProfile).mockClear();
  logs = [];
  for (const m of ["error", "log", "warn", "info"] as const) vi.spyOn(console, m).mockImplementation((...a) => { logs.push(a.map(String).join(" ")); });
});

describe("routes: guard", () => {
  it("every handler asks for the admin role, and POSTs check the origin first", async () => {
    state.rpc.mockResolvedValue({ data: { enabled: false, changed_at: null }, error: null });
    await statusGet();
    expect(requireProfile).toHaveBeenLastCalledWith(["admin"]);
    state.origin = false;
    for (const call of [() => statusPost(req()), () => contactsPost(req()), () => revokePost(req(), { params: Promise.resolve({ id: K }) })]) {
      vi.mocked(requireProfile).mockClear();
      expect((await call()).status).toBe(403);
      expect(requireProfile).not.toHaveBeenCalled();
    }
    expect(state.rpc).toHaveBeenCalledTimes(1);
  });
  it("a refused sign-in is returned as is and nothing is called", async () => {
    state.allowed = false;
    expect((await statusGet()).status).toBe(401);
    expect((await contactsGet(req("https://t.test/x?customer=" + C))).status).toBe(401);
    state.json = invite;
    expect((await contactsPost(req())).status).toBe(401);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("status", () => {
  it("GET calls customer_portal_status with no arguments", async () => {
    state.rpc.mockResolvedValue({ data: { enabled: true, changed_at: "2026-11-12T10:00:00Z" }, error: null });
    const res = await statusGet();
    expect(state.rpc).toHaveBeenCalledWith("customer_portal_status");
    expect(await res.json()).toEqual({ enabled: true, changedAt: "2026-11-12T10:00:00Z" });
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
  it("POST calls customer_portal_set_enabled(p_enabled, p_reason) and rejects extra or bad fields before any call", async () => {
    state.rpc.mockResolvedValue({ data: { enabled: true, changed_at: null }, error: null });
    state.json = { enabled: true, reason: "  go live " };
    expect((await statusPost(req())).status).toBe(200);
    expect(state.rpc).toHaveBeenCalledWith("customer_portal_set_enabled", { p_enabled: true, p_reason: "go live" });
    state.rpc.mockClear();
    for (const bad of [{ enabled: "true", reason: "x" }, { enabled: true, reason: "" }, { enabled: true, reason: "x", extra: 1 }, { enabled: true, reason: "x".repeat(501) }, null]) {
      state.json = bad;
      expect((await statusPost(req())).status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("a stale authenticator code on switching on asks for a fresh one", async () => {
    state.json = { enabled: true, reason: "x" };
    state.rpc.mockResolvedValue({ data: null, error: { code: "42501", hint: "mfa_recent_required", message: "db words" } });
    const res = await statusPost(req());
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("mfa_recent_required");
  });
});

describe("contacts", () => {
  it("GET calls portal_contacts_list(p_customer) and maps rows; a bad id calls nothing", async () => {
    state.rpc.mockResolvedValue({ data: [{ contact_id: K, email: "a@b.c", display_name: "A", permissions: ["quotes"], invited_at: "t", invited_by: C, revoked_at: null, live_sessions: 2 }], error: null });
    const res = await contactsGet(new Request("https://t.test/x?customer=" + C));
    expect(state.rpc).toHaveBeenCalledWith("portal_contacts_list", { p_customer: C });
    expect(await res.json()).toEqual([{ contactId: K, email: "a@b.c", displayName: "A", permissions: ["quotes"], invitedAt: "t", invitedBy: C, revokedAt: null, liveSessions: 2 }]);
    state.rpc.mockClear();
    expect((await contactsGet(new Request("https://t.test/x?customer=nope"))).status).toBe(400);
    expect((await contactsGet(new Request("https://t.test/x"))).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("POST calls portal_contact_invite with the exact argument names and answers 201", async () => {
    state.json = invite;
    state.rpc.mockResolvedValue({ data: { contact_id: K, customer_id: C, permissions: ["jobs", "quotes"] }, error: null });
    const res = await contactsPost(req());
    expect(res.status).toBe(201);
    expect(state.rpc).toHaveBeenCalledWith("portal_contact_invite", { p_customer: C, p_email: "pat@secret.example", p_name: "Pat Secret", p_permissions: ["quotes", "jobs"], p_reason: "Because secret" });
    expect(await res.json()).toEqual({ contactId: K, customerId: C, permissions: ["jobs", "quotes"] });
  });
  it("POST rejects bad input without calling the database", async () => {
    for (const bad of [{ ...invite, customerId: "x" }, { ...invite, permissions: [] }, { ...invite, permissions: ["admin"] }, { ...invite, name: " " }, { ...invite, reason: "" }, { ...invite, extra: 1 }]) {
      state.json = bad;
      expect((await contactsPost(req())).status).toBe(400);
    }
    expect(state.rpc).not.toHaveBeenCalled();
  });
  it("a stale authenticator code on invite maps to mfaRecentRequired('invite a portal contact')", async () => {
    state.json = invite;
    state.rpc.mockResolvedValue({ data: null, error: { code: "42501", hint: "mfa_recent_required", message: "x" } });
    const res = await contactsPost(req());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "fresh code to invite a portal contact", code: "mfa_recent_required" });
  });
});

describe("revoke", () => {
  it("calls portal_contact_revoke(p_contact, p_reason) and a bad id calls nothing", async () => {
    state.json = { reason: "left the company" };
    state.rpc.mockResolvedValue({ data: { contact_id: K, revoked_at: "t", ended_sessions: 1 }, error: null });
    const res = await revokePost(req(), { params: Promise.resolve({ id: K }) });
    expect(state.rpc).toHaveBeenCalledWith("portal_contact_revoke", { p_contact: K, p_reason: "left the company" });
    expect(await res.json()).toEqual({ contactId: K, revokedAt: "t", endedSessions: 1 });
    state.rpc.mockClear();
    expect((await revokePost(req(), { params: Promise.resolve({ id: "x" }) })).status).toBe(400);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("hints and logging", () => {
  it.each([
    ["admin_required", 403], ["portal_off", 409], ["customer_not_found", 404], ["customer_archived", 409], ["invalid_email", 400], ["invalid_name", 400],
    ["invalid_permissions", 400], ["invalid_enabled", 400], ["reason_required", 400], ["already_invited", 409], ["contact_not_found", 404], ["already_revoked", 409],
  ])("hint %s gives a fixed message and status %i, never the database text", async (hint, status) => {
    state.json = invite;
    state.rpc.mockResolvedValue({ data: null, error: { code: "P0002", hint, message: "pat@secret.example leaked" } });
    const res = await contactsPost(req());
    const text = JSON.stringify(await res.json());
    expect(res.status).toBe(status);
    expect(text).not.toContain("leaked");
    expect(text).not.toContain("secret");
  });
  it("unknown hints, thrown errors and odd answers are generic or unavailable", async () => {
    expect(mapStaffError({ hint: "surprise", code: "XX000" }).status).toBe(409);
    expect(mapStaffError({ hint: "constructor" }).status).toBe(409);
    expect(mapStaffError({ code: "42501" }).status).toBe(403);
    state.json = invite;
    state.rpc.mockRejectedValue(new Error("pat@secret.example"));
    expect((await contactsPost(req())).status).toBe(503);
    state.rpc.mockResolvedValue({ data: { contact_id: K, surprise: 1 }, error: null });
    expect((await contactsPost(req())).status).toBe(503);
  });
  it("no log line holds an e-mail, name or reason, across success and failure", async () => {
    state.json = invite;
    state.rpc.mockResolvedValue({ data: { contact_id: K, customer_id: C, permissions: ["quotes"] }, error: null });
    await contactsPost(req());
    state.rpc.mockResolvedValue({ data: null, error: { code: "22023", hint: "invalid_email", message: "pat@secret.example" } });
    await contactsPost(req());
    state.rpc.mockRejectedValue(new Error("pat@secret.example Pat Secret"));
    await contactsPost(req());
    expect(logs.join("\n")).not.toMatch(/secret/i);
  });
  it("the staff files never touch the service role or log", () => {
    for (const f of ["lib/portal/staff.ts", "app/api/portal/staff/status/route.ts", "app/api/portal/staff/contacts/route.ts", "app/api/portal/staff/contacts/[id]/revoke/route.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/supabase-admin|createSupabaseAdminClient|service_role|console\./);
    }
  });
});
