/**
 * Turns activity-trail rows (public.record_activity / public.org_activity, migration 013) into plain sentences:
 * "Status: Draft → Sent", "Drawing added: part-12.pdf", "Signed off by Dave".
 */

import { fmtDateTime } from "@/lib/dates";
import { cleanName, type PeopleMap, personName, UNKNOWN } from "@/lib/people";

export type ActivityEntry = {
  id: string;
  created_at: string;
  actor_name: string | null;
  /** org_activity (admins) only: the record history never carries an e-mail address (migration 035). */
  actor_email?: string | null;
  action: string;
  entity_table: string;
  entity_id: string | null;
  changes: Record<string, FieldChange> | null;
  snapshot: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  // org_activity only
  actor_user_id?: string | null;
  record_table?: string | null;
  record_id?: string | null;
  record_label?: string | null;
};

export type FieldChange =
  | { from: unknown; to: unknown }
  | { added: unknown[]; removed: unknown[] }
  | { changed: true; keys?: string[] };

export const RECORD_TYPES: { table: string; label: string; singular: string }[] = [
  { table: "quotes", label: "Quotes", singular: "Quote" },
  { table: "jobs", label: "Jobs", singular: "Job" },
  { table: "sales_orders", label: "Sales orders", singular: "Sales order" },
  { table: "invoices", label: "Invoices", singular: "Invoice" },
  { table: "purchase_orders", label: "Purchase orders", singular: "Purchase order" },
  { table: "delivery_notes", label: "Delivery notes", singular: "Delivery note" },
  { table: "customers", label: "Customers", singular: "Customer" },
  { table: "suppliers", label: "Suppliers", singular: "Supplier" },
  { table: "machines", label: "Machines", singular: "Machine" },
  { table: "user_profiles", label: "Users", singular: "User profile" },
];

const CHILD_LABELS: Record<string, string> = {
  quote_line_items: "Line",
  invoice_line_items: "Line",
  delivery_note_items: "Line",
  quote_attachments: "Attachment",
  machine_bookings: "Machine booking",
  job_machines: "Job machine",
  sales_order_line_machines: "Order line machine",
  job_values: "Job value",
};

/** Names for the other tables the trail records (a run on a machine, a sign-off ...), so no raw table name shows. */
const TABLE_LABELS: Record<string, string> = {
  machine_runs: "Machine run",
  bench_runs: "Bench run",
  machine_run_ops: "Machine run",
  job_signoffs: "Sign-off",
  job_files: "File",
  document_attachments: "File",
  job_rework: "Rework",
  job_rework_entries: "Rework entry",
  // 081: the job flow's history (finish, reopen with its reason, put back, complete, pass voided, early release) and each inspection.
  job_flow_events: "Job flow",
  job_inspections: "Inspection",
  invoice_payments: "Payment",
  credit_notes: "Credit note",
  credit_note_lines: "Credit note line",
  // Every other audited table, so the Activity and Security pages never fall back to a raw table name ("Rfqs", "Attendance events").
  rfqs: "RFQ",
  stock: "Stock item",
  operator_sessions: "Operator session",
  time_settings: "Time setting",
  attendance_events: "Clock action",
  attendance_event_networks: "Clock action network",
  time_week_approvals: "Week approval",
  time_day_flags: "Day flag",
  time_sync_rejections: "Rejected clock sync",
  invoice_queue_events: "Invoice queue event",
  inspector_authorisations: "Inspector authorisation",
  integration_connections: "Integration connection",
  integration_mappings: "Integration mapping",
  integration_contacts: "Integration contact",
  integration_sends: "Integration send",
  site_network_settings: "Site network setting",
  site_networks: "Site network",
  site_network_members: "Site network member",
  // 114: the clock-in network lock and the clock actions it could not check.
  clock_in_network_locks: "Clock-in network lock",
  clock_in_network_exemptions: "Off-site clock-in setting",
  clock_in_network_unverified: "Unchecked clock action",
  import_mappings: "Import mapping",
  import_batches: "Import batch",
  import_runs: "Import run",
};

