/**
 * Tolra AI agent 1: the pre-issue finance check (docs/handover/ai-connectors/AGENTS-SPEC.md, section 2). SUGGEST ONLY.
 *
 * Plain deterministic code, no model (spec open question 2): it compares one draft invoice, purchase order or credit note with the
 * records it was made from and returns suggestions. It never changes anything; the person decides and edits the document themselves.
 *
 * Record text (line descriptions, notes, customer PO text) is DATA. It is used only to pair lines by equal normalised wording; it is
 * never interpreted, and messages are built from fixed templates with numbers and line positions, never from free text. Every record
 * id a suggestion cites must be one of the ids passed in (allow-list), and only codes from the fixed list leave this module.
 *
 * An empty result means "Nothing to flag", never "Safe to issue".
 */
import { documentTotals, fromPence, gbp, isTextLine, linePence, toPence } from "@/lib/money";

export const FINANCE_CHECK_KINDS = ["invoice", "purchase_order", "credit_note"] as const;
export type FinanceCheckKind = (typeof FINANCE_CHECK_KINDS)[number];

/** The fixed list of suggestion codes (spec section 2 "Output", plus totals_mismatch). Anything else is dropped. */
export const SUGGESTION_CODES = [
  "qty_mismatch", "price_mismatch", "vat_mismatch", "totals_mismatch", "missing_customer_po", "possible_duplicate",
  "credit_exceeds_balance", "delivery_not_despatched",
] as const;
export type SuggestionCode = (typeof SUGGESTION_CODES)[number];
export type Severity = "warning" | "info";
export type EvidenceValue = string | number | boolean | null;

export type Suggestion = {
  /** Stable within one document: `${code}:${scope}`. */
  id: string;
  code: SuggestionCode;
  severity: Severity;
  /** Plain English, from a template per code. */
  message: string;
  /** The document fields involved, e.g. "lines[2].quantity", "customer_po", "total". */
  fields: string[];
  /** The values compared. */
  evidence: Record<string, EvidenceValue>;
  /** Ids of the records the evidence comes from; always among the ids passed in. */
  recordIds: string[];
};

/** Days either side of the document's date within which another document can count as a possible duplicate (spec: last 90 days). */
export const DUPLICATE_WINDOW_DAYS = 90;
/** Statuses of a delivery note that has gone out (same list as the database, 034). */
const DESPATCHED = new Set(["despatched", "delivered", "signed"]);
/** The usual UK rates offered on documents (lib/vat.ts VAT_CHOICES, without "exempt"). */
const USUAL_RATES = new Set([20, 5, 0]);

export type CheckLine = {
  id: string;
  /** 1-based position on the document as shown; defaults to the index + 1. */
  position?: number;
  description?: string | null;
  quantity: number;
  unitPrice: number;
  vatPct?: number | null;
  vatExempt?: boolean | null;
  /** A credit note line's fixed VAT share. */
  vatAmount?: number | null;
};
export type CompanyVat = { vatRegistered: boolean; standardRate: number };

export type InvoiceCheckInput = {
  kind: "invoice";
  document: {
    id: string; customerPo: string | null; subtotal: number | null; vat: number | null; total: number | null; carriage: number;
    carriageVat: boolean; vatEnabled: boolean; date: string | null; lines: CheckLine[];
  };
  company?: CompanyVat | null;
  order?: { id: string; customerPo: string | null; lines: Array<CheckLine & { quoteLineId?: string | null }> } | null;
  quote?: { id: string; lines: CheckLine[] } | null;
  deliveryNotes?: Array<{ id: string; status: string; lines: Array<{ id: string; description?: string | null; quantity: number; orderLineId?: string | null }> }>;
  /** The same customer's other invoices (not void), each with its lines when they were read. */
  recent?: Array<{ id: string; total: number | null; date: string | null; lines?: CheckLine[] }>;
};

