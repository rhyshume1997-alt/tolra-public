/**
 * Inputs: error thrown during quote or sales-order creation and the document label ("quote" | "sales order").
 * Outputs: user-safe message preserving definite refusals while warning on uncertain outcomes instead of claiming "Nothing was saved."
 * Boundary: Module 3 (Quotes / Sales Orders) only; does not modify shared lib/friendly-error.ts or other modules.
 */
import { ValidationError, userMessage } from "@/lib/validation/schemas";

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

export function uncertainCreateMessage(recordLabel: "quote" | "sales order"): string {
  return `Could not confirm whether the ${recordLabel} was saved. Refresh the list and check before trying again.`;
}

function isDefiniteCreateRefusal(err: unknown): boolean {
  if (err instanceof ValidationError) return true;
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  const hint = "hint" in err ? String((err as { hint?: unknown }).hint ?? "") : "";
  if (DEFINITE_REFUSAL_CODES.has(code)) return true;
  if (hint === "company_changed" || hint === "company_on_hold") return true;
  return false;
}

/**
 * Formats an error from creating a quote or sales order.
 * Only definite client/database refusals report the refusal directly; network drops, timeouts, 5xx errors,
 * and unexpected post-write errors warn that the outcome is uncertain instead of falsely claiming nothing was saved.
 */
export function salesCreateErrorMessage(err: unknown, recordLabel: "quote" | "sales order"): string {
  const uncertain = uncertainCreateMessage(recordLabel);
  if (isDefiniteCreateRefusal(err)) {
    return userMessage(err, uncertain);
  }
  return uncertain;
}
