/**
 * The customer's PO (decision 16, migration 123): the reference the customer gives on their order. It goes on the quote beside the
 * quote number, and from there to the job, delivery note and invoice, always labelled "Customer PO". A purchase order WE send is a
 * supplier document ("Purchase order", "PO No.") and never shows a Customer PO.
 */
export const CUSTOMER_PO_LABEL = "Customer PO";

/** Trimmed; empty means none. */
export function customerPoText(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed : null;
}

/** "Customer PO 4471" beside a document number, or "" when there is none. */
export function customerPoBeside(value: string | null | undefined): string {
  const po = customerPoText(value);
  return po ? `${CUSTOMER_PO_LABEL} ${po}` : "";
}

/** The PDF key/value row ("Customer PO" / 4471), only when there is a PO. */
export function customerPoKeyValue(value: string | null | undefined): Array<{ label: string; value: string }> {
  const po = customerPoText(value);
  return po ? [{ label: CUSTOMER_PO_LABEL, value: po }] : [];
}