export type PurchaseOrderCheckInput = {
  kind: "purchase_order";
  document: { id: string; total: number | null; vatEnabled: boolean; date: string | null; lines: CheckLine[] };
  company?: CompanyVat | null;
  /** Other POs to the same supplier (not cancelled). */
  recent?: Array<{ id: string; total: number | null; date: string | null; lines?: CheckLine[] }>;
};

export type CreditNoteCheckInput = {
  kind: "credit_note";
  document: {
    id: string; subtotal: number | null; vat: number | null; total: number | null; vatEnabled: boolean; date: string | null;
    lines: Array<CheckLine & { invoiceLineId?: string | null }>;
  };
  invoice: { id: string; total: number | null; lines: CheckLine[] } | null;
  /** Other credit notes against the same invoice. */
  otherCredits?: Array<{ id: string; status: string; total: number | null; date: string | null; lines: Array<{ invoiceLineId?: string | null; quantity: number; unitPrice: number }> }>;
};

export type FinanceCheckInput = InvoiceCheckInput | PurchaseOrderCheckInput | CreditNoteCheckInput;

// ---- helpers -------------------------------------------------------------------------------------------------------------------

const num = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
/** Credit notes are stored positive; an input given as negative (signed credit) is read as its size. */
const size = (value: unknown) => Math.abs(num(value));
const qtyText = (value: number) => String(Number(value.toFixed(3)));
const money = (value: number) => gbp(value, 2);
const norm = (text: string | null | undefined) => (text ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const position = (line: CheckLine, index: number) => (Number.isInteger(line.position) && (line.position as number) > 0 ? (line.position as number) : index + 1);
const priced = <T extends CheckLine>(lines: T[]) => lines.map((line, index) => ({ line, pos: position(line, index) })).filter(({ line }) => !isTextLine({ quantity: num(line.quantity), unitPrice: num(line.unitPrice) }));
const rateOf = (line: Pick<CheckLine, "vatPct" | "vatExempt">, standard: number) => (line.vatExempt ? "exempt" : String(line.vatPct ?? standard));
const rateText = (rate: string) => (rate === "exempt" ? "exempt" : `${rate}%`);

function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(a.slice(0, 10));
  const tb = Date.parse(b.slice(0, 10));
  return Number.isFinite(ta) && Number.isFinite(tb) ? Math.abs(ta - tb) / 86_400_000 : null;
}

/** The order-independent signature of a document's priced lines: wording, quantity and price. */
function lineSignature(lines: CheckLine[]): string {
  return priced(lines).map(({ line }) => `${norm(line.description)}|${qtyText(size(line.quantity))}|${toPence(size(line.unitPrice))}`).sort().join("\n");
}

/** Pairs each priced document line with a reference line: equal wording first, then by order when both have the same count. */
function pairLines<R extends CheckLine>(lines: CheckLine[], reference: R[]): Map<string, R> {
  const pairs = new Map<string, R>();
  const docLines = priced(lines).map(({ line }) => line);
  const refLines = priced(reference).map(({ line }) => line);
  const used = new Set<string>();
  for (const line of docLines) {
    const key = norm(line.description);
    const match = key ? refLines.find((ref) => !used.has(ref.id) && norm(ref.description) === key) : undefined;
    if (match) {
      pairs.set(line.id, match);
      used.add(match.id);
    }
  }
  if (docLines.length === refLines.length) {
    const freeRefs = refLines.filter((ref) => !used.has(ref.id));
    const freeDocs = docLines.filter((line) => !pairs.has(line.id));
    if (freeRefs.length === freeDocs.length) freeDocs.forEach((line, i) => pairs.set(line.id, freeRefs[i]));
  }
  return pairs;
}

