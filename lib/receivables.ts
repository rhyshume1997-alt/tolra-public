/**
 * What is owed on an invoice and whether it should be collected (audit D23, A2). One rule for the invoice list,
 * aging, late-payer view, chasers and the dashboard.
 *
 *   - Paid invoices are settled. Drafts, void, cancelled and credited invoices are not collectible: they never appear
 *     in money owed, aging or chasers.
 *   - Everything else is collectible (a part paid invoice, status 'partial', included: it stays open until the balance
 *     is cleared), and what is owed is the face value minus receipts and minus the credits applied to it (never below
 *     zero). amount_paid is the sum of the invoice's payments (migration 032); credited_amount the sum of the credit
 *     notes applied to it (migration 034), which are allocations, not payments.
 *   - Overdue means the due date is in the past; due today is not overdue; no due date is "no due date", not late.
 *   - Imported invoices whose payment wasn't recorded (payment_unverified, migration 027) are neither owed nor paid
 *     until someone checks them: they are left out of money owed, aging and chasers, and listed as "payment to confirm".
 */
import { fromPence, toPence } from "@/lib/money";

const NOT_COLLECTIBLE = new Set(["draft", "void", "voided", "cancelled", "canceled", "credited", "written_off"]);

export type InvoiceLifecycle = "paid" | "closed" | "collectible";

/**
 * An invoice's status as the database means it: invoices.status is nullable (000) and the server treats a missing
 * status as a draft (coalesce(status, 'draft') in issue_invoice, the issue lock and the reference check, 027), so the
 * app does too, everywhere it reads the status.
 */
export function invoiceStatus(rawStatus: string | null | undefined): string {
  return String(rawStatus ?? "").trim().toLowerCase() || "draft";
}

export function invoiceLifecycle(rawStatus: string | null | undefined): InvoiceLifecycle {
  const status = invoiceStatus(rawStatus);
  if (status === "paid") return "paid";
  if (NOT_COLLECTIBLE.has(status)) return "closed";
  return "collectible";
}

/**
 * Why a payment can't be recorded on this invoice yet, or null. A draft has no number and isn't owed: it is issued first (the database
 * refuses a payment on one: "<ref> is still a draft: issue it before recording a payment", record_invoice_payment 034). The list's
 * Record payment button, the details dialog and Pay Selected in Full all use this one rule.
 */
export const DRAFT_PAYMENT_REASON = "Issue the invoice before recording a payment";
export function paymentBlockedReason(rawStatus: string | null | undefined): string | null {
  return invoiceStatus(rawStatus) === "draft" ? DRAFT_PAYMENT_REASON : null;
}

/** True while some, but not all, of an invoice has been received (status 'partial', or receipts with a balance left). */
export function isPartPaid(invoice: { status?: string | null; total?: number | null; amount_paid?: number | null; credited_amount?: number | null; refunded_amount?: number | null }): boolean {
  if (invoiceLifecycle(invoice.status) !== "collectible") return false;
  return invoiceStatus(invoice.status) === "partial" || (toPence(Number(invoice.amount_paid) || 0) > 0 && balanceDue(Number(invoice.total) || 0, Number(invoice.amount_paid) || 0, Number(invoice.credited_amount) || 0, Number(invoice.refunded_amount) || 0) > 0);
}

/**
 * Face value minus receipts and minus credits applied, plus what has been refunded or moved to another invoice, in pounds, exact to the
 * penny and never below zero (below zero it is customer credit: see customerCredit).
 */
export function balanceDue(total: number, amountPaid: number, credited = 0, refunded = 0): number {
  return fromPence(Math.max(0, toPence(Number(total) || 0) - toPence(Number(amountPaid) || 0) - toPence(Number(credited) || 0) + toPence(Number(refunded) || 0)));
}

/** What the customer has paid or been credited beyond this invoice, not yet refunded or applied elsewhere (migration 034). */
export function customerCredit(invoice: { status?: string | null; total?: number | null; amount_paid?: number | null; credited_amount?: number | null; refunded_amount?: number | null; payment_unverified?: boolean | null }): number {
  if (invoice.payment_unverified || invoiceStatus(invoice.status) === "draft" || ["void", "voided", "cancelled", "canceled", "written_off"].includes(invoiceStatus(invoice.status))) return 0;
  const surplus = toPence(Number(invoice.amount_paid) || 0) + toPence(Number(invoice.credited_amount) || 0) - toPence(Number(invoice.refunded_amount) || 0) - toPence(Number(invoice.total) || 0);
  return fromPence(Math.max(0, surplus));
}

