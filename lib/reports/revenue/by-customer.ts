/**
 * Invoiced revenue (ex VAT, less credit notes) per customer, over a date range. Pure.
 *
 * Inputs: invoices, credit notes, a range and an optional customer. Output: one row per customer present in the range, the sum, and
 * each row's whole-percent share. Customers are matched by the name text on the document, not by customer id. A customer whose counted
 * invoice has no figures is null (never 0) and makes every share unavailable, since the total is then unknown. Shares sum to exactly 100
 * (largest remainder) whenever they are available. Only the invoiced basis is split here; cash and pipeline are never mixed in.
 * Must not change: the money rules (isInvoiced, invoiceNetPence), which come from lib/numbers.
 */
import { calendarDate } from "@/lib/dates";
import { fromPence, toPence } from "@/lib/money";
import { invoiceNetPence, isInvoiced, type NumberCredit, type NumberInvoice } from "@/lib/numbers";
import { creditsInScope, customerName, invoicesInScope, type RevenueRange } from "@/lib/reports/revenue/invoiced";
import { invoiceStatus } from "@/lib/receivables";

/** Whole-percent shares of `pence` values that add to exactly 100 (largest remainder); null when the total is not above zero. */
export function sharesOf(pence: number[]): number[] | null {
  const total = pence.reduce((sum, v) => sum + v, 0);
  if (!(total > 0)) return null;
  const exact = pence.map((v) => (v * 100) / total);
  const shares = exact.map(Math.floor);
  let left = 100 - shares.reduce((sum, v) => sum + v, 0);
  const order = exact.map((value, index) => ({ index, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest || a.index - b.index);
  for (const { index } of order) {
    if (left <= 0) break;
    shares[index] += 1;
    left -= 1;
  }
  return shares;
}

export type CustomerRow = { customer: string; invoicedNet: number | null; invoicedShare: number | null };
export type CustomerResult = { rows: CustomerRow[]; invoicedNetTotal: number | null };

export function invoicedByCustomer(invoices: NumberInvoice[], credits: NumberCredit[], range: RevenueRange, customer: string | null = null): CustomerResult {
  const pence = new Map<string, number | null>();
  for (const row of invoicesInScope(invoices, range, customer)) {
    if (!isInvoiced(row)) continue;
    const name = customerName(row.customer);
    const net = invoiceNetPence(row);
    const held = pence.get(name);
    pence.set(name, net === null || held === null ? null : (held ?? 0) + net);
  }
  for (const credit of creditsInScope(credits, range, customer)) {
    if (invoiceStatus(credit.status) !== "issued" || !calendarDate(credit.credit_date)) continue;
    const name = customerName(credit.customer);
    const held = pence.get(name);
    if (held === null) continue;
    pence.set(name, (held ?? 0) - (toPence(Number(credit.total ?? 0) || 0) - toPence(Number(credit.vat ?? 0) || 0)));
  }
  const entries = [...pence].sort((a, b) => (b[1] ?? -Infinity) - (a[1] ?? -Infinity) || a[0].localeCompare(b[0]));
  const unknown = entries.some(([, v]) => v === null);
  const shares = unknown ? null : sharesOf(entries.map(([, v]) => v as number));
  return {
    rows: entries.map(([name, v], i) => ({ customer: name, invoicedNet: v === null ? null : fromPence(v), invoicedShare: shares ? shares[i] : null })),
    invoicedNetTotal: unknown ? null : fromPence(entries.reduce((sum, [, v]) => sum + (v as number), 0)),
  };
}
