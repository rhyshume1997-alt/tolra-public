import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { type EmailScheduleRow } from "@/lib/email/schedules/store";
import { type ReminderInvoiceRow, reminderCandidates, runInvoiceReminders } from "@/lib/email/schedules/reminders";
import { dueOccurrence } from "@/lib/email/schedules/due";
import type { CompanyEmailInput, CompanyEmailResult } from "@/lib/email/send-company-email";
import { FakeDb } from "../support/fake-db";

const ORG = "org-a";
const inv = (id: string, extra: Partial<ReminderInvoiceRow> = {}): ReminderInvoiceRow => ({
  id, invoice_ref: `INV-${id}`, customer: "Acme Ltd", total: 120, amount_paid: 0, credited_amount: 0, refunded_amount: 0, status: "sent", due_date: "2026-10-01", payment_unverified: false, ...extra,
});

describe("which invoices get a reminder", () => {
  const today = "2026-10-26";
  const pick = (rows: ReminderInvoiceRow[]) => reminderCandidates(rows, today).map((r) => r.id);

  it("issued, unpaid, past due: yes", () => {
    expect(pick([inv("1")])).toEqual(["1"]);
  });
  it.each([
    ["a draft", { status: "draft", invoice_ref: null }],
    ["a missing status (a draft)", { status: null, invoice_ref: null }],
    ["a draft that somehow has a number", { status: "draft" }],
    ["void", { status: "void" }],
    ["voided", { status: "voided" }],
    ["cancelled", { status: "cancelled" }],
    ["credited", { status: "credited" }],
    ["written off", { status: "written_off" }],
    ["paid", { status: "paid", amount_paid: 120 }],
    ["not numbered yet", { invoice_ref: null }],
    ["a payment still to confirm", { payment_unverified: true }],
    ["no due date", { due_date: null }],
    ["due today", { due_date: "2026-10-26" }],
    ["due tomorrow", { due_date: "2026-10-27" }],
    ["fully received but status not yet 'paid'", { amount_paid: 120 }],
    ["fully credited", { credited_amount: 120 }],
    ["overpaid", { amount_paid: 150 }],
  ])("never for %s", (_name, change) => {
    expect(pick([inv("1", change as Partial<ReminderInvoiceRow>)])).toEqual([]);
  });

  it("a part-paid invoice is reminded for the balance; the case and spaces of a status don't matter", () => {
    const [one] = reminderCandidates([inv("1", { status: " Partial ", amount_paid: 20, total: "120.00" })], today);
    expect(one).toMatchObject({ balance: 100, daysOverdue: 25 });
    expect(pick([inv("2", { status: "SENT" })])).toEqual(["2"]);
  });

  it("a refund adds back what is owed; credits take it off", () => {
    expect(reminderCandidates([inv("1", { amount_paid: 120, refunded_amount: 30 })], today)[0].balance).toBe(30);
    expect(reminderCandidates([inv("2", { credited_amount: 20 })], today)[0].balance).toBe(100);
  });

  it("oldest due first", () => {
    expect(pick([inv("b", { due_date: "2026-10-10" }), inv("a", { due_date: "2026-09-01" })])).toEqual(["a", "b"]);
  });
});

