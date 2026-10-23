/**
 * What the app may record in the audit log through /api/audit (audit SEC1, A5). Shared by the API route and its
 * tests; the database (write_audit, migration 023) applies the same rule by role, so a direct RPC call can't claim
 * more than the app could.
 *
 * Read events: someone looked at or exported records they can read.
 * Payment events (MARK_PAID, RECORD_PAYMENT, ...) are not in this list: the database writes them itself, with the payment (035).
 * Write events: someone did something to records their role may change. The row triggers in the database remain the
 * authoritative record of what actually changed; these events add context ("sent", "marked paid"), recorded with
 * metadata.source = "write_audit" so they can't be mistaken for the database's own record.
 */
export const AUDIT_READ_ACTIONS = ["EXPORT", "PRINT_PACK", "DOWNLOAD_PDF", "DOWNLOAD_ATTACHMENT", "EMAIL_COPIED"] as const;

export const AUDIT_WRITE_ACTIONS = [
  "CREATE", "UPDATE", "DELETE", "SEND", "DESPATCH", "ACCEPT", "REJECT", "UPDATE_WORKSHEET", "UPLOAD_DRAWING",
  "CONVERT_TO_JOB", "SEND_TO_WORKSHOP", "MARK_RECEIVED", "MARK_SIGNED", "UPLOAD_ATTACHMENT",
  "EMAIL_SENT_MANUALLY", "DRAFT_CHASERS", "CREATE_SUPPLIER", "DELETE_SUPPLIER", "INVITE_USER", "UPDATE_USER_ACCESS",
  "PASSWORD_RESET_PREPARED", "ORGANIZATION_SETTINGS_UPDATE",
] as const;

export const AUDIT_ACTIONS = [...AUDIT_READ_ACTIONS, ...AUDIT_WRITE_ACTIONS] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** Stable record types (database table names), never display titles. */
export const AUDIT_TABLES = [
  "quotes", "quote_attachments", "invoices", "sales_orders", "purchase_orders", "delivery_notes", "jobs", "rfqs",
  "customers", "suppliers", "machines", "machine_bookings", "job_machines", "sales_order_line_machines", "machine_runs", "stock", "email_history", "user_profiles",
  "organization_settings",
  // 076: named only by read events (EXPORT and the like) from the payments export and the weekly hours export; the database accepts
  // them for admin and office (audit_event_allowed, 076). invoice_payments has no row-change audit trigger (its payments are audited as
  // RECORD_PAYMENT / REVERSE_PAYMENT on invoices); time_week_approvals has one (052). Before 076 is applied the database refuses such
  // an event.
  "invoice_payments", "time_week_approvals",
] as const;
export type AuditTable = (typeof AUDIT_TABLES)[number];
