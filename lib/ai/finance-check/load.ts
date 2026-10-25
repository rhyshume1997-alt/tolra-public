import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  type CheckLine, type CompanyVat, type CreditNoteCheckInput, DUPLICATE_WINDOW_DAYS, type FinanceCheckInput, type FinanceCheckKind,
  type InvoiceCheckInput, type PurchaseOrderCheckInput,
} from "@/lib/ai/finance-check/check";
import { invoiceNotesFilter } from "@/lib/invoice-delivery-notes";

/**
 * Reads what the finance check needs, READ ONLY, through the signed-in person's own client (their JWT, so RLS decides what they can
 * see). The loader never gets the client itself: only `read(table, columns)`, which is `select` plus this session's company filter
 * (as well as RLS, never instead of it). A select builder has no insert, update, delete or upsert, so nothing here can write.
 * No bank details, contacts or payment detail beyond amounts are selected.
 */
type Row = Record<string, unknown>;
type Result = { data: unknown; error: { code?: string } | null };
/** The filters the loader uses on a select. Deliberately no insert / update / delete / upsert / rpc. */
export interface ReadQuery extends PromiseLike<Result> {
  eq(column: string, value: string): ReadQuery;
  neq(column: string, value: string): ReadQuery;
  gte(column: string, value: string): ReadQuery;
  in(column: string, values: string[]): ReadQuery;
  or(filter: string): ReadQuery;
  limit(count: number): ReadQuery;
}
export type Reader = (table: string, columns: string) => ReadQuery;

export class LoadError extends Error {
  constructor(readonly status: 404 | 409 | 500, readonly reason: string) {
    super(reason);
  }
}

export function sessionReader(supabase: SupabaseClient, organizationId: string): Reader {
  return (table, columns) => supabase.from(table).select(columns).eq("organization_id", organizationId) as unknown as ReadQuery;
}

async function many(query: PromiseLike<{ data: unknown; error: { code?: string } | null }>): Promise<Row[]> {
  const { data, error } = await query;
  if (error) throw new LoadError(500, `read:${error.code ?? "error"}`);
  return Array.isArray(data) ? (data as Row[]) : [];
}
async function one(query: PromiseLike<{ data: unknown; error: { code?: string } | null }>): Promise<Row | null> {
  return (await many(query))[0] ?? null;
}

const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? null : String(v));
const n = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const day = (row: Row, ...keys: string[]) => {
  for (const key of keys) if (row[key]) return String(row[key]).slice(0, 10);
  return null;
};
const isDraft = (status: unknown) => (status === null || status === undefined ? true : String(status).toLowerCase() === "draft");
const VOID = ["void", "voided", "cancelled", "canceled"];

function line(row: Row, index: number): CheckLine {
  return {
    // Lines are sorted by their stored position first; the shown position is the 1-based place in that order.
    id: String(row.id), position: index + 1, description: str(row.description),
    quantity: n(row.quantity) ?? 0, unitPrice: n(row.unit_price) ?? 0, vatPct: n(row.vat_pct), vatExempt: row.vat_exempt === true,
    vatAmount: n(row.vat_amount),
  };
}
const byPosition = (rows: Row[]) => [...rows].sort((a, b) => (n(a.position) ?? 0) - (n(b.position) ?? 0));

/** The window start for "other documents" (spec: last 90 days), from the document's own date. */
function since(date: string | null): string {
  const base = date ? Date.parse(date) : NaN;
  const from = new Date((Number.isFinite(base) ? base : Date.now()) - DUPLICATE_WINDOW_DAYS * 86_400_000);
  return from.toISOString().slice(0, 10);
}

async function companyVat(read: Reader): Promise<CompanyVat | null> {
  // Only the two VAT keys of the profile are selected (never the bank details or address).
  const row = await one(read("organization_settings", "vat_registered:company_profile->vatRegistered, standard_rate:company_profile->defaultVatRate").limit(1));
  if (!row) return null;
  const rate = n(row.standard_rate);
  return { vatRegistered: row.vat_registered !== false, standardRate: rate !== null && rate >= 0 && rate <= 100 ? rate : 20 };
}