function totalsSuggestion(
  stored: { subtotal: number | null; vat: number | null; total: number | null },
  computed: { subtotal: number; vat: number; total: number },
  recordId: string,
  what: string,
): Suggestion | null {
  const keys = (["subtotal", "vat", "total"] as const).filter((key) => stored[key] !== null && stored[key] !== undefined);
  const off = keys.filter((key) => toPence(size(stored[key])) !== toPence(computed[key]));
  if (!off.length) return null;
  const evidence: Record<string, EvidenceValue> = {};
  for (const key of off) {
    evidence[`stored_${key}`] = fromPence(toPence(size(stored[key])));
    evidence[`lines_${key}`] = computed[key];
  }
  const first = off[0];
  return {
    id: `totals_mismatch:${off.join("-")}`, code: "totals_mismatch", severity: "warning",
    message: `The ${what}'s ${first} (${money(size(stored[first]))}) doesn't match its lines (${money(computed[first])}).${off.length > 1 ? " Other totals differ too." : ""}`,
    fields: [...off], evidence, recordIds: [recordId],
  };
}

function unusualRates(lines: CheckLine[], standard: number): Suggestion[] {
  return priced(lines).flatMap(({ line, pos }) => {
    if (line.vatExempt || line.vatPct === null || line.vatPct === undefined) return [];
    const pct = num(line.vatPct);
    if (USUAL_RATES.has(pct) || pct === standard) return [];
    return [{
      id: `vat_mismatch:line-${pos}:rate`, code: "vat_mismatch" as const, severity: "info" as const,
      message: `Line ${pos} uses VAT at ${pct}%, which isn't one of the usual rates (20%, 5%, 0% or exempt).`,
      fields: [`lines[${pos}].vat_pct`], evidence: { line_rate: pct }, recordIds: [line.id],
    }];
  });
}

function duplicateSuggestions(
  doc: { id: string; date: string | null; total: number | null; lines: CheckLine[] },
  recent: Array<{ id: string; total: number | null; date: string | null; lines?: CheckLine[] }> | undefined,
  what: string,
  computedTotal: number,
  signature: (lines: CheckLine[]) => string = lineSignature,
): Suggestion[] {
  const total = toPence(doc.total === null ? computedTotal : size(doc.total));
  const mine = signature(doc.lines);
  if (!mine) return [];
  return (recent ?? []).flatMap((other) => {
    if (other.id === doc.id || !other.lines || other.total === null) return [];
    const days = daysBetween(doc.date, other.date);
    if (days === null || days > DUPLICATE_WINDOW_DAYS) return [];
    if (toPence(size(other.total)) !== total || signature(other.lines) !== mine) return [];
    return [{
      id: `possible_duplicate:${other.id}`, code: "possible_duplicate" as const, severity: "warning" as const,
      message: `Another ${what} dated ${other.date?.slice(0, 10)} has the same total (${money(fromPence(total))}) and the same lines. Check this isn't a duplicate.`,
      fields: ["total", "lines"], evidence: { total: fromPence(total), other_date: other.date?.slice(0, 10) ?? null, days_apart: Math.round(days) },
      recordIds: [other.id],
    }];
  });
}

// ---- invoice -------------------------------------------------------------------------------------------------------------------

