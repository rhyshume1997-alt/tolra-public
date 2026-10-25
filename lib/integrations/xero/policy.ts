// Every behaviour that depends on an unanswered Xero sign-off question (Tolra Progress, G22, "Xero sign-off questions") is decided here
// and only here, set to the G22 default until the JNR controller and the accountant answer. Each names its question. Question 5's carriage rule is in
// the database (migration 084, public.integration_carriage_vat_key), where every VAT key is worked out.
//
// Questions that change no code: 1 (which Xero org per company: Rhys connects each company to its own), 2 (VAT scheme: Tolra's VAT
// registration decides "no_vat"; the scheme itself changes nothing that is sent), 3 (CIS: no CIS or reverse-charge handling is built;
// if any work is under CIS, its tax rate is added as a mapping), 4 and 5 (account codes and tax codes: data the admin enters on the
// mapping page), 8 (payments: never sent, never pulled; the office marks paid in Tolra by hand).

/** Q7 (credit notes as Xero credit notes or negative invoices). G22 default: Xero credit notes (ACCRECCREDIT); negative invoices are not built. */
export const CREDIT_NOTE_XERO_TYPE = "ACCRECCREDIT" as const;

/** Q7 with Q8: a credit note is sent unallocated (its Reference is the invoice number); allocating it to the invoice in Xero is a payment-like step the accountant does in Xero. */
export const ALLOCATE_CREDIT_NOTES = false;

/** Q9 (who may connect and disconnect). Rhys, Wed 21 Oct: admins only (after the second step of sign-in); the database checks the same. */
export const CONNECT_ROLES = ["admin"] as const;

/** Rhys, Wed 21 Oct: the mappings (account codes, tax rates) are an admin's too; the database checks the same (integration_set_mapping). */
export const MAPPING_ROLES = ["admin"] as const;

/**
 * Rhys, Wed 21 Oct: every manual send, retry or resend (Send now; the send log's Retry in PR 2) is an admin's. The automatic send right
 * after an invoice or credit note is issued (or an invoice voided) runs for whoever issued it, but only for that document's first attempt.
 */
export const MANUAL_SEND_ROLES = ["admin"] as const;
export const AUTOMATIC_SEND_ROLES = ["admin", "office"] as const;

/** Q10 (who sends invoices to customers). G22 default: Tolra, as today. Xero never e-mails the customer: SentToContact stays false and the e-mail endpoint is never called. */
export const XERO_EMAILS_CUSTOMERS = false;

/** Q6 (tracking categories). G22 default: none; no tracking category is sent on any line. */
export const TRACKING_CATEGORIES: ReadonlyArray<{ name: string; option: string }> = [];

/**
 * Q11 (an invoice sent to Xero and voided later in Tolra). G22 default: void it in Xero too (Status VOIDED). Xero refuses when a payment
 * or credit is applied there (from the bank feed); then nothing is changed automatically: the send log says so and the accountant raises a
 * credit note in Xero by hand.
 */
export const VOID_IN_XERO = true;
export function voidRefusedMessage(xeroMessage: string): string {
  return `Xero did not void it (${xeroMessage.slice(0, 200)}). It may have a payment or credit applied in Xero: raise a credit note in Xero by hand.`;
}
