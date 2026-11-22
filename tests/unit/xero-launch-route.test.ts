import { beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ support: false, rpc: vi.fn(), allowed: true, origin: true, recent: null as Response | null, recentArgs: [] as unknown[], conn: { data: { tenant_id: "t-a", tenant_name: "Org A" }, error: null } as { data: unknown; error: unknown } }));
vi.mock("@/lib/server/auth", () => ({
  requireProfile: async () => (state.allowed ? { session: { support: state.support }, profile: { organization_id: "org-1" }, supabase: { rpc: state.rpc, from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => state.conn }) }) }) }) } } : new Response("", { status: 403 })),
  isErrorResponse: (v: unknown) => v instanceof Response,
  sameOrigin: () => state.origin,
  forbiddenOrigin: () => new Response("", { status: 403 }),
  jsonError: (error: string, status: number) => Response.json({ error }, { status }),
  mfaRecentRequired: (action: string) => Response.json({ error: `fresh code to ${action}`, code: "mfa_recent_required" }, { status: 403 }),
  readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
}));
vi.mock("@/lib/server/admin-users", () => ({ requireRecentAal2: async (...args: unknown[]) => { state.recentArgs = args; return state.recent; } }));
import { GET, POST } from "@/app/api/integrations/xero/launch/route";

const ON = { enabled: true, confirmTenantId: "t-a" };
const request = (body: unknown) => new Request("https://synthetic.test/api/integrations/xero/launch", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => {
  state.support = false; state.allowed = true; state.origin = true; state.recent = null; state.recentArgs = []; state.conn = { data: { tenant_id: "t-a", tenant_name: "Org A" }, error: null };
  state.rpc.mockReset().mockResolvedValue({ data: { enabled: false, connected: true, mapped: true, status: "connected" }, error: null });
});

it("shows connected but OFF, and saves an explicit admin switch through the signed-in client only", async () => {
  expect(await (await GET()).json()).toEqual({ enabled: false, connected: true, mapped: true, status: "connected", organisation: { tenantId: "t-a", name: "Org A" } });
  state.rpc.mockResolvedValue({ data: null, error: null });
  expect((await POST(request(ON))).status).toBe(200);
  expect(state.rpc).toHaveBeenCalledWith("integration_xero_set_transfers", { p_enabled: true });
  expect(state.rpc).toHaveBeenCalledWith("write_audit", expect.objectContaining({ p_metadata: expect.objectContaining({ purpose: "xero_organisation_confirmed", organisation: "Org A" }) }));
});
it("turning ON asks for the recent authenticator code, forced on, before anything is written; the refusal is the mfa_recent_required answer the code dialog opens on", async () => {
  state.recent = Response.json({ error: "fresh code", code: "mfa_recent_required" }, { status: 403 });
  const res = await POST(request(ON));
  expect(res.status).toBe(403);
  expect((await res.json()).code).toBe("mfa_recent_required");
  expect(state.recentArgs[1]).toBe("turn Xero transfers on");
  expect(state.recentArgs[2]).toBe(true);
  expect(state.rpc).not.toHaveBeenCalled();
});
it("turning OFF never needs a fresh code (the way out stays open)", async () => {
  state.recent = Response.json({ code: "mfa_recent_required" }, { status: 403 });
  state.rpc.mockResolvedValue({ data: null, error: null });
  expect((await POST(request({ enabled: false }))).status).toBe(200);
  expect(state.recentArgs).toEqual([]);
  expect(state.rpc).toHaveBeenCalledWith("integration_xero_set_transfers", { p_enabled: false });
});
it("refuses non-admin, support (GET too), cross-origin, a string, extra keys and an empty body without changing anything", async () => {
  state.allowed = false; expect((await POST(request(ON))).status).toBe(403); expect((await GET()).status).toBe(403);
  state.allowed = true; state.support = true; expect((await POST(request(ON))).status).toBe(403); expect((await GET()).status).toBe(403);
  state.support = false; state.origin = false; expect((await POST(request(ON))).status).toBe(403);
  state.origin = true;
  expect((await POST(request({ enabled: "true" }))).status).toBe(400);
  expect((await POST(request({ enabled: true, extra: 1 }))).status).toBe(400);
  expect((await POST(request({}))).status).toBe(400);
  expect(state.rpc).not.toHaveBeenCalled();
});
it("the database's own refusals are answered plainly: not connected and not mapped are 409, a wrong role is 403, a stale code in the database re-opens the code dialog", async () => {
  const refuse = (hint: string | undefined, code: string) => state.rpc.mockResolvedValue({ data: null, error: { code, hint, message: "x" } });
  refuse("not_connected", "55000"); expect((await POST(request(ON))).status).toBe(409);
  refuse("not_mapped", "55000"); expect((await POST(request(ON))).status).toBe(409);
  refuse(undefined, "42501"); expect((await POST(request(ON))).status).toBe(403);
  refuse("mfa_recent_required", "42501");
  const res = await POST(request(ON));
  expect(res.status).toBe(403); expect((await res.json()).code).toBe("mfa_recent_required");
});
it("a status read the database refuses is 503 and says nothing was changed", async () => {
  state.rpc.mockResolvedValue({ data: null, error: { code: "PGRST202" } });
  const res = await GET();
  expect(res.status).toBe(503);
  expect((await res.json()).error).toContain("Nothing was changed");
});
it("turning ON without confirmTenantId, or with the wrong one, is 409 confirm_organisation: no RPC and no audit", async () => {
  for (const body of [{ enabled: true }, { enabled: true, confirmTenantId: "t-other" }]) {
    const res = await POST(request(body));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("confirm_organisation");
  }
  expect(state.rpc).not.toHaveBeenCalled();
});
it("turning ON with nothing connected (no stored tenant), or an unreadable connection, is refused with no RPC and no audit; the fresh code is still checked first", async () => {
  state.conn = { data: null, error: null };
  expect((await POST(request(ON))).status).toBe(409);
  state.conn = { data: null, error: { code: "x" } };
  expect((await POST(request(ON))).status).toBe(503);
  expect(state.rpc).not.toHaveBeenCalled();
  state.recent = Response.json({ code: "mfa_recent_required" }, { status: 403 });
  expect((await POST(request({ enabled: true }))).status).toBe(403);
});
it("turning OFF needs no confirmTenantId and is never blocked by the organisation", async () => {
  state.conn = { data: null, error: null };
  state.rpc.mockResolvedValue({ data: null, error: null });
  expect((await POST(request({ enabled: false }))).status).toBe(200);
  expect(state.rpc).toHaveBeenCalledTimes(1);
  expect(state.rpc).toHaveBeenCalledWith("integration_xero_set_transfers", { p_enabled: false });
});