/**
 * Columns that hold a person (a user id): shown as that person's display name from company_people, or "—" when they have no
 * usable name (lib/people.ts). Never the id, never an e-mail address.
 */
const PERSON_FIELDS = new Set([
  "created_by", "started_by", "finished_by", "ended_by", "operator_id", "assigned_to", "assigned_by", "sent_by", "accepted_by",
  "issued_by", "paid_by", "emailed_by", "confirmed_by", "received_by", "despatched_by", "signed_recorded_by", "deleted_by",
  "inspected_by_user", "signed_by", "raised_by", "disposition_by", "user_id", "actor_user_id", "taken_over_by", "released_by",
]);

/** Internal columns that mean nothing to a person reading the history: never shown. */
const HIDDEN_FIELDS = new Set([
  "id", "organization_id", "updated_at", "version", "client_op_id", "ended_op_id", "op_id", "request_id", "storage_path",
  "storage_bucket", "signature_data", "snapshot", "issuer_snapshot", "customer_snapshot", "search_vector",
]);
const HIDDEN_PATTERN = /(_id|_op_id|_sha256|_hash|_key|_token)$|^hash$|sha256/;

/** Whether a field of a change is internal (ids, op ids, hashes) and so left out of the history as people see it. */
export function isHiddenField(key: string) {
  if (PERSON_FIELDS.has(key)) return false;
  return HIDDEN_FIELDS.has(key) || HIDDEN_PATTERN.test(key);
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_TEXT.test(value.trim());

/** Stored values (enums) as words, per column, then for any column. */
const VALUE_LABELS: Record<string, Record<string, string>> = {
  end_reason: { paused: "Paused", finished: "Finished", override: "Taken over by another job", admin_released: "Released by an admin", to_machine: "Moved onto a machine" },
  kind: { primary: "Operator", inspector: "Inspector", start: "Start", pause: "Pause", photo: "Photo", drawing: "Drawing", cert: "Certificate" },
  signature_kind: { drawn: "Drawn", typed: "Typed" },
  upload_state: { reserved: "Waiting for upload", uploaded: "Uploaded", abandoned: "Upload abandoned" },
};
const ANY_VALUE_LABELS: Record<string, string> = {
  paused: "Paused", finished: "Finished", to_machine: "Moved onto a machine", admin_released: "Released by an admin", on_bench: "On the bench",
  on_machine: "On a machine", in_progress: "In progress", on_track: "On track", at_risk: "At risk",
};

/** A stored value of a column as people read it: an enum as words, anything else formatted as before. */
function valueText(key: string, value: unknown): string {
  if (typeof value === "string") {
    const label = VALUE_LABELS[key]?.[value] ?? ANY_VALUE_LABELS[value];
    if (label) return label;
  }
  return formatValue(value);
}

const FIELD_LABELS: Record<string, string> = {
  status: "Status",
  stage: "Stage",
  customer: "Customer",
  supplier: "Supplier",
  description: "Description",
  total_value: "Value",
  value: "Value",
  quantity: "Quantity",
  unit_price: "Unit price",
  vat_pct: "VAT rate",
  vat_exempt: "VAT exempt",
  vat_enabled: "VAT",
  part_number: "Part no.",
  drawing_number: "Drawing no.",
  drawing_revision: "Drawing revision",
  declined: "Not ordered",
  version: "Version",
  carriage: "Carriage",
  carriage_vat: "VAT on carriage",
  due_date: "Due date",
  valid_until: "Valid until",
  delivery_date: "Delivery date",
  expected_delivery: "Expected delivery",
  order_date: "Order date",
  invoice_date: "Invoice date",
  customer_po: "Customer PO",
  terms: "Terms",
  notes: "Notes",
  internal_notes: "Internal notes",
  customer_notes: "Notes to customer",
  amount_paid: "Amount paid",
  items: "Items",
  drawing_no: "Drawing no.",
  quantity_required: "Quantity required",
  material_required: "Material",
  material_ordered: "Material ordered",
  material_supplier: "Material supplier",
  material_cert_no: "Material cert no.",
  heat_cast_no: "Heat/cast no.",
  dimension_report_no: "Dimension report no.",
  setup_time_hr: "Setup time (h)",
  run_time_hr: "Run time (h)",
  job_time_quoted_hr: "Time quoted (h)",
  job_time_taken_hr: "Time taken (h)",
  improvement_comments: "Improvement comments",
  overrun_reasons: "Overrun reasons",
  checked_by: "Checked by",
  start_at: "Start",
  estimated_hours: "Estimated hours",
  hours_done: "Hours done",
  day_plan: "Split by day",
  ship_via: "Ship via",
  signature_notes: "Signature notes",
  file_name: "File",
  end_reason: "Ended because",
  ended_at: "Ended",
  ended_by: "Ended by",
  operator_id: "Operator",
  assigned_to: "Assigned to",
  assigned_at: "Assigned",
  assigned_by: "Assigned by",
  started_by: "Started by",
  finished_by: "Finished by",
  created_by: "Created by",
  sent_by: "Sent by",
  accepted_by: "Accepted by",
  issued_by: "Issued by",
  paid_by: "Paid by",
  emailed_by: "E-mailed by",
  confirmed_by: "Confirmed by",
  received_by: "Received by",
  despatched_by: "Despatched by",
  signed_recorded_by: "Signature recorded by",
  deleted_by: "Removed by",
  deleted_at: "Removed",
  inspected_by_user: "Inspected by",
  signed_by: "Signed by",
  raised_by: "Raised by",
  device_started_at: "Start time on the device",
  device_ended_at: "End time on the device",
  worksheet_version: "Worksheet revision",
  upload_state: "Upload",
  uploaded_at: "Uploaded",
  captured_at: "Taken",
  byte_size: "Size (bytes)",
  mime_type: "File type",
  signer_name: "Signed by",
  signed_on: "Signed on",
  // Customer sign-off (072).
  signer_position: "Position",
  signer_company: "Company",
  customer_comment: "Customer's comment",
  statement: "Statement signed",
  device_signed_at: "Signed on the phone at",
  shown_worksheet_version: "Revision on the phone",
  signature_kind: "Signature",
  initials: "Initials",
  is_internal: "Internal job",
};

const ACTION_LABELS: Record<string, string> = {
  SEND_TO_WORKSHOP: "Sent to the workshop",
  CONVERT_TO_JOB: "Converted to a job",
  MARK_PAID: "Marked as paid",
  RECORD_PAYMENT: "Payment recorded",
  REVERSE_PAYMENT: "Payment reversed",
  MARK_RECEIVED: "Marked as received",
  INSPECT_JOB: "Inspection recorded",
  JOB_SIGN_OFF: "Signed off",
  JOB_CUSTOMER_SIGN_OFF: "Customer signed off",
  FAIL_INSPECTION: "Failed inspection: sent to rework",
  JOB_DRAFT_INVOICE: "Draft invoice made when the job was finished",
  LINK_JOB_INVOICE: "Put on the job's invoice",
  CREATE_JOB: "Job created on the Job Board",
  OVERRIDE_MACHINE_CLASH: "Booked over another job (admin)",
  SET_SO_LINE_MACHINES: "Machines set on an order line",
  CARRY_MACHINES: "Machines carried from the sales order",
  SET_JOB_MACHINES: "Machines on the job changed",
  START_MACHINE_RUN: "Started on a machine",
  PAUSE_MACHINE_RUN: "Paused: machine freed",
  OVERRIDE_MACHINE_IN_USE: "Took over a machine another job was using (admin)",
  FINISH_ENDS_MACHINE_RUNS: "Finished: machines freed",
  RELEASE_MACHINE: "Machine released (admin)",
  MACHINE_RUN_TIME_CONFLICT: "Offline time not used: server time recorded",
  START_OVER_PAUSED_JOB: "Started on a machine paused on another job (check recorded)",
  BOOK_OVER_PAUSED_JOB: "Booked a machine paused on another job (check recorded)",
  ASSIGN_JOB: "Assigned to an operator",
  START_REWORK: "Rework started",
  RECORD_REWORK_COST: "Rework hours or material recorded",
  SCRAP: "Parts scrapped",
  FINISH_REWORK: "Rework finished: awaiting re-inspection",
  REOPEN_REWORK: "Rework reopened for the replacements still to make",
  ADD_PHOTO: "Photo added",
  REMOVE_PHOTO: "Photo removed",
  PHOTO_MISMATCH: "Photo upload refused (the stored file didn't match)",
  ABANDON_STALE_PHOTOS: "Unfinished photo uploads closed",
  SEND: "Sent",
  DESPATCH: "Despatched",
  QUOTE_EMAILED: "Emailed to the customer",
  CREATE_USER: "User created",
  SET_USER_PASSWORD: "Password set by an admin",
  CHANGE_OWN_PASSWORD: "Changed their password",
  UPDATE_USER_ACCESS: "Access changed",
  DEACTIVATE_USER: "Deactivated",
  REACTIVATE_USER: "Reactivated",
  UPDATE_USERNAME: "Username changed",
  RESET_MFA: "Two-step sign-in reset",
  // 066: written by admin_set_company_access in the company whose access changed.
  GRANT_COMPANY_ACCESS: "Given access to this company",
  CHANGE_COMPANY_ROLE: "Role in this company changed",
  REMOVE_COMPANY_ACCESS: "Access to this company removed",
  ISSUE: "Issued",
  CONFIRM: "Confirmed",
  CONFIRM_STILL_OWED: "Confirmed as still owed",
  CONFIRM_PAYMENTS: "Payments confirmed",
  APPLY_CREDIT: "Credit applied",
  VOID_INVOICE: "Invoice voided",
  WRITE_OFF_INVOICE: "Invoice written off",
  REVERSE_WRITE_OFF: "Write-off reversed",
  RESEND: "Sent again",
  REVISE: "Revised as a new version",
  REOPEN: "Reopened",
};

/** A table as people name it: "Quote", "Machine run", "Sign-off" (never the raw table name). */
export function recordTypeLabel(table: string) {
  return RECORD_TYPES.find((type) => type.table === table)?.singular ?? TABLE_LABELS[table] ?? CHILD_LABELS[table] ?? humanise(table);
}

/** Plain wording for a raw audit action (INSERT / UPDATE / DELETE); named events keep their own words. */
export function auditActionLabel(action: string) {
  return ({ INSERT: "Created", UPDATE: "Changed", DELETE: "Removed" } as Record<string, string>)[action] ?? humanise(action.toLowerCase());
}

export function humanise(key: string) {
  return FIELD_LABELS[key] ?? key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T|\s)\d{2}:\d{2}/.test(value);
}

