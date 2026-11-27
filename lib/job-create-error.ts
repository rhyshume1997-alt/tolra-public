/**
 * Inputs: error thrown during job delivery-note or inspection recording and the record label.
 * Outputs: user-safe message preserving definite refusals while warning on uncertain outcomes instead of claiming "Nothing was saved."
 * Boundary: Module 2 (Workshop & Jobs) only; does not modify shared lib/friendly-error.ts or other modules.
 */
import { ValidationError, userMessage } from "@/lib/validation/schemas";

export type JobCreateRecordLabel = "delivery note" | "inspection";

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
  "not_independent",
  "override_reason",
  "criteria_required",
  "disposition_required",
  "concession_admin_only",
  "not_authorised_inspector",
  "drawing_revision_required",
  "traceability_missing",
  "already_despatched",
  "invoice_issued",
  "record_immutable",
]);

export function uncertainJobCreateMessage(recordLabel: JobCreateRecordLabel): string {
  return `Could not confirm whether the ${recordLabel} was saved. Refresh and check before trying again.`;
}

function isDefiniteJobCreateRefusal(err: unknown): boolean {
  if (err instanceof ValidationError) return true;
  if (!err || typeof err !== "object") return false;
  const code = "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  const hint = "hint" in err ? String((err as { hint?: unknown }).hint ?? "") : "";
  if (DEFINITE_REFUSAL_CODES.has(code)) return true;
  if (DEFINITE_REFUSAL_HINTS.has(hint)) return true;
  return false;
}

/**
 * Formats an error from creating a job delivery note or recording an inspection.
 * Definite client/database refusals keep their specific message; uncertain outcomes warn the user
 * to refresh and check instead of falsely claiming nothing was saved.
 */
export function jobCreateErrorMessage(err: unknown, recordLabel: JobCreateRecordLabel): string {
  const uncertain = uncertainJobCreateMessage(recordLabel);
  if (isDefiniteJobCreateRefusal(err)) {
    return userMessage(err, uncertain);
  }
  return uncertain;
}
