import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmailProvider } from "@/lib/email/providers/types";
import { checkInput, type CompanyEmailInput, type CompanyEmailResult } from "@/lib/email/send-company-email";
import { attemptKey } from "@/lib/email/chase/attempt";
import { recordSendAudit } from "@/lib/email/chase/send-audit";
import { customerStatement, STATEMENT_PREFIX } from "@/lib/email/customer-statement";
import { reminderCandidates, type ReminderInvoiceRow } from "@/lib/email/schedules/reminders";
import { loadCompanyName, loadTemplateOverride } from "@/lib/email/schedules/store";
import { renderInvoiceReminder } from "@/lib/email/schedules/render";
import { fmtDate, toDateInput } from "@/lib/dates";
import { gbp, fromPence, toPence } from "@/lib/money";

type Draft = { id: string; organization_id: string; to_email: string; subject: string; body: string; status: string; related_to_type: string; related_to_id: string; drafted_by: string | null };
/** `provider: "resend"` is an admin's explicit choice for ONE message whose send failed for certain (never automatic); `isAdmin` comes from the session. */
export type DraftApproval = { org: string; user: string; draftId: string; subject: string; body: string; to: string; provider?: "resend"; isAdmin?: boolean };
/** `resend`: Resend built from this deployment's own configuration (null: not configured). Only used for an explicit choice. */
export type DraftApprovalDeps = { db: SupabaseClient; resend?: (org: string) => Promise<EmailProvider | null>; provider: (org: string) => Promise<EmailProvider | null | "refused">; send: (input: CompanyEmailInput, provider: EmailProvider) => Promise<CompanyEmailResult> };

