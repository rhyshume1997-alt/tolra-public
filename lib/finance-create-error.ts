/**
 * Inputs: error thrown during invoice, delivery-note, purchase-order, or credit-note creation and the record label.
 * Outputs: user-safe message preserving definite refusals while warning on uncertain outcomes instead of claiming "Nothing was saved."
 * Boundary: Module 4 (Invoices / Delivery Notes / Purchase Orders / Credit Notes) only; does not modify shared lib/friendly-error.ts or other modules.
 */
import { ValidationError, userMessage } from "@/lib/validation/schemas";

export type FinanceCreateRecordLabel =
  | "invoice"
  | "delivery note"
  | "purchase order"
  | "credit note";

const DEFINITE_REFUSAL_CODES = new Set([
  "22023",
  "23503",
  "23505",
  "23514",
  "42501",
  "P0002",
  "PT409",
  "PGRST116",
  "PGRST301",
]);

const DEFINITE_REFUSAL_HINTS = new Set([
  "company_changed",
  "company_on_hold",
  "dln_numbering_not_set",
  "job_not_released",
  "job_not_complete",
  "job_has_draft",
  "supplier_blocked",
  "supplier_not_listed",
]);

export function uncertainFinanceCreateMessage(recordLabel: FinanceCreateRecordLabel): string {
  return `Could not confirm whether the ${recordLabel} was saved. Refresh the list and check before trying again.`;
}

function isDefiniteFinanceCreateRefusal(err: unknown): boolean {
  if (err instanceof ValidationError) return true;
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  const hint = "hint" in err ? String((err as { hint?: unknown }).hint ?? "") : "";
  if (DEFINITE_REFUSAL_CODES.has(code)) return true;
  if (DEFINITE_REFUSAL_HINTS.has(hint)) return true;
  return false;
}

/**
 * Formats an error from creating an invoice, delivery note, purchase order, or credit note.
 * Only definite client/database refusals report the refusal directly; network drops, timeouts, 5xx errors,
 * and unexpected post-write errors warn that the outcome is uncertain instead of falsely claiming nothing was saved.
 */
export function financeCreateErrorMessage(
  err: unknown,
  recordLabel: FinanceCreateRecordLabel,
): string {
  const uncertain = uncertainFinanceCreateMessage(recordLabel);
  if (isDefiniteFinanceCreateRefusal(err)) {
    return userMessage(err, uncertain);
  }
  return uncertain;
}
