/**
 * Invoiced revenue (ex VAT, less credit notes) by part number, over a date range. Pure.
 *
 * Inputs: invoices, their invoice_line_items (005; vat_exempt 010; sales_order_line_id and line_kind 099), the part numbers of the
 * sales_order_lines they link to (068), credit notes, a range and an optional customer. Output: rows by part number plus
 * "Uncategorised", "Carriage" and "Credit notes (not split by product)", the sum, and how many invoices could not be split.
 *
 * Rules:
 *   - A line with a linked order line AND a non-blank (trimmed) part number there goes under that part number. Every other line goes
 *     under "Uncategorised". Nothing is grouped by description.
 *   - A line's net is quantity x unit price in pence (linePence, rounded once, as the invoice itself: documentTotals). vat_exempt and
 *     line_kind change the VAT and the kind of line, never its net.
 *   - A line linked to an order line that was NOT returned by the read (sales_order_lines has a restrictive Sales Orders section policy,
 *     so a person with that section hidden reads none, without an error) is never put in Uncategorised silently: it is its own row,
 *     "Part number not readable", counted in unreadableLines so the page can say so.
 *   - Invoice carriage is its own "Carriage" row.
 *   - Reconciliation, per invoice: sum of line nets + carriage must equal invoiceNetPence (total less VAT). An invoice that does not
 *     add up is counted (mismatchedInvoices) and its WHOLE net goes to Uncategorised, so the table's sum is still the invoiced figure.
 *   - An invoice with no figures at all is counted (unknownInvoices) and left out; the sum is then null (never a guess).
 *   - Issued credit notes are one row, "Credit notes (not split by product)", on their own credit date.
 * Only the invoiced basis is split here; cash and pipeline are never mixed in.
 * Must not change: the money rules, which come from lib/numbers and lib/money.
 */
import { calendarDate } from "@/lib/dates";
import { fromPence, linePence, toPence } from "@/lib/money";
import { invoiceNetPence, isInvoiced, type NumberCredit, type NumberInvoice } from "@/lib/numbers";
import { sharesOf } from "@/lib/reports/revenue/by-customer";
import { creditsInScope, invoicesInScope, type RevenueRange } from "@/lib/reports/revenue/invoiced";
import { invoiceStatus } from "@/lib/receivables";

export const UNCATEGORISED = "Uncategorised";
export const NOT_READABLE = "Part number not readable";
export const CARRIAGE = "Carriage";
export const CREDIT_NOTES_ROW = "Credit notes (not split by product)";

export type PartInvoice = NumberInvoice & { id?: string | null };
export type InvoiceLineRow = {
  invoice_id?: string | null;
  quantity?: number | string | null;
  unit_price?: number | string | null;
  sales_order_line_id?: string | null;
  line_kind?: string | null;
};
export type OrderLinePart = { id?: string | null; part_number?: string | null };

export type PartRowKind = "part" | "uncategorised" | "unreadable" | "carriage" | "credit";
export type PartRow = { part: string; partKind: PartRowKind; partNet: number; partShare: number | null };
export type PartResult = { rows: PartRow[]; partNetTotal: number | null; mismatchedInvoices: number; unknownInvoices: number; unreadableLines: number };

const num = (value: number | string | null | undefined) => Number(value ?? 0) || 0;

/** A line's net in pence, or null when its quantity or price is not a number. */
function lineNetPence(line: InvoiceLineRow): number | null {
  const quantity = Number(line.quantity);
  const price = Number(line.unit_price);
  return Number.isFinite(quantity) && Number.isFinite(price) && line.quantity != null && line.unit_price != null ? linePence(quantity, price) : null;
}

export function invoicedByPart(
  invoices: PartInvoice[],
  lines: InvoiceLineRow[],
  orderLines: OrderLinePart[],
  credits: NumberCredit[],
  range: RevenueRange,
  customer: string | null = null,
): PartResult {
  const partOf = new Map<string, string>();
  const returned = new Set<string>();
  for (const orderLine of orderLines) {
    if (orderLine.id) returned.add(orderLine.id);
    const part = (orderLine.part_number ?? "").trim();
    if (orderLine.id && part) partOf.set(orderLine.id, part);
  }
  const linesOf = new Map<string, InvoiceLineRow[]>();
  for (const line of lines) {
    if (!line.invoice_id) continue;
    linesOf.set(line.invoice_id, [...(linesOf.get(line.invoice_id) ?? []), line]);
  }

  const parts = new Map<string, number>();
  const add = (name: string, pence: number) => parts.set(name, (parts.get(name) ?? 0) + pence);
  let carriage = 0;
  let uncategorised = 0;
  let unreadable = 0;
  let unreadableLines = 0;
  let mismatchedInvoices = 0;
  let unknownInvoices = 0;

  for (const invoice of invoicesInScope(invoices, range, customer) as PartInvoice[]) {
    if (!isInvoiced(invoice)) continue;
    const net = invoiceNetPence(invoice);
    if (net === null) {
      unknownInvoices += 1;
      continue;
    }
    const own = invoice.id ? linesOf.get(invoice.id) ?? [] : [];
    const nets = own.map(lineNetPence);
    const carriagePence = toPence(num(invoice.carriage));
    const known = nets.every((v): v is number => v !== null);
    const adds = known && (nets as number[]).reduce((sum, v) => sum + v, 0) + carriagePence === net;
    if (!adds) {
      mismatchedInvoices += 1;
      uncategorised += net;
      continue;
    }
    carriage += carriagePence;
    own.forEach((line, i) => {
      const part = line.sales_order_line_id && line.line_kind !== "manual" ? partOf.get(line.sales_order_line_id) : undefined;
      if (part) add(part, nets[i] as number);
      else if (line.sales_order_line_id && line.line_kind !== "manual" && !returned.has(line.sales_order_line_id)) {
        unreadable += nets[i] as number;
        unreadableLines += 1;
      } else uncategorised += nets[i] as number;
    });
  }

  let credit = 0;
  let anyCredit = false;
  for (const note of creditsInScope(credits, range, customer)) {
    if (invoiceStatus(note.status) !== "issued" || !calendarDate(note.credit_date)) continue;
    anyCredit = true;
    credit -= toPence(num(note.total)) - toPence(num(note.vat));
  }

  const rows: Array<{ part: string; partKind: PartRowKind; pence: number }> = [
    ...[...parts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([part, pence]) => ({ part, partKind: "part" as const, pence })),
    ...(uncategorised !== 0 ? [{ part: UNCATEGORISED, partKind: "uncategorised" as const, pence: uncategorised }] : []),
    ...(unreadableLines > 0 ? [{ part: NOT_READABLE, partKind: "unreadable" as const, pence: unreadable }] : []),
    ...(carriage !== 0 ? [{ part: CARRIAGE, partKind: "carriage" as const, pence: carriage }] : []),
    ...(anyCredit ? [{ part: CREDIT_NOTES_ROW, partKind: "credit" as const, pence: credit }] : []),
  ];
  const shares = unknownInvoices > 0 ? null : sharesOf(rows.map((r) => r.pence));
  return {
    rows: rows.map((r, i) => ({ part: r.part, partKind: r.partKind, partNet: fromPence(r.pence), partShare: shares ? shares[i] : null })),
    partNetTotal: unknownInvoices > 0 ? null : fromPence(rows.reduce((sum, r) => sum + r.pence, 0)),
    mismatchedInvoices,
    unknownInvoices,
    unreadableLines,
  };
}
