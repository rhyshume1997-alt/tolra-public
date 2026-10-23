/**
 * How an invoice's number is shown. A draft has no invoice_ref until it is issued (issue_invoice), so the Invoices page keeps a
 * stable key for it (DRAFT-xxxxxxxx, built from the id; it is only a key, never shown) and flags the row `unnumbered`. People see
 * DRAFT_NO_NUMBER_LABEL instead; CSV and Excel exports leave the Invoice No cell blank, which the importer treats as "Invoice
 * number is required" rather than importing a draft under a made-up number.
 */
export const DRAFT_NO_NUMBER_LABEL = "Draft, no number yet";

/** The key for an invoice with no number yet. Not for display. */
export function draftKey(id: string): string {
  return `DRAFT-${String(id).slice(0, 8).toUpperCase()}`;
}

/** The invoice number to show: its own, or the plain words for a draft that has none. */
export function shownInvoiceRef(invoice: { reference: string; unnumbered?: boolean }): string {
  return invoice.unnumbered ? DRAFT_NO_NUMBER_LABEL : invoice.reference;
}

/** The Invoice No cell of an export: the invoice's own number, blank for a draft that has none. */
export function exportedInvoiceRef(invoice: { reference: string; unnumbered?: boolean }): string {
  return invoice.unnumbered ? "" : invoice.reference;
}