/** Whole days past the due date (positive = late, 0 = due today, negative = not yet due); null without a due date. */
export function daysPastDue(dueDate: string | null | undefined, today: string): number | null {
  if (!dueDate) return null;
  const day = (iso: string) => Date.parse(`${iso.slice(0, 10)}T00:00:00Z`);
  return Math.round((day(today) - day(dueDate)) / 86_400_000);
}

/** Amount still to collect on an invoice (0 when paid, not collectible, or its payment is still to be confirmed). */
export function owed(invoice: { status?: string | null; total?: number | null; amount_paid?: number | null; credited_amount?: number | null; refunded_amount?: number | null; payment_unverified?: boolean | null }): number {
  if (invoice.payment_unverified) return 0;
  return invoiceLifecycle(invoice.status) === "collectible" ? balanceDue(Number(invoice.total || 0), Number(invoice.amount_paid || 0), Number(invoice.credited_amount || 0), Number(invoice.refunded_amount || 0)) : 0;
}

export type OnTimeInvoice = { status?: string | null; payment_unverified?: boolean | null; due_date?: string | null; paid_at?: string | null };

/**
 * "Paid on time" (go-live polish item 12): of the PAID invoices that have BOTH a due date and a last payment date, the share whose
 * last payment was on or before the due date.
 *   - Only invoices with status paid count; unpaid invoices, due or not, are neither on time nor late.
 *   - The last payment date is invoices.paid_at: the date of the payment that cleared it (record_invoice_payment, migration 032,
 *     sets it from that payment's paid_on).
 *   - A paid invoice without a due date or without a payment date is UNKNOWN: left out of the numerator and the denominator, and
 *     counted in `excluded` so the card can say so ("1 without dates not counted").
 *   - Imported invoices whose payment is still to be confirmed (payment_unverified) are not paid yet: not counted at all.
 * rate = onTime / counted, in whole percent; null when no invoice qualifies (the card shows "—").
 */
export function paidOnTime(invoices: OnTimeInvoice[]): { counted: number; onTime: number; excluded: number; rate: number | null } {
  const paid = invoices.filter((invoice) => invoiceLifecycle(invoice.status) === "paid" && !invoice.payment_unverified);
  const dated = paid.filter((invoice) => invoice.due_date && invoice.paid_at);
  const onTime = dated.filter((invoice) => (invoice.paid_at as string).slice(0, 10) <= (invoice.due_date as string).slice(0, 10));
  return { counted: dated.length, onTime: onTime.length, excluded: paid.length - dated.length, rate: dated.length ? Math.round((onTime.length / dated.length) * 100) : null };
}

/** The line under the figure: "3 of 4 paid on time · 1 without dates not counted". */
export function paidOnTimeNote(result: { counted: number; onTime: number; excluded: number }): string {
  const main = result.counted ? `${result.onTime} of ${result.counted} paid on time` : "No paid invoices with a due date and payment date";
  return result.excluded ? `${main} · ${result.excluded} without dates not counted` : main;
}

/** Invoices raised: issued ones (not drafts, not void or cancelled). */
export function isRaised(status: string | null | undefined): boolean {
  const value = invoiceStatus(status);
  return value !== "draft" && !["void", "voided", "cancelled", "canceled"].includes(value);
}

/**
 * The Status badge on the invoice details. A draft, void, cancelled or credited invoice is "closed" for collecting, but its badge
 * names what it actually is (DRAFT, VOID, ...), the same as the invoice list; "CLOSED" is never shown.
 */
export function invoiceDetailStatusLabel(invoice: { status: string; rawStatus: string; partPaid: boolean }): string {
  if (invoice.status === "paid") return "PAID";
  if (invoice.partPaid) return "PART PAID";
  if (invoice.status === "closed") return invoice.rawStatus.toUpperCase();
  return invoice.status.toUpperCase();
}