/** A day of a plan, read from JSON text when it arrives as a string; anything else is returned as it is. */
function readDay(value: unknown): unknown {
  if (typeof value !== "string" || !/^\s*\{/.test(value)) return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

/** A day of a booking split by day: {date, start, end} (or the earlier {date, hours}). */
function isPlanDay(value: unknown): value is { date: unknown; start?: unknown; end?: unknown; hours?: unknown } {
  return Boolean(value && typeof value === "object" && "date" in value && (("start" in value && "end" in value) || "hours" in value));
}

/** "10/10/2026" for a YYYY-MM-DD date (the one date format of lists and tables, lib/dates fmtDate), or the text as it is. */
function weekdayDate(value: unknown) {
  const m = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m) return formatValue(value);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "empty";
  // The database can hand a day_plan element over as JSON text: '{"date": "2026-10-10", "start": "05:00", "end": "13:00"}'. Read it, or keep the text.
  if (typeof value === "string" && /^\s*[{[]/.test(value)) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) || isPlanDay(parsed)) return formatValue(parsed);
    } catch { /* not JSON: show the text */ }
  }
  // A booking split by day (machine_bookings.day_plan), or one day of it: "10/10/2026 05:00-13:00".
  if (Array.isArray(value) && value.length) {
    const days = value.map(readDay);
    if (days.every(isPlanDay)) return days.map(formatValue).join(", ");
  }
  if (isPlanDay(value)) {
    if ("start" in value && "end" in value) return `${weekdayDate(value.date)} ${String(value.start)}-${String(value.end)}`;
    return `${String(value.hours)}h on ${formatValue(value.date)}`;
  }
  if (isTimestamp(value)) return fmtDateTime(value);
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split("-");
    return `${d}/${m}/${y}`;
  }
  const text = String(value).replace(/_/g, " ");
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

