import { NextResponse } from "next/server";

import { sendInviteCodeEmail } from "@/lib/integrations/invite-mail";
import { INVITE_REF, allowedInviteRedirect, cleanInviteCode, inviteConfirmPage, invitePage, inviteRateOk, issueInviteCode, logInviteRefusal, maskRecipient, peekInvite, redeemInvite, type InviteNotice } from "@/lib/integrations/invite";
import { xeroReady } from "@/lib/integrations/server";
import { sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * The accountant opens the connect link (E2, migration 107; hardened by proposal 151): PUBLIC, no Tolra session. The address carries only an
 * opaque reference that grants nothing on its own. Rate limited per IP (20 in 15 minutes, with the callback; fails closed).
 * GET: a page "Connect <company> to Xero" with the MASKED recipient and two forms, for an open invite only (integration_invite_peek). NOTHING is
 *   used up and nothing is sent: a mail scanner (Safe Links) or a chat preview fetching the link doesn't burn it. Any other link gets the same fixed page.
 * POST action=send (same origin): e-mails a one-time code to the address the invite was bound to when the admin made it (never one the visitor
 *   supplies); at most five codes per invite, one a minute. The code is never in the response, the URL, a log or the audit.
 * POST action=verify (same origin): the typed code is checked and the invite used up in one database call (integration_invite_code_verify: open,
 *   admin still an admin, code unexpired, at most five wrong codes in the invite's life), a 10-minute OAuth state (state + PKCE) is kept, bound to that
 *   company, that admin and the invite, and the browser is sent straight to Xero. Xero not set up, or the redirect address not on the exact allow
 *   list (XERO_INVITE_REDIRECT_URIS): nothing is used up.
 */
export async function GET(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const service = createSupabaseAdminClient();
  if (!service) return invitePage("not_configured", 503);
  if (!(await inviteRateOk(service, request))) return invitePage("busy", 429, await logInviteRefusal(service, "request", "rate_limited", ref));
  if (!INVITE_REF.test(ref)) return invitePage("invalid", 404, await logInviteRefusal(service, "page", "malformed_ref", ref));
  try {
    const open = await peekInvite(service, ref);
    return open ? inviteConfirmPage(open.companyName, open.recipientHint) : invitePage("invalid", 404, await logInviteRefusal(service, "page", "not_open", ref));
  } catch (err) {
    console.error("[integrations] invite page failed:", (err as { code?: string }).code ?? (err instanceof Error ? err.name : "error"));
    return invitePage("failed", 500);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const service = createSupabaseAdminClient();
  if (!sameOrigin(request)) return invitePage("invalid", 403, await logInviteRefusal(service, "request", "bad_origin", ref));
  if (!service) return invitePage("not_configured", 503);
  if (!(await inviteRateOk(service, request))) return invitePage("busy", 429, await logInviteRefusal(service, "request", "rate_limited", ref));
  if (!INVITE_REF.test(ref)) return invitePage("invalid", 404, await logInviteRefusal(service, "request", "malformed_ref", ref));
  const ready = await xeroReady(process.env, service);
  if (!ready || !allowedInviteRedirect(ready.config)) return invitePage("not_configured", 503, await logInviteRefusal(service, "verify", "redirect_not_allowed", ref));
  const form = await request.formData().catch(() => null);
  const action = form?.get("action");
  try {
    const again = async (notice: InviteNotice, status: number, correlationId?: string) => {
      const open = await peekInvite(service, ref);
      return open ? inviteConfirmPage(open.companyName, open.recipientHint, notice, status, correlationId) : invitePage("invalid", 404, correlationId ?? await logInviteRefusal(service, "page", "not_open", ref));
    };
    if (action === "send") {
      const issued = await issueInviteCode(service, ref, ready.key);
      if (!issued.ok) return issued.reason === "invalid" ? invitePage("invalid", 404, issued.correlationId) : again(issued.reason, 429, issued.correlationId);
      const sent = await sendInviteCodeEmail({ organizationId: issued.organizationId, to: issued.recipient, companyName: issued.companyName, code: issued.code });
      if (!sent.ok) return invitePage("mail_failed", 503, await logInviteRefusal(service, "code", "mail_failed", ref));
      return inviteConfirmPage(issued.companyName, maskRecipient(issued.recipient), "code_sent");
    }
    if (action === "verify") {
      const code = cleanInviteCode(form?.get("code"));
      if (!code) return again("enter_code", 400, await logInviteRefusal(service, "verify", "wrong_code", ref));
      const outcome = await redeemInvite(service, ref, code, ready);
      if (outcome.ok) return NextResponse.redirect(outcome.url, 303);
      if (outcome.reason === "wrong_code") return again("wrong_code", 400, outcome.correlationId);
      if (outcome.reason === "code_expired") return again("code_expired", 400, outcome.correlationId);
      if (outcome.reason === "locked") return invitePage("locked", 403, outcome.correlationId);
      if (outcome.reason === "redirect_not_allowed") return invitePage("not_configured", 503, outcome.correlationId);
      return invitePage("invalid", 404, outcome.correlationId);
    }
    return invitePage("invalid", 400, await logInviteRefusal(service, "request", "invalid_request", ref));
  } catch (err) {
    console.error("[integrations] invite open failed:", (err as { code?: string }).code ?? (err instanceof Error ? err.name : "error"));
    return invitePage("failed", 500);
  }
}
