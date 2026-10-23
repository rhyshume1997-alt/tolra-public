/**
 * What an invoice's PDF may say about payment (migration 032). One rule for the invoice screen's PDF and the year-end
 * export: only an amount that is known is printed. An imported invoice whose payment is still to be confirmed, or one
 * marked paid whose amount was never recorded, prints the Total with no Paid / Balance due rows and no PAID stamp: nothing
 * is assumed.
 */
import { fromPence, toPence } from "@/lib/money";
import { knownPaid } from "@/lib/payments";
import { balanceDue, invoiceLifecycle } from "@/lib/receivables";

/**
 * The "Less credit notes" amount for an invoice's PDF: only when the company's setting is on and there is something to show. The PDF's
 * Balance due (total - payments - this) must equal the balance the screen shows, which is total - payments - credits applied + refunds
 * (lib/receivables balanceDue, never below zero). So this is the part of the credits (credit notes, and customer credit applied from
 * other invoices) that is still standing after refunds, and no more than the invoice still owed after payments: credit beyond that is
 * customer credit, which stays off the invoice PDF.
 */
export function invoicePdfCredits(invoice: { credited_amount?: number | string | null; refunded_amount?: number | string | null; total?: number | string | null; amount_paid?: number | string | null }, company: { showCreditsInBalance?: boolean }): { credits?: number } {
  const paid = Number(invoice.amount_paid || 0);
  const net = toPence(Number(invoice.credited_amount || 0)) - toPence(Number(invoice.refunded_amount || 0)); // credits still standing
  let credits = Math.max(0, net);
  if (invoice.total !== undefined && invoice.total !== null) {
    const total = Number(invoice.total);
    const screenBalance = balanceDue(total, paid, Number(invoice.credited_amount || 0), Number(invoice.refunded_amount || 0));
    credits = Math.max(0, toPence(total) - toPence(paid) - toPence(screenBalance));
  }
  return company.showCreditsInBalance === true && credits > 0 ? { credits: fromPence(credits) } : {};
}

export function invoicePdfPayments(invoice: { status?: string | null; amount_paid?: number | string | null; payment_unverified?: boolean | null }): { payments?: number; paid: boolean; paymentUnknown: boolean } {
  const known = knownPaid(invoice);
  if (known === null) return { paid: false, paymentUnknown: true };
  return { payments: known, paid: invoiceLifecycle(invoice.status) === "paid", paymentUnknown: false };
}