function checkInvoice(input: InvoiceCheckInput): Suggestion[] {
  const { document: doc, order, quote } = input;
  const company = input.company ?? { vatRegistered: true, standardRate: 20 };
  const notes = input.deliveryNotes ?? [];
  const out: Suggestion[] = [];
  const docLines = priced(doc.lines);

  const orderPairs = order ? pairLines(doc.lines, order.lines) : new Map<string, CheckLine & { quoteLineId?: string | null }>();
  const quotePairs = quote ? pairLines(doc.lines, quote.lines) : new Map<string, CheckLine>();
  const quoteById = new Map((quote?.lines ?? []).map((line) => [line.id, line]));

  // Delivered quantity per order line: delivery note items linked to that order line, or with its wording.
  const delivered = (orderLine: CheckLine) => {
    let total = 0;
    for (const note of notes) {
      for (const item of note.lines) {
        if (item.orderLineId ? item.orderLineId === orderLine.id : norm(item.description) !== "" && norm(item.description) === norm(orderLine.description)) total += num(item.quantity);
      }
    }
    return total;
  };

  for (const { line, pos } of docLines) {
    const qty = num(line.quantity);
    const price = num(line.unitPrice);
    const orderLine = orderPairs.get(line.id);

    // Quantity vs the order and the delivery notes.
    if (orderLine && qty > num(orderLine.quantity)) {
      out.push({
        id: `qty_mismatch:line-${pos}:order`, code: "qty_mismatch", severity: "warning",
        message: `Line ${pos} invoices ${qtyText(qty)} but the order is for ${qtyText(num(orderLine.quantity))}.`,
        fields: [`lines[${pos}].quantity`], evidence: { invoice_qty: qty, order_qty: num(orderLine.quantity) }, recordIds: [line.id, order!.id, orderLine.id],
      });
    }
    if (orderLine && notes.length) {
      const sent = delivered(orderLine);
      if (qty !== sent) {
        out.push({
          id: `qty_mismatch:line-${pos}:delivery`, code: "qty_mismatch", severity: qty > sent ? "warning" : "info",
          message: qty > sent
            ? `Line ${pos} invoices ${qtyText(qty)} but the delivery notes show ${qtyText(sent)} delivered.`
            : `Line ${pos} invoices ${qtyText(qty)} but the delivery notes show ${qtyText(sent)} delivered (part invoice?).`,
          fields: [`lines[${pos}].quantity`], evidence: { invoice_qty: qty, delivered_qty: sent }, recordIds: [line.id, orderLine.id, ...notes.map((n) => n.id)],
        });
      }
    }

    // Unit price vs the order, or the quote when there is no order line.
    const quoteLine = orderLine?.quoteLineId ? quoteById.get(orderLine.quoteLineId) : quotePairs.get(line.id);
    const reference = orderLine ? { price: num(orderLine.unitPrice), id: orderLine.id, from: "order" } : quoteLine ? { price: num(quoteLine.unitPrice), id: quoteLine.id, from: "quote" } : null;
    if (reference && toPence(price) !== toPence(reference.price)) {
      out.push({
        id: `price_mismatch:line-${pos}`, code: "price_mismatch", severity: "warning",
        message: `Line ${pos} is priced at ${money(price)} each but the ${reference.from} says ${money(reference.price)}.`,
        fields: [`lines[${pos}].unit_price`], evidence: { invoice_price: price, [`${reference.from}_price`]: reference.price },
        recordIds: [line.id, reference.id, ...(reference.from === "order" ? [order!.id] : [quote!.id])],
      });
    }

    // VAT rate vs the order line's.
    if (orderLine) {
      const used = rateOf(line, company.standardRate);
      const expected = rateOf(orderLine, company.standardRate);
      if (used !== expected) {
        out.push({
          id: `vat_mismatch:line-${pos}`, code: "vat_mismatch", severity: "warning",
          message: `Line ${pos} has VAT ${rateText(used)} but the order line has ${rateText(expected)}.`,
          fields: [`lines[${pos}].vat_pct`], evidence: { invoice_rate: used, order_rate: expected }, recordIds: [line.id, orderLine.id],
        });
      }
    }
  }
  out.push(...unusualRates(doc.lines, company.standardRate));

  // Totals add up (same rules and rounding as the printed invoice).
  const computed = documentTotals(docLines.map(({ line }) => ({ quantity: num(line.quantity), unitPrice: num(line.unitPrice), vatPct: line.vatPct ?? undefined, vatExempt: Boolean(line.vatExempt) })), num(doc.carriage), {
    vatEnabled: doc.vatEnabled && company.vatRegistered, carriageVat: doc.carriageVat, standardRate: company.standardRate,
  });
  const totals = totalsSuggestion(doc, computed, doc.id, "invoice");
  if (totals) out.push(totals);

  // Customer PO.
  const orderPo = (order?.customerPo ?? "").trim();
  const invoicePo = (doc.customerPo ?? "").trim();
  if (order && orderPo && !invoicePo) {
    out.push({
      id: "missing_customer_po:empty", code: "missing_customer_po", severity: "warning",
      message: "The order has a customer PO but this invoice has none.", fields: ["customer_po"],
      evidence: { order_po: orderPo, invoice_po: null }, recordIds: [order.id],
    });
  } else if (order && orderPo && invoicePo && norm(orderPo) !== norm(invoicePo)) {
    out.push({
      id: "missing_customer_po:differs", code: "missing_customer_po", severity: "warning",
      message: "This invoice's customer PO is not the one on the order.", fields: ["customer_po"],
      evidence: { order_po: orderPo, invoice_po: invoicePo }, recordIds: [order.id],
    });
  }

  // Delivery notes that have not gone out.
  for (const note of notes) {
    if (!DESPATCHED.has(note.status)) {
      out.push({
        id: `delivery_not_despatched:${note.id}`, code: "delivery_not_despatched", severity: "warning",
        message: "A delivery note on this invoice hasn't been despatched yet.", fields: ["delivery_notes"],
        evidence: { note_status: note.status }, recordIds: [note.id],
      });
    }
  }

  out.push(...duplicateSuggestions(doc, input.recent, "invoice to this customer", computed.total));
  return out;
}

