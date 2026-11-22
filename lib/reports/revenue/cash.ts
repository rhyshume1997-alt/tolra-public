/**
 * Revenue, basis 2: CASH RECEIVED. Pure: rows in, figures out.
 *
 * Inputs: invoice_payments rows (amount, paid_on, invoice_id), the customer names of the invoices they were paid against, a date range
 * (London dates, both ends included) and an optional customer. Output: money received per London month by the date paid, reversals
 * (negative rows) included on their own date, and the same money per customer. Months are worked out by receivedByMonth (lib/numbers),
 * so they agree with the Numbers page.
 * A payment belongs to its invoice's customer name (the same name text the invoiced basis uses). A payment whose invoice can't be
 * read (not returned: row-level security, or gone) goes to "Customer not known": never dropped, never guessed. Shares per customer
 * add to exactly 100. Cash is a basis of its own: no figure here is ever added to invoiced or pipeline.
 * Must not change: the agreement with receivedByMonth; the "Customer not known" row.
 */
import { calendarDate } from "@/lib/dates";
import { fromPence, toPence } from "@/lib/money";
import { receivedByMonth, type NumberPayment } from "@/lib/numbers";
import { sharesOf } from "@/lib/reports/revenue/by-customer";
import { customerName, inRange, periodsForRange, type RevenueRange } from "@/lib/reports/revenue/invoiced";

export const CUSTOMER_NOT_KNOWN = "Customer not known";

export type CashPayment = NumberPayment & { invoice_id?: string | null };
export type PaymentInvoice = { id?: string | null; customer?: string | null };

export type CashMonth = { key: string; label: string; received: number };
export type CashResult = { months: CashMonth[]; receivedTotal: number };
export type CashCustomerRow = { cashCustomer: string; cashReceived: number; cashShare: number | null };
export type CashCustomerResult = { cashRows: CashCustomerRow[]; cashCustomerTotal: number };

/** The customer a payment belongs to, by its invoice's name text; "Customer not known" when the invoice was not returned. */
export function paymentCustomer(payment: CashPayment, invoices: PaymentInvoice[]): string {
  const invoice = payment.invoice_id ? invoices.find((row) => row.id === payment.invoice_id) : undefined;
  return invoice ? customerName(invoice.customer) : CUSTOMER_NOT_KNOWN;
}

/** The payments in the range and, when a customer is chosen, on that customer's invoices. */
function paymentsInScope(payments: CashPayment[], invoices: PaymentInvoice[], range: RevenueRange, customer: string | null): CashPayment[] {
  const byId = new Map(invoices.map((row) => [row.id, customerName(row.customer)]));
  return payments.filter((p) => inRange(calendarDate(p.paid_on), range) && (!customer || (p.invoice_id ? byId.get(p.invoice_id) ?? CUSTOMER_NOT_KNOWN : CUSTOMER_NOT_KNOWN) === customer));
}

export function cashRevenue(payments: CashPayment[], invoices: PaymentInvoice[], range: RevenueRange, customer: string | null = null): CashResult {
  const periods = periodsForRange(range);
  const byMonth = receivedByMonth(paymentsInScope(payments, invoices, range, customer), periods);
  const months = periods.map((p) => ({ key: p.key, label: p.label, received: byMonth.get(p.key) ?? 0 }));
  return { months, receivedTotal: fromPence(months.reduce((sum, m) => sum + toPence(m.received), 0)) };
}

export function cashByCustomer(payments: CashPayment[], invoices: PaymentInvoice[], range: RevenueRange, customer: string | null = null): CashCustomerResult {
  const byId = new Map(invoices.map((row) => [row.id, customerName(row.customer)]));
  const pence = new Map<string, number>();
  for (const payment of paymentsInScope(payments, invoices, range, customer)) {
    const name = payment.invoice_id ? byId.get(payment.invoice_id) ?? CUSTOMER_NOT_KNOWN : CUSTOMER_NOT_KNOWN;
    pence.set(name, (pence.get(name) ?? 0) + toPence(Number(payment.amount ?? 0) || 0));
  }
  const entries = [...pence].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shares = sharesOf(entries.map(([, v]) => v));
  return {
    cashRows: entries.map(([name, v], i) => ({ cashCustomer: name, cashReceived: fromPence(v), cashShare: shares ? shares[i] : null })),
    cashCustomerTotal: fromPence(entries.reduce((sum, [, v]) => sum + v, 0)),
  };
}