async function loadInvoice(read: Reader, id: string): Promise<InvoiceCheckInput> {
  const inv = await one(read("invoices", "id, status, customer, customer_po, job_id, subtotal, vat, total, carriage, carriage_vat, vat_enabled, invoice_date, created_at").eq("id", id).limit(1));
  if (!inv) throw new LoadError(404, "not_found");
  if (!isDraft(inv.status)) throw new LoadError(409, "not_draft");
  const date = day(inv, "invoice_date", "created_at");
  const lines = byPosition(await many(read("invoice_line_items", "id, position, description, quantity, unit_price, vat_pct, vat_exempt").eq("invoice_id", id))).map(line);

  const filter = invoiceNotesFilter(id, str(inv.job_id));
  const noteRows = filter ? await many(read("delivery_notes", "id, status, invoice_id, job_id, sales_order_id").or(filter)) : [];
  const notes = noteRows.filter((row) => str(row.invoice_id) === id || (!row.invoice_id && inv.job_id && str(row.job_id) === str(inv.job_id)));
  const noteIds = notes.map((row) => String(row.id));
  const itemRows = noteIds.length ? await many(read("delivery_note_items", "id, delivery_note_id, description, quantity, sales_order_line_id").in("delivery_note_id", noteIds)) : [];

  let orderId = notes.map((row) => str(row.sales_order_id)).find(Boolean) ?? null;
  if (!orderId && inv.job_id) orderId = str((await one(read("jobs", "id, converted_from_sales_order_id").eq("id", String(inv.job_id)).limit(1)))?.converted_from_sales_order_id);
  const orderRow = orderId ? await one(read("sales_orders", "id, customer_po, quote_id").eq("id", orderId).limit(1)) : null;
  const orderLines = orderRow ? byPosition(await many(read("sales_order_lines", "id, position, description, quantity, unit_price, vat_pct, vat_exempt, source_quote_line_id").eq("sales_order_id", String(orderRow.id)))) : [];
  const quoteId = str(orderRow?.quote_id);
  const quoteLines = quoteId ? byPosition(await many(read("quote_line_items", "id, position, description, quantity, unit_price").eq("quote_id", quoteId))) : [];

  const customer = str(inv.customer);
  const recentRows = customer
    ? (await many(read("invoices", "id, status, total, invoice_date, created_at").eq("customer", customer).neq("id", id).gte("created_at", since(date)).limit(50)))
      .filter((row) => !VOID.includes(String(row.status ?? "").toLowerCase()))
    : [];
  const sameTotal = recentRows.filter((row) => n(row.total) !== null && n(row.total) === n(inv.total)).map((row) => String(row.id)).slice(0, 10);
  const recentLines = sameTotal.length ? await many(read("invoice_line_items", "id, invoice_id, position, description, quantity, unit_price").in("invoice_id", sameTotal)) : [];

  return {
    kind: "invoice",
    document: {
      id, customerPo: str(inv.customer_po), subtotal: n(inv.subtotal), vat: n(inv.vat), total: n(inv.total), carriage: n(inv.carriage) ?? 0,
      carriageVat: inv.carriage_vat === true, vatEnabled: inv.vat_enabled !== false, date, lines,
    },
    company: await companyVat(read),
    order: orderRow ? { id: String(orderRow.id), customerPo: str(orderRow.customer_po), lines: orderLines.map((row, i) => ({ ...line(row, i), quoteLineId: str(row.source_quote_line_id) })) } : null,
    quote: quoteId ? { id: quoteId, lines: quoteLines.map(line) } : null,
    deliveryNotes: notes.map((row) => ({
      id: String(row.id), status: String(row.status ?? ""),
      lines: itemRows.filter((item) => str(item.delivery_note_id) === String(row.id)).map((item) => ({ id: String(item.id), description: str(item.description), quantity: n(item.quantity) ?? 0, orderLineId: str(item.sales_order_line_id) })),
    })),
    recent: recentRows.map((row) => ({
      id: String(row.id), total: n(row.total), date: day(row, "invoice_date", "created_at"),
      lines: sameTotal.includes(String(row.id)) ? byPosition(recentLines.filter((l) => str(l.invoice_id) === String(row.id))).map(line) : undefined,
    })),
  };
}

type PoItem = { description?: unknown; qty?: unknown; unit_price?: unknown; vat_pct?: unknown; vat_exempt?: unknown };
function poLines(poId: string, items: unknown): CheckLine[] {
  // Same reading as the PO page and lib/purchase-order-total.ts: lines without a description are not lines; no qty means 1.
  return (Array.isArray(items) ? (items as PoItem[]) : []).map((item, i) => ({ item, i })).filter(({ item }) => item && item.description).map(({ item, i }) => ({
    id: `${poId}#${i + 1}`, position: i + 1, description: str(item.description), quantity: Number(item.qty || 1), unitPrice: Number(item.unit_price || 0),
    vatPct: item.vat_pct === undefined || item.vat_pct === null ? null : Number(item.vat_pct), vatExempt: item.vat_exempt === true,
  }));
}

