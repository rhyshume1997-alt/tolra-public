/**
 * Turns an error into a message that is safe to show users. Raw database
 * messages reveal table/column/policy names, so they are logged, not shown.
 */
import { COMPANY_CHANGED_MESSAGE } from "@/lib/page-company";

const KNOWN: Record<string, string> = {
  "23505": "That number or name is already in use. Refresh and try again.",
  "23503": "This record is linked to something that no longer exists.",
  "23514": "One of the values isn't allowed (check quantities and prices).",
  "42501": "You don't have permission to do that.",
  PGRST116: "That record couldn't be found.",
  PGRST301: "Your session has expired. Sign in again.",
};

/**
 * Codes our own database functions raise with messages written for people (validation, conflicts, not found,
 * issued-document locks). Their text is shown as is; Postgres' own messages for the same codes are not, because
 * they never pass the RAW_DB_TEXT check below.
 */
const OWN_MESSAGE_CODES = new Set(["22023", "PT409", "P0002", "42501"]);
const RAW_DB_TEXT = /row-level security|permission denied|violates|relation|column|function|syntax|constraint/i;

/**
 * Refusals that share a generic code (23514 = check violation) but carry a hint naming the rule (064's booking identity guards).
 * The hint picks the message, so a booking refusal never reads as the quantities/prices one. Our own text is shown when it is
 * safe; otherwise the fixed text here.
 */
const KNOWN_HINTS: Record<string, string> = {
  booking_has_runs: "This booking has machine run history. Keep its job and machine, or create a separate booking.",
  run_booking_mismatch: "The booking must belong to this run's job, machine and company.",
  invoice_status_not_allowed: "That isn't an invoice status Tolra uses. Nothing was changed.",
  // 081: the job flow and its release (In progress -> Finished -> Complete).
  not_independent: "The person who finished a job can't record its pass. Ask another inspector, or an admin can record it with a reason.",
  override_reason: "Give the reason for inspecting your own work (10 to 500 characters).",
  criteria_required: "Record the acceptance criteria and the measured or checked result.",
  disposition_required: "Say what failed and what happens to it: rework, scrap or concession.",
  concession_admin_only: "A concession has to be authorised by an admin.",
  reopen_required: "A Finish is kept as it was recorded. To undo it, reopen the job and say why.",
  reopen_not_allowed: "Only the person who finished it (while it awaits inspection), the office or an admin can reopen this job.",
  reason_required: "Say why (at least 10 characters).",
  already_despatched: "This job has gone out, so it can't be reopened. Record a failed inspection instead.",
  invoice_issued: "This job has been invoiced, so it can't be reopened.",
  job_not_released: "This job isn't Complete yet, so its delivery note can't be made or despatched. It can go once it passes inspection, or an admin releases it early.",
  job_not_complete: "This job isn't Complete yet, so its invoice stays a draft until it passes inspection, or an admin releases it early.",
  job_has_draft: "This job already has a draft invoice: add to that one instead of making a second.",
  early_release_admin_only: "Only an admin can release a job before it passes inspection.",
  record_immutable: "That is a record: it is never changed or removed.",
  // 083: the authorised inspectors list and the drawing revision where a job requires it.
  not_authorised_inspector: "Only an authorised inspector can record an inspection. An admin adds inspectors in Admin > Users > Inspectors.",
  drawing_revision_required: "This job needs its drawing revision before it can be Complete: enter it under Drawing revision on the job.",
  drawing_revision_via_rpc: "The drawing revision is set under Drawing revision on the job.",
  // 082 (ISO 9001): the database's own sentence names the supplier, customer or job; these stand in when it can't be shown.
  supplier_blocked: "That supplier is blocked, so this purchase order can't be issued. An admin can change its status on the Suppliers page.",
  supplier_not_listed: "Choose the supplier from the Suppliers list. Add it on the Suppliers page first.",
  supplier_status_admin_only: "Only an admin can change a supplier's status.",
  supplier_in_use: "This supplier is on purchase orders, jobs or stock items, so it can't be renamed or deleted: those records keep its name. To stop new orders, an admin can set it to Blocked.",
  customer_in_use: "This customer is on quotes, orders, jobs, delivery notes or invoices, so it can't be renamed or deleted: those records keep its name.",
  traceability_missing: "This job is traceable: enter its material cert no. and heat/cast no. on the worksheet before it can pass.",
  // 088: a converted sales order's value and VAT are its job's (the database's own sentence names the job).
  sales_order_converted: "Converted to a job: change the job, not the order.",
  // 091: a draft invoice gets its number and leaves draft only through Issue invoice.
  invoice_issue_direct: "A draft invoice is issued with Issue invoice, which gives it the next number. Its number and status can't be set by editing it.",
  // 110: logging an RFQ clarification e-mail (the e-mail and the RFQ's status in one step).
  rfq_not_allowed: "Only admin and office staff can log RFQ e-mails.",
  rfq_not_found: "That RFQ couldn't be found. Refresh the page and try again.",
  rfq_no_email: "This RFQ has no email address. Add one before sending.",
  rfq_email_subject: "The e-mail needs a subject.",
  // S5: another tab switched the session's company since this page opened (lib/page-company.ts): nothing was saved.
  company_changed: COMPANY_CHANGED_MESSAGE,
};

export function friendlyError(err: unknown, fallback = "Something went wrong. Try again.") {
  if (typeof console !== "undefined") console.error(err);
  const code = typeof err === "object" && err && "code" in err ? String((err as { code: unknown }).code) : "";
  const message = err instanceof Error ? err.message : typeof err === "object" && err && "message" in err ? String((err as { message: unknown }).message) : "";
  const hint = typeof err === "object" && err && "hint" in err ? String((err as { hint: unknown }).hint) : "";
  if (Object.prototype.hasOwnProperty.call(KNOWN_HINTS, hint)) return message && message.length <= 300 && !RAW_DB_TEXT.test(message) ? message : KNOWN_HINTS[hint];
  if (OWN_MESSAGE_CODES.has(code) && message && message.length <= 300 && !RAW_DB_TEXT.test(message)) return message;
  if (code && KNOWN[code]) return KNOWN[code];
  if (/JWT|session/i.test(message)) return KNOWN.PGRST301;
  if (/permission denied|row-level security/i.test(message)) return KNOWN["42501"];
  if (/Failed to fetch|NetworkError|network/i.test(message)) return "Can't reach the server. Check your connection and try again.";
  return fallback;
}