describe("running a period of reminders", () => {
  const schedule: EmailScheduleRow = {
    id: "sch-1", organization_id: ORG, kind: "invoice_reminder", enabled: true, frequency: "daily", weekday: null, time_of_day: "08:00", run_at: null,
    timezone: "Europe/London", recipients: null, last_run_at: null, updated_at: "2026-10-01T00:00:00Z",
  };
  const now = new Date("2026-10-26T09:00:00Z");
  const occurrence = dueOccurrence(schedule, now)!;
  const send = vi.fn<(input: CompanyEmailInput) => Promise<CompanyEmailResult>>();
  let db: FakeDb;

  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({ ok: true, mode: "sent", provider: "mock" });
    db = new FakeDb({
      invoices: [
        { organization_id: ORG, ...inv("1") },
        { organization_id: ORG, ...inv("2", { customer: "No Email Ltd" }) },
        { organization_id: ORG, ...inv("3", { status: "paid", amount_paid: 120 }) },
        { organization_id: ORG, ...inv("4", { status: "void" }) },
        { organization_id: "org-b", ...inv("9") },
      ],
      customers: [
        { organization_id: ORG, name: " acme LTD ", email: "pay@acme.test", contact_name: "Pat" },
        { organization_id: ORG, name: "No Email Ltd", email: null },
        { organization_id: "org-b", name: "Acme Ltd", email: "other@b.test" },
      ],
      organizations: [{ id: ORG, name: "JNR Engineering" }],
      organization_settings: [{ organization_id: ORG, company_profile: { name: "JNR" } }],
    });
  });

  const run = (s = schedule) => runInvoiceReminders(db as never, s, occurrence, now, { send });

  it("sends one reminder to the customer's address for the overdue unpaid invoice only, from this company only", async () => {
    const out = await run();
    expect(out).toMatchObject({ sent: 1, drafted: 0, skipped: 1, failed: 0, error: null, retryable: true });
    expect(send).toHaveBeenCalledTimes(1);
    const mail = send.mock.calls[0][0];
    expect(mail).toMatchObject({ organizationId: ORG, kind: "invoice_reminder", to: ["pay@acme.test"], recordType: "invoice", recordId: "1", idempotencyKey: "invoice_reminder:sch-1:2026-10-26:1" });
    expect(mail.subject).toContain("INV-1");
    expect(mail.text).toContain("Pat");
    expect(mail.text).toContain("£120.00");
    expect(mail.text).toContain("25 days overdue");
    expect(mail.text).toContain("JNR");
  });

  it("dedupe: the same period never sends the same invoice twice, however often it runs", async () => {
    await run();
    await run();
    await run();
    expect(send).toHaveBeenCalledTimes(1);
    expect(db.rows("invoice_reminder_sends")).toHaveLength(1);
  });

  it("the next period reminds again", async () => {
    await run();
    const tomorrow = new Date("2026-10-27T09:00:00Z");
    await runInvoiceReminders(db as never, schedule, dueOccurrence(schedule, tomorrow)!, tomorrow, { send });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].idempotencyKey).toBe("invoice_reminder:sch-1:2026-10-27:1");
  });

  it("an invoice paid since the last period is not reminded", async () => {
    await run();
    db.rows("invoices").find((r) => r.id === "1")!.status = "paid";
    const tomorrow = new Date("2026-10-27T09:00:00Z");
    await runInvoiceReminders(db as never, schedule, dueOccurrence(schedule, tomorrow)!, tomorrow, { send });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("fixed recipients replace the customer's address, even for a customer with none", async () => {
    const out = await run({ ...schedule, recipients: ["collections@jnr.test"] });
    expect(out.sent).toBe(2);
    expect(send.mock.calls.map((c) => c[0].to)).toEqual([["collections@jnr.test"], ["collections@jnr.test"]]);
  });

  it("a failed send gives its claim back, is counted, and the next try sends only what is left", async () => {
    send.mockResolvedValueOnce({ ok: false, error: "x@y.test refused", code: "provider_error" });
    const first = await run();
    expect(first).toMatchObject({ sent: 0, failed: 1, retryable: true });
    expect(first.error).toBe("1 reminder not sent (provider_error)");
    expect(first.error).not.toContain("y.test"); // never an address
    expect(db.rows("invoice_reminder_sends")).toHaveLength(0);
    const second = await run();
    expect(second).toMatchObject({ sent: 1, failed: 0, error: null });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a sender that throws is counted and does not stop the other invoices", async () => {
    db.rows("customers").push({ organization_id: ORG, name: "No Email Ltd", email: "x@noemail.test" });
    db.tables.customers = db.rows("customers").filter((r) => !(r.name === "No Email Ltd" && r.email === null));
    send.mockRejectedValueOnce(new Error("boom: a@b.test"));
    const out = await run();
    expect(out).toMatchObject({ sent: 1, failed: 1 });
    expect(out.error).toBe("1 reminder not sent (unexpected)");
  });

  it("drafted mode (no provider configured) counts as drafted", async () => {
    send.mockResolvedValue({ ok: true, mode: "drafted", provider: "none" });
    expect(await run()).toMatchObject({ sent: 1, drafted: 1 });
  });

  it("stops at the time limit and says so; the rest goes on the next try", async () => {
    const out = await runInvoiceReminders(db as never, { ...schedule, recipients: ["c@j.test"] }, occurrence, now, { send, deadline: 1000, clock: () => 2000 });
    expect(out.sent).toBe(0);
    expect(out.error).toBe("stopped at the time limit; the rest goes on the next try");
    expect(send).not.toHaveBeenCalled();
  });

  it("uses the company's own wording when it has saved some, and the default otherwise", async () => {
    db.rows("email_templates").push({ organization_id: ORG, key: "invoice_reminder", subject: "Pay up {{document_number}}", body: "Dear {{customer_name}}, {{total}} please." });
    await run();
    expect(send.mock.calls[0][0]).toMatchObject({ subject: "Pay up INV-1", text: "Dear Pat, £120.00 please." });
  });

  it("reads the right company only (a customer of the same name in another company is not used)", async () => {
    db.tables.customers = db.rows("customers").filter((r) => r.organization_id !== ORG || r.name === "No Email Ltd");
    const out = await run();
    expect(out.sent).toBe(0);
    expect(out.skipped).toBe(2);
    expect(JSON.stringify(send.mock.calls)).not.toContain("other@b.test");
  });
});
