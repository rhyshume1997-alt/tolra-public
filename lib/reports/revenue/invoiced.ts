/**
 * Revenue, basis 1: INVOICED (ex VAT, less credit notes). Pure: rows in, figures out; nothing here reads a database.
 *
 * Inputs: invoices and credit notes (the row types of lib/numbers), a date range (London dates, both ends included) and an optional
 * customer name. Output: invoiced ex VAT per London month, and their sum (null when any counted invoice has no figures).
 * The rules are lib/numbers' own: isInvoiced and invoiceNetPence (lib/overview-metrics) decide what counts and for how much, and the
 * month figures come from invoicedByMonth, so this page cannot drift from the Numbers page (tests/unit/revenue-invoiced.test.ts).
 * Customers are matched by the name text on the invoice, not by customer id.
 * Must not change: these rules without changing lib/numbers first; and no figure here may be added to cash or pipeline.
 */
import { calendarDate } from "@/lib/dates";
import {
  invoicedByMonth,
  londonMonthsEnding,
  sumOrNull,
  type NumberCredit,
  type NumberInvoice,
  type Period,
} from "@/lib/numbers";

/** A chosen stretch of London dates, YYYY-MM-DD, `from` and `to` both included. */
export type RevenueRange = { from: string; to: string };

/** The name a customer is matched by (the same fallback as lib/numbers). */
export const customerName = (name: string | null | undefined) => (name ?? "").trim() || "No customer";

/** The London day an invoice counts on: its invoice date, else the day it was made (as lib/numbers). */
export const invoiceDayOf = (row: Pick<NumberInvoice, "invoice_date" | "created_at">) => calendarDate(row.invoice_date) || calendarDate(row.created_at);

export const inRange = (day: string, range: RevenueRange) => day !== "" && day >= range.from && day <= range.to;

/** The day after a London date (YYYY-MM-DD), used as the exclusive end of a query. */
export function dayAfter(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** The London calendar months the range touches, oldest first. */
export function periodsForRange(range: RevenueRange): Period[] {
  const [fy, fm] = range.from.split("-").map(Number);
  const [ty, tm] = range.to.split("-").map(Number);
  const count = Math.max(1, (ty - fy) * 12 + (tm - fm) + 1);
  return londonMonthsEnding(new Date(`${range.to}T12:00:00Z`), count);
}

/** Invoices whose counting day is in the range (and of the customer, when one is chosen). Status is left to isInvoiced. */
export function invoicesInScope(invoices: NumberInvoice[], range: RevenueRange, customer: string | null): NumberInvoice[] {
  return invoices.filter((row) => inRange(invoiceDayOf(row), range) && (!customer || customerName(row.customer) === customer));
}

/** Credit notes whose own credit date is in the range (and of the customer, when one is chosen). */
export function creditsInScope(credits: NumberCredit[], range: RevenueRange, customer: string | null): NumberCredit[] {
  return credits.filter((row) => inRange(calendarDate(row.credit_date), range) && (!customer || customerName(row.customer) === customer));
}

export type InvoicedMonth = { key: string; label: string; invoiced: number | null };
export type InvoicedResult = { months: InvoicedMonth[]; invoicedTotal: number | null };

/** Invoiced ex VAT (credit notes off on their own date) per London month of the range, and the sum; unknown is null, never 0. */
export function invoicedRevenue(invoices: NumberInvoice[], credits: NumberCredit[], range: RevenueRange, customer: string | null = null): InvoicedResult {
  const periods = periodsForRange(range);
  const byMonth = invoicedByMonth(invoicesInScope(invoices, range, customer), creditsInScope(credits, range, customer), periods);
  const months = periods.map((p) => ({ key: p.key, label: p.label, invoiced: byMonth.get(p.key) ?? null }));
  return { months, invoicedTotal: sumOrNull(months.map((m) => m.invoiced)) };
}
