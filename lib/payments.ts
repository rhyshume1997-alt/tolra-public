/**
 * Part payments on invoices (migration 032). The database is the authority: record_invoice_payment and
 * reverse_invoice_payment lock the invoice, apply these same rules and set invoices.amount_paid to the sum of its
 * payments. These helpers repeat the arithmetic for the screen (the balance a dialog starts with, the status a list
 * shows, the history of one invoice) and for the exports, always in whole pence.
 */
import { fromPence, toPence } from "@/lib/money";

export const PAYMENT_METHODS = ["BACS", "cheque", "card", "cash", "other"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** One row of invoice_payments. A reversal has a negative amount, points at the payment it undoes and carries the reason. */
export type InvoicePayment = {
  id: string;
  invoiceId: string;
  /** Positive for a payment, negative for a reversal. */
  amount: number;
  /** YYYY-MM-DD; empty only on a legacy row whose invoice had no paid date. */
  paidOn: string;
  method: string;
  reference: string;
  /** 'recorded' in the app, or 'legacy': carried over from the single amount_paid an invoice had before part payments. */
  source: "recorded" | "legacy";
  reversesPaymentId: string | null;
  voidReason: string;
  createdBy: string | null;
  createdAt: string;
};

/** Maps a row as the API returns it. */
export function paymentFromRow(row: Record<string, unknown>): InvoicePayment {
  return {
    id: String(row.id),
    invoiceId: String(row.invoice_id),
    amount: Number(row.amount || 0),
    paidOn: row.paid_on ? String(row.paid_on).slice(0, 10) : "",
    method: row.method ? String(row.method) : "",
    reference: row.reference ? String(row.reference) : "",
    source: row.source === "legacy" ? "legacy" : "recorded",
    reversesPaymentId: row.reverses_payment_id ? String(row.reverses_payment_id) : null,
    voidReason: row.void_reason ? String(row.void_reason) : "",
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: row.created_at ? String(row.created_at) : "",
  };
}

/** Everything received so far, net of reversals (this is what invoices.amount_paid holds). */
export function netPaid(payments: Pick<InvoicePayment, "amount">[]): number {
  return fromPence(payments.reduce((sum, payment) => sum + toPence(payment.amount), 0));
}

/** Ids of the payments that have been reversed. */
export function reversedIds(payments: Pick<InvoicePayment, "reversesPaymentId">[]): Set<string> {
  return new Set(payments.flatMap((payment) => (payment.reversesPaymentId ? [payment.reversesPaymentId] : [])));
}

export type PaidState = "unpaid" | "partial" | "paid";

/** Where an invoice of this total stands once this much has been received. */
export function paidState(total: number, amountPaid: number): PaidState {
  const paid = toPence(Number(amountPaid) || 0);
  if (paid <= 0) return "unpaid";
  return paid >= toPence(Number(total) || 0) ? "paid" : "partial";
}

/**
 * Why a payment of this size can't be recorded against this balance (the server refuses the same ones), or null.
 * Both in pounds: a payment is more than zero, to the penny, and no more than the balance due.
 */
export function paymentAmountProblem(amount: number, balance: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return "Enter an amount more than zero.";
  if (Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) return "Enter the amount in pounds and pence (two decimal places at most).";
  if (toPence(amount) > toPence(balance)) return `That is more than the balance due (£${balance.toFixed(2)}).`;
  return null;
}

/** A payment can't be dated in the future (both dates YYYY-MM-DD). */
export function paymentDateProblem(paidOn: string, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn)) return "Enter the date the payment was received.";
  if (paidOn > today) return "The payment date can't be in the future.";
  return null;
}

/**
 * What the year-end export and money screens may say an invoice has been paid. Returns null when it is not known and
 * must not be guessed: an imported invoice still flagged payment_unverified, or one marked paid whose payments were
 * never recorded (amount_paid 0 and no rows).
 */
export function knownPaid(invoice: { status?: string | null; amount_paid?: number | string | null; payment_unverified?: boolean | null }): number | null {
  if (invoice.payment_unverified) return null;
  const paid = Number(invoice.amount_paid || 0);
  if (String(invoice.status ?? "").trim().toLowerCase() === "paid" && toPence(paid) === 0) return null;
  return fromPence(toPence(paid));
}

/**
 * What the Payments section of an invoice says when it has no payment rows to list. The "marked paid before payments
 * were recorded" wording is only true once the rows have been fetched and there are none (and nothing is held as
 * received): while they are still being fetched, or when the figures and the rows disagree, it must not be said.
 */
export function paymentsEmptyText(state: { loaded: boolean; status: string; amountPaid: number }): string {
  if (!state.loaded) return "Loading payments…";
  if (toPence(Number(state.amountPaid) || 0) > 0) return "The payments recorded on this invoice could not be listed. Reload the page to try again.";
  return state.status === "paid" ? "Marked paid before payments were recorded: no amounts or dates are held." : "No payments recorded yet.";
}