/** Reuses #233's reviewed-text compare/claim and stable-ledger pattern, on the existing generic Approvals queue. No new schema. */
export async function approveDraft(input: DraftApproval, deps: DraftApprovalDeps): Promise<{ status: number; body: { status: string; error?: string; history_id?: string } }> {
  const fail = (status: number, error: string) => ({ status, body: { status: "failed", error } });
  const { db } = deps;
  if (input.provider === "resend" && !input.isAdmin) return fail(403, "Only an admin can choose another provider for a failed email.");
  const { data: row, error } = await db.from("email_history").select("id, organization_id, to_email, subject, body, status, related_to_type, related_to_id, drafted_by").eq("id", input.draftId).eq("organization_id", input.org).maybeSingle();
  const draft = row as Draft | null;
  if (error || !draft || draft.organization_id !== input.org) return fail(404, "Draft not found.");
  if (draft.status === "unknown" || draft.status === "sending") return fail(409, "This email's outcome is not known yet. It is held for checking: it will not be retried or sent another way until a person has checked Email history and settled it.");
  if (draft.status !== "drafted" || input.subject !== draft.subject || input.body !== draft.body || input.to !== draft.to_email) return fail(409, "The draft changed. Reload and review it before sending.");
  // The same current-data check runs before the claim and again after it (a customer address or balance changed in between voids it).
  type Verified = { kind: CompanyEmailInput["kind"] } | { out: ReturnType<typeof fail> };
  const verify = async (): Promise<Verified> => {
  try {
    if (draft.related_to_type === "general" && draft.related_to_id.startsWith(STATEMENT_PREFIX)) {
      const customerId = draft.related_to_id.slice(STATEMENT_PREFIX.length).split(":")[0];
      const current = await customerStatement(db, input.org, customerId);
      if (current.recordId !== draft.related_to_id || current.to !== draft.to_email) return { out: fail(409, "The customer balance or address changed. Make a new statement and review it.") };
      return { kind: "statement" as const };
    } else if (draft.related_to_type === "invoice" && draft.drafted_by === null) {
      // Existing chase drafts retain their own pause/claim workflow in #233; this only handles the baseline scheduled reminders.
      const chase = await db.from("chase_sends").select("id").eq("draft_history_id", draft.id).eq("organization_id", input.org).limit(1);
      if (!chase.error || !["42P01", "PGRST205", "PGRST204"].includes(chase.error.code)) return { out: fail(409, "Use the existing chase approval controls for this reminder.") };
      const { data: invoice, error: invoiceError } = await db.from("invoices").select("id, organization_id, invoice_ref, customer, total, amount_paid, credited_amount, refunded_amount, status, due_date, payment_unverified").eq("id", draft.related_to_id).eq("organization_id", input.org).maybeSingle();
      if (invoiceError || !invoice) return { out: fail(404, "Invoice not found.") };
      const current = reminderCandidates([invoice as ReminderInvoiceRow], toDateInput(new Date()))[0];
      if (!current) return { out: fail(409, "This invoice is no longer overdue or needs checking. Do not send this reminder.") };
      const { data: customers, error: customerError } = await db.from("customers").select("name, email, contact_name").eq("organization_id", input.org).ilike("name", current.customer.replace(/[\\%_]/g, "\\$&")).limit(2);
      if (customerError || customers?.length !== 1 || String(customers[0].email).trim().toLowerCase() !== draft.to_email.toLowerCase()) return { out: fail(409, "Check this reminder's customer and email address before sending it manually.") };
      const [companyName, override] = await Promise.all([loadCompanyName(db, input.org), loadTemplateOverride(db, input.org, "invoice_reminder")]);
      const received = Number(current.amount_paid) || 0;
      const rendered = renderInvoiceReminder({ reference: current.invoice_ref ?? "", total: gbp(fromPence(toPence(current.balance) + toPence(received)), 2), dueDate: fmtDate(current.due_date), daysOverdue: current.daysOverdue, companyName, customerName: current.customer, contactName: customers[0].contact_name, amountPaid: received, paidText: gbp(received, 2), balanceText: gbp(current.balance, 2) }, override);
      if (rendered.text !== draft.body || rendered.subject !== draft.subject) return { out: fail(409, "The invoice, date, template or draft changed. Regenerate the reminder, or review and send it manually.") };
      return { kind: "invoice_reminder" as const };
    } else return { out: fail(400, "Use the document's send screen or the existing manual-send controls for this draft.") };
  } catch { return { out: fail(409, "The current customer or invoice data could not be checked. Nothing was sent.") }; }
  };
  const verified = await verify();
  if ("out" in verified) return verified.out;
  const kind = verified.kind;
  const mail: CompanyEmailInput = { organizationId: input.org, userId: input.user, kind, to: [draft.to_email], subject: draft.subject, text: draft.body, recordType: draft.related_to_type, recordId: draft.related_to_id, idempotencyKey: await attemptKey(db, input.org, `approve-draft:${draft.id}`, draft.related_to_id, draft.id), requireLedger: true };
  const checked = checkInput(mail, process.env);
  if ("error" in checked || !("email" in checked) || checked.email.subject !== draft.subject || checked.email.to.join(", ") !== draft.to_email) return fail(400, "Save a valid subject, address and complete message before approving.");
  let provider: Awaited<ReturnType<DraftApprovalDeps["provider"]>>;
  if (input.provider === "resend") {
    const earlier = await db.from("email_history").select("status").eq("organization_id", input.org).eq("related_to_id", draft.related_to_id).in("status", ["failed", "unknown"]);
    const statuses = earlier.error ? ["unknown"] : (earlier.data ?? []).map((r: { status: string }) => r.status);
    if (statuses.includes("unknown")) return fail(409, "An earlier attempt has an unknown outcome. Check Email history first; nothing is sent another way until it is settled.");
    if (!statuses.includes("failed")) return fail(409, "Another provider can only be chosen for an email whose send failed.");
    try { provider = (await deps.resend?.(input.org)) ?? null; } catch { provider = null; }
    if (!provider) return fail(503, "Resend is not set up for this company, so it can't be used. The draft stays for manual sending.");
  } else {
    try { provider = await deps.provider(input.org); } catch { return fail(502, "Microsoft 365 needs attention. Nothing was sent and no other provider was used. An admin can choose Resend for this message if it is set up."); }
  }
  if (!provider || provider === "refused") return fail(503, "Sending is not set up here. The draft stays for manual sending.");
  const { data: claimed, error: claimError } = await db.from("email_history").update({ status: "sending" }).eq("id", draft.id).eq("organization_id", input.org).eq("status", "drafted").eq("subject", input.subject).eq("body", input.body).eq("to_email", input.to).eq("related_to_id", draft.related_to_id).select("id");
  if (claimError || claimed?.length !== 1) return fail(409, "The draft changed or is already being sent. Reload before doing anything else.");
  // Last look before anything leaves: the claimed row must still be exactly what was reviewed. Any difference voids the approval.
  const { data: claimedRow, error: recheckError } = await db.from("email_history").select("to_email, subject, body, status").eq("id", draft.id).eq("organization_id", input.org).maybeSingle();
  const now = claimedRow as { to_email: string; subject: string; body: string; status: string } | null;
  if (recheckError || !now || now.status !== "sending" || now.to_email !== draft.to_email || now.subject !== draft.subject || now.body !== draft.body) {
    await db.from("email_history").update({ status: "drafted" }).eq("id", draft.id).eq("organization_id", input.org).eq("status", "sending");
    await recordSendAudit(db, { outcome: "changed", historyId: draft.id, channel: "email-approve" });
    return fail(409, "The draft changed after you approved it. Nothing was sent. Review it and approve again.");
  }
  const again = await verify();
  if ("out" in again || again.kind !== kind) {
    await db.from("email_history").update({ status: "drafted" }).eq("id", draft.id).eq("organization_id", input.org).eq("status", "sending");
    await recordSendAudit(db, { outcome: "changed", historyId: draft.id, channel: "email-approve" });
    return "out" in again ? again.out : fail(409, "The customer or invoice changed after you approved it. Nothing was sent.");
  }
  if (input.provider === "resend") await recordSendAudit(db, { outcome: "provider_override", historyId: draft.id, channel: "email-approve", provider: "resend" });
  let answer: CompanyEmailResult;
  try { answer = await deps.send(mail, provider); } catch { answer = { ok: false, code: "provider_error", error: "Outcome unknown. Check Email history; do not resend.", uncertain: true }; }
  if (answer.ok && answer.mode === "sent" && answer.historyId) {
    const { error: removeError } = await db.from("email_history").delete().eq("id", draft.id).eq("organization_id", input.org).eq("status", "sending");
    // The sent history/ledger keeps the exact text and approving user. A failed cleanup must never trigger another send.
    return { status: 200, body: { status: "sent", history_id: answer.historyId, ...(removeError ? { error: "Sent, but queue cleanup needs checking. Do not resend." } : {}) } };
  }
  const uncertain = answer.ok || answer.uncertain;
  const { error: settleError } = await db.from("email_history").update({ status: uncertain ? "unknown" : "drafted" }).eq("id", draft.id).eq("organization_id", input.org).eq("status", "sending");
  // Failed (the provider refused it for certain) and unknown (held) both leave an audit row: ids and codes only. A lost audit write changes nothing else.
  await recordSendAudit(db, { outcome: uncertain || settleError ? "unknown" : "failed", historyId: draft.id, channel: "email-approve", code: answer.ok ? "unexpected_ok" : answer.code, provider: provider.name });
  const status = uncertain || settleError || answer.ok ? 502 : answer.code === "rate_limited" ? 429 : answer.code === "invalid" ? 400 : answer.code === "recipient_refused" ? 403 : answer.code === "no_provider" ? 503 : 502;
  return fail(status, uncertain || settleError ? "Outcome unknown. Check Email history; do not resend." : !answer.ok ? answer.error : "Sending stopped. Check the draft before retrying.");
}
