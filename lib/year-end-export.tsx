"use client";

/**
 * Year-end export (Settings > Year-end export): one zip with the PDF of every issued invoice, sent quote, issued
 * purchase order and delivery note dated in a period, plus summary.csv (opens in Excel): type, number, date,
 * customer/supplier, net, VAT, gross, paid, balance due, paid date, status. Admin/office only (the page is admin-only);
 * audit-logged. payments.csv lists every recorded payment of those invoices (invoice, paid on, amount, method,
 * reference, source, reversed). Paid and balance come from the real recorded payments (invoices.amount_paid is their
 * sum, migration 032); an invoice whose payment is unknown (imported and still to be confirmed, or marked paid with no
 * amount recorded) is left blank in both and listed in problems.txt, never filled in with a guess.
 *
 * PDFs are built with the same document components the pages print with, from the details recorded at issue
 * (lib/document-snapshot). A document whose lines don't add up to its stored totals is never reprinted with
 * different amounts: it is listed in problems.txt instead and still appears in the summary with its stored totals.
 * Purchase orders store total_value net of VAT: their Net, VAT and Gross come from the lines, as the PO PDF prints them.
 * A PO whose stored net doesn't match its lines is UNRESOLVED: no PDF, no amounts in summary.csv (so it can't be read
 * as a reconciled figure), its reference, stored net, calculated net and discrepancy in problems.txt, and README.txt
 * says the export contains unresolved records. Quotes follow the same rule: Net, VAT and Gross come from the lines (the
 * quote's VAT switch, under the registration and rate it was issued with); a quote whose stored total doesn't match is
 * UNRESOLVED in the same way (stored total, calculated total, difference in problems.txt), stored amounts unchanged.
 */
import { pdf, type DocumentProps } from "@react-pdf/renderer";
import { strToU8, zipSync } from "fflate";
import type { ReactElement } from "react";

import { DeliveryNotePDF } from "@/components/pdf/DeliveryNotePDF";
import { InvoicePDF } from "@/components/pdf/InvoicePDF";
import { PurchaseOrderPDF } from "@/components/pdf/PurchaseOrderPDF";
import { QuotePDF } from "@/components/pdf/QuotePDF";
import { auditEvent } from "@/lib/audit";
import type { CompanyProfile } from "@/lib/company";
import { resolveCustomerAddress } from "@/lib/customers";
import { deliveryAddressLines } from "@/lib/invoice-fields";
import { calendarDate, fmtDate } from "@/lib/dates";
import { csvField } from "@/lib/html";
import { issuedBillTo, issuedCompany } from "@/lib/document-snapshot";
import { fetchAll } from "@/lib/fetch-all";
import { documentTotals, toPence } from "@/lib/money";
import { invoicePdfCredits, invoicePdfPayments } from "@/lib/invoice-pdf-data";
import { type InvoicePayment, knownPaid, paymentFromRow, reversedIds } from "@/lib/payments";
import { balanceDue, invoiceLifecycle, invoiceStatus } from "@/lib/receivables";
import { supabase } from "@/lib/supabase";
import { companyVat } from "@/lib/vat";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** Net/VAT/Gross are null for an unresolved record: listed, but with no amounts that could be taken as reconciled. */
export type SummaryRow = {
  type: string; number: string; date: string; party: string; net: number | null; vat: number | null; gross: number | null;
  /** Invoices only: received so far and still to pay; null (blank) when not known, and for other document types. */
  paid?: number | null; balance?: number | null;
  paidDate: string; status: string; pdf: string;
};
export type ExportProgress = (done: number, total: number, label: string) => void;

/** DATE columns as they are; timestamps as their Europe/London calendar date (lib/dates calendarDate). */
const day = calendarDate;
const inRange = (date: string, from: string, to: string) => Boolean(date) && date >= from && date <= to;
const money = (n: unknown) => Math.round(Number(n || 0) * 100) / 100;
const safe = (name: string) => name.replace(/[^\w.\- ]/g, "_");

