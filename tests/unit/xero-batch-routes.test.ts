/**
 * Xero batch and summary routes (E3): who may call them (batch: admin only; summary: admin and office; workshop, viewer and every support
 * session refused before any database or Xero call), the request is validated, only the caller's own company is read, and the summary
 * file is a CSV with the formula guard and a name carrying the company and the range.
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  role: "admin" as string,
  support: false,
  adminClients: 0,
  filters: [] as Array<[string, string, unknown]>,
  chunkCalls: 0,
}));

vi.mock("@/lib/server/auth", () => ({
  sameOrigin: () => true,
  forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  isErrorResponse: (v: unknown) => v instanceof NextResponse,
  jsonError: (m: string, s: number) => NextResponse.json({ error: m }, { status: s }),
  readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
  requireProfile: async (roles?: string[]) => (roles && !roles.includes(state.role)
    ? NextResponse.json({ error: "Forbidden" }, { status: 403 })
    : { supabase: {}, user: { id: "u1" }, profile: { organization_id: "org-1", role: state.role }, session: state.support ? { support: true, read_only: false } : null }),
}));

const TABLES: Record<string, unknown[]> = {
  invoices: [{ id: "i1", invoice_ref: "INV-1", customer: "=Evil", status: "issued", invoice_date: "2026-10-05", tax_point: null, issued_at: null, created_at: null, subtotal: 100, vat: 20, total: 120 }],
  credit_notes: [],
  integration_sends: [{ id: "s1", doc_type: "invoice", doc_id: "i1", action: "create", status: "sent", attempts: 1, external_id: "x1", external_number: "INV-1", last_error: null, next_attempt_at: null, sent_at: "2026-10-30T10:00:00Z" }],
  organizations: [{ name: "Marpet Ltd" }],
};
function query(table: string) {
  const q: Record<string, unknown> = {};
  const self = () => q;
  for (const m of ["select", "not", "or", "gte", "lte", "order", "limit"]) q[m] = self;
  q.eq = (col: string, val: unknown) => { state.filters.push([table, col, val]); return q; };
  q.range = async () => ({ data: TABLES[table] ?? [], error: null });
  q.maybeSingle = async () => ({ data: (TABLES[table] ?? [])[0] ?? null, error: null });
  return q;
}
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => { state.adminClients += 1; return { from: query }; } }));
vi.mock("@/lib/integrations/server", () => ({ xeroReady: () => ({ config: {}, key: Buffer.alloc(32) }) }));
vi.mock("@/lib/integrations/xero/batch-deps", () => ({ batchDeps: () => ({}) }));
vi.mock("@/lib/integrations/xero/batch-server", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/xero/batch-server")>()),
  runBatchChunk: async () => { state.chunkCalls += 1; return { results: [], stopped: null, remaining: [] }; },
}));

const post = (body: unknown) => new Request("https://app.example.test/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const get = (qs: string) => new Request(`https://app.example.test/x?${qs}`);
const ID = "11111111-1111-4111-8111-111111111111";
const SEND = { action: "send", mode: "unsent", items: [{ doc_type: "invoice", doc_id: ID }] };

beforeEach(() => { state.role = "admin"; state.support = false; state.adminClients = 0; state.filters = []; state.chunkCalls = 0; });

describe("batch route guards", () => {
  it.each(["office", "workshop", "viewer"])("%s gets 403 before any service-role client or send", async (role) => {
    state.role = role;
    const { POST } = await import("@/app/api/integrations/xero/batch/route");
    for (const body of [SEND, { action: "preview", from: "2026-10-01", to: "2026-10-31", mode: "unsent" }]) {
      expect((await POST(post(body))).status).toBe(403);
    }
    expect(state.adminClients).toBe(0);
    expect(state.chunkCalls).toBe(0);
  });

  it("a support session (read-only or elevated) gets 403 and no service-role client", async () => {
    state.support = true;
    const { POST } = await import("@/app/api/integrations/xero/batch/route");
    const res = await POST(post(SEND));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Support access can't change Xero settings." });
    expect(state.adminClients).toBe(0);
    expect(state.chunkCalls).toBe(0);
  });

  it("refuses bad bodies: a bad range, more than a chunk, a bad id", async () => {
    const { POST } = await import("@/app/api/integrations/xero/batch/route");
    expect((await POST(post({ action: "preview", from: "2026-10-31", to: "2026-10-01", mode: "unsent" }))).status).toBe(400);
    expect((await POST(post({ action: "preview", from: "x", to: "2026-10-01", mode: "unsent" }))).status).toBe(400);
    expect((await POST(post({ ...SEND, items: Array.from({ length: 4 }, () => ({ doc_type: "invoice", doc_id: ID })) }))).status).toBe(400);
    expect((await POST(post({ ...SEND, items: [{ doc_type: "invoice", doc_id: "nope" }] }))).status).toBe(400);
    expect((await POST(post({ ...SEND, mode: "all" }))).status).toBe(400);
    expect(state.chunkCalls).toBe(0);
  });

  it("an admin's send for a connected company runs the chunk; for a company not connected it is refused", async () => {
    const { POST } = await import("@/app/api/integrations/xero/batch/route");
    TABLES.integration_connections = [{ status: "connected" }];
    expect((await POST(post(SEND))).status).toBe(200);
    expect(state.chunkCalls).toBe(1);
    TABLES.integration_connections = [{ status: "disconnected" }];
    expect((await POST(post(SEND))).status).toBe(409);
    expect(state.chunkCalls).toBe(1);
    expect(state.filters).toContainEqual(["integration_connections", "organization_id", "org-1"]);
  });
});

describe("summary route", () => {
  it.each(["workshop", "viewer"])("%s gets 403", async (role) => {
    state.role = role;
    const { GET } = await import("@/app/api/integrations/xero/summary/route");
    expect((await GET(get("from=2026-10-01&to=2026-10-31"))).status).toBe(403);
    expect(state.adminClients).toBe(0);
  });

  it("a support session gets 403 and no service-role client", async () => {
    state.support = true;
    const { GET } = await import("@/app/api/integrations/xero/summary/route");
    expect((await GET(get("from=2026-10-01&to=2026-10-31"))).status).toBe(403);
    expect(state.adminClients).toBe(0);
  });

  it.each(["admin", "office"])("%s downloads a CSV named with the company and range; every read carries the company; formulas are guarded", async (role) => {
    state.role = role;
    const { GET } = await import("@/app/api/integrations/xero/summary/route");
    const res = await GET(get("from=2026-10-01&to=2026-10-31"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Xero-summary-Marpet-Ltd-2026-10-01-to-2026-10-31.csv"');
    const text = await res.text();
    expect(text).toContain("INV-1,Invoice,Create,'=Evil,2026-10-05,100.00,20.00,120.00,INV-1,x1,");
    for (const table of ["invoices", "credit_notes", "integration_sends"]) expect(state.filters).toContainEqual([table, "organization_id", "org-1"]);
    expect(state.filters).toContainEqual(["organizations", "id", "org-1"]);
  });

  it("refuses a bad range", async () => {
    const { GET } = await import("@/app/api/integrations/xero/summary/route");
    expect((await GET(get("from=2026-10-31&to=2026-10-01"))).status).toBe(400);
    expect((await GET(get("from=2026-10-01"))).status).toBe(400);
  });
});
