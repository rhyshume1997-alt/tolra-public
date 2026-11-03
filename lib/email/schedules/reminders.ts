// Invoice reminders (E12; since 138 the chase steps): for one schedule period, a DRAFT for each owed invoice that has reached a chase step
// (lib/email/chase/run.ts). reminderCandidates below is the overdue rule as it was (kept with its tests). "Owed" is lib/receivables' one rule (the invoice list, aging, the
// "Chase All Overdue" button and the dashboard use it): not a draft/void/cancelled/credited invoice, not a payment still to confirm, a
// balance left after receipts and credits, and a due date before today (due today is not overdue).
import type { SupabaseClient } from "@supabase/supabase-js";

import { type ChaseDeps, runChase } from "@/lib/email/chase/run";
import type { EmailScheduleRow } from "@/lib/email/schedules/store";
import { type Occurrence, localDate } from "@/lib/email/schedules/due";
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

export type ReminderDeps = { deadline?: number; clock?: () => number; createDraft?: ChaseDeps["createDraft"] };

/**
 * One period of the invoice_reminder schedule (138): DRAFTS ONLY. Each owed invoice gets the chase step it is due for today, at most once
 * per step (lib/email/chase/run.ts, public.chase_create_draft), as a draft in the Approvals queue; nothing is e-mailed until an office or
 * admin user approves it. Before 138 a run e-mailed every overdue invoice through the company mailer once per period; that path is gone
 * (invoice_reminder_sends is no longer written). Until 138 is applied a run drafts nothing and records "database update 138 not applied".
 */
export async function runInvoiceReminders(admin: SupabaseClient, schedule: EmailScheduleRow, occurrence: Occurrence, now: Date, deps: ReminderDeps = {}): Promise<ExecResult> {
  void occurrence; // each step is once per invoice, whatever the period
  const { reasons, ...result } = await runChase(admin, {
    organizationId: schedule.organization_id,
    today: localDate(now, schedule.timezone ?? "Europe/London"),
    recipients: schedule.recipients,
    userId: null,
  }, { deadline: deps.deadline, clock: deps.clock, createDraft: deps.createDraft });
  void reasons;
  return result;
}
