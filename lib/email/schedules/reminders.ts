// Invoice reminders (E12): for one schedule period, an e-mail for each issued, unpaid, non-void invoice that is past its due date, at most
// one per invoice per period (invoice_reminder_sends, migration 108). "Owed" is lib/receivables' one rule (the invoice list, aging, the
// "Chase All Overdue" button and the dashboard use it): not a draft/void/cancelled/credited invoice, not a payment still to confirm, a
// balance left after receipts and credits, and a due date before today (due today is not overdue).
import type { SupabaseClient } from "@supabase/supabase-js";

import { type EmailScheduleRow, StoreError, loadCompanyName, loadTemplateOverride, readAll } from "@/lib/email/schedules/store";
import { type Occurrence, localDate } from "@/lib/email/schedules/due";
import { scheduleEmailKey } from "@/lib/email/schedules/keys";
import { renderInvoiceReminder } from "@/lib/email/schedules/render";
import { sendCompanyEmail } from "@/lib/email/send-company-email";
import { fmtDate } from "@/lib/dates";
import { fromPence, gbp, toPence } from "@/lib/money";
import { balanceDue, daysPastDue, invoiceLifecycle } from "@/lib/receivables";

export type ReminderInvoiceRow = {
  id: string;
  invoice_ref: string | null;
  customer: string;
  total: number | string | null;
  amount_paid: number | string | null;
  credited_amount: number | string | null;
  refunded_amount: number | string | null;
  status: string | null;
  due_date: string | null;
  payment_unverified: boolean | null;
};
export type ReminderInvoice = ReminderInvoiceRow & { balance: number; daysOverdue: number };

/** What a run reports (counts only). `retryable`: the same period may safely be tried again (nothing is sent twice). */
export type ExecResult = { sent: number; drafted: number; skipped: number; failed: number; error: string | null; retryable: boolean };

const INVOICE_COLUMNS = "id, invoice_ref, customer, total, amount_paid, credited_amount, refunded_amount, status, due_date, payment_unverified";
/** Statuses the database query leaves out (the same words as lib/receivables NOT_COLLECTIBLE, plus paid); the pure filter below decides again. */
const EXCLUDED_STATUSES = "(draft,void,voided,cancelled,canceled,credited,written_off,paid)";

/** The invoices to remind about on `today` (YYYY-MM-DD), oldest due first. */
export function reminderCandidates(rows: ReminderInvoiceRow[], today: string): ReminderInvoice[] {
  const out: ReminderInvoice[] = [];
  for (const row of rows) {
    if (!row.invoice_ref) continue; // a number means issued (invoices_issued_have_number)
    if (invoiceLifecycle(row.status) !== "collectible") continue;
    if (row.payment_unverified) continue;
    const days = daysPastDue(row.due_date, today);
    if (days === null || days <= 0) continue;
    const balance = balanceDue(Number(row.total) || 0, Number(row.amount_paid) || 0, Number(row.credited_amount) || 0, Number(row.refunded_amount) || 0);
    if (balance <= 0) continue;
    out.push({ ...row, balance, daysOverdue: days });
  }
  return out.sort((a, b) => (a.due_date ?? "").localeCompare(b.due_date ?? "") || a.id.localeCompare(b.id));
}

const looksLikeEmail = (value: string) => /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(value) && value.length <= 254;

type CustomerContact = { name: string; email: string | null; contact_name: string | null };

export type ReminderDeps = { send: typeof sendCompanyEmail; deadline?: number; clock?: () => number };

/**
 * Sends one period of reminders. A reminder is claimed in invoice_reminder_sends BEFORE it is sent (so two runs never both send it) and
 * the claim is released if the send fails, so the next try (same period, up to 3 times) sends only what is left.
 */
