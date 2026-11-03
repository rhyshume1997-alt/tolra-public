// "Approve and send" for a chase draft in the Approvals queue (migration 138). The person (office or admin, checked by the route) has read
// the draft, maybe edited it, and approves it. Nothing is sent unless every check below passes:
//   1. the draft is this company's, still 'drafted', and is a chase draft (a chase_sends row points at it);
//   2. its invoice is still owed (issued, not paid / void / credited / written off, no payment to confirm, no open payment claim, a
//      balance left) and its chasing
//      (and its customer's) is not paused: an invoice paid since the draft was made is never chased;
//   3. every recipient is the invoice's customer's address on file, the schedule's fixed recipients, the company's own people, or
//      EMAIL_RECIPIENT_DOMAINS (the same rule as POST /api/email/send);
//   4. a mailer is set up for the company (Microsoft 365, else Resend). Without one: { status: "no_provider" } and NOTHING is written, so
//      the draft stays for Copy / Open in email client / Mark as Sent Manually.
// Then the existing company mailer sends it (lib/email/send-company-email.ts) through the person's own session, with one idempotency
// key per draft, so a double click or a retry never sends twice (106's ledger), and public.chase_record_sent records who approved it and
// which e-mail went, removes the draft it replaced and audits it. The sent e-mail's history row holds the final text.
import type { SupabaseClient } from "@supabase/supabase-js";

import { pauseActive } from "@/lib/email/chase/steps";
import { escapeHtml, oneLine } from "@/lib/email/templates/defaults";
import type { CompanyEmailInput, CompanyEmailResult } from "@/lib/email/send-company-email";
import { balanceDue, invoiceLifecycle } from "@/lib/receivables";

export type ApproveInput = { organizationId: string; userId: string; draftId: string; subject?: string; body?: string; today: string };
export type ApproveDeps = {
  /** The person's own session (row level security). */
  db: SupabaseClient;
  /** The service role: chase_record_sent, and removing a stray draft. */
  admin: SupabaseClient;
  /** Microsoft 365 / Resend / null (none set up) / "refused" (the test provider on a deployment). */
  provider: (organizationId: string) => Promise<unknown | null | "refused">;
  send: (input: CompanyEmailInput) => Promise<CompanyEmailResult>;
  /** EMAIL_RECIPIENT_DOMAINS. */
  allowlisted: (address: string) => boolean;
};
export type ApproveResult =
  | { status: "sent"; historyId: string; recorded: boolean }
  | { status: "no_provider"; message: string }
  | { status: "refused"; http: number; message: string };

export const NO_PROVIDER_MESSAGE = "E-mail sending isn't set up for this company, so Tolra can't send this. Copy it or open it in your email client, send it yourself, then choose Mark as Sent Manually.";

const refused = (http: number, message: string): ApproveResult => ({ status: "refused", http, message });
const lower = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : "");

/** Stable per draft: the mailer's idempotency key (letters, digits and : . _ -). */
export const approveKey = (draftId: string) => `chase-approve:${draftId}`;