const isEmpty = (value: unknown) => value === null || value === undefined || value === "";

const fileName = (value: unknown) => String(value ?? "").split("/").pop() || String(value ?? "");

/** One line per changed field, special-casing the fields people care about. */
export function describeChanges(changes: Record<string, FieldChange> | null | undefined, names: PeopleMap = {}): string[] {
  if (!changes) return [];
  const lines: string[] = [];
  for (const [key, change] of Object.entries(changes)) {
    if (!change || typeof change !== "object" || isHiddenField(key)) continue;
    if ("added" in change) {
      const noun = key === "drawings" ? "Drawing" : humanise(key);
      change.added.forEach((item) => lines.push(`${noun} added: ${key === "drawings" ? fileName(item) : formatValue(item)}`));
      change.removed.forEach((item) => lines.push(`${noun} removed: ${key === "drawings" ? fileName(item) : formatValue(item)}`));
      continue;
    }
    if ("changed" in change) {
      if (key === "checklist") lines.push(`Checklist updated${change.keys?.length ? `: ${change.keys.map(humanise).join(", ")}` : ""}`);
      else lines.push(`${humanise(key)} updated`);
      continue;
    }
    const { from, to } = change;
    if (key === "signed_off_at" || key === "signed_at" || key === "sent_at" || key === "paid_at" || key === "received_at"
        || key === "started_at" || key === "finished_at" || key === "emailed_at" || key === "converted_at") {
      const verb: Record<string, string> = {
        signed_off_at: "Worksheet signed off", signed_at: "Signed for", sent_at: "Sent", paid_at: "Paid", received_at: "Received",
        started_at: "Job started", finished_at: "Job completed", emailed_at: "Emailed", converted_at: "Converted",
      };
      lines.push(to ? `${verb[key]} (${formatValue(to)})` : `${verb[key]}: cleared`);
      continue;
    }
    if (key === "signed_off_by" && to) { lines.push(`Signed off by ${formatValue(to)}`); continue; }
    if (key === "signed_by_name" && to) { lines.push(`Signed by ${formatValue(to)}`); continue; }
    if (PERSON_FIELDS.has(key)) {
      // A person: their display name, or "—". Set for the first time reads "Ended by Dave"; cleared reads "Assigned to: cleared".
      const who = (value: unknown) => (isEmpty(value) ? "" : personName(names, value));
      if (isEmpty(from) && isEmpty(to)) continue;
      lines.push(isEmpty(from) ? `${humanise(key)} ${who(to)}` : isEmpty(to) ? `${humanise(key)}: cleared` : `${humanise(key)}: ${who(from)} → ${who(to)}`);
      continue;
    }
    // An id we can't name (a link to another record) means nothing here: left out rather than shown raw.
    if (isUuid(from) || isUuid(to)) continue;
    // Set for the first time: "Ended: 09/10/2026, 10:00" (not "empty → ..."); cleared: "Due date: 01/10/2026 → cleared".
    if (isEmpty(from) && isEmpty(to)) continue;
    if (isEmpty(from)) lines.push(`${humanise(key)}: ${valueText(key, to)}`);
    else if (isEmpty(to)) lines.push(`${humanise(key)}: ${valueText(key, from)} → cleared`);
    else lines.push(`${humanise(key)}: ${valueText(key, from)} → ${valueText(key, to)}`);
  }
  return lines;
}