/**
 * The CSVs' (and README's) dates are ISO YYYY-MM-DD whoever exports them (Rhys, Wed 21 Oct 2026): the same as every other export and
 * the format Admin > Data import reads; never the person's own date format. The PDFs in the pack follow the person exporting, as
 * anything they print does.
 */
/** CSV with quoting, a UTF-8 BOM (so Excel reads £ correctly) and CRLF line ends. */
export function summaryCsv(rows: SummaryRow[]) {
  const header = ["Type", "Number", "Date", "Customer / supplier", "Net", "VAT", "Gross", "Paid", "Balance due", "Paid date", "Status", "PDF"];
  // Text fields starting with = + - @ (or a tab / carriage return) are neutralised so a hostile customer name can't run as a
  // formula in Excel; the money columns are numbers and stay plain numbers (lib/html csvField).
  const cell = csvField;
  const body = rows.map((r) => [r.type, r.number, r.date ? calendarDate(r.date) : "", r.party, r.net, r.vat, r.gross, r.paid ?? null, r.balance ?? null, r.paidDate ? calendarDate(r.paidDate) : "", r.status, r.pdf].map(cell).join(","));
  return `﻿${[header.join(","), ...body].join("\r\n")}\r\n`;
}

/**
 * What an invoice's summary.csv row says was paid and is still to pay, from its stored receipts (amount_paid, the sum of
 * its payments). Both are null when that is not known and must not be guessed: an imported invoice still flagged
 * payment_unverified, or one marked paid whose payments were never recorded. Then a problems.txt line says so.
 */
export function invoicePaidFigures(r: Row): { paid: number | null; balance: number | null; problem: string | null } {
  const ref = String(r.invoice_ref || "");
  const paid = knownPaid(r);
  if (paid === null) {
    const why = r.payment_unverified ? "imported without payment details and still to be confirmed" : "marked paid but no payment amount was ever recorded";
    return { paid: null, balance: null, problem: `Invoice ${ref}: payment unknown (${why}). Paid and balance due are left blank in summary.csv; nothing has been guessed.` };
  }
  const closed = invoiceLifecycle(r.status as string | null) === "closed";
  return { paid, balance: closed ? 0 : balanceDue(Number(r.total || 0), paid, Number(r.credited_amount || 0), Number(r.refunded_amount || 0)), problem: null };
}

/** One line of payments.csv. */
export type PaymentExportRow = { invoice: string; paidOn: string; amount: number; method: string; reference: string; source: string; reversed: string };

