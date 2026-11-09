/**
 * POST /api/email/send FAILS CLOSED without the 106 send ledger. The REAL sendCompanyEmail runs; only the provider (a spy) and the database
 * rpc are fakes. With 106: one provider call for a repeated key. Without 106 (rpc PGRST202): no provider call at all, a clear message.
 * An uncertain provider outcome is held, never retried by the route.
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => { throw new Error("service role used"); } }));

const DOC = "11111111-1111-4111-8111-111111111111";
const rows: Record<string, Array<Record<string, unknown>>> = {
  invoices: [{ id: DOC, organization_id: "o-1", customer: "Customer Ltd", invoice_ref: "INV-0042" }],
  customers: [{ organization_id: "o-1", name: "Customer Ltd", email: "acc@customer.test" }],
};
function builder(table: string) {
  let found = [...(rows[table] ?? [])];
  const q = {
    select: () => q,
    eq: (c: string, v: unknown) => { found = found.filter((r) => r[c] === v); return q; },
    limit: (n: number) => { found = found.slice(0, n); return q; },
    maybeSingle: async () => ({ data: found[0] ?? null, error: null }),
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: found, error: null }).then(resolve),
  };
  return q;
}
vi.mock("@/lib/server/auth", () => ({
  sameOrigin: () => true,
  forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  isErrorResponse: (v: unknown) => v instanceof NextResponse,
  jsonError: (m: string, s: number) => NextResponse.json({ error: m }, { status: s }),
  readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
  requireProfile: async () => ({ supabase: fakeSupabase(), user: { id: "u-1" }, profile: { id: "u-1", organization_id: "o-1", role: "office" }, session: { support: false } }),
}));

const state = vi.hoisted(() => ({ missing: false, outcome: "accepted" as string, calls: [] as unknown[], ledger: new Map<string, { id: string; status: string }>() }));
vi.mock("@/lib/email/providers/mock", () => ({
  mockProvider: () => ({ name: "mock", send: async (e: unknown) => { state.calls.push(e); return { outcome: state.outcome, detail: "x" }; } }),
}));
vi.mock("@/lib/email/chase/send-audit", () => ({ recordSendAudit: async () => undefined }));

import { POST } from "@/app/api/email/send/route";

function fakeSupabase() {
  return {
    from: (t: string) => builder(t),
    rpc: async (fn: string, a: Record<string, unknown>) => {
      if (state.missing) return { data: null, error: { code: "PGRST202" } };
      if (fn === "reserve_company_email") {
        const prior = state.ledger.get(String(a.p_key));
        if (prior) return { data: { send_id: prior.id, history_id: "h", status: prior.status, replay: true }, error: null };
        const row = { id: `s${state.ledger.size}`, status: "sending" };
        state.ledger.set(String(a.p_key), row);
        return { data: { send_id: row.id, history_id: "h", status: "sending", replay: false }, error: null };
      }
      for (const v of state.ledger.values()) if (v.id === a.p_send) v.status = String(a.p_outcome);
      return { data: null, error: null };
    },
  };
}

const post = (body: Record<string, unknown>) => POST(new Request("http://localhost/api/email/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const valid = { kind: "invoice", record_id: DOC, to: ["acc@customer.test"], subject: "Invoice I-1", text: "Hello", idempotency_key: "abc-12345678" };

describe("POST /api/email/send requires the ledger", () => {
  beforeEach(() => { state.missing = false; state.outcome = "accepted"; state.calls = []; state.ledger.clear(); process.env.EMAIL_PROVIDER = "mock"; delete process.env.VERCEL_ENV; vi.spyOn(console, "error").mockImplementation(() => undefined); });
  it("106 present: one send, and a repeat of the same key is a replay with NO second provider call", async () => {
    expect((await post(valid)).status).toBe(200);
    expect((await post(valid)).status).toBe(200);
    expect(state.calls).toHaveLength(1);
  });
  it("106 absent: the send fails safely with a clear message and NO provider call", async () => {
    state.missing = true;
    const res = await post(valid);
    expect(res.status).toBeGreaterThanOrEqual(400);
    const body = await res.json();
    expect(body.status).toBe("failed");
    expect(String(body.error)).toMatch(/migration 106/);
    expect(state.calls).toHaveLength(0);
    await post(valid); // a retry also sends nothing
    expect(state.calls).toHaveLength(0);
  });
  it("unknown provider outcome: held, and a retry with the same key makes no second provider call", async () => {
    state.outcome = "unknown";
    const first = await post(valid);
    expect((await first.json()).held).toBe(true);
    const second = await post(valid);
    expect((await second.json()).status).toBe("failed");
    expect(state.calls).toHaveLength(1);
  });
});
