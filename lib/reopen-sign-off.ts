/**
 * Reopen sign-off (migration 113; Rhys, 30 Oct, D30-5): "Reopening needs a confirmation and counts as signed off with admin approval.
 * If no admin is available it can be a tick box that notifies the admin for later, so staff are never blamed either way."
 *
 * The Reopen dialog asks for a reason (10+ characters), a confirmation sentence that names the job and its invoice, and one of two
 * ways to sign it off:
 *   - "An admin is here": an admin reopens and approves at once; anyone else's request waits (nothing is reopened) until an admin
 *     approves it with their own session in the Approval Queue, as the early release is an admin's own action.
 *   - "No admin available": the job is reopened now and the admin is told (Approval Queue badge, and an e-mail where the company
 *     mailer is set up); the admin approves or rejects later. A rejection records the decision; it does not undo the reopen.
 * Every rule of who may reopen what stays in 081's reopen_job (the server checks it in every mode), with one exception made by the
 * sign-off: an issued invoice does not stop it (the invoice stays exactly as it is). A job gone out on a delivery note stays refused. Before 113 is applied the dialog
 * keeps today's Reopen (reopen_job with a reason) and says so (REOPEN_FALLBACK_NOTICE).
 */
import { missingDbObject } from "@/lib/db-features";
import { REASON_MIN } from "@/lib/job-flow";

export const REOPEN_FALLBACK_NOTICE = "Admin approval recording is available after database update 113.";
export const REASON_MAX = 500;

export type ReopenMode = "admin_present" | "tick_box_notify";

/** reopen_preview's answer: what the dialog shows before anything is done. */
export type ReopenPreview = {
  record_ref: string;
  issued_invoices: string[];
  draft_invoice: boolean;
  delivery_notes_out: string[];
  is_admin: boolean;
  waiting_request_id: string | null;
  allowed: boolean;
  refusal: string | null;
  refusal_hint: string | null;
};

type RpcError = { code?: string | null; message?: string | null; hint?: string | null };
type RpcAnswer = { data: unknown; error: RpcError | null };
export type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<RpcAnswer> };

const text = (value: unknown) => (typeof value === "string" ? value : "");
const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** The preview as the dialog uses it; anything missing reads as "not allowed", never as allowed. */
export function parsePreview(data: unknown, fallbackRef: string): ReopenPreview {
  const row = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  return {
    record_ref: text(row.record_ref) || fallbackRef,
    issued_invoices: list(row.issued_invoices),
    draft_invoice: row.draft_invoice === true,
    delivery_notes_out: list(row.delivery_notes_out),
    is_admin: row.is_admin === true,
    waiting_request_id: text(row.waiting_request_id) || null,
    allowed: row.allowed === true,
    refusal: text(row.refusal) || null,
    refusal_hint: text(row.refusal_hint) || null,
  };
}

/**
 * The sentence the person confirms. A job whose invoice is issued can be reopened through this sign-off only (113; plain reopen_job
 * still refuses it), and the issued invoice is never changed, so the sentence names it; a draft invoice stays a draft.
 */
export function confirmationSentence(preview: Pick<ReopenPreview, "record_ref" | "issued_invoices" | "draft_invoice">): string {
  const ref = preview.record_ref;
  if (preview.issued_invoices.length) {
    const many = preview.issued_invoices.length > 1;
    return `I am reopening ${ref}; the issued invoice${many ? "s" : ""} ${preview.issued_invoices.join(", ")} stay${many ? "" : "s"} as ${many ? "they are" : "it is"}.`;
  }
  if (preview.draft_invoice) return `I am reopening ${ref}; its draft invoice stays a draft and is not issued.`;
  return `I am reopening ${ref}; it has no issued invoice.`;
}

/** The dialog's inputs. `mode` null until the person picks one; `fallback` while 113 isn't applied. */
export type ReopenForm = { reason: string; confirmed: boolean; mode: ReopenMode | null };
export type ReopenFormCheck = { ok: true; mode: ReopenMode | null } | { ok: false; error: string };

/**
 * The state machine's gate, in the order the dialog asks: reason, confirmation, sign-off. An admin signs off as "admin here"
 * (the tick box isn't for them); anyone else picks one of the two. In fallback (no 113) only the reason is asked, as before.
 */
export function checkReopenForm(form: ReopenForm, context: { isAdmin: boolean; fallback: boolean; preview: ReopenPreview | null }): ReopenFormCheck {
  const reason = form.reason.trim();
  if (reason.length < REASON_MIN) return { ok: false, error: `Say why it is reopened (at least ${REASON_MIN} characters).` };
  if (reason.length > REASON_MAX) return { ok: false, error: `Keep the reason to ${REASON_MAX} characters.` };
  if (context.fallback) return { ok: true, mode: null };
  if (context.preview && !context.preview.allowed) return { ok: false, error: context.preview.refusal ?? "This job can't be reopened." };
  if (!form.confirmed) return { ok: false, error: "Tick the confirmation first." };
  if (context.isAdmin) return { ok: true, mode: "admin_present" };
  if (!form.mode) return { ok: false, error: "Choose who signs it off: an admin who is here, or no admin available." };
  return { ok: true, mode: form.mode };
}