export async function runInvoiceReminders(admin: SupabaseClient, schedule: EmailScheduleRow, occurrence: Occurrence, now: Date, deps: ReminderDeps = { send: sendCompanyEmail }): Promise<ExecResult> {
  const result: ExecResult = { sent: 0, drafted: 0, skipped: 0, failed: 0, error: null, retryable: true };
  const org = schedule.organization_id;
  const today = localDate(now, schedule.timezone ?? "Europe/London");

  const rows = await readAll<ReminderInvoiceRow>((from, to) => admin.from("invoices").select(INVOICE_COLUMNS).eq("organization_id", org)
    .not("due_date", "is", null).lt("due_date", today).not("status", "in", EXCLUDED_STATUSES).order("due_date").order("id").range(from, to));
  const invoices = reminderCandidates(rows, today);
  if (!invoices.length) return result;

  const fixed = (schedule.recipients ?? []).filter(looksLikeEmail);
  const customers = new Map<string, CustomerContact>();
  if (!fixed.length) {
    const list = await readAll<CustomerContact>((from, to) => admin.from("customers").select("name, email, contact_name").eq("organization_id", org).not("email", "is", null).order("id").range(from, to));
    for (const c of list) if (c.email && looksLikeEmail(c.email.trim())) customers.set(c.name.trim().toLowerCase(), c);
  }
  const [companyName, override] = await Promise.all([loadCompanyName(admin, org), loadTemplateOverride(admin, org, "invoice_reminder")]);
  const clock = deps.clock ?? Date.now;
  const failureCodes = new Set<string>();
  let stoppedEarly = false;

  for (const invoice of invoices) {
    if (deps.deadline !== undefined && clock() > deps.deadline) {
      stoppedEarly = true;
      break;
    }
    const customer = customers.get(invoice.customer.trim().toLowerCase());
    const to = fixed.length ? fixed : customer?.email ? [customer.email.trim()] : [];
    if (!to.length) {
      result.skipped += 1; // no address for this customer
      continue;
    }
    const claim = await admin.from("invoice_reminder_sends").upsert({ invoice_id: invoice.id, schedule_id: schedule.id, period_key: occurrence.periodKey },
      { onConflict: "invoice_id,schedule_id,period_key", ignoreDuplicates: true }).select("invoice_id");
    if (claim.error) throw new StoreError("claim reminder", claim.error.code);
    if ((claim.data ?? []).length === 0) {
      result.skipped += 1; // already reminded in this period
      continue;
    }
    const release = () => admin.from("invoice_reminder_sends").delete().eq("invoice_id", invoice.id).eq("schedule_id", schedule.id).eq("period_key", occurrence.periodKey);
    try {
      // "total" is what the invoice came to before receipts (balance + received), so "received X, leaving Y to pay" always adds up;
      // credits and refunds change only the balance. The greeting, days ("5 days") and payment note come from E11's invoiceReminderVars.
      const received = Number(invoice.amount_paid) || 0;
      const mail = renderInvoiceReminder({
        reference: invoice.invoice_ref ?? "",
        total: gbp(fromPence(toPence(invoice.balance) + toPence(received)), 2),
        dueDate: fmtDate(invoice.due_date),
        daysOverdue: invoice.daysOverdue,
        companyName,
        customerName: invoice.customer,
        contactName: customer?.contact_name,
        amountPaid: received,
        paidText: gbp(received, 2),
        balanceText: gbp(invoice.balance, 2),
      }, override);
      const sent = await deps.send({
        organizationId: org, userId: null, kind: "invoice_reminder", to, subject: mail.subject, text: mail.text, html: mail.html,
        recordType: "invoice", recordId: invoice.id, idempotencyKey: scheduleEmailKey("invoice_reminder", schedule.id, occurrence.periodKey, invoice.id),
      });
      if (sent.ok) {
        result.sent += 1;
        if (sent.mode === "drafted") result.drafted += 1;
      } else {
        await release();
        result.failed += 1;
        failureCodes.add(sent.code);
      }
    } catch {
      await Promise.resolve(release()).catch(() => undefined);
      result.failed += 1;
      failureCodes.add("unexpected");
    }
  }
  const problems = [
    result.failed ? `${result.failed} reminder${result.failed === 1 ? "" : "s"} not sent (${[...failureCodes].sort().join(", ")})` : "",
    stoppedEarly ? "stopped at the time limit; the rest goes on the next try" : "",
  ].filter(Boolean);
  result.error = problems.length ? problems.join("; ") : null;
  return result;
}