// ---- purchase order ------------------------------------------------------------------------------------------------------------

function checkPurchaseOrder(input: PurchaseOrderCheckInput): Suggestion[] {
  const { document: doc } = input;
  const company = input.company ?? { vatRegistered: true, standardRate: 20 };
  const out: Suggestion[] = [];
  const docLines = priced(doc.lines);

  // A line with a quantity but no price.
  for (const { line, pos } of docLines) {
    if (num(line.quantity) > 0 && toPence(num(line.unitPrice)) === 0) {
      out.push({
        id: `price_mismatch:line-${pos}:zero`, code: "price_mismatch", severity: "info",
        message: `Line ${pos} has a quantity but no price.`, fields: [`lines[${pos}].unit_price`],
        evidence: { quantity: num(line.quantity), unit_price: 0 }, recordIds: [line.id],
      });
    }
  }

  // VAT: "Add VAT" on while the company isn't VAT registered; unusual rates.
  if (doc.vatEnabled && !company.vatRegistered) {
    out.push({
      id: "vat_mismatch:not_registered", code: "vat_mismatch", severity: "warning",
      message: "VAT is switched on for this purchase order but the company isn't VAT registered.", fields: ["vat_enabled"],
      evidence: { vat_enabled: true, vat_registered: false }, recordIds: [doc.id],
    });
  }
  out.push(...unusualRates(doc.lines, company.standardRate));

  // Totals: the stored value is ex VAT and is the sum of the lines.
  const net = docLines.reduce((sum, { line }) => sum + linePence(num(line.quantity), num(line.unitPrice)), 0);
  if (docLines.length && doc.total !== null && toPence(num(doc.total)) !== net) {
    out.push({
      id: "totals_mismatch:subtotal", code: "totals_mismatch", severity: "warning",
      message: `The purchase order's value (${money(num(doc.total))}) doesn't match its lines (${money(fromPence(net))}).`,
      fields: ["total_value"], evidence: { stored_subtotal: num(doc.total), lines_subtotal: fromPence(net) }, recordIds: [doc.id],
    });
  }

  out.push(...duplicateSuggestions(doc, input.recent, "purchase order to this supplier", fromPence(net)));
  return out;
}

// ---- credit note ---------------------------------------------------------------------------------------------------------------

