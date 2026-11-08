/**
 * The header of a delivery note made by hand (Delivery Notes page, "Without an order"). It carries no number: the database gives the
 * next DLN number from the company's counter in the same transaction (release 147's numbering guard), and refuses a typed one. An
 * invoice number named on the note is kept as a reference only; it no longer becomes the note's number (the old INV-0456 -> DLN-0456).
 */
export type HandMadeNoteInput = { customer: string; invoiceRef: string; job: string; shipDate: string; taxDate: string; notes: string };

export function handMadeDeliveryNoteHeader(input: HandMadeNoteInput) {
  return {
    customer: input.customer,
    invoice_ref: input.invoiceRef || null,
    job_ref: input.job || null,
    delivery_date: input.shipDate,
    ship_date: input.shipDate,
    tax_date: input.taxDate,
    status: "awaiting",
    notes: input.notes || null,
  };
}
