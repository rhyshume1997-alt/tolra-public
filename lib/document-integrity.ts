import { toPence } from "@/lib/money";

/**
 * Stored face value vs what a document's lines add up to (independent review of 0604bf4). An issued quote or
 * invoice is printed from its lines, so when the stored totals (what the customer was actually given) differ from
 * the lines, a reprint would show amounts nobody issued. Imported records can be like this: the legacy system kept
 * a total but not always the unit prices or VAT treatment behind it. Nothing is guessed or rewritten: the document
 * is refused, with the reason, and the stored amounts stay as they are.
 */
export type StoredTotals = { total: number; subtotal?: number | null; vat?: number | null };
export type ComputedTotals = { total: number; subtotal: number; vat: number };

const gbp = (n: number) => `£${(toPence(n) / 100).toFixed(2)}`;

export class DocumentTotalsMismatchError extends Error {
  constructor(
    readonly reference: string,
    readonly stored: StoredTotals,
    readonly computed: ComputedTotals,
    readonly issued: boolean,
  ) {
    super(
      `${reference} has a stored total of ${gbp(stored.total)}, but its line items add up to ${gbp(computed.total)}. ` +
        "The original prices or VAT can't be worked out from the record, so it can't be printed or sent as it is. " +
        (issued
          ? "The stored amount is kept unchanged; copy it to a new document if it needs to go out again."
          : "Correct the lines so they match before issuing it."),
    );
    this.name = "DocumentTotalsMismatchError";
  }
}

/** Null when every stored figure matches the lines to the penny. Only the figures the record stores are compared. */
export function totalsMismatch(reference: string, stored: StoredTotals, computed: ComputedTotals, issued: boolean) {
  const differs = (a: number | null | undefined, b: number) => a !== null && a !== undefined && toPence(Number(a)) !== toPence(b);
  if (differs(stored.total, computed.total) || differs(stored.subtotal, computed.subtotal) || differs(stored.vat, computed.vat)) {
    return new DocumentTotalsMismatchError(reference, stored, computed, issued);
  }
  return null;
}
