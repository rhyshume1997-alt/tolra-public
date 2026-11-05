import { beforeEach, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ support: false, rpc: vi.fn(), allowed: true, origin: true, recent: null as Response | null, recentArgs: [] as unknown[] }));
vi.mock("@/lib/server/auth", () => ({
  requireProfile: async () => (state.allowed ? { session: { support: state.support }, supabase: { rpc: state.rpc } } : new Response("", { status: 403 })),
  isErrorResponse: (v: unknown) => v instanceof Response,
  sameOrigin: () => state.origin,
  forbiddenOrigin: () => new Response("", { status: 403 }),
  jsonError: (error: string, status: number) => Response.json({ error }, { status }),
  mfaRecentRequired: (action: string) => Response.json({ error: `fresh code to ${action}`, code: "mfa_recent_required" }, { status: 403 }),
  readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
}));
vi.mock("@/lib/server/admin-users", () => ({ requireRecentAal2: async (...args: unknown[]) => { state.recentArgs = args; return state.recent; } }));
import { GET, POST } from "@/app/api/integrations/xero/held/route";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const request = (body: unknown) => new Request("https://synthetic.test/api/integrations/xero/held", { method: "POST", body: JSON.stringify(body) });
beforeEach(() => {
  state.support = false; state.allowed = true; state.origin = true; state.recent = null; state.recentArgs = [];
  state.rpc.mockReset().mockResolvedValue({ data: [{ id: A, doc_ref: "INV-1" }], error: null });
});

it("lists the company's held documents through the signed-in client, and approves the named ones only", async () => {
  expect(await (await GET()).json()).toEqual({ held: [{ id: A, doc_ref: "INV-1" }] });
  expect(state.rpc).toHaveBeenCalledWith("integration_xero_held_sends");
  state.rpc.mockResolvedValue({ data: { approved: 2, already: 0 }, error: null });
  const res = await POST(request({ sends: [A, B] }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ approved: 2, already: 0 });
  expect(state.rpc).toHaveBeenLastCalledWith("integration_xero_approve_held", { p_sends: [A, B] });
});
it("approving always asks for a recent authenticator code (forced on) before anything is written", async () => {
  state.recent = Response.json({ code: "mfa_recent_required" }, { status: 403 });
  const res = await POST(request({ sends: [A] }));
  expect(res.status).toBe(403);
  expect(state.recentArgs[1]).toBe("approve held Xero documents");
  expect(state.recentArgs[2]).toBe(true);
  expect(state.rpc).not.toHaveBeenCalled();
});
it("refuses non-admin, support (GET too), cross-origin, bad and duplicate lists, extra keys, without calling the database", async () => {
  state.allowed = false; expect((await POST(request({ sends: [A] }))).status).toBe(403); expect((await GET()).status).toBe(403);
  state.allowed = true; state.support = true; expect((await POST(request({ sends: [A] }))).status).toBe(403); expect((await GET()).status).toBe(403);
  state.support = false; state.origin = false; expect((await POST(request({ sends: [A] }))).status).toBe(403);
  state.origin = true;
  for (const body of [{}, { sends: [] }, { sends: ["not-a-uuid"] }, { sends: [A, A] }, { sends: [A], extra: 1 }, { sends: Array.from({ length: 201 }, () => A) }]) {
    expect((await POST(request(body))).status, JSON.stringify(body).slice(0, 60)).toBe(400);
  }
  expect(state.rpc).not.toHaveBeenCalled();
});
it("the database's own refusals are answered plainly", async () => {
  const refuse = (hint: string | undefined, code: string) => state.rpc.mockResolvedValue({ data: null, error: { code, hint, message: "x" } });
  refuse("mfa_recent_required", "42501"); expect(await (await POST(request({ sends: [A] }))).json()).toMatchObject({ code: "mfa_recent_required" });
  refuse("not_connected", "55000"); expect((await POST(request({ sends: [A] }))).status).toBe(409);
  refuse("not_held", "22023"); expect((await POST(request({ sends: [A] }))).status).toBe(409);
  refuse(undefined, "P0002"); expect((await POST(request({ sends: [A] }))).status).toBe(404);
  refuse(undefined, "42501"); expect((await POST(request({ sends: [A] }))).status).toBe(403);
  state.rpc.mockResolvedValue({ data: null, error: { code: "42883", message: "missing" } });
  expect((await GET()).status).toBe(503);
});