/** Headline + detail lines for one entry. `names` (company_people) lets an event name the person it refers to. */
export function describeEntry(entry: ActivityEntry, names: PeopleMap = {}): { title: string; details: string[] } {
  const child = CHILD_LABELS[entry.entity_table];
  const snap = entry.snapshot ?? {};
  const named = String(snap.description ?? snap.file_name ?? snap.quote_ref ?? snap.invoice_ref ?? snap.so_number ?? snap.po_ref ?? snap.dn_number ?? snap.job_no ?? "");
  const what = isUuid(named) ? "" : named;
  const singular = RECORD_TYPES.find((type) => type.table === entry.entity_table)?.singular ?? TABLE_LABELS[entry.entity_table] ?? humanise(entry.entity_table);

  if (entry.action === "INSERT") {
    if (entry.entity_table === "quote_attachments") return { title: `File added: ${fileName(snap.file_name)}`, details: [] };
    if (child) return { title: `${child} added${what ? `: ${formatValue(what)}` : ""}`, details: snap.quantity !== undefined ? [`Qty ${formatValue(snap.quantity)}${snap.unit_price !== undefined ? ` @ ${formatValue(snap.unit_price)}` : ""}`] : [] };
    return { title: `${singular} created`, details: what && !child ? [formatValue(what)] : [] };
  }
  if (entry.action === "DELETE") {
    if (entry.entity_table === "quote_attachments") return { title: `File removed: ${fileName(snap.file_name)}`, details: [] };
    return { title: `${child ?? singular} removed${what ? `: ${formatValue(what)}` : ""}`, details: [] };
  }
  if (entry.action === "UPDATE") {
    const details = describeChanges(entry.changes, names);
    const status = entry.changes?.status;
    if (status && "to" in status) return { title: `Status changed to ${formatValue(status.to)}`, details: details.filter((line) => !line.startsWith("Status:")) };
    // A run (on a machine, or on the bench) that ended: "Machine run ended: Paused", then who and when.
    const ended = entry.changes?.end_reason;
    if (ended && "to" in ended && !isEmpty(ended.to)) {
      return { title: `${singular} ended: ${valueText("end_reason", ended.to)}`, details: details.filter((line) => !line.startsWith(`${humanise("end_reason")}:`)) };
    }
    if (child) return { title: `${child} edited${what ? `: ${formatValue(what)}` : ""}`, details };
    if (details.length === 1) return { title: details[0], details: [] };
    return { title: "Edited", details };
  }
  const label = ACTION_LABELS[entry.action] ?? humanise(entry.action.toLowerCase());
  const meta = entry.metadata ?? {};
  const extra = typeof meta.recipient === "string" ? [`To ${meta.recipient}`] : [];
  if (entry.action === "RECORD_PAYMENT" || entry.action === "REVERSE_PAYMENT") {
    // Amounts are removed from the history of people who may not see money (migration 024), so each part is optional.
    const amount = typeof meta.amount === "number" ? `£${Math.abs(meta.amount).toFixed(2)}` : "";
    const when = typeof meta.paid_on === "string" ? ` on ${formatValue(meta.paid_on)}` : "";
    const how = typeof meta.method === "string" && meta.method ? ` by ${meta.method}` : "";
    const lines = [amount ? `${amount}${when}${how}` : "", typeof meta.reference === "string" && meta.reference ? `Reference ${meta.reference}` : "", typeof meta.reason === "string" ? `Reason: ${meta.reason}` : ""].filter(Boolean);
    return { title: label, details: lines };
  }
  // Migration 073: the reason given when the invoice was voided.
  // Migration 105: the reason given when the invoice was written off, or its write-off reversed.
  if (entry.action === "VOID_INVOICE" || entry.action === "WRITE_OFF_INVOICE" || entry.action === "REVERSE_WRITE_OFF") {
    return { title: label, details: typeof meta.reason === "string" && meta.reason ? [`Reason: ${meta.reason}`] : [] };
  }
  if (entry.action === "RESEND") {
    const previous = typeof meta.previous_by === "string" ? ` by ${personName(names, meta.previous_by)}` : "";
    const when = typeof meta.previous_at === "string" ? ` on ${formatValue(meta.previous_at)}` : "";
    return { title: label, details: previous || when ? [`Previously sent${previous}${when}`] : [] };
  }
  if (entry.action === "REOPEN") {
    const lines = [typeof meta.previous_finished_by === "string" ? `Had been finished by ${personName(names, meta.previous_finished_by)}` : "", meta.sign_off_withdrawn === true ? "Inspection sign-off withdrawn" : ""].filter(Boolean);
    return { title: label, details: lines };
  }
  if (entry.action === "INSPECT_JOB") {
    const result = typeof meta.result === "string" ? humanise(meta.result) : "";
    const lines = [result ? `Result: ${result}${meta.release_decision === "released" ? " (released)" : " (held)"}` : "", typeof meta.concession_reason === "string" ? `Concession: ${meta.concession_reason}` : "", meta.after_rework === true ? "Inspected again after rework" : ""].filter(Boolean);
    return { title: label, details: lines };
  }
  // Operator sign-off (migration 045): the revision signed.
  if (entry.action === "JOB_SIGN_OFF" || entry.action === "JOB_CUSTOMER_SIGN_OFF") {
    // The worksheet hash is kept on the sign-off itself (the job's sign-off section); the history shows the revision only.
    const revision = typeof meta.worksheet_version === "number" ? ` (revision ${meta.worksheet_version})` : "";
    return { title: `${label}${revision}`, details: [] };
  }
  // Rework (migration 037). Amounts of money are removed from these for people who may not see money, so each part is optional.
  if (entry.action === "FAIL_INSPECTION") {
    const quantity = typeof meta.quantity === "number" ? (meta.all_of_job === true ? `All of the job (${meta.quantity})` : `${meta.quantity} affected`) : meta.all_of_job === true ? "All of the job" : "";
    // Which order lines (and batches) failed, when the job was made from a sales order: only those are held.
    const failedLines = Array.isArray(meta.lines) && meta.all_of_job !== true
      ? (meta.lines as Array<Record<string, unknown>>).map((item) => `${typeof item.line === "string" ? item.line : "Order line"}: ${typeof item.quantity === "number" ? item.quantity : "all"}${typeof item.batch === "string" ? ` (batch ${item.batch})` : ""}`)
      : [];
    const lines = [typeof meta.reason === "string" ? `Reason: ${meta.reason}` : "", quantity ? `Quantity: ${quantity}` : "", ...failedLines.map((text) => `Failed: ${text}`),
      failedLines.length === 0 && typeof meta.batch === "string" ? `Batch: ${meta.batch}` : "",
      typeof meta.instructions === "string" ? `Instructions: ${meta.instructions}` : "", "Assigned to the workshop"].filter(Boolean);
    return { title: label, details: lines };
  }
  if (entry.action === "REOPEN_REWORK") {
    const lines = [typeof meta.quantity === "number" ? `To make: ${meta.quantity}${typeof meta.line === "string" ? ` of ${meta.line}` : ""}${typeof meta.batch === "string" ? ` (batch ${meta.batch})` : ""}` : "",
      typeof meta.instructions === "string" ? `Instructions: ${meta.instructions}` : "", "Assigned to the workshop; released only after they pass inspection"].filter(Boolean);
    return { title: label, details: lines };
  }
  if (entry.action === "SCRAP") {
    const lines = [typeof meta.quantity === "number" ? `Scrapped ${meta.quantity}${typeof meta.reason === "string" ? `: ${meta.reason}` : ""}` : "", typeof meta.remaining_to_make === "number" ? `Remaining to make: ${meta.remaining_to_make}` : ""].filter(Boolean);
    return { title: label, details: lines };
  }
  if (entry.action === "RECORD_REWORK_COST") {
    const lines = [typeof meta.hours === "number" ? `${meta.hours} h worked` : "", typeof meta.material === "string" ? `Material: ${meta.material}` : "", typeof meta.material_cost === "number" ? `Material cost £${meta.material_cost.toFixed(2)}` : ""].filter(Boolean);
    return { title: label, details: lines };
  }
  if (entry.action === "FINISH_REWORK") {
    const lines = [typeof meta.rework_hours === "number" ? `${meta.rework_hours} h of rework in all` : "", typeof meta.quantity_scrapped === "number" && meta.quantity_scrapped > 0 ? `${meta.quantity_scrapped} scrapped and remade` : "", typeof meta.note === "string" ? meta.note : ""].filter(Boolean);
    return { title: label, details: lines };
  }
  if (entry.action === "START_REWORK") {
    return { title: label, details: typeof meta.quantity === "number" ? [`Quantity: ${meta.quantity}`] : [] };
  }
  return { title: label, details: extra };
}