export async function approveChaseDraft(input: ApproveInput, deps: ApproveDeps): Promise<ApproveResult> {
  const org = input.organizationId;
  const { db } = deps;
  const { data: draftRow, error: draftError } = await db.from("email_history")
    .select("id, organization_id, to_email, subject, body, status, related_to_type, related_to_id").eq("id", input.draftId).maybeSingle();
  const draft = draftRow as { id: string; organization_id: string; to_email: string; subject: string; body: string; status: string; related_to_type: string | null; related_to_id: string | null } | null;
  if (draftError || !draft || draft.organization_id !== org) return refused(404, "Draft not found.");
  if (draft.status !== "drafted") return refused(409, "This e-mail is no longer waiting for approval. Reload the page.");

  const { data: chaseRow } = await db.from("chase_sends").select("id, invoice_id, status").eq("draft_history_id", draft.id).eq("organization_id", org).maybeSingle();
  const chase = chaseRow as { id: string; invoice_id: string; status: string } | null;
  if (!chase || draft.related_to_type !== "invoice" || draft.related_to_id !== chase.invoice_id) return refused(400, "Only chase drafts can be approved and sent from here.");
  if (chase.status !== "drafted") return refused(409, "This chase has already been sent.");

  const { data: invoiceRow } = await db.from("invoices")
    .select("id, organization_id, customer, invoice_ref, status, total, amount_paid, credited_amount, refunded_amount, payment_unverified, payment_claimed_at").eq("id", chase.invoice_id).maybeSingle();
  const invoice = invoiceRow as { organization_id: string; customer: string | null; invoice_ref: string | null; status: string | null; total: unknown; amount_paid: unknown; credited_amount: unknown; refunded_amount: unknown; payment_unverified: boolean | null; payment_claimed_at?: string | null } | null;
  if (!invoice || invoice.organization_id !== org) return refused(404, "Invoice not found.");
  const balance = balanceDue(Number(invoice.total) || 0, Number(invoice.amount_paid) || 0, Number(invoice.credited_amount) || 0, Number(invoice.refunded_amount) || 0);
  if (!invoice.invoice_ref || invoiceLifecycle(invoice.status) !== "collectible" || invoice.payment_unverified || balance <= 0) {
    return refused(409, "This invoice is no longer owed (paid, closed or a payment to confirm), so it isn't chased. Skip this draft.");
  }
  if (invoice.payment_claimed_at) return refused(409, "The customer says this invoice is paid (a payment claim is open), so it isn't chased. Settle the claim first.");

  const customerName = lower(invoice.customer);
  const [{ data: pauses }, { data: customers }, { data: schedule }] = await Promise.all([
    db.from("chase_pauses").select("invoice_id, customer_id, paused_until").eq("organization_id", org),
    db.from("customers").select("id, name, email").eq("organization_id", org),
    db.from("email_schedules").select("recipients").eq("organization_id", org).eq("kind", "invoice_reminder").maybeSingle(),
  ]);
  const customerRows = ((customers ?? []) as Array<{ id: string; name: string; email: string | null }>).filter((c) => lower(c.name) === customerName);
  if (customerRows.length > 1) return refused(409, "Two customer records use this name. Check them before sending.");
  const customerIds = new Set(customerRows.map((c) => c.id));
  for (const p of (pauses ?? []) as Array<{ invoice_id: string | null; customer_id: string | null; paused_until: string | null }>) {
    if (!pauseActive(p.paused_until, input.today)) continue;
    if (p.invoice_id === chase.invoice_id) return refused(409, "Chasing is paused for this invoice. Resume it first.");
    if (p.customer_id && customerIds.has(p.customer_id)) return refused(409, "Chasing is paused for this customer. Resume it first.");
  }

  const to = draft.to_email.split(",").map((a) => a.trim()).filter(Boolean);
  const allowed = new Set<string>();
  for (const c of customerRows) if (lower(c.email)) allowed.add(lower(c.email));
  for (const r of ((schedule as { recipients?: string[] | null } | null)?.recipients ?? [])) if (lower(r)) allowed.add(lower(r));
  const outside = () => to.filter((a) => !allowed.has(lower(a)) && !deps.allowlisted(lower(a)));
  if (outside().length) {
    const { data: people } = await db.from("user_profiles").select("email, workshop_email").eq("organization_id", org);
    for (const p of (people ?? []) as Array<{ email?: unknown; workshop_email?: unknown }>) {
      if (lower(p.email)) allowed.add(lower(p.email));
      if (lower(p.workshop_email)) allowed.add(lower(p.workshop_email));
    }
  }
  if (!to.length || outside().length) return refused(403, "A chase can only go to the customer's e-mail address on file, your reminder recipients or your own team. Update the customer's e-mail first.");

  // An edit made in the approval dialog is saved on the draft first (the person's own session), then that text is what is sent.
  let subject = draft.subject;
  let body = draft.body;
  if (input.subject !== undefined || input.body !== undefined) {
    const nextSubject = oneLine(input.subject ?? draft.subject);
    const nextBody = input.body ?? draft.body;
    if (!nextSubject || nextSubject.length > 200) return refused(400, "Enter a subject of up to 200 characters.");
    if (!nextBody.trim() || nextBody.length > 100_000) return refused(400, "Enter the e-mail text.");
    if (nextSubject !== draft.subject || nextBody !== draft.body) {
      const { error } = await db.from("email_history").update({ subject: nextSubject, body: nextBody }).eq("id", draft.id).eq("status", "drafted");
      if (error) return refused(409, "Couldn't save your changes to the draft, so nothing was sent. Try again.");
    }
    subject = nextSubject;
    body = nextBody;
  }

  const provider = await deps.provider(org);
  if (provider === "refused") return refused(503, "E-mail sending is switched off on this site.");
  if (!provider) return { status: "no_provider", message: NO_PROVIDER_MESSAGE };

  const sent = await deps.send({
    organizationId: org, userId: input.userId, kind: "invoice_reminder", to, subject, text: body, html: escapeHtml(body).replace(/\r?\n/g, "<br>\n"),
    recordType: "invoice", recordId: chase.invoice_id, idempotencyKey: approveKey(draft.id),
  });
  if (!sent.ok) {
    const http = sent.code === "invalid" ? 400 : sent.code === "recipient_refused" ? 403 : sent.code === "rate_limited" ? 429 : sent.code === "no_provider" ? 503 : 502;
    if (sent.code === "no_provider") return { status: "no_provider", message: NO_PROVIDER_MESSAGE };
    return refused(http, sent.error);
  }
  if (sent.mode === "drafted") {
    // The mailer was switched off between the check and the send: it saved a second draft. Remove that copy; the original stays.
    if (sent.historyId && sent.historyId !== draft.id) await deps.admin.from("email_history").delete().eq("id", sent.historyId).eq("organization_id", org).eq("status", "drafted");
    return { status: "no_provider", message: NO_PROVIDER_MESSAGE };
  }
  const historyId = sent.historyId ?? "";
  const { error: recordError } = historyId
    ? await deps.admin.rpc("chase_record_sent", { p_org: org, p_draft: draft.id, p_sent: historyId, p_user: input.userId })
    : { error: { code: "no_history" } };
  if (recordError) console.error("[chase/approve] sent but not recorded", (recordError as { code?: string }).code);
  return { status: "sent", historyId, recorded: !recordError };
}
