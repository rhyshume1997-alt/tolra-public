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

import { fetchAll } from "@/lib/fetch-all";
import { pauseActive } from "@/lib/email/chase/steps";
import type { CompanyEmailInput, CompanyEmailResult } from "@/lib/email/send-company-email";
import { attemptKey } from "@/lib/email/chase/attempt";
import { recordSendAudit } from "@/lib/email/chase/send-audit";
import { balanceDue, invoiceLifecycle } from "@/lib/receivables";

export type ApproveInput = { organizationId: string; userId: string; draftId: string; expectedTo: string; expectedSubject: string; expectedBody: string; today: string; /** An admin's explicit choice for ONE failed message (never automatic). */ provider?: "resend"; isAdmin?: boolean };
export type ApproveDeps = {
  /** The person's own session (row level security). */
  db: SupabaseClient;
  /** The service role: chase_record_sent, and removing a stray draft. */
  admin: SupabaseClient;
  /** Microsoft 365 / Resend / null (none set up) / "refused" (the test provider on a deployment). */
  provider: (organizationId: string) => Promise<unknown | null | "refused">;
  send: (input: CompanyEmailInput, provider?: unknown) => Promise<CompanyEmailResult>;
  /** Resend from this deployment's configuration (null: not configured); used only for an explicit choice. */
  resend?: () => unknown | null;
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
  if (input.provider === "resend" && !input.isAdmin) return refused(403, "Only an admin can choose another provider for a failed email.");
  const { data: draftRow, error: draftError } = await db.from("email_history")
    .select("id, organization_id, to_email, subject, body, status, related_to_type, related_to_id").eq("id", input.draftId).maybeSingle();
  const draft = draftRow as { id: string; organization_id: string; to_email: string; subject: string; body: string; status: string; related_to_type: string | null; related_to_id: string | null } | null;
  if (draftError || !draft || draft.organization_id !== org) return refused(404, "Draft not found.");
  if (typeof input.expectedTo !== "string" || input.expectedTo !== draft.to_email || typeof input.expectedSubject !== "string" || typeof input.expectedBody !== "string" || input.expectedSubject !== draft.subject || input.expectedBody !== draft.body) return refused(409, "The draft changed after you checked it. Reload and review it before sending.");
  if (draft.status === "unknown" || draft.status === "sending") return refused(409, "This email's outcome is not known yet. It is held for checking: it will not be retried or sent another way until a person has checked Email history and settled it.");
  if (draft.status !== "drafted") return refused(409, "This e-mail is no longer waiting for approval. Reload the page.");

  const { data: chaseRow } = await db.from("chase_sends").select("id, invoice_id, status").eq("draft_history_id", draft.id).eq("organization_id", org).maybeSingle();
  const chase = chaseRow as { id: string; invoice_id: string; status: string } | null;
  if (!chase || draft.related_to_type !== "invoice" || draft.related_to_id !== chase.invoice_id) return refused(400, "Only chase drafts can be approved and sent from here.");
  if (chase.status !== "drafted") return refused(409, "This chase has already been sent.");

  const to = draft.to_email.split(",").map((a) => a.trim()).filter(Boolean);
  // Reuse the same eligibility checks immediately before sending. A payment or dispute
  // recorded while provider credentials are being checked must cancel this approval.
  const checkCurrentInvoice = async (): Promise<ApproveResult | null> => {
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
    let pauses: Array<{ invoice_id: string | null; customer_id: string | null; paused_until: string | null }>;
    let customers: Array<{ id: string; name: string; email: string | null }>;
    let schedule: { recipients?: string[] | null } | null;
    try {
      const [pauseRead, customerRead, scheduleRead] = await Promise.all([
        fetchAll<{ id: string; invoice_id: string | null; customer_id: string | null; paused_until: string | null }>((from, to) => db.from("chase_pauses").select("id, invoice_id, customer_id, paused_until").eq("organization_id", org).order("id").range(from, to)),
        fetchAll<{ id: string; name: string; email: string | null }>((from, to) => db.from("customers").select("id, name, email").eq("organization_id", org).order("id").range(from, to)),
        db.from("email_schedules").select("recipients").eq("organization_id", org).eq("kind", "invoice_reminder").maybeSingle(),
      ]);
      if (pauseRead.truncated || customerRead.truncated || scheduleRead.error) throw new Error("Incomplete chasing checks");
      pauses = pauseRead.rows; customers = customerRead.rows; schedule = scheduleRead.data;
    } catch {
      return refused(503, "Could not check chasing pauses and recipients. Nothing was sent. Try again when these checks are available.");
    }
    const customerRows = ((customers ?? []) as Array<{ id: string; name: string; email: string | null }>).filter((c) => lower(c.name) === customerName);
    if (customerRows.length > 1) return refused(409, "Two customer records use this name. Check them before sending.");
    const customerIds = new Set(customerRows.map((c) => c.id));
    for (const p of (pauses ?? []) as Array<{ invoice_id: string | null; customer_id: string | null; paused_until: string | null }>) {
      if (!pauseActive(p.paused_until, input.today)) continue;
      if (p.invoice_id === chase.invoice_id) return refused(409, "Chasing is paused for this invoice. Resume it first.");
      if (p.customer_id && customerIds.has(p.customer_id)) return refused(409, "Chasing is paused for this customer. Resume it first.");
    }

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
    return null;
  };
  const invalidInvoice = await checkCurrentInvoice();
  if (invalidInvoice) return invalidInvoice;

  // Approval covers only saved, reviewed text. Edits must be saved and reviewed separately.
  if (draft.subject !== draft.subject.trim() || !draft.subject.trim() || draft.subject.length > 200 || !draft.body.trim() || draft.body.length > 100_000 || /[\r\n\u2028\u2029\0]/.test(draft.subject)) return refused(400, "Check the subject and message before sending.");
  const subject = input.expectedSubject;
  const body = input.expectedBody;

  let provider: unknown;
  if (input.provider === "resend") {
    const earlier = await db.from("email_history").select("status").eq("organization_id", org).eq("related_to_id", chase.invoice_id).in("status", ["failed", "unknown"]);
    const statuses = earlier.error ? ["unknown"] : (earlier.data ?? []).map((r: { status: string }) => r.status);
    if (statuses.includes("unknown")) return refused(409, "An earlier attempt has an unknown outcome. Check Email history first; nothing is sent another way until it is settled.");
    if (!statuses.includes("failed")) return refused(409, "Another provider can only be chosen for an email whose send failed.");
    provider = deps.resend?.() ?? null;
    if (!provider) return refused(503, "Resend is not set up for this company, so it can't be used. The draft stays for manual sending.");
  } else {
    try { provider = await deps.provider(org); } catch { return refused(502, "Microsoft 365 needs attention. Nothing was sent and no other provider was used. An admin can choose Resend for this message if it is set up."); }
  }
  if (provider === "refused") return refused(503, "E-mail sending is switched off on this site.");
  if (!provider) return { status: "no_provider", message: NO_PROVIDER_MESSAGE };

  // Compare and claim in one UPDATE: an edit before this point invalidates approval.
  // Every editor requires status=drafted, so an edit cannot alter a claimed send.
  const { data: claimed, error: claimError } = await db.from("email_history")
    .update({ status: "sending" }).eq("id", draft.id).eq("organization_id", org).eq("status", "drafted")
    .eq("subject", subject).eq("body", body).eq("to_email", draft.to_email).select("id");
  if (claimError || !Array.isArray(claimed) || claimed.length !== 1) return refused(409, "The draft changed after you checked it. Reload and review it before sending.");

  const settleClaim = async (status: "drafted" | "unknown") => {
    const { data, error } = await db.from("email_history").update({ status })
      .eq("id", draft.id).eq("organization_id", org).eq("status", "sending")
      .eq("subject", subject).eq("body", body).eq("to_email", draft.to_email).select("id");
    if (error || !Array.isArray(data) || data.length !== 1) {
      // Keep the claim closed if persistence failed; a retry must never guess whether mail went out.
      return false;
    }
    return true;
  };
  const needsChecking = () => refused(502, "The send result needs checking. Do not send this reminder again until it has been checked.");

  const changedInvoice = await checkCurrentInvoice();
  if (changedInvoice) {
    if (!await settleClaim("drafted")) return needsChecking();
    await recordSendAudit(db, { outcome: "changed", historyId: draft.id, channel: "chase-approve" });
    return changedInvoice;
  }

  if (input.provider === "resend") await recordSendAudit(db, { outcome: "provider_override", historyId: draft.id, channel: "chase-approve", provider: "resend" });
  let sent: CompanyEmailResult;
  try { sent = await deps.send({
    organizationId: org, userId: input.userId, kind: "invoice_reminder", to, subject, text: body,
    recordType: "invoice", recordId: chase.invoice_id, idempotencyKey: await attemptKey(db, org, approveKey(draft.id), chase.invoice_id, draft.id),
  }, provider); } catch { await settleClaim("unknown"); await recordSendAudit(db, { outcome: "unknown", historyId: draft.id, channel: "chase-approve", code: "thrown" }); return needsChecking(); }
  if (!sent.ok) {
    if (sent.uncertain) { await settleClaim("unknown"); await recordSendAudit(db, { outcome: "unknown", historyId: draft.id, channel: "chase-approve", code: sent.code }); return needsChecking(); }
    if (!await settleClaim("drafted")) { await recordSendAudit(db, { outcome: "unknown", historyId: draft.id, channel: "chase-approve", code: "settle_failed" }); return needsChecking(); }
    await recordSendAudit(db, { outcome: "failed", historyId: draft.id, channel: "chase-approve", code: sent.code });
    const http = sent.code === "invalid" ? 400 : sent.code === "recipient_refused" ? 403 : sent.code === "rate_limited" ? 429 : sent.code === "no_provider" ? 503 : 502;
    if (sent.code === "no_provider") return { status: "no_provider", message: NO_PROVIDER_MESSAGE };
    return refused(http, sent.error);
  }
  if (sent.mode === "drafted") {
    // The mailer was switched off between the check and the send: it saved a second draft. Remove that copy; the original stays.
    if (sent.historyId && sent.historyId !== draft.id) await deps.admin.from("email_history").delete().eq("id", sent.historyId).eq("organization_id", org).eq("status", "drafted");
    await db.from("email_history").update({ status: "drafted" }).eq("id", draft.id).eq("organization_id", org).eq("status", "sending").eq("subject", subject).eq("body", body);
    return { status: "no_provider", message: NO_PROVIDER_MESSAGE };
  }
  const historyId = sent.historyId ?? "";
  const { error: recordError } = historyId
    ? await deps.admin.rpc("chase_record_sent", { p_org: org, p_draft: draft.id, p_sent: historyId, p_user: input.userId })
    : { error: { code: "no_history" } };
  if (recordError) console.error("[chase/approve] sent but not recorded", (recordError as { code?: string }).code);
  // 138 only deletes a drafted source. Remove our claimed source after it records the send.
  if (!recordError) await deps.admin.from("email_history").delete().eq("id", draft.id).eq("organization_id", org).eq("status", "sending");
  return { status: "sent", historyId, recorded: !recordError };
}
