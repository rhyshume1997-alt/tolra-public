/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333", I = "44444444-4444-4444-8444-444444444444";
const state = vi.hoisted(() => ({ org: "", role: "office", support: false, origin: true, mfa: true, token: "none", tables: {} as Record<string, any[]>, ledger: new Map<string, any>(), reads: [] as string[], sends: [] as any[], calls: [] as string[], status: 200, malformed: false, completeError: false, networkFailure: false, stall: false, editOnClaim: false, credit: 15 }));
let sequence = 10;
const nextId = () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(sequence++).padStart(12, "0")}`;
function query(table: string) {
  state.reads.push(table);
  const filters: Array<(r: any) => boolean> = [];
  let mode = "read", patch = {}, start = 0, end = Infinity;
  function execute() {
    const all = state.tables[table] ?? [];
    if (table === "email_history" && mode === "update" && (patch as any).status === "sending" && state.editOnClaim) { all[0].body += " changed"; state.editOnClaim = false; }
    const rows = all.filter((r) => filters.every((f) => f(r))).slice(start, end + 1);
    if (mode === "update") rows.forEach((r) => Object.assign(r, patch));
    if (mode === "delete") state.tables[table] = all.filter((r) => !rows.includes(r));
    if (table === "chase_sends" && !all.length) return { data: null, error: { code: "PGRST205" } };
    return { data: structuredClone(rows), error: null };
  }
  const q: any = {
    select: () => q, order: () => q,
    eq: (k: string, v: any) => { filters.push((r) => r[k] === v); return q; },
    ilike: (k: string, v: string) => { filters.push((r) => String(r[k]).toLowerCase() === v.replace(/\\(.)/g, "$1").toLowerCase()); return q; },
    range: (a: number, b: number) => { start = a; end = b; return q; },
    limit: (n: number) => { end = n - 1; return q; },
    update: (v: any) => { mode = "update"; patch = v; return q; }, delete: () => { mode = "delete"; return q; },
    maybeSingle: async () => { const out = execute(); return { ...out, data: out.data?.[0] ?? null }; },
    then: (ok: any, bad: any) => Promise.resolve(execute()).then(ok, bad),
  };
  return q;
}
const db = {
  from: query,
  async rpc(fn: string, p: any) {
    state.calls.push(fn);
    if (fn === "customer_credit") return { data: [{ customer: "Practice Customer", credit: state.credit }], error: null };
    if (fn === "reserve_company_email") {
      expect(p.p_org).toBe(state.org);
      const prior = state.ledger.get(p.p_key);
      if (prior && prior.status !== "failed") return { data: { ...prior, replay: true }, error: null };
      const history = prior ? state.tables.email_history.find((r) => r.id === prior.history_id) : { id: nextId() };
      Object.assign(history, { organization_id: p.p_org, to_email: p.p_to, subject: p.p_subject, body: p.p_body, related_to_type: p.p_related_type, related_to_id: p.p_related_id, drafted_by: p.p_user, status: p.p_mode });
      if (!prior) state.tables.email_history.push(history);
      const entry = { send_id: prior?.send_id ?? nextId(), history_id: history.id, status: p.p_mode, replay: false };
      state.ledger.set(p.p_key, entry);
      return { data: entry, error: null };
    }
    if (fn === "complete_company_email") {
      if (state.completeError) return { data: null, error: { code: "XX000" } };
      const entry = [...state.ledger.values()].find((r) => r.send_id === p.p_send)!;
      entry.status = p.p_outcome;
      state.tables.email_history.find((r) => r.id === entry.history_id).status = p.p_outcome === "accepted" ? "sent_via_system" : p.p_outcome;
      return { data: null, error: null };
    }
    throw new Error(`Unexpected RPC ${fn}`);
  },
};
vi.mock("@/lib/server/auth", () => ({
  sameOrigin: () => state.origin,
  forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  isErrorResponse: (v: unknown) => v instanceof NextResponse,
  jsonError: (error: string, status: number) => NextResponse.json({ error }, { status }),
  readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
  requireProfile: async (roles: string[]) => roles.includes(state.role) && state.mfa ? { supabase: db, user: { id: "person-1" }, profile: { organization_id: state.org }, session: { support: state.support } } : NextResponse.json({ error: "Forbidden" }, { status: 403 }),
}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => { throw new Error("Unexpected service role access"); } }));
vi.mock("@/lib/integrations/microsoft/token-source", () => ({ getDelegatedAccessToken: async (org: string) => {
  if (state.token === "error") throw new Error("refresh refused");
  return state.token === "connected" ? `mock-token-${org}` : null;
} }));
vi.mock("resend", () => ({ Resend: class {
  emails = { send: async (payload: any, options: any) => {
    state.sends.push({ provider: "resend", payload, options });
    if (state.networkFailure) throw new TypeError("Synthetic network failure");
    if (state.stall) return new Promise<never>(() => {});
    return state.status === 200 ? { data: state.malformed ? null : { id: "re_mock_message_id" }, error: state.malformed ? { name: "application_error", statusCode: null, message: "Malformed SDK response" } : null } : { data: null, error: { name: "validation_error", statusCode: state.status, message: "Synthetic provider refusal" } };
  } };
} }));

import { POST as draftStatement } from "@/app/api/email/statement/route";
import { POST as approve } from "@/app/api/email/approve/route";
import { customerStatement } from "@/lib/email/customer-statement";
import { sendCompanyEmail } from "@/lib/email/send-company-email";
import { renderInvoiceReminder } from "@/lib/email/schedules/render";
import { gbp } from "@/lib/money";
import { fmtDate } from "@/lib/dates";

const request = (path: string, data: unknown) => new Request(`https://app.test${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
const create = () => draftStatement(request("/api/email/statement", { customer_id: C, idempotency_key: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", organization_id: B }));
async function reviewedDraft() { const res = await create(); expect(res.status).toBe(200); return state.tables.email_history[0]; }
const approveRow = (r: any, overrides = {}) => approve(request("/api/email/approve", { draft_id: r.id, subject: r.subject, body: r.body, to: r.to_email, ...overrides }));

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
  vi.stubEnv("RESEND_API_KEY", "re_fake_only_not_a_real_key"); vi.stubEnv("EMAIL_FROM", "Practice Shop <billing@sender.test>"); vi.stubEnv("VERCEL_ENV", ""); vi.stubEnv("EMAIL_PROVIDER", "");
  state.org = A; state.role = "office"; state.support = false; state.origin = true; state.mfa = true; state.token = "none"; state.status = 200; state.malformed = false; state.completeError = false; state.editOnClaim = false; state.networkFailure = false; state.stall = false; state.credit = 15;
  state.sends = []; state.reads = []; state.calls = []; state.ledger.clear(); sequence = 10;
  state.tables = {
    customers: [{ id: C, organization_id: A, name: "Practice Customer", contact_name: "Alex", email: "buyer@customer.test" }, { id: B, organization_id: B, name: "Other Customer", email: "other@customer.test" }],
    invoices: [{ id: I, organization_id: A, invoice_ref: "INV-1", customer: "Practice Customer", total: 120, amount_paid: 20, credited_amount: 10, refunded_amount: 0, status: "partial", due_date: "2026-10-31", payment_unverified: false }, { id: B, organization_id: B, invoice_ref: "SECRET-B", customer: "Practice Customer", total: 9999, status: "issued" }],
    email_history: [], organizations: [{ id: A, name: "Practice Shop" }], organization_settings: [], email_templates: [], chase_sends: [],
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", async (url: any, init: any) => {
    expect(String(url)).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    state.sends.push({ provider: "microsoft", url: String(url), headers: init.headers, payload: JSON.parse(init.body) });
    return new Response(null, { status: state.status === 200 ? 202 : state.status });
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("statement -> existing Approvals -> configured provider (mocks only)", () => {
  it("always creates one draft, scoped to the session, with correct receipts/credits and no provider call", async () => {
    const before = structuredClone(state.tables.invoices);
    const r = await reviewedDraft();
    expect(r.organization_id).toBe(A); expect(r.status).toBe("drafted"); expect(r.body).toContain("£90.00"); expect(r.body).toContain("£15.00"); expect(r.body).not.toContain("SECRET-B");
    expect(state.sends).toHaveLength(0); await create(); expect(state.tables.email_history).toHaveLength(1);
    expect(state.tables.invoices).toEqual(before);
  });
  it.each(["none", "connected"])("sends the exact approved text once through token mode %s", async (token) => {
    state.token = token;
    const before = structuredClone(state.tables.invoices), r = await reviewedDraft();
    const out = await approveRow(r); expect(out.status).toBe(200); expect(state.sends).toHaveLength(1);
    const sent = state.sends[0]; expect(sent.provider).toBe(token === "connected" ? "microsoft" : "resend");
    if (token === "connected") { expect(sent.headers.Authorization).toBe(`Bearer mock-token-${A}`); expect(sent.payload.message.body.content).toBe(r.body); }
    else { expect(sent.payload.text).toBe(r.body); expect(sent.options.idempotencyKey).toContain("company-email/"); }
    expect((await approveRow(r)).status).toBe(404); expect(state.sends).toHaveLength(1);
    expect(state.tables.email_history).toHaveLength(1); expect(state.tables.email_history[0].status).toBe("sent_via_system"); expect(state.tables.email_history[0].drafted_by).toBe("person-1");
    expect(state.tables.invoices).toEqual(before);
  });
  it("compares recipient as well as reviewed subject/body and refuses a changed balance/address", async () => {
    const r = await reviewedDraft();
    for (const change of [{ body: "Unreviewed" }, { subject: "Different" }, { to: "outsider@customer.test" }]) expect((await approveRow(r, change)).status).toBe(409);
    state.tables.invoices[0].amount_paid = 30; expect((await approveRow(r)).status).toBe(409);
    expect(state.sends).toHaveLength(0);
  });
  it("permits saved human wording changes without losing the statement's financial snapshot check", async () => {
    const r = await reviewedDraft(); r.body = "Hello,\n" + r.body + "\nPlease call our office.";
    expect((await approveRow(r)).status).toBe(200); expect(state.sends[0].payload.text).toBe(r.body);
  });
  it("refuses another company, concurrent edits and simultaneous duplicate approvals", async () => {
    const r = await reviewedDraft(); state.org = B;
    expect((await approveRow(r)).status).toBe(404); state.org = A;
    state.editOnClaim = true; expect((await approveRow(r)).status).toBe(409); expect(state.sends).toHaveLength(0);
    const changed = state.tables.email_history[0]; const out = await Promise.all([approveRow(changed), approveRow(changed)]);
    expect(out.map((r) => r.status).sort()).toEqual([200, 409]); expect(state.sends).toHaveLength(1);
  });
  it.each([400, 401, 403, 429])("keeps definite Resend refusal %i retryable under the same ledger key", async (status) => {
    const r = await reviewedDraft(); state.status = status;
    expect((await approveRow(r)).status).toBe(status === 429 ? 429 : 502); expect(state.tables.email_history.find((x) => x.id === r.id).status).toBe("drafted");
    const key = state.sends[0].options.idempotencyKey; state.status = 200;
    expect((await approveRow(r)).status).toBe(200); expect(state.sends[1].options.idempotencyKey).toBe(key);
  });
  it.each([408, 409, 500, 503])("holds ambiguous Resend response %i as unknown and never resends", async (status) => {
    const r = await reviewedDraft(); state.status = status;
    expect((await approveRow(r)).status).toBe(502); expect(state.tables.email_history.find((x) => x.id === r.id).status).toBe("unknown");
    expect((await approveRow(r)).status).toBe(409); expect(state.sends).toHaveLength(1);
  });
  it("treats malformed success and lost completion writes as unknown", async () => {
    const r = await reviewedDraft(); state.malformed = true;
    expect((await approveRow(r)).status).toBe(502); expect((await approveRow(r)).status).toBe(409);
    expect(state.sends).toHaveLength(1);
  });
  it("holds network failures and timeouts instead of automatically retrying", async () => {
    const r = await reviewedDraft(); state.stall = true;
    const pending = approveRow(r);
    await vi.advanceTimersByTimeAsync(15_001);
    expect((await pending).status).toBe(502);
    expect((await approveRow(r)).status).toBe(409);
    expect(state.sends).toHaveLength(1);
  });
  it("holds a thrown SDK connection failure as unknown", async () => {
    const r = await reviewedDraft(); state.networkFailure = true;
    expect((await approveRow(r)).status).toBe(502); expect((await approveRow(r)).status).toBe(409); expect(state.sends).toHaveLength(1);
  });
  it("does not repeat an accepted email if recording its outcome fails", async () => {
    const r = await reviewedDraft(); state.completeError = true;
    expect((await approveRow(r)).status).toBe(502); expect((await approveRow(r)).status).toBe(409); expect(state.sends).toHaveLength(1);
  });
  it("does not fall back after a Microsoft connection error and retains the draft", async () => {
    const r = await reviewedDraft(); state.token = "error";
    expect((await approveRow(r)).status).toBe(502); expect(state.sends).toHaveLength(0); expect(state.tables.email_history[0].status).toBe("drafted");
  });
  it("without a provider keeps the original draft and sends nothing", async () => {
    const r = await reviewedDraft(); vi.stubEnv("RESEND_API_KEY", ""); vi.stubEnv("EMAIL_FROM", "");
    expect((await approveRow(r)).status).toBe(503); expect(state.sends).toHaveLength(0); expect(state.tables.email_history).toHaveLength(1);
  });
  it.each(["workshop", "viewer"])("rejects role %s before any query", async (role) => {
    state.role = role; expect((await create()).status).toBe(403); expect(state.reads).toHaveLength(0);
  });
  it("rejects cross-origin, support and missing MFA approval requests", async () => {
    const r = await reviewedDraft(); state.origin = false; expect((await approveRow(r)).status).toBe(403);
    state.origin = true; state.support = true; expect((await approveRow(r)).status).toBe(403);
    state.support = false; state.mfa = false; expect((await approveRow(r)).status).toBe(403); expect(state.sends).toHaveLength(0);
  });
  it("rejects duplicate customer names and bad money before creating any statement", async () => {
    state.tables.customers.push({ ...state.tables.customers[0], id: I }); expect((await create()).status).toBe(400);
    state.tables.customers.pop(); state.tables.invoices[0].total = "broken"; expect((await create()).status).toBe(400); expect(state.sends).toHaveLength(0);
  });
  it("scheduled customer reminders draft even when a real provider adapter is configured", async () => {
    const out = await sendCompanyEmail({ organizationId: A, userId: null, kind: "invoice_reminder", to: ["buyer@customer.test"], subject: "Reminder", text: "Please review", recordType: "invoice", recordId: I }, { db: db as never });
    expect(out).toMatchObject({ ok: true, mode: "drafted" }); expect(state.sends).toHaveLength(0);
  });
  it("checks a statement's fingerprint again after customer address changes", async () => {
    const first = await customerStatement(db as never, A, C); state.tables.customers[0].email = "changed@customer.test";
    expect((await customerStatement(db as never, A, C)).recordId).not.toBe(first.recordId);
  });
});

describe("baseline reminder approval uses existing rendering and current receivables", () => {
  function reminder() {
    const rendered = renderInvoiceReminder({ reference: "INV-1", total: gbp(110, 2), dueDate: fmtDate("2026-10-31"), daysOverdue: 5, companyName: "Practice Shop", customerName: "Practice Customer", contactName: "Alex", amountPaid: 20, paidText: gbp(20, 2), balanceText: gbp(90, 2) });
    const r = { id: nextId(), organization_id: A, to_email: "buyer@customer.test", subject: rendered.subject, body: rendered.text, status: "drafted", related_to_type: "invoice", related_to_id: I, drafted_by: null };
    state.tables.email_history.push(r); return r;
  }
  it("sends only an explicitly approved current reminder", async () => { const r = reminder(); expect((await approveRow(r)).status).toBe(200); expect(state.sends).toHaveLength(1); });
  it("holds paid, part-changed, edited and chase-controlled reminders", async () => {
    const r = reminder(); state.tables.invoices[0].amount_paid = 120; expect((await approveRow(r)).status).toBe(409);
    state.tables.invoices[0].amount_paid = 30; expect((await approveRow(r)).status).toBe(409);
    state.tables.invoices[0].amount_paid = 20; state.tables.chase_sends.push({ id: "chase-1", draft_history_id: r.id, organization_id: A }); expect((await approveRow(r)).status).toBe(409);
    expect(state.sends).toHaveLength(0);
  });
});
