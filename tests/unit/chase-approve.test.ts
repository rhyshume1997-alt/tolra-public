// 138: "Approve and send" for a chase draft, with a mock mailer. Sends through the company mailer only after every check; with no mailer
// set up it says so and writes nothing; it records the approval (chase_record_sent) once sent.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NO_PROVIDER_MESSAGE, approveChaseDraft, approveKey } from "@/lib/email/chase/approve";
import type { CompanyEmailInput, CompanyEmailResult } from "@/lib/email/send-company-email";
import { FakeDb } from "../support/fake-db";

const ORG = "org-a";
const DRAFT = "11111111-1111-4111-8111-111111111111";
let db: FakeDb;
let admin: FakeDb & { rpc: ReturnType<typeof vi.fn> };
const send = vi.fn<(input: CompanyEmailInput) => Promise<CompanyEmailResult>>();
let provider: unknown;

const approve = (extra: { subject?: string; body?: string } = {}) => approveChaseDraft(
  { organizationId: ORG, userId: "u-office", draftId: DRAFT, today: "2026-11-13", ...extra },
  { db: db as never, admin: admin as never, provider: async () => provider, send, allowlisted: () => false },
);

beforeEach(() => {
  provider = { name: "mock" };
  send.mockReset().mockResolvedValue({ ok: true, mode: "sent", provider: "mock", historyId: "sent-1" });
  db = new FakeDb({
    email_history: [{ id: DRAFT, organization_id: ORG, to_email: "pay@acme.test", subject: "Overdue invoice INV-1", body: "Hi Acme Ltd\n\nPlease pay", status: "drafted", related_to_type: "invoice", related_to_id: "inv-1" }],
    chase_sends: [{ id: "cs-1", organization_id: ORG, invoice_id: "inv-1", status: "drafted", draft_history_id: DRAFT }],
    invoices: [{ id: "inv-1", organization_id: ORG, customer: "Acme Ltd", invoice_ref: "INV-1", status: "sent", total: 120, amount_paid: 0, credited_amount: 0, refunded_amount: 0, payment_unverified: false }],
    customers: [{ id: "c1", organization_id: ORG, name: "Acme Ltd", email: "Pay@Acme.test" }],
    chase_pauses: [], email_schedules: [], user_profiles: [{ organization_id: ORG, email: "office@jnr.test" }],
  });
  admin = Object.assign(new FakeDb({ email_history: [] }), { rpc: vi.fn().mockResolvedValue({ data: { recorded: true }, error: null }) });
});

describe("Approve and send", () => {
  it("sends the draft through the mailer as the approver, with one key per draft, and records the approval", async () => {
    expect(await approve()).toEqual({ status: "sent", historyId: "sent-1", recorded: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({
      organizationId: ORG, userId: "u-office", kind: "invoice_reminder", to: ["pay@acme.test"], subject: "Overdue invoice INV-1", text: "Hi Acme Ltd\n\nPlease pay",
      html: "Hi Acme Ltd<br>\n<br>\nPlease pay", recordType: "invoice", recordId: "inv-1", idempotencyKey: approveKey(DRAFT),
    });
    expect(admin.rpc).toHaveBeenCalledWith("chase_record_sent", { p_org: ORG, p_draft: DRAFT, p_sent: "sent-1", p_user: "u-office" });
  });
  it("the key fits the mailer and is the same on a retry (so a double click never sends twice)", () => {
    expect(approveKey(DRAFT)).toMatch(/^[A-Za-z0-9:._-]{8,200}$/);
    expect(approveKey(DRAFT)).toBe(approveKey(DRAFT));
  });
  it("an edit in the dialog is saved on the draft, then that text is sent", async () => {
    await approve({ subject: "Invoice INV-1\r\nBcc: x", body: "Edited text" });
    expect(db.rows("email_history")[0]).toMatchObject({ subject: "Invoice INV-1 Bcc: x", body: "Edited text" });
    expect(send.mock.calls[0][0]).toMatchObject({ subject: "Invoice INV-1 Bcc: x", text: "Edited text" });
  });
  it("no mailer set up: says so, sends nothing and writes nothing (the draft stays for copy / mail app / mark sent)", async () => {
    provider = null;
    expect(await approve({ body: "Edited" })).toEqual({ status: "no_provider", message: NO_PROVIDER_MESSAGE });
    expect(send).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(db.rows("email_history")[0]).toMatchObject({ status: "drafted" });
  });
  it("the mailer switched off between the check and the send: the stray second draft is removed, the original stays", async () => {
    send.mockResolvedValueOnce({ ok: true, mode: "drafted", provider: "none", historyId: "stray" });
    admin.rows("email_history").push({ id: "stray", organization_id: ORG, status: "drafted" });
    expect((await approve()).status).toBe("no_provider");
    expect(admin.rows("email_history")).toEqual([]);
    expect(admin.rpc).not.toHaveBeenCalled();
  });
  it("a mailer failure is passed on and nothing is recorded", async () => {
    send.mockResolvedValueOnce({ ok: false, error: "The e-mail service refused this e-mail.", code: "provider_error" });
    expect(await approve()).toEqual({ status: "refused", http: 502, message: "The e-mail service refused this e-mail." });
    expect(admin.rpc).not.toHaveBeenCalled();
  });
});

describe("Approve and send refuses", () => {
  const refusedWith = async (http: number) => {
    const out = await approve();
    expect(out).toMatchObject({ status: "refused", http });
    expect(send).not.toHaveBeenCalled();
  };
  it("a draft that is not a chase draft", async () => { db.tables.chase_sends = []; await refusedWith(400); });
  it("a draft already sent or marked sent", async () => { db.rows("email_history")[0].status = "sent_manually"; await refusedWith(409); });
  it("another company's draft", async () => { db.rows("email_history")[0].organization_id = "org-b"; await refusedWith(404); });
  it("an invoice paid since the draft was made", async () => { Object.assign(db.rows("invoices")[0], { status: "paid", amount_paid: 120 }); await refusedWith(409); });
  it("an invoice with a payment to confirm", async () => { db.rows("invoices")[0].payment_unverified = true; await refusedWith(409); });
  it("an invoice with an open payment claim", async () => { db.rows("invoices")[0].payment_claimed_at = "2026-11-12T10:00:00Z"; await refusedWith(409); });
  it("chasing paused on the invoice", async () => { db.rows("chase_pauses").push({ organization_id: ORG, invoice_id: "inv-1", customer_id: null, paused_until: null }); await refusedWith(409); });
  it("chasing paused for the customer", async () => { db.rows("chase_pauses").push({ organization_id: ORG, invoice_id: null, customer_id: "c1", paused_until: "2026-11-13" }); await refusedWith(409); });
  it("a recipient who is not the customer, a reminder recipient or the team", async () => { db.rows("email_history")[0].to_email = "someone@else.test"; await refusedWith(403); });
  it("but the company's own people are allowed", async () => {
    db.rows("email_history")[0].to_email = "office@jnr.test";
    expect((await approve()).status).toBe("sent");
  });
});
