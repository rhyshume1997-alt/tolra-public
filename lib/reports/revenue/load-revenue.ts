/**
 * Reads the rows the revenue report is worked out from. SELECT only, under the signed-in person's own session (their company is
 * the row-level-security scope; the service role is never used here). Nothing is written, nothing is saved.
 *
 * Inputs: a Supabase client (or null) and the chosen range. Output: one Read per table: its rows (with `truncated` true when the
 * 20,000-row cap was reached, so the page says "may be incomplete") or { failed: true } when the read errored. It never throws.
 * Every query is bounded by the range: invoices, credit notes, payments and quotes by their own dates; invoice lines, order lines and
 * quote lines by the ids of the rows the range produced. Paged with fetchAll (lib/fetch-all).
 * Must not change: it stays read-only. The select strings below are the page's own query shapes (the browser test counts them).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { fetchAll, MAX_LIST_ROWS } from "@/lib/fetch-all";
import { londonMidnight, type NumberCredit, type NumberInvoice } from "@/lib/numbers";
import type { CashPayment, PaymentInvoice } from "@/lib/reports/revenue/cash";
import type { InvoiceLineRow, OrderLinePart } from "@/lib/reports/revenue/by-part";
import { dayAfter, type RevenueRange } from "@/lib/reports/revenue/invoiced";
import type { PipelineQuote, PipelineQuoteLine } from "@/lib/reports/revenue/pipeline";

export const REVENUE_SELECT = {
  invoices: "id, customer, status, subtotal, vat, carriage, total, invoice_date, created_at",
  credits: "id, customer, status, vat, total, credit_date",
  payments: "id, amount, paid_on, invoice_id",
  paymentInvoices: "id, customer",
  invoiceLines: "id, invoice_id, quantity, unit_price, sales_order_line_id, line_kind",
  orderLines: "id, part_number",
  quotes: "id, customer, status, valid_until, sent_at",
  quoteLines: "id, quote_id, quantity, unit_price, declined",
} as const;

export type Read<T> = { rows: T[]; truncated: boolean } | { failed: true };
export type RevenueData = {
  invoices: Read<NumberInvoice & { id?: string | null }>;
  credits: Read<NumberCredit>;
  payments: Read<CashPayment>;
  paymentInvoices: Read<PaymentInvoice>;
  invoiceLines: Read<InvoiceLineRow>;
  orderLines: Read<OrderLinePart>;
  quotes: Read<PipelineQuote>;
  quoteLines: Read<PipelineQuoteLine>;
};

type PageResult<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

const CHUNK = 100;
const iso = (instant: string) => instant.replace(".000Z", "Z");

async function readAll<T extends Record<string, unknown>>(page: (from: number, to: number) => PageResult<T>): Promise<Read<T>> {
  try {
    return await fetchAll<T>(page);
  } catch {
    return { failed: true };
  }
}

/** Rows whose parent ids are listed, a hundred ids at a time (a long id list would not fit in one address), 20,000 rows at most. */
async function readByIds<T extends Record<string, unknown>>(ids: string[], page: (chunk: string[], from: number, to: number) => PageResult<T>): Promise<Read<T>> {
  const rows: T[] = [];
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const left = MAX_LIST_ROWS - rows.length;
      if (left <= 0) return { rows, truncated: true };
      const part = await fetchAll<T>((from, to) => page(chunk, from, to), { maxRows: left });
      rows.push(...part.rows);
      if (part.truncated) return { rows, truncated: true };
    }
    return { rows, truncated: false };
  } catch {
    return { failed: true };
  }
}

const idsOf = (read: Read<{ id?: string | null }>) => ("rows" in read ? read.rows.map((r) => r.id).filter((id): id is string => Boolean(id)) : []);
const FAILED = { failed: true } as const;

export async function loadRevenue(db: SupabaseClient | null, range: RevenueRange): Promise<RevenueData> {
  if (!db) return { invoices: FAILED, credits: FAILED, payments: FAILED, paymentInvoices: FAILED, invoiceLines: FAILED, orderLines: FAILED, quotes: FAILED, quoteLines: FAILED };
  const end = dayAfter(range.to);
  const startAt = iso(londonMidnight(range.from));
  const endAt = iso(londonMidnight(end));

  const [invoices, credits, payments, quotes] = await Promise.all([
    // An invoice counts on its invoice date, else the day it was made (London): the window is applied to whichever it has.
    readAll<NumberInvoice & Record<string, unknown>>((from, to) => db.from("invoices").select(REVENUE_SELECT.invoices)
      .or(`invoice_date.gte.${range.from},and(invoice_date.is.null,created_at.gte.${startAt})`)
      .or(`invoice_date.lt.${end},and(invoice_date.is.null,created_at.lt.${endAt})`)
      .order("id").range(from, to)),
    readAll<NumberCredit & Record<string, unknown>>((from, to) => db.from("credit_notes").select(REVENUE_SELECT.credits).eq("status", "issued").gte("credit_date", range.from).lt("credit_date", end).order("id").range(from, to)),
    readAll<CashPayment & Record<string, unknown>>((from, to) => db.from("invoice_payments").select(REVENUE_SELECT.payments).gte("paid_on", range.from).lt("paid_on", end).order("id").range(from, to)),
    readAll<PipelineQuote & Record<string, unknown>>((from, to) => db.from("quotes").select(REVENUE_SELECT.quotes).eq("status", "sent").gte("sent_at", startAt).lt("sent_at", endAt).order("id").range(from, to)),
  ]);

  // The customer of each payment: its invoice, which may be older than the range, read by id. An invoice not returned stays unknown.
  const paymentInvoiceIds = "rows" in payments ? [...new Set(payments.rows.map((p) => p.invoice_id).filter((id): id is string => Boolean(id)))] : [];
  const paymentInvoices = "rows" in payments
    ? await readByIds<PaymentInvoice & Record<string, unknown>>(paymentInvoiceIds, (chunk, from, to) => db.from("invoices").select(REVENUE_SELECT.paymentInvoices).in("id", chunk).order("id").range(from, to))
    : FAILED;
  const invoiceLines = "rows" in invoices
    ? await readByIds<InvoiceLineRow & Record<string, unknown>>(idsOf(invoices), (chunk, from, to) => db.from("invoice_line_items").select(REVENUE_SELECT.invoiceLines).in("invoice_id", chunk).order("id").range(from, to))
    : FAILED;
  const orderLineIds = "rows" in invoiceLines
    ? [...new Set(invoiceLines.rows.map((line) => line.sales_order_line_id).filter((id): id is string => Boolean(id)))]
    : [];
  const orderLines = "rows" in invoiceLines
    ? await readByIds<OrderLinePart & Record<string, unknown>>(orderLineIds, (chunk, from, to) => db.from("sales_order_lines").select(REVENUE_SELECT.orderLines).in("id", chunk).order("id").range(from, to))
    : FAILED;
  const quoteLines = "rows" in quotes
    ? await readByIds<PipelineQuoteLine & Record<string, unknown>>(idsOf(quotes), (chunk, from, to) => db.from("quote_line_items").select(REVENUE_SELECT.quoteLines).in("quote_id", chunk).order("id").range(from, to))
    : FAILED;
  return { invoices, credits, payments, paymentInvoices, invoiceLines, orderLines, quotes, quoteLines };
}