/** The Reopen button's words for the choice made. */
export function submitLabel(context: { isAdmin: boolean; fallback: boolean; mode: ReopenMode | null }): string {
  if (context.fallback) return "Reopen job";
  if (context.isAdmin) return "Approve and reopen";
  if (context.mode === "admin_present") return "Ask the admin to approve";
  if (context.mode === "tick_box_notify") return "Reopen now and notify the admin";
  return "Reopen job";
}

export type PreviewLoad = { kind: "ready"; preview: ReopenPreview } | { kind: "fallback" } | { kind: "error"; error: RpcError };

/** reopen_preview, or "fallback" when the database has no 113 yet. */
export async function loadReopenPreview(client: RpcClient, job: { id: string; job_no: string }): Promise<PreviewLoad> {
  const { data, error } = await client.rpc("reopen_preview", { p_record_type: "job", p_record_id: job.id });
  if (error) return missingDbObject(error) ? { kind: "fallback" } : { kind: "error", error };
  return { kind: "ready", preview: parsePreview(data, job.job_no) };
}

export type ReopenSent =
  | { ok: true; status: "approved" | "pending"; reopened: boolean; requestId: string | null; message: string }
  | { ok: false; error: RpcError | null; fallback?: boolean };

/** reopen_record (113): the reopen and its sign-off row in one transaction. */
export async function sendReopen(client: RpcClient, job: { id: string; job_no: string }, reason: string, mode: ReopenMode): Promise<ReopenSent> {
  const { data, error } = await client.rpc("reopen_record", { p_record_type: "job", p_record_id: job.id, p_reason: reason.trim(), p_mode: mode });
  if (error) return missingDbObject(error) ? { ok: false, error, fallback: true } : { ok: false, error };
  const row = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const status = row.status === "approved" ? "approved" : "pending";
  const reopened = row.reopened === true;
  const message = status === "approved" ? `${job.job_no} reopened and signed off by you as admin.`
    : reopened ? `${job.job_no} reopened. The admin has been told and will approve or reject it later.`
    : `Waiting for an admin: ${job.job_no} is reopened once an admin approves it in the Approval Queue with their own login.`;
  return { ok: true, status, reopened, requestId: text(row.request_id) || null, message };
}

/** Today's Reopen (081 reopen_job), used while 113 isn't applied. */
export async function sendLegacyReopen(client: RpcClient, job: { id: string }, reason: string): Promise<{ ok: true } | { ok: false; error: RpcError }> {
  const { error } = await client.rpc("reopen_job", { p_job: job.id, p_reason: reason.trim() });
  return error ? { ok: false, error } : { ok: true };
}

/** An admin's decision (113 decide_reopen_request). */
export async function decideReopen(client: RpcClient, requestId: string, decision: "approve" | "reject", note: string | null) {
  const { data, error } = await client.rpc("decide_reopen_request", { p_request: requestId, p_decision: decision, p_note: note?.trim() || null });
  if (error) return { ok: false as const, error };
  const row = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  return { ok: true as const, reopenedNow: row.reopened_now === true, reopenKept: row.reopen_kept === true };
}

/** A pending request as the Approval Queue lists it. */
export type ReopenRequestRow = {
  id: string;
  record_ref: string | null;
  reason: string;
  requested_by: string;
  requested_at: string;
  approval_mode: ReopenMode;
  reopened_at: string | null;
};

/** What the admin is told about one pending request: done already (tick box) or waiting for them. */
export function approvalLine(row: Pick<ReopenRequestRow, "approval_mode" | "reopened_at" | "record_ref">): { badge: string; detail: string; approveLabel: string } {
  const ref = row.record_ref ?? "The job";
  if (row.reopened_at) {
    return { badge: "REOPENED, NO ADMIN WAS AVAILABLE", detail: `${ref} was reopened with the tick box. Approve to sign it off; rejecting records your decision but does not undo the reopen or the work done since.`, approveLabel: "Approve" };
  }
  return { badge: "WAITING FOR AN ADMIN", detail: `${ref} is not reopened yet. Approve to reopen it now; reject and it stays as it is.`, approveLabel: "Approve and reopen" };
}

/** The window event the sidebar's Approval Queue badge listens to (pending reopens). */
export const REOPEN_COUNT_EVENT = "reopen-count-change";