function checkCreditNote(input: CreditNoteCheckInput): Suggestion[] {
  const { document: doc, invoice } = input;
  const others = (input.otherCredits ?? []).filter((other) => other.id !== doc.id);
  const issued = others.filter((other) => other.status === "issued");
  const out: Suggestion[] = [];
  const lines = doc.lines.map((line) => ({ ...line, quantity: size(line.quantity), unitPrice: size(line.unitPrice), vatAmount: line.vatAmount === null || line.vatAmount === undefined ? undefined : size(line.vatAmount) }));
  const docLines = priced(lines);
  const invoiceLines = new Map((invoice?.lines ?? []).map((line) => [line.id, line]));

  for (const { line, pos } of docLines) {
    const source = line.invoiceLineId ? invoiceLines.get(line.invoiceLineId) : undefined;
    if (!source) continue;
    const already = issued.reduce((sum, other) => sum + other.lines.filter((l) => l.invoiceLineId === source.id).reduce((s, l) => s + size(l.quantity), 0), 0);
    const left = Math.max(0, num(source.quantity) - already);
    if (line.quantity > left + 1e-9) {
      out.push({
        id: `qty_mismatch:line-${pos}:credit`, code: "qty_mismatch", severity: "warning",
        message: `Line ${pos} credits ${qtyText(line.quantity)} but only ${qtyText(left)} of that invoice line is left to credit.`,
        fields: [`lines[${pos}].quantity`], evidence: { credit_qty: line.quantity, invoiced_qty: num(source.quantity), already_credited_qty: already },
        recordIds: [line.id, source.id, ...issued.map((o) => o.id)],
      });
    }
    if (toPence(line.unitPrice) > toPence(num(source.unitPrice))) {
      out.push({
        id: `price_mismatch:line-${pos}:credit`, code: "price_mismatch", severity: "warning",
        message: `Line ${pos} credits ${money(line.unitPrice)} each but the invoice charged ${money(num(source.unitPrice))}.`,
        fields: [`lines[${pos}].unit_price`], evidence: { credit_price: line.unitPrice, invoice_price: num(source.unitPrice) }, recordIds: [line.id, source.id],
      });
    }
    const used = rateOf(line, 20);
    const expected = rateOf(source, 20);
    if (used !== expected) {
      out.push({
        id: `vat_mismatch:line-${pos}`, code: "vat_mismatch", severity: "warning",
        message: `Line ${pos} has VAT ${rateText(used)} but the invoice line has ${rateText(expected)}.`,
        fields: [`lines[${pos}].vat_pct`], evidence: { credit_rate: used, invoice_rate: expected }, recordIds: [line.id, source.id],
      });
    }
  }

  const computed = documentTotals(docLines.map(({ line }) => ({ quantity: line.quantity, unitPrice: line.unitPrice, vatPct: line.vatPct ?? undefined, vatExempt: Boolean(line.vatExempt), vatAmount: line.vatAmount })), 0, { vatEnabled: doc.vatEnabled });
  const stored = { subtotal: doc.subtotal, vat: doc.vat, total: doc.total };
  const totals = totalsSuggestion(stored, computed, doc.id, "credit note");
  if (totals) out.push(totals);

  // More than the invoice has left to credit.
  if (invoice && invoice.total !== null) {
    const creditTotal = toPence(doc.total === null ? computed.total : size(doc.total));
    const creditedBefore = issued.reduce((sum, other) => sum + toPence(size(other.total)), 0);
    const left = Math.max(0, toPence(num(invoice.total)) - creditedBefore);
    if (creditTotal > left) {
      out.push({
        id: "credit_exceeds_balance:invoice", code: "credit_exceeds_balance", severity: "warning",
        message: `This credit note (${money(fromPence(creditTotal))}) is more than the ${money(fromPence(left))} of the invoice not yet credited.`,
        fields: ["total"], evidence: { credit_total: fromPence(creditTotal), invoice_total: num(invoice.total), already_credited: fromPence(creditedBefore) },
        recordIds: [invoice.id, ...issued.map((o) => o.id)],
      });
    }
  }

  // Another credit note on the same invoice with the same total and lines.
  const creditSignature = (ls: Array<{ invoiceLineId?: string | null; quantity: number; unitPrice: number }>) => ls
    .filter((l) => !isTextLine({ quantity: size(l.quantity), unitPrice: size(l.unitPrice) }))
    .map((l) => `${l.invoiceLineId ?? ""}|${qtyText(size(l.quantity))}|${toPence(size(l.unitPrice))}`).sort().join("\n");
  out.push(...duplicateSuggestions(
    { id: doc.id, date: doc.date, total: doc.total, lines: lines as CheckLine[] },
    others.map((o) => ({ id: o.id, total: o.total, date: o.date, lines: o.lines as unknown as CheckLine[] })),
    "credit note on this invoice", computed.total,
    (ls) => creditSignature(ls as unknown as Array<{ invoiceLineId?: string | null; quantity: number; unitPrice: number }>),
  ));
  return out;
}