/** payments.csv rows for these invoices: every recorded payment and reversal, oldest first within an invoice. */
export function paymentExportRows(invoices: Row[], payments: InvoicePayment[]): PaymentExportRow[] {
  const refs = new Map(invoices.map((r) => [String(r.id), String(r.invoice_ref || "")]));
  const mine = payments.filter((p) => refs.has(p.invoiceId));
  const reversed = reversedIds(mine);
  return mine
    .slice()
    .sort((a, b) => (refs.get(a.invoiceId) as string).localeCompare(refs.get(b.invoiceId) as string) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((p) => ({
      invoice: refs.get(p.invoiceId) as string, paidOn: p.paidOn, amount: p.amount, method: p.method, reference: p.reference, source: p.source,
      reversed: p.reversesPaymentId ? `Reversal: ${p.voidReason}` : reversed.has(p.id) ? "Yes" : "No",
    }));
}

/** One line of credits.csv: an issued credit note, with how much of it has been applied to its invoice. */
export type CreditExportRow = { credit: string; invoice: string; date: string; customer: string; net: number; vat: number; gross: number; applied: number; left: number; lastApplied: string };

/**
 * credits.csv rows: every issued credit note dated in the period (drafts are not included), against the invoice it credits, with
 * the amount applied so far and the date of the last application. Credits are allocations, not payments, so they are not in
 * payments.csv and are never netted into the invoice's Paid column.
 */
export function creditExportRows(creditNotes: Row[], invoices: Row[], allocations: Row[], from: string, to: string): CreditExportRow[] {
  const refs = new Map(invoices.map((r) => [String(r.id), String(r.invoice_ref || "")]));
  const last = new Map<string, string>();
  for (const a of allocations) {
    const id = String(a.credit_note_id);
    const on = day(a.allocated_on);
    if (on && on > (last.get(id) ?? "")) last.set(id, on);
  }
  return creditNotes
    .filter((c) => c.status === "issued" && c.credit_ref && inRange(day(c.credit_date) || day(c.created_at), from, to))
    .sort((a, b) => String(a.credit_ref).localeCompare(String(b.credit_ref)))
    .map((c) => ({
      credit: String(c.credit_ref), invoice: refs.get(String(c.invoice_id)) ?? "", date: day(c.credit_date) || day(c.created_at), customer: String(c.customer || ""),
      net: money(c.subtotal), vat: money(c.vat), gross: money(c.total), applied: money(c.allocated_amount), left: Math.round((toPence(Number(c.total || 0)) - toPence(Number(c.allocated_amount || 0))) ) / 100,
      lastApplied: last.get(String(c.id)) ?? "",
    }));
}

/** credits.csv: same conventions as summary.csv (BOM, CRLF, quoting, ISO dates, two decimals). Amounts are positive: a credit note reduces what an invoice is owed. */
export function creditsCsv(rows: CreditExportRow[]) {
  const header = ["Credit note", "Invoice", "Date", "Customer", "Net", "VAT", "Gross", "Applied", "Left to apply", "Last applied"];
  const cell = csvField;
  const body = rows.map((r) => [r.credit, r.invoice, r.date ? calendarDate(r.date) : "", r.customer, r.net, r.vat, r.gross, r.applied, r.left, r.lastApplied ? calendarDate(r.lastApplied) : ""].map(cell).join(","));
  return `\ufeff${[header.join(","), ...body].join("\r\n")}\r\n`;
}

/** payments.csv: same conventions as summary.csv (BOM, CRLF, quoting, ISO dates, two decimals). */
export function paymentsCsv(rows: PaymentExportRow[]) {
  const header = ["Invoice", "Paid on", "Amount", "Method", "Reference", "Source", "Reversed"];
  const cell = csvField;
  const body = rows.map((r) => [r.invoice, r.paidOn ? calendarDate(r.paidOn) : "", r.amount, r.method, r.reference, r.source, r.reversed].map(cell).join(","));
  return `\ufeff${[header.join(","), ...body].join("\r\n")}\r\n`;
}

async function all(table: string) {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { rows } = await fetchAll<Row>((from, to) => supabase!.from(table).select("*").order("id").range(from, to));
  return rows;
}

async function lines(table: string, fk: string, id: string, columns: string) {
  const { data, error } = await supabase!.from(table).select(columns).eq(fk, id).order("position");
  if (error) throw error;
  return (data ?? []) as unknown as Row[];
}

async function render(element: ReactElement) {
  const blob = await pdf(element as ReactElement<DocumentProps>).toBlob();
  return new Uint8Array(await blob.arrayBuffer());
}

export type PurchaseOrderExportLine = { description: string; quantity: number; unitPrice: number; vatPct?: number; vatExempt?: boolean };

const pounds = (n: number) => `£${(toPence(n) / 100).toFixed(2)}`;

/**
 * A purchase order's lines and summary.csv amounts (audit A2). purchase_orders.total_value is stored NET of VAT (VAT,
 * when the PO's "Add VAT" is on, is only added on the printed PO), so Net, VAT and Gross are worked out from the lines
 * exactly as PurchaseOrderPDF prints them: documentTotals, VAT only when the PO has VAT on and the company is VAT
 * registered, lines without a rate at the company's default rate. A PO with no saved items prints one line for its
 * stored value. When the stored net doesn't match the saved lines to the penny, nothing is guessed or rewritten: the PO
 * is returned as unresolved (stored net, calculated net, discrepancy) and the export leaves out its amounts and PDF.
 */
export function purchaseOrderExportTotals(r: Row, company: Pick<CompanyProfile, "vatRegistered" | "defaultVatRate">) {
  const ref = String(r.po_ref || r.po_number || "");
  const saved = (Array.isArray(r.items) ? r.items : []).filter((i: Row) => i?.description);
  const items: PurchaseOrderExportLine[] = saved.length
    ? saved.map((i: Row) => ({ description: String(i.description), quantity: Number(i.qty || 1), unitPrice: Number(i.unit_price || 0), vatPct: i.vat_pct === undefined ? undefined : Number(i.vat_pct), vatExempt: Boolean(i.vat_exempt) }))
    : [{ description: `Materials ordered from ${r.supplier || ""}`, quantity: 1, unitPrice: Number(r.total_value || 0) }];
  const { registered, standardRate } = companyVat(company);
  const totals = documentTotals(items.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, vatPct: l.vatPct, vatExempt: l.vatExempt })), 0, { vatEnabled: r.vat_enabled === true && registered, standardRate });
  const stored = r.total_value;
  const mismatch = saved.length > 0 && stored !== null && stored !== undefined && stored !== "" && toPence(Number(stored)) !== toPence(totals.subtotal);
  const unresolved = mismatch
    ? { storedNet: toPence(Number(stored)) / 100, calculatedNet: totals.subtotal, discrepancy: (toPence(totals.subtotal) - toPence(Number(stored))) / 100 }
    : null;
  const problem = unresolved
    ? `Purchase order ${ref}: UNRESOLVED, not reconciled. Stored net ${pounds(unresolved.storedNet)}, calculated net from its lines ${pounds(unresolved.calculatedNet)}, discrepancy ${pounds(unresolved.discrepancy)} (lines minus stored). Left out of the summary amounts and no PDF included; the stored value is unchanged.`
    : null;
  return { ref, items, net: totals.subtotal, vat: totals.vat, gross: totals.total, problem, unresolved };
}

