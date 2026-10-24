// Admin > Integrations > Send log (G22, Lot B PR 2; no migration): one row per document and action from migration 084's
// integration_sends (admins of the company read it; nobody else, so office, workshop and viewers see no log). Pure, so it is unit tested.
// Retry is 084's integration_retry_send: admin only, after the second step of sign-in, for a failed send or one to check in Xero; the
// server reads Xero back before sending again, so a document that did arrive is never sent twice.

import type { StatusKey } from "@/lib/status-colours";

export type SendStatus = "pending" | "sending" | "sent" | "failed" | "needs_check" | "skipped";

/** The columns the page reads (never a token: integration_sends holds none). */
export const SEND_LOG_COLUMNS = "id, doc_type, doc_id, doc_ref, action, status, attempts, external_number, last_error, created_at, updated_at, sent_at";

export type SendLogRow = {
  id: string;
  doc_type: "invoice" | "credit_note";
  doc_id: string;
  doc_ref: string | null;
  action: "create" | "void";
  status: SendStatus;
  attempts: number;
  external_number: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
};

export type SendLogView = {
  /** The badge: colour from the central status map, the word from here. */
  badge: StatusKey;
  label: string;
  /** What the document is: "Invoice INV-0042", "Void of invoice INV-0042", "Credit note CN-0007". */
  document: string;
  /** The reason it failed, was skipped or needs checking; what Xero calls it once sent. */
  detail: string | null;
  /** When it was sent, or when its status last changed. */
  when: string;
  retry: boolean;
};

const LABEL: Record<SendStatus, { badge: StatusKey; label: string }> = {
  pending: { badge: "sync_pending", label: "Waiting to send" },
  sending: { badge: "sync_pending", label: "Sending" },
  sent: { badge: "complete", label: "Sent" },
  failed: { badge: "sync_failed", label: "Failed" },
  needs_check: { badge: "at_risk", label: "Check in Xero" },
  skipped: { badge: "cancelled", label: "Not sent" },
};

/** 084's integration_retry_send takes a failed send or one to check in Xero; nothing else. */
export const canRetry = (status: SendStatus) => status === "failed" || status === "needs_check";

export function sendLogView(row: SendLogRow): SendLogView {
  const kind = row.doc_type === "credit_note" ? "Credit note" : "Invoice";
  const number = row.doc_ref?.trim() || "(no number)";
  const document = row.action === "void" ? `Void of invoice ${number}` : `${kind} ${number}`;
  const state = LABEL[row.status] ?? { badge: "sync_pending" as StatusKey, label: row.status };
  let detail: string | null = null;
  if (row.status === "sent") detail = row.external_number && row.external_number !== row.doc_ref ? `In Xero as ${row.external_number}` : null;
  else if (row.status === "needs_check") detail = row.last_error ?? "Xero's answer was lost. Retry checks Xero first, so it is never sent twice.";
  else if (row.status === "failed") detail = row.last_error ?? "Xero refused it.";
  else if (row.status === "skipped") detail = row.last_error ?? "Not sent.";
  else if (row.status === "pending" && row.last_error) detail = `Trying again soon: ${row.last_error}`;
  return { badge: state.badge, label: state.label, document, detail, when: row.sent_at ?? row.updated_at ?? row.created_at, retry: canRetry(row.status) };
}

export type SendLogFilter = "all" | "problems" | SendStatus;

/** The filter above the log: everything, the ones needing an admin (failed or to check), or one status. */
export function filterSendLog(rows: SendLogRow[], filter: SendLogFilter): SendLogRow[] {
  if (filter === "all") return rows;
  if (filter === "problems") return rows.filter((r) => canRetry(r.status));
  return rows.filter((r) => r.status === filter);
}

/** Who issued each document (invoices.issued_by / credit_notes.issued_by, 035): the person whose issue queued the send. */
export function issuedByMap(invoices: unknown, creditNotes: unknown): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const list of [invoices, creditNotes]) {
    if (!Array.isArray(list)) continue;
    for (const r of list as Array<{ id?: unknown; issued_by?: unknown }>) {
      if (typeof r?.id === "string") out[r.id] = typeof r.issued_by === "string" ? r.issued_by : null;
    }
  }
  return out;
}

/** The friendly words for a refused retry (084: 42501 not admin / no second step; not_retryable already queued or sent). */
export function retryErrorMessage(error: { code?: string | null; hint?: string | null; message?: string | null }): string {
  if (error.code === "42501") return error.hint === "mfa_required" ? "Confirm your authenticator code first." : "Only an admin can send a document again.";
  if (error.hint === "not_retryable") return "It is already waiting to send or has been sent. Reload the page.";
  if (error.code === "P0002") return "That send is no longer in the log. Reload the page.";
  return "Couldn't queue it again. Try again.";
}
