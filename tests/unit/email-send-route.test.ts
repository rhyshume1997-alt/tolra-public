/**
 * E8 one-click send route (app/api/email/send): office and admin only, a support session refused before any read, the document must be
 * the caller's company's, recipients only the document's party on file / the company's own people / the allowlist, a real PDF only,
 * the session's own client handed to the mailer (row level security on the history row), and the mailer's answers mapped to statuses.
 */
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => { throw new Error("service role used"); } }));

const ORG = "o-1";
const DOC = "11111111-1111-4111-8111-111111111111";
const db = vi.hoisted(() => ({ tables: {} as Record<string, Array<Record<string, unknown>>>, reads: [] as string[] }));
function builder(table: string) {
  let rows = [...(db.tables[table] ?? [])];
  const q = {
    select: (cols: string) => { db.reads.push(`${table}:${cols}`); return q; },
    eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return q; },
    limit: (n: number) => { rows = rows.slice(0, n); return q; },
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
  };
  return q;
}
const session = { from: (table: string) => builder(table) };
const auth = vi.hoisted(() => ({ role: "office", support: false, calls: [] as string[][] }));
vi.mock("@/lib/server/auth", () => ({
  sameOrigin: () => true,
  forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  isErrorResponse: (v: unknown) => v instanceof NextResponse,
  jsonError: (m: string, s: number) => NextResponse.json({ error: m }, { status: s }),
  readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
  requireProfile: vi.fn(async (roles: string[]) => {
    auth.calls.push(roles);
    if (!roles.includes(auth.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return { supabase: session, user: { id: "u-1" }, profile: { id: "u-1", organization_id: ORG, role: auth.role }, session: { support: auth.support } };
  }),
}));
const mailer = vi.hoisted(() => ({ calls: [] as Array<{ input: Record<string, unknown>; deps: Record<string, unknown> }>, answer: { ok: true, mode: "sent", provider: "resend", historyId: "h-1" } as Record<string, unknown> }));
vi.mock("@/lib/email/send-company-email", async (original) => {
  const real = await original<typeof import("@/lib/email/send-company-email")>();
  return { ...real, sendCompanyEmail: vi.fn(async (input: Record<string, unknown>, deps: Record<string, unknown>) => { mailer.calls.push({ input, deps }); return mailer.answer; }) };
});

import { POST } from "@/app/api/email/send/route";
import { EMAIL_SEND_ROLES as SEND_ROLES } from "@/lib/email/send-company-email";

const post = (body: Record<string, unknown>) => POST(new Request("http://localhost/api/email/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const valid = { kind: "invoice", record_id: DOC, to: ["acc@customer.test"], subject: "Invoice I-1", text: "Hello" };

describe("POST /api/email/send", () => {
  beforeEach(() => {
    auth.role = "office"; auth.support = false; auth.calls = [];
    mailer.calls = []; mailer.answer = { ok: true, mode: "sent", provider: "resend", historyId: "h-1" };
    db.reads = [];
    db.tables = {
      invoices: [{ id: DOC, organization_id: ORG, customer: "Customer Ltd" }],
      quotes: [{ id: DOC, organization_id: "other-org", customer: "Customer Ltd" }],
      customers: [{ organization_id: ORG, name: "Customer Ltd", email: "Acc@Customer.test" }],
      suppliers: [], delivery_notes: [], purchase_orders: [],
      user_profiles: [{ organization_id: ORG, email: "me@acme.test", workshop_email: "shop@acme.test" }],
    };
  });

  it("office and admin only; workshop and viewers refused by requireProfile", async () => {
    expect([...SEND_ROLES]).toEqual(["admin", "office"]);
    for (const role of ["workshop", "viewer"]) {
      auth.role = role;
      expect((await post(valid)).status).toBe(403);
    }
    expect(auth.calls.every((roles) => roles.join() === "admin,office")).toBe(true);
    expect(mailer.calls).toEqual([]);
  });

  it("a support session is refused before anything is read or sent", async () => {
    auth.support = true;
    auth.role = "admin";
    const res = await post(valid);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Support access/);
    expect(db.reads).toEqual([]);
    expect(mailer.calls).toEqual([]);
  });

  it("sends to the customer on file through the session's own client, for the caller's company", async () => {
    const res = await post({ ...valid, idempotency_key: "abc-12345678" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "sent", provider: "resend", history_id: "h-1" });
    expect(mailer.calls).toHaveLength(1);
    expect(mailer.calls[0].input).toMatchObject({ organizationId: ORG, userId: "u-1", kind: "invoice", to: ["acc@customer.test"], recordId: DOC, recordType: "invoice", idempotencyKey: "abc-12345678" });
    expect(mailer.calls[0].deps.db).toBe(session);
  });

  it("the company's own people may be written to; anyone else is refused (403) without a send", async () => {
    expect((await post({ ...valid, to: ["shop@acme.test"] })).status).toBe(200);
    mailer.calls = [];
    const res = await post({ ...valid, to: ["acc@customer.test"], cc: ["stranger@evil.test"] });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/customer's e-mail address on file/);
    expect(mailer.calls).toEqual([]);
  });

  it("a document of another company (or none) is 404", async () => {
    expect((await post({ ...valid, kind: "quote" })).status).toBe(404);
    expect((await post({ ...valid, record_id: "22222222-2222-4222-8222-222222222222" })).status).toBe(404);
    expect(mailer.calls).toEqual([]);
  });

  it("bad input is 400: unknown kind, CR/LF address, not a PDF", async () => {
    expect((await post({ ...valid, kind: "alert" })).status).toBe(400);
    expect((await post({ ...valid, to: ["acc@customer.test\r\nBcc: x@evil.test"] })).status).toBe(400);
    expect((await post({ ...valid, attachment: { filename: "i.pdf", content_base64: Buffer.from("<html>not a pdf</html>").toString("base64") } })).status).toBe(400);
    expect(mailer.calls).toEqual([]);
    expect((await post({ ...valid, attachment: { filename: "i.pdf", content_base64: Buffer.from("%PDF-1.7 body").toString("base64") } })).status).toBe(200);
    expect(mailer.calls[0].input.attachments).toEqual([{ filename: "i.pdf", content: Buffer.from("%PDF-1.7 body"), contentType: "application/pdf" }]);
  });

  it("maps the mailer's answers: drafted 200, refused/limited/no provider/provider error with their codes", async () => {
    mailer.answer = { ok: true, mode: "drafted", provider: "none", historyId: "h-2" };
    expect(await (await post(valid)).json()).toMatchObject({ status: "drafted" });
    for (const [code, status] of [["invalid", 400], ["recipient_refused", 403], ["rate_limited", 429], ["no_provider", 503], ["provider_error", 502]] as const) {
      mailer.answer = { ok: false, code, error: `e-${code}` };
      const res = await post(valid);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ status: "failed", error: `e-${code}`, code });
    }
  });
});