/** The summary.csv row for a purchase order, and whether its PDF may be included (never for an unresolved PO). */
export function purchaseOrderSummaryRow(r: Row, company: Pick<CompanyProfile, "vatRegistered" | "defaultVatRate">) {
  const totals = purchaseOrderExportTotals(r, company);
  const base = { type: "Purchase order", number: totals.ref, date: day(r.order_date) || day(r.created_at), party: String(r.supplier || ""), paidDate: "", pdf: "" };
  const row: SummaryRow = totals.unresolved
    ? { ...base, net: null, vat: null, gross: null, status: "UNRESOLVED: stored net doesn't match lines (see problems.txt)" }
    : { ...base, net: totals.net, vat: totals.vat, gross: totals.gross, status: String(r.status || "") };
  return { ...totals, row, includePdf: !totals.unresolved };
}

export type QuoteExportLine = { description: string; quantity: number; unitPrice: number; vatPct?: number; vatExempt?: boolean };

/**
 * A quote's summary.csv amounts, worked out from its saved lines exactly as QuotePDF prints them: the quote's own
 * "Add VAT" switch, and the VAT registration and standard rate it was issued under (its issuer snapshot when it has
 * one, otherwise today's company settings; nothing older is guessed). When the stored total doesn't equal that
 * calculated total to the penny (for example a legacy quote stored before VAT), nothing is rewritten: the quote is
 * returned as unresolved (stored total, calculated total, difference) and the export leaves out its amounts and PDF.
 */