async function loadPurchaseOrder(read: Reader, id: string): Promise<PurchaseOrderCheckInput> {
  const po = await one(read("purchase_orders", "id, status, supplier, items, total_value, vat_enabled, order_date, created_at").eq("id", id).limit(1));
  if (!po) throw new LoadError(404, "not_found");
  if (!isDraft(po.status)) throw new LoadError(409, "not_draft");
  const date = day(po, "order_date", "created_at");
  const supplier = str(po.supplier);
  const recent = supplier
    ? (await many(read("purchase_orders", "id, status, items, total_value, order_date, created_at").eq("supplier", supplier).neq("id", id).gte("created_at", since(date)).limit(50)))
      .filter((row) => String(row.status ?? "") !== "cancelled")
    : [];
  return {
    kind: "purchase_order",
    document: { id, total: n(po.total_value), vatEnabled: po.vat_enabled === true, date, lines: poLines(id, po.items) },
    company: await companyVat(read),
    recent: recent.map((row) => ({ id: String(row.id), total: n(row.total_value), date: day(row, "order_date", "created_at"), lines: poLines(String(row.id), row.items) })),
  };
}

async function loadCreditNote(read: Reader, id: string): Promise<CreditNoteCheckInput> {
  const cn = await one(read("credit_notes", "id, status, invoice_id, subtotal, vat, total, vat_enabled, credit_date, created_at").eq("id", id).limit(1));
  if (!cn) throw new LoadError(404, "not_found");
  if (!isDraft(cn.status)) throw new LoadError(409, "not_draft");
  const lines = byPosition(await many(read("credit_note_lines", "id, position, invoice_line_id, quantity, unit_price, vat_pct, vat_exempt, vat_amount").eq("credit_note_id", id)));
  const invoiceId = str(cn.invoice_id);
  const invoice = invoiceId ? await one(read("invoices", "id, total").eq("id", invoiceId).limit(1)) : null;
  const invoiceLines = invoice ? byPosition(await many(read("invoice_line_items", "id, position, quantity, unit_price, vat_pct, vat_exempt").eq("invoice_id", String(invoice.id)))) : [];
  const others = invoiceId ? await many(read("credit_notes", "id, status, total, credit_date, created_at").eq("invoice_id", invoiceId).neq("id", id)) : [];
  const otherIds = others.map((row) => String(row.id));
  const otherLines = otherIds.length ? await many(read("credit_note_lines", "credit_note_id, invoice_line_id, quantity, unit_price").in("credit_note_id", otherIds)) : [];
  return {
    kind: "credit_note",
    document: {
      id, subtotal: n(cn.subtotal), vat: n(cn.vat), total: n(cn.total), vatEnabled: cn.vat_enabled !== false, date: day(cn, "credit_date", "created_at"),
      lines: lines.map((row, i) => ({ ...line(row, i), invoiceLineId: str(row.invoice_line_id) })),
    },
    invoice: invoice ? { id: String(invoice.id), total: n(invoice.total), lines: invoiceLines.map(line) } : null,
    otherCredits: others.map((row) => ({
      id: String(row.id), status: String(row.status ?? ""), total: n(row.total), date: day(row, "credit_date", "created_at"),
      lines: otherLines.filter((l) => str(l.credit_note_id) === String(row.id)).map((l) => ({ invoiceLineId: str(l.invoice_line_id), quantity: n(l.quantity) ?? 0, unitPrice: n(l.unit_price) ?? 0 })),
    })),
  };
}

export function loadFinanceCheckInput(read: Reader, kind: FinanceCheckKind, id: string): Promise<FinanceCheckInput> {
  return kind === "invoice" ? loadInvoice(read, id) : kind === "purchase_order" ? loadPurchaseOrder(read, id) : loadCreditNote(read, id);
}

/** One read to prove the person can see this draft in their own company (RLS); used before recording a decision. */
export async function documentVisible(read: Reader, kind: FinanceCheckKind, id: string): Promise<boolean> {
  const table = kind === "invoice" ? "invoices" : kind === "purchase_order" ? "purchase_orders" : "credit_notes";
  return Boolean(await one(read(table, "id").eq("id", id).limit(1)));
}
