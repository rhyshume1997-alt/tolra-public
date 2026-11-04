import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { type EmailScheduleRow } from "@/lib/email/schedules/store";
import { type ReminderDeps, type ReminderInvoiceRow, reminderCandidates, runInvoiceReminders } from "@/lib/email/schedules/reminders";
import { dueOccurrence } from "@/lib/email/schedules/due";
import type { ChaseDeps } from "@/lib/email/chase/run";
import { scheduleEmailKey } from "@/lib/email/schedules/keys";
import { FakeDb } from "../support/fake-db";

const MAILER_KEY = /^[A-Za-z0-9_-]{8,100}$/; // lib/email/send-company-email.ts accepts only this

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

describe("idempotency keys fit the mailer", () => {
  it("only [A-Za-z0-9_-], 8 to 100 characters, even for a 'once' period key (an ISO time) and long ids", () => {
    const uuid = "8f14e45f-ceea-467a-9575-5c0a1f1b2c3d";
    for (const key of [
      scheduleEmailKey("invoice_reminder", uuid, "2026-11-03T14:30:00.000Z", uuid),
      scheduleEmailKey("timesheet", uuid, "2026-W44", uuid),
      scheduleEmailKey("invoice_reminder", "s", "k", "i"),
    ]) expect(key).toMatch(MAILER_KEY);
  });
  it("the same input gives the same key; any part changing gives another; parts can't be shuffled into each other", () => {
    expect(scheduleEmailKey("invoice_reminder", "a", "b", "c")).toBe(scheduleEmailKey("invoice_reminder", "a", "b", "c"));
    const keys = new Set([scheduleEmailKey("invoice_reminder", "a", "b", "c"), scheduleEmailKey("invoice_reminder", "a", "b", "d"), scheduleEmailKey("invoice_reminder", "a", "x", "c"),
      scheduleEmailKey("invoice_reminder", "x", "b", "c"), scheduleEmailKey("timesheet", "a", "b", "c"), scheduleEmailKey("invoice_reminder", "ab", "c"), scheduleEmailKey("invoice_reminder", "a", "bc")]);
    expect(keys.size).toBe(7);
  });
});

// 138: a run of the invoice_reminder schedule only DRAFTS (lib/email/chase/run.ts, tested in tests/unit/chase-run.test.ts). Before 138 it
// e-mailed each overdue invoice through the company mailer once per period; that path is gone, so these tests prove it never sends.
describe("running a period of reminders (138: chase drafts, never a send)", () => {
  const schedule: EmailScheduleRow = {
    id: "sch-1", organization_id: ORG, kind: "invoice_reminder", enabled: true, frequency: "daily", weekday: null, time_of_day: "08:00", run_at: null,
    timezone: "Europe/London", recipients: null, last_run_at: null, updated_at: "2026-10-01T00:00:00Z",
  };
  const now = new Date("2026-10-26T09:00:00Z");
  const occurrence = dueOccurrence(schedule, now)!;
  const createDraft = vi.fn<NonNullable<ChaseDeps["createDraft"]>>();
  let db: FakeDb;

  beforeEach(() => {
    createDraft.mockReset();
    createDraft.mockImplementation(async (_admin, args) => ({ created: true, history_id: `h-${args.invoiceId}` }));
    db = new FakeDb({
      invoices: [
        { organization_id: ORG, job_id: null, ...inv("1") },
        { organization_id: ORG, job_id: null, ...inv("3", { status: "paid", amount_paid: 120 }) },
        { organization_id: "org-b", job_id: null, ...inv("9") },
      ],
      customers: [{ id: "c1", organization_id: ORG, name: " acme LTD ", email: "pay@acme.test", contact_name: "Pat" }],
      chase_steps: [{ id: "s7", organization_id: ORG, offset_days: 7, tone: "friendly" }, { id: "s30", organization_id: ORG, offset_days: 30, tone: "final" }],
      chase_pauses: [], chase_sends: [],
      organizations: [{ id: ORG, name: "JNR Engineering" }],
      organization_settings: [{ organization_id: ORG, company_profile: { name: "JNR" } }],
    });
  });

  it("drafts the step due (25 days late: the 7-day friendly step) for this company's owed invoice only, and sends nothing", async () => {
    const out = await runInvoiceReminders(db as never, schedule, occurrence, now, { createDraft });
    expect(out).toMatchObject({ sent: 0, drafted: 1, failed: 0, error: null, retryable: true });
    expect(createDraft).toHaveBeenCalledTimes(1);
    const args = createDraft.mock.calls[0][1];
    expect(args).toMatchObject({ organizationId: ORG, invoiceId: "1", stepId: "s7", to: "pay@acme.test", userId: null });
    // ChatGPT's renderChase wording (lib/chase/steps.ts) is the default for every tone.
    expect(args.subject).toBe("Payment reminder: invoice INV-1");
    expect(args.body).toBe("Hello Acme Ltd,\n\nWe have not yet recorded payment of £120.00 for invoice INV-1, which was due on 01/10/2026. Please let us know when payment is arranged.\n\nIf you have already paid, please let us know so we can check our records.\n\nKind regards,\nJNR");
    expect(db.rows("invoice_reminder_sends")).toHaveLength(0);
  });

  it("the deps take no mailer at all: there is nothing a run could send with", () => {
    const deps: ReminderDeps = { createDraft };
    expect(Object.keys(deps)).toEqual(["createDraft"]);
  });

  it("fixed recipients replace the customer's address", async () => {
    await runInvoiceReminders(db as never, { ...schedule, recipients: ["collections@jnr.test"] }, occurrence, now, { createDraft });
    expect(createDraft.mock.calls[0][1].to).toBe("collections@jnr.test");
  });

  it("stops at the time limit and says so", async () => {
    const out = await runInvoiceReminders(db as never, schedule, occurrence, now, { createDraft, deadline: 1000, clock: () => 2000 });
    expect(out.drafted).toBe(0);
    expect(out.error).toBe("stopped at the time limit; the rest goes on the next try");
    expect(createDraft).not.toHaveBeenCalled();
  });
});
