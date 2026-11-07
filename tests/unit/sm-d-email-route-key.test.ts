/**
 * Branch D: POST /api/email/send must carry an idempotency key. Without one the library mints a fresh random key per call, so a client
 * retry (timeout, double click, reload) would send the e-mail again. The only caller (components/email/send-email-button.tsx) always sends one.
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
  requireProfile: async () => ({ supabase: { from: (t: string) => builder(t) }, user: { id: "u-1" }, profile: { id: "u-1", organization_id: "o-1", role: "office" }, session: { support: false } }),
}));
const sent = vi.hoisted(() => ({ inputs: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/email/send-company-email", async (original) => {
  const real = await original<typeof import("@/lib/email/send-company-email")>();
  return { ...real, sendCompanyEmail: vi.fn(async (input: Record<string, unknown>) => { sent.inputs.push(input); return { ok: true, mode: "sent", provider: "resend", historyId: "h-1" }; }) };
});

import { POST } from "@/app/api/email/send/route";

const post = (body: Record<string, unknown>) => POST(new Request("http://localhost/api/email/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const valid = { kind: "invoice", record_id: DOC, to: ["acc@customer.test"], subject: "Invoice I-1", text: "Hello" };

describe("POST /api/email/send idempotency key", () => {
  beforeEach(() => { sent.inputs = []; });
  it("refuses a request with no idempotency_key and sends nothing", async () => {
    const res = await post(valid);
    expect(res.status).toBe(400);
    expect(sent.inputs).toEqual([]);
  });
  it("accepts the same request with a key and passes the key on unchanged", async () => {
    const res = await post({ ...valid, idempotency_key: "abc-12345678" });
    expect(res.status).toBe(200);
    expect(sent.inputs[0]).toMatchObject({ idempotencyKey: "abc-12345678" });
  });
});
