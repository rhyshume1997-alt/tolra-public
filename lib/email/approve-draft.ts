import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmailProvider } from "@/lib/email/providers/types";
import { checkInput, type CompanyEmailInput, type CompanyEmailResult } from "@/lib/email/send-company-email";
import { customerStatement, STATEMENT_PREFIX } from "@/lib/email/customer-statement";
import { reminderCandidates, type ReminderInvoiceRow } from "@/lib/email/schedules/reminders";
import { loadCompanyName, loadTemplateOverride } from "@/lib/email/schedules/store";
import { renderInvoiceReminder } from "@/lib/email/schedules/render";
import { fmtDate, toDateInput } from "@/lib/dates";
import { gbp, fromPence, toPence } from "@/lib/money";

type Draft = { id: string; organization_id: string; to_email: string; subject: string; body: string; status: string; related_to_type: string; related_to_id: string; drafted_by: string | null };
export type DraftApproval = { org: string; user: string; draftId: string; subject: string; body: string; to: string };
export type DraftApprovalDeps = { db: SupabaseClient; provider: (org: string) => Promise<EmailProvider | null | "refused">; send: (input: CompanyEmailInput, provider: EmailProvider) => Promise<CompanyEmailResult> };

/** Reuses #233's reviewed-text compare/claim and stable-ledger pattern, on the existing generic Approvals queue. No new schema. */
export async function approveDraft(input: DraftApproval, deps: DraftApprovalDeps): Promise<{ status: number; body: { status: string; error?: string; history_id?: string } }> {
  const fail = (status: number, error: string) => ({ status, body: { status: "failed", error } });
  const { db } = deps;
  const { data: row, error } = await db.from("email_history").select("id, organization_id, to_email, subject, body, status, related_to_type, related_to_id, drafted_by").eq("id", input.draftId).eq("organization_id", input.org).maybeSingle();
  const draft = row as Draft | null;
  if (error || !draft || draft.organization_id !== input.org) return fail(404, "Draft not found.");
  if (draft.status !== "drafted" || input.subject !== draft.subject || input.body !== draft.body || input.to !== draft.to_email) return fail(409, "The draft changed. Reload and review it before sending.");
  let kind: CompanyEmailInput["kind"];
  try {
    if (draft.related_to_type === "general" && draft.related_to_id.startsWith(STATEMENT_PREFIX)) {
      const customerId = draft.related_to_id.slice(STATEMENT_PREFIX.length).split(":")[0];
      const current = await customerStatement(db, input.org, customerId);
      if (current.recordId !== draft.related_to_id || current.to !== draft.to_email) return fail(409, "The customer balance or address changed. Make a new statement and review it.");
      kind = "statement";
    } else if (draft.related_to_type === "invoice" && draft.drafted_by === null) {
      // Existing chase drafts retain their own pause/claim workflow in #233; this only handles the baseline scheduled reminders.
      const chase = await db.from("chase_sends").select("id").eq("draft_history_id", draft.id).eq("organization_id", input.org).limit(1);
      if (!chase.error || !["42P01", "PGRST205", "PGRST204"].includes(chase.error.code)) return fail(409, "Use the existing chase approval controls for this reminder.");
      const { data: invoice, error: invoiceError } = await db.from("invoices").select("id, organization_id, invoice_ref, customer, total, amount_paid, credited_amount, refunded_amount, status, due_date, payment_unverified").eq("id", draft.related_to_id).eq("organization_id", input.org).maybeSingle();
      if (invoiceError || !invoice) return fail(404, "Invoice not found.");
      const current = reminderCandidates([invoice as ReminderInvoiceRow], toDateInput(new Date()))[0];
      if (!current) return fail(409, "This invoice is no longer overdue or needs checking. Do not send this reminder.");
      const { data: customers, error: customerError } = await db.from("customers").select("name, email, contact_name").eq("organization_id", input.org).ilike("name", current.customer.replace(/[\\%_]/g, "\\$&")).limit(2);
      if (customerError || customers?.length !== 1 || String(customers[0].email).trim().toLowerCase() !== draft.to_email.toLowerCase()) return fail(409, "Check this reminder's customer and email address before sending it manually.");
      const [companyName, override] = await Promise.all([loadCompanyName(db, input.org), loadTemplateOverride(db, input.org, "invoice_reminder")]);
      const received = Number(current.amount_paid) || 0;
      const rendered = renderInvoiceReminder({ reference: current.invoice_ref ?? "", total: gbp(fromPence(toPence(current.balance) + toPence(received)), 2), dueDate: fmtDate(current.due_date), daysOverdue: current.daysOverdue, companyName, customerName: current.customer, contactName: customers[0].contact_name, amountPaid: received, paidText: gbp(received, 2), balanceText: gbp(current.balance, 2) }, override);
      if (rendered.text !== draft.body || rendered.subject !== draft.subject) return fail(409, "The invoice, date, template or draft changed. Regenerate the reminder, or review and send it manually.");
      kind = "invoice_reminder";
    } else return fail(400, "Use the document's send screen or the existing manual-send controls for this draft.");
  } catch { return fail(409, "The current customer or invoice data could not be checked. Nothing was sent."); }
  const mail: CompanyEmailInput = { organizationId: input.org, userId: input.user, kind, to: [draft.to_email], subject: draft.subject, text: draft.body, recordType: draft.related_to_type, recordId: draft.related_to_id, idempotencyKey: `approve-draft:${draft.id}`, requireLedger: true };
  const checked = checkInput(mail, process.env);
  if ("error" in checked || !("email" in checked) || checked.email.subject !== draft.subject || checked.email.to.join(", ") !== draft.to_email) return fail(400, "Save a valid subject, address and complete message before approving.");
  let provider: Awaited<ReturnType<DraftApprovalDeps["provider"]>>;
  try { provider = await deps.provider(input.org); } catch { return fail(502, "Microsoft 365 needs attention. No other provider was used."); }
  if (!provider || provider === "refused") return fail(503, "Sending is not set up here. The draft stays for manual sending.");
  const { data: claimed, error: claimError } = await db.from("email_history").update({ status: "sending" }).eq("id", draft.id).eq("organization_id", input.org).eq("status", "drafted").eq("subject", input.subject).eq("body", input.body).eq("to_email", input.to).eq("related_to_id", draft.related_to_id).select("id");
  if (claimError || claimed?.length !== 1) return fail(409, "The draft changed or is already being sent. Reload before doing anything else.");
  let answer: CompanyEmailResult;
  try { answer = await deps.send(mail, provider); } catch { answer = { ok: false, code: "provider_error", error: "Outcome unknown. Check Email history; do not resend.", uncertain: true }; }
  if (answer.ok && answer.mode === "sent" && answer.historyId) {
    const { error: removeError } = await db.from("email_history").delete().eq("id", draft.id).eq("organization_id", input.org).eq("status", "sending");
    // The sent history/ledger keeps the exact text and approving user. A failed cleanup must never trigger another send.
    return { status: 200, body: { status: "sent", history_id: answer.historyId, ...(removeError ? { error: "Sent, but queue cleanup needs checking. Do not resend." } : {}) } };
  }
  const uncertain = answer.ok || answer.uncertain;
  const { error: settleError } = await db.from("email_history").update({ status: uncertain ? "unknown" : "drafted" }).eq("id", draft.id).eq("organization_id", input.org).eq("status", "sending");
  const status = uncertain || settleError || answer.ok ? 502 : answer.code === "rate_limited" ? 429 : answer.code === "invalid" ? 400 : answer.code === "recipient_refused" ? 403 : answer.code === "no_provider" ? 503 : 502;
  return fail(status, uncertain || settleError ? "Outcome unknown. Check Email history; do not resend." : !answer.ok ? answer.error : "Sending stopped. Check the draft before retrying.");
}
