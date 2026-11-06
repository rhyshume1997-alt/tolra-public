// Worker W-A: recipient binding by customer name in the direct-send routes (two customers with one name are ambiguous). Mocks only.
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const T = vi.hoisted(() => ({ tables: {} as Record<string, Array<Record<string, unknown>>>, mailerCalls: [] as Array<Record<string, unknown>> }));

describe("direct-send routes: two customers with one name are ambiguous", () => {
  const ORG = "o-1", DOC = "11111111-1111-4111-8111-111111111111";
  const session = { from: (t: string) => { let rows = [...(T.tables[t] ?? [])]; const q: Record<string, unknown> = { select: () => q, eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; }, not: () => q, limit: (n: number) => { rows = rows.slice(0, n); return q; }, maybeSingle: async () => ({ data: rows[0] ?? null, error: null }), then: (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res) }; return q; }, rpc: async () => ({ data: { history_id: "h", replay: false, status: "sending" }, error: null }) };
  vi.mock("@/lib/server/auth", () => ({
    sameOrigin: () => true, forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }), isErrorResponse: (v: unknown) => v instanceof NextResponse,
    jsonError: (m: string, s: number) => NextResponse.json({ error: m }, { status: s }), readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
    requireProfile: async () => ({ supabase: (globalThis as { __wa?: unknown }).__wa, user: { id: "u-1" }, profile: { id: "u-1", organization_id: "o-1", role: "office" }, session: { support: false } }),
  }));
  vi.mock("@/lib/email/send-company-email", async (orig) => { const real = await orig<typeof import("@/lib/email/send-company-email")>(); return { ...real, sendCompanyEmail: vi.fn(async (input: Record<string, unknown>) => { T.mailerCalls.push(input); return { ok: true, mode: "sent", provider: "resend", historyId: "h" }; }) }; });
  beforeEach(() => {
    (globalThis as { __wa?: unknown }).__wa = session; T.mailerCalls = [];
    T.tables = {
      invoices: [{ id: DOC, organization_id: ORG, customer: "Customer Ltd", invoice_ref: "INV-1" }],
      jobs: [{ id: DOC, organization_id: ORG, customer: "Customer Ltd" }],
      customers: [{ organization_id: ORG, name: "Customer Ltd", email: "first@customer.test" }, { organization_id: ORG, name: "Customer Ltd", email: "second@customer.test" }],
      suppliers: [], delivery_notes: [], user_profiles: [],
    };
  });
  it("/api/email/send refuses both same-name addresses", async () => {
    const { POST } = await import("@/app/api/email/send/route");
    for (const to of ["first@customer.test", "second@customer.test"]) {
      const res = await POST(new Request("http://x/api/email/send", { method: "POST", body: JSON.stringify({ kind: "invoice", record_id: DOC, to: [to], subject: "S", text: "T" }) }));
      expect(res.status).toBe(403);
    }
    expect(T.mailerCalls).toEqual([]);
  });
  it("/api/email/send still accepts a name that is unique", async () => {
    T.tables.customers = [{ organization_id: ORG, name: "Customer Ltd", email: "first@customer.test" }];
    const { POST } = await import("@/app/api/email/send/route");
    const res = await POST(new Request("http://x/api/email/send", { method: "POST", body: JSON.stringify({ kind: "invoice", record_id: DOC, to: ["first@customer.test"], subject: "S", text: "T" }) }));
    expect(res.status).toBe(200);
  });
  it("/api/send-job refuses both same-name addresses (the base trusted whichever row came first)", async () => {
    const { POST } = await import("@/app/api/send-job/route");
    for (const recipient_email of ["first@customer.test", "second@customer.test"]) {
      const res = await POST(new Request("http://x/api/send-job", { method: "POST", body: JSON.stringify({ job_id: DOC, recipient_email, subject: "S", body: "T" }) }));
      expect(res.status).toBe(403);
    }
  });
});