export function quoteExportTotals(r: Row, items: QuoteExportLine[], company: CompanyProfile) {
  const ref = String(r.quote_ref || "");
  const issuer = issuedCompany(company, r.issuer_snapshot);
  const { registered, standardRate } = companyVat(issuer);
  const totals = documentTotals(items.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice, vatPct: l.vatPct, vatExempt: l.vatExempt })), 0, { vatEnabled: r.vat_enabled !== false && registered, standardRate });
  const stored = r.total_value;
  const hasStored = stored !== null && stored !== undefined && stored !== "";
  const unresolved = !hasStored || toPence(Number(stored)) !== toPence(totals.total)
    ? { storedTotal: hasStored ? toPence(Number(stored)) / 100 : null, calculatedNet: totals.subtotal, calculatedVat: totals.vat, calculatedTotal: totals.total, difference: hasStored ? (toPence(totals.total) - toPence(Number(stored))) / 100 : null }
    : null;
  const problem = unresolved
    ? `Quote ${ref}: UNRESOLVED, not reconciled. Stored (as saved) total ${unresolved.storedTotal === null ? "missing" : pounds(unresolved.storedTotal)}, calculated net ${pounds(unresolved.calculatedNet)} + VAT ${pounds(unresolved.calculatedVat)} = calculated gross ${pounds(unresolved.calculatedTotal)}${unresolved.difference === null ? "" : `, difference ${pounds(unresolved.difference)} (calculated gross minus stored)`}. Left out of the summary amounts and no PDF included; the stored total is unchanged.`
    : null;
  return { ref, issuer, net: totals.subtotal, vat: totals.vat, gross: totals.total, problem, unresolved };
}

/** The summary.csv row for a quote, and whether its PDF may be included (never for an unresolved quote). */
export function quoteSummaryRow(r: Row, items: QuoteExportLine[], company: CompanyProfile) {
  const totals = quoteExportTotals(r, items, company);
  const base = { type: "Quote", number: totals.ref, date: day(r.sent_at) || day(r.created_at), party: String(r.customer || ""), paidDate: "", pdf: "" };
  const row: SummaryRow = totals.unresolved
    ? { ...base, net: null, vat: null, gross: null, status: "UNRESOLVED: stored total (as saved) doesn't match calculated gross (see problems.txt)" }
    : { ...base, net: totals.net, vat: totals.vat, gross: totals.gross, status: String(r.status || "") };
  return { ...totals, row, includePdf: !totals.unresolved };
}

/** README.txt; it leads with a warning when any record is unresolved. */
export function exportReadme(companyName: string, from: string, to: string, counts: { documents: number; invoices: number; quotes: number; pos: number; notes: number; unresolved: number }) {
  const warning = counts.unresolved
    ? `WARNING: THIS EXPORT CONTAINS ${counts.unresolved} UNRESOLVED RECORD${counts.unresolved === 1 ? "" : "S"}. They are listed in summary.csv without amounts and without a PDF, and are not part of the reconciled figures. Details (stored amount, amount calculated from the lines, discrepancy) are in problems.txt. Resolve them before relying on this export.\r\n\r\n`
    : "";
  return `${warning}${companyName} year-end export, ${calendarDate(from)} to ${calendarDate(to)}.\r\n${counts.documents} documents: ${counts.invoices} invoices, ${counts.quotes} quotes, ${counts.pos} purchase orders, ${counts.notes} delivery notes.\r\nsummary.csv opens in Excel; payments.csv lists the payments recorded on those invoices; credits.csv lists the credit notes issued in the period and how much of each has been applied. Drafts are not included.\r\n`;
}