/** Collapses the many rows a single save writes for line items into one entry per (time, actor, table). */
export function groupEntries(entries: ActivityEntry[]): ActivityEntry[][] {
  const groups: ActivityEntry[][] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    const head = last?.[0];
    if (head && CHILD_LABELS[entry.entity_table] && entry.entity_table === head.entity_table && entry.created_at === head.created_at
        && entry.actor_name === head.actor_name && entry.entity_table !== "quote_attachments") {
      last.push(entry);
    } else {
      groups.push([entry]);
    }
  }
  return groups;
}

export function describeGroup(group: ActivityEntry[], names: PeopleMap = {}): { title: string; details: string[] } {
  if (group.length === 1) return describeEntry(group[0], names);
  const child = CHILD_LABELS[group[0].entity_table] ?? "Line";
  const added = group.filter((e) => e.action === "INSERT").length;
  const removed = group.filter((e) => e.action === "DELETE").length;
  const edited = group.filter((e) => e.action === "UPDATE").length;
  const parts = [added ? `${added} added` : "", edited ? `${edited} edited` : "", removed ? `${removed} removed` : ""].filter(Boolean);
  return {
    title: `${child}s updated (${parts.join(", ")})`,
    details: group.filter((e) => e.action !== "DELETE").map((e) => describeEntry(e, names).title).slice(0, 8),
  };
}