// ---- entry point ---------------------------------------------------------------------------------------------------------------

/** Every record id in the input: the only ids a suggestion may cite. */
export function inputIds(input: FinanceCheckInput): Set<string> {
  const ids = new Set<string>([input.document.id, ...input.document.lines.map((l) => l.id)]);
  if (input.kind === "invoice") {
    if (input.order) [input.order.id, ...input.order.lines.map((l) => l.id)].forEach((id) => ids.add(id));
    if (input.quote) [input.quote.id, ...input.quote.lines.map((l) => l.id)].forEach((id) => ids.add(id));
    for (const note of input.deliveryNotes ?? []) [note.id, ...note.lines.map((l) => l.id)].forEach((id) => ids.add(id));
    for (const other of input.recent ?? []) ids.add(other.id);
  } else if (input.kind === "purchase_order") {
    for (const other of input.recent ?? []) ids.add(other.id);
  } else {
    if (input.invoice) [input.invoice.id, ...input.invoice.lines.map((l) => l.id)].forEach((id) => ids.add(id));
    for (const other of input.otherCredits ?? []) ids.add(other.id);
  }
  return ids;
}

const CODES = new Set<string>(SUGGESTION_CODES);
const MAX_MESSAGE = 300;

/** The output gate: unknown codes dropped, record ids not sent in dropped, over-long text cut, one suggestion per id. */
export function sanitiseSuggestions(suggestions: unknown[], allowedIds: Set<string>): Suggestion[] {
  const seen = new Set<string>();
  const out: Suggestion[] = [];
  for (const raw of suggestions) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Partial<Suggestion>;
    if (typeof s.code !== "string" || !CODES.has(s.code) || typeof s.id !== "string" || seen.has(s.id)) continue;
    if (typeof s.message !== "string" || (s.severity !== "warning" && s.severity !== "info")) continue;
    const evidence: Record<string, EvidenceValue> = {};
    for (const [key, value] of Object.entries(s.evidence ?? {})) {
      if (value === null || typeof value === "number" || typeof value === "boolean") evidence[key] = value;
      else if (typeof value === "string") evidence[key] = value.slice(0, 120);
    }
    seen.add(s.id);
    out.push({
      id: s.id.slice(0, 120), code: s.code as SuggestionCode, severity: s.severity, message: s.message.slice(0, MAX_MESSAGE),
      fields: (Array.isArray(s.fields) ? s.fields : []).filter((f): f is string => typeof f === "string").map((f) => f.slice(0, 64)).slice(0, 10),
      evidence, recordIds: [...new Set((Array.isArray(s.recordIds) ? s.recordIds : []).filter((id): id is string => typeof id === "string" && allowedIds.has(id)))],
    });
  }
  return out;
}

/** Runs the deterministic checks for one draft. Pure: no I/O, no clock (dates come from the records). */
export function runFinanceCheck(input: FinanceCheckInput): Suggestion[] {
  const raw = input.kind === "invoice" ? checkInvoice(input) : input.kind === "purchase_order" ? checkPurchaseOrder(input) : checkCreditNote(input);
  return sanitiseSuggestions(raw, inputIds(input));
}