/** Builds the zip for [from, to] (inclusive dates, YYYY-MM-DD) and returns it with the summary rows and problems. */
export async function buildYearEndZip(from: string, to: string, company: CompanyProfile, onProgress: ExportProgress = () => undefined) {
  const standardRate = companyVat(company).standardRate;
  const [invoices, quotes, pos, notes, paymentRows, creditNotes, creditAllocations] = await Promise.all([all("invoices"), all("quotes"), all("purchase_orders"), all("delivery_notes"), all("invoice_payments"), all("credit_notes"), all("invoice_credit_allocations")]);
  const payments = paymentRows.map(paymentFromRow);
  const pick = {
    invoices: invoices.filter((r) => invoiceStatus(r.status as string | null) !== "draft" && r.invoice_ref && inRange(day(r.invoice_date) || day(r.created_at), from, to)),
    quotes: quotes.filter((r) => r.status !== "draft" && inRange(day(r.sent_at) || day(r.created_at), from, to)),
    pos: pos.filter((r) => r.status !== "draft" && inRange(day(r.order_date) || day(r.created_at), from, to)),
    notes: notes.filter((r) => inRange(day(r.delivery_date) || day(r.ship_date) || day(r.created_at), from, to)),
  };
  const total = pick.invoices.length + pick.quotes.length + pick.pos.length + pick.notes.length;
  const files: Record<string, Uint8Array> = {};
  const summary: SummaryRow[] = [];
  const problems: string[] = [];
  let done = 0;
  const step = (label: string) => onProgress(++done, total, label);

  for (const r of pick.invoices) {
    const ref = String(r.invoice_ref);
    const row: SummaryRow = { type: "Invoice", number: ref, date: day(r.invoice_date) || day(r.created_at), party: String(r.customer || ""), net: money(r.subtotal), vat: money(r.vat), gross: money(r.total), paidDate: day(r.paid_at), status: String(r.status || ""), pdf: "" };
    const figures = invoicePaidFigures(r);
    row.paid = figures.paid;
    row.balance = figures.balance;
    if (figures.problem) problems.push(figures.problem);
    try {
      const items = (await lines("invoice_line_items", "invoice_id", r.id, "description, quantity, unit_price, vat_pct, vat_exempt")).map((l) => ({ description: String(l.description || ""), quantity: Number(l.quantity || 0), unitPrice: Number(l.unit_price || 0), vatPct: Number(l.vat_pct ?? standardRate), vatExempt: Boolean(l.vat_exempt) }));
      if (!items.length) throw new Error("no line items");
      const profile = issuedCompany(company, r.issuer_snapshot);
      const billTo = issuedBillTo(r.customer_snapshot, String(r.customer || "")) ?? await resolveCustomerAddress(String(r.customer || ""));
      const path = `invoices/${safe(ref)}.pdf`;
      files[path] = await render(<InvoicePDF data={{
        storedTotals: { reference: ref, issued: true, total: Number(r.total || 0), subtotal: Number(r.subtotal || 0), vat: Number(r.vat || 0) },
        number: ref, date: fmtDate(row.date), taxPoint: r.tax_point ? fmtDate(r.tax_point) : undefined, terms: r.terms || profile.defaultInvoiceTerms, quoteRef: r.quote_ref || undefined, customerPo: r.customer_po || undefined,
        billTo, deliverTo: deliveryAddressLines(typeof r.delivery_address === "string" ? r.delivery_address : undefined),
        note: typeof r.invoice_note === "string" ? r.invoice_note : undefined,
        lineItems: items, carriage: Number(r.carriage || 0), vatEnabled: r.vat_enabled !== false, carriageVat: Boolean(r.carriage_vat),
        ...invoicePdfPayments(r), ...invoicePdfCredits(r, company), company: profile,
      }} />);
      row.pdf = path;
    } catch (err) {
      problems.push(`Invoice ${ref}: PDF not included (${err instanceof Error ? err.message : "couldn't be built"}). Stored totals are in summary.csv.`);
    }
    summary.push(row);
    step(ref);
  }

  let unresolved = 0;
  for (const r of pick.quotes) {
    const ref = String(r.quote_ref || "");
    const items = (await lines("quote_line_items", "quote_id", r.id, "description, quantity, unit_price, vat_pct, vat_exempt")).map((l) => ({ description: String(l.description || ""), quantity: Number(l.quantity || 0), unitPrice: Number(l.unit_price || 0), vatPct: l.vat_pct === null || l.vat_pct === undefined ? undefined : Number(l.vat_pct), vatExempt: Boolean(l.vat_exempt) }));
    const { row, problem, includePdf, issuer: profile } = quoteSummaryRow(r, items, company);
    if (problem) { problems.push(problem); unresolved += 1; }
    if (includePdf) {
      try {
        if (!items.length) throw new Error("no line items");
        const billTo = issuedBillTo(r.customer_snapshot, String(r.customer || "")) ?? await resolveCustomerAddress(String(r.customer || ""));
        const path = `quotes/${safe(ref)}.pdf`;
        files[path] = await render(<QuotePDF data={{
          storedTotals: { reference: ref, issued: true, total: Number(r.total_value || 0) },
          number: ref, date: fmtDate(day(r.created_at)), terms: r.terms || profile.defaultQuoteTerms, validUntil: r.valid_until ? fmtDate(day(r.valid_until)) : "",
          scope: r.description || undefined, customerPo: r.customer_po ? String(r.customer_po) : undefined, billTo, lineItems: items, vatEnabled: r.vat_enabled !== false,
          customerMessage: r.customer_notes ? [...profile.defaultCustomerMessage, String(r.customer_notes)] : undefined, company: profile,
        }} />);
        row.pdf = path;
      } catch (err) {
        problems.push(`Quote ${ref}: PDF not included (${err instanceof Error ? err.message : "couldn't be built"}). Its amounts are in summary.csv.`);
      }
    }
    summary.push(row);
    step(ref);
  }

  for (const r of pick.pos) {
    const { ref, items, row, problem, includePdf } = purchaseOrderSummaryRow(r, company);
    if (problem) { problems.push(problem); unresolved += 1; }
    if (includePdf) {
      try {
        const path = `purchase-orders/${safe(ref)}.pdf`;
        files[path] = await render(<PurchaseOrderPDF data={{
          number: ref, date: fmtDate(row.date), requiredBy: fmtDate(day(r.expected_delivery)), supplier: [String(r.supplier || "")],
          deliverTo: [company.documentName, ...company.addressLines], lineItems: items, vatEnabled: r.vat_enabled === true, notes: r.notes ? [String(r.notes)] : undefined, company,
        }} />);
        row.pdf = path;
      } catch (err) {
        problems.push(`Purchase order ${ref}: PDF not included (${err instanceof Error ? err.message : "couldn't be built"}).`);
      }
    }
    summary.push(row);
    step(ref);
  }

  for (const r of pick.notes) {
    const ref = String(r.dn_number || r.dn_ref || "");
    const row: SummaryRow = { type: "Delivery note", number: ref, date: day(r.delivery_date) || day(r.ship_date) || day(r.created_at), party: String(r.customer || r.customer_name || ""), net: 0, vat: 0, gross: 0, paidDate: "", status: String(r.status || ""), pdf: "" };
    try {
      const items = (await lines("delivery_note_items", "delivery_note_id", r.id, "description, quantity")).map((l) => ({ description: String(l.description || ""), quantity: Number(l.quantity || 0) }));
      if (!items.length) throw new Error("no items");
      const shipDate = day(r.ship_date) || row.date;
      const path = `delivery-notes/${safe(ref)}.pdf`;
      files[path] = await render(<DeliveryNotePDF data={{
        number: ref, taxDate: fmtDate(day(r.tax_date) || shipDate), shipDate: fmtDate(shipDate), shipVia: r.ship_via || undefined,
        billTo: await resolveCustomerAddress(row.party), items, company,
      }} />);
      row.pdf = path;
    } catch (err) {
      problems.push(`Delivery note ${ref}: PDF not included (${err instanceof Error ? err.message : "couldn't be built"}).`);
    }
    summary.push(row);
    step(ref);
  }

  files["summary.csv"] = strToU8(summaryCsv(summary));
  files["payments.csv"] = strToU8(paymentsCsv(paymentExportRows(pick.invoices, payments)));
  files["credits.csv"] = strToU8(creditsCsv(creditExportRows(creditNotes, invoices, creditAllocations, from, to)));
  files["README.txt"] = strToU8(exportReadme(company.name, from, to, { documents: summary.length, invoices: pick.invoices.length, quotes: pick.quotes.length, pos: pick.pos.length, notes: pick.notes.length, unresolved }));
  if (problems.length) files["problems.txt"] = strToU8(`${problems.join("\r\n")}\r\n`);
  const zip = zipSync(files, { level: 6 });
  void auditEvent({ action: "EXPORT", entityTable: "invoices", metadata: { title: "Year-end export", from, to, documents: summary.length, pdfs: summary.filter((r) => r.pdf).length, payments: payments.filter((p) => pick.invoices.some((i) => String(i.id) === p.invoiceId)).length, problems: problems.length, unresolved } });
  return { zip, summary, problems, unresolved };
}