/** Each kind of record's own number: the keys a named event's metadata may carry it under (as migration 080 labels the rows). */
const RECORD_NUMBER_KEYS: Record<string, string[]> = {
  quotes: ["quote_ref"],
  invoices: ["invoice_ref"],
  credit_notes: ["credit_ref"],
  sales_orders: ["so_number"],
  purchase_orders: ["po_ref", "po_number"],
  delivery_notes: ["dn_number"],
  jobs: ["job_no"],
};

/**
 * The record's number on an Activity line: org_activity's record_label, else (a named event such as a quote's Accept, which carries
 * its details in metadata only, so the database finds no label) the record's OWN number from the event's metadata. Never another
 * document's number: an Accept also names the order and job it made, and the line is still the quote's.
 */
export function recordLabel(entry: Pick<ActivityEntry, "record_label" | "record_table" | "entity_table" | "metadata">): string | null {
  if (entry.record_label) return entry.record_label;
  const meta = entry.metadata ?? {};
  for (const key of RECORD_NUMBER_KEYS[entry.record_table ?? entry.entity_table] ?? []) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 80);
  }
  return null;
}

/**
 * Who did it, as the history shows it: the person's display name from company_people (by their user id), else the name the
 * trail carries if it is a usable name, else "System" for the database's own changes, else "—". Never an e-mail address.
 */
export function actorLabel(entry: Pick<ActivityEntry, "actor_user_id" | "actor_name">, people: PeopleMap = {}): string {
  const id = typeof entry.actor_user_id === "string" && entry.actor_user_id ? entry.actor_user_id : null;
  if (id && people[id]) return people[id] as string;
  if (!id && entry.actor_name === "System") return "System";
  return cleanName(entry.actor_name) ?? UNKNOWN;
}
