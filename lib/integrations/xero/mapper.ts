// Tolra document -> Xero payload (pure, no I/O). The figures are Tolra's own (integration_document, 084): each line's net and VAT as Tolra
// totals it, so the explicit TaxAmount on each line makes Xero's totals Tolra's; the totals are still compared after every push and a
// difference is never rounded away (it fails the send with the difference). Tolra's numbers are kept as Xero's numbers.

import type { DocumentLine, IntegrationDocument, Mappings, Totals } from "@/lib/integrations/types";
import { CREDIT_NOTE_XERO_TYPE, TRACKING_CATEGORIES, XERO_EMAILS_CUSTOMERS } from "@/lib/integrations/xero/policy";

export type XeroLineItem = {
  Description: string;
  Quantity?: number;
  UnitAmount?: number;
  AccountCode?: string;
  TaxType?: string;
  TaxAmount?: number;
  Tracking?: Array<{ Name: string; Option: string }>;
};

export type XeroInvoicePayload = {
  Type: "ACCREC";
  Contact: { ContactID: string };
  InvoiceNumber: string;
  Reference?: string;
  Date: string;
  DueDate?: string;
  LineAmountTypes: "Exclusive";
  Status: "AUTHORISED";
  SentToContact: boolean;
  LineItems: XeroLineItem[];
};

export type XeroCreditNotePayload = {
  Type: typeof CREDIT_NOTE_XERO_TYPE;
  Contact: { ContactID: string };
  CreditNoteNumber: string;
  Reference?: string;
  Date: string;
  LineAmountTypes: "Exclusive";
  Status: "AUTHORISED";
  SentToContact: boolean;
  LineItems: XeroLineItem[];
};

const cents = (n: number) => Math.round(Number(n) * 100);
const money = (n: number) => cents(n) / 100;

/** What is not mapped for this document: "account:sales" / "account:credit" and "vat:<key>" (the database's gate says the same). */
export function missingMappings(doc: IntegrationDocument, mappings: Mappings): string[] {
  const missing = new Set<string>();
  if (doc.doc_type === "invoice" && !mappings.salesAccount) missing.add("account:sales");
  if (doc.doc_type === "credit_note" && !mappings.creditAccount) missing.add("account:credit");
  for (const line of doc.lines) {
    if (line.text_only || line.vat_key === null) continue;
    if (!mappings.taxRates[line.vat_key]) missing.add(`vat:${line.vat_key}`);
  }
  return [...missing].sort();
}

export class UnmappedError extends Error {
  constructor(readonly missing: string[]) {
    super(`Not mapped yet: ${missing.join(", ")}`);
    this.name = "UnmappedError";
  }
}

function lineItem(line: DocumentLine, accountCode: string, mappings: Mappings): XeroLineItem {
  const description = line.description.trim().slice(0, 4000) || "-";
  // A £0 text-only line (073) is a description line in Xero: no quantity, amount, account or tax.
  if (line.text_only || line.vat_key === null) return { Description: description };
  const item: XeroLineItem = {
    Description: description,
    Quantity: Number(line.quantity),
    UnitAmount: Number(line.unit_price),
    AccountCode: accountCode,
    TaxType: mappings.taxRates[line.vat_key],
    TaxAmount: money(line.vat),
  };
  if (TRACKING_CATEGORIES.length) item.Tracking = TRACKING_CATEGORIES.map((t) => ({ Name: t.name, Option: t.option }));
  return item;
}

function requireReady(doc: IntegrationDocument, mappings: Mappings) {
  const missing = missingMappings(doc, mappings);
  if (missing.length) throw new UnmappedError(missing);
  if (!doc.number) throw new Error("The document has no number yet (not issued)");
  if (!doc.date) throw new Error("The document has no date");
}

export function mapInvoice(doc: IntegrationDocument, mappings: Mappings, contactId: string): XeroInvoicePayload {
  if (doc.doc_type !== "invoice") throw new Error("Not an invoice");
  requireReady(doc, mappings);
  const payload: XeroInvoicePayload = {
    Type: "ACCREC",
    Contact: { ContactID: contactId },
    InvoiceNumber: doc.number!,
    Date: doc.date!,
    LineAmountTypes: "Exclusive",
    Status: "AUTHORISED",
    SentToContact: XERO_EMAILS_CUSTOMERS,
    LineItems: doc.lines.map((line) => lineItem(line, mappings.salesAccount!, mappings)),
  };
  if (doc.reference) payload.Reference = doc.reference.slice(0, 255);
  if (doc.due_date) payload.DueDate = doc.due_date;
  return payload;
}

export function mapCreditNote(doc: IntegrationDocument, mappings: Mappings, contactId: string): XeroCreditNotePayload {
  if (doc.doc_type !== "credit_note") throw new Error("Not a credit note");
  requireReady(doc, mappings);
  const payload: XeroCreditNotePayload = {
    Type: CREDIT_NOTE_XERO_TYPE,
    Contact: { ContactID: contactId },
    CreditNoteNumber: doc.number!,
    Date: doc.date!,
    LineAmountTypes: "Exclusive",
    Status: "AUTHORISED",
    SentToContact: XERO_EMAILS_CUSTOMERS,
    LineItems: doc.lines.map((line) => lineItem(line, mappings.creditAccount!, mappings)),
  };
  if (doc.reference) payload.Reference = doc.reference.slice(0, 255);
  return payload;
}

/** Tolra's totals as Xero states them: net of every line (carriage included), VAT, total. */
export function expectedTotals(doc: IntegrationDocument): Totals {
  const subTotal = money(Number(doc.subtotal) + Number(doc.carriage || 0));
  return { subTotal, totalTax: money(doc.vat), total: money(doc.total) };
}

/** null when Xero's totals are Tolra's to the penny; otherwise the difference, said plainly. Never rounded away. */
export function totalsDifference(expected: Totals, got: Totals): string | null {
  const parts: string[] = [];
  const cmp = (label: string, a: number, b: number) => {
    if (cents(a) !== cents(b)) parts.push(`${label} Tolra ${money(a).toFixed(2)}, Xero ${money(b).toFixed(2)}`);
  };
  cmp("net", expected.subTotal, got.subTotal);
  cmp("VAT", expected.totalTax, got.totalTax);
  cmp("total", expected.total, got.total);
  return parts.length ? `Totals differ: ${parts.join("; ")}` : null;
}
