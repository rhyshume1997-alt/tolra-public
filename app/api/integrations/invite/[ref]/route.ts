import { NextResponse } from "next/server";

import { sendInviteCodeEmail } from "@/lib/integrations/invite-mail";
import { INVITE_REF, allowedInviteRedirect, cleanInviteCode, inviteConfirmPage, invitePage, inviteRateOk, issueInviteCode, maskRecipient, peekInvite, redeemInvite, type InviteNotice } from "@/lib/integrations/invite";
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
  if (!INVITE_REF.test(ref)) return invitePage("invalid", 404);
  const service = createSupabaseAdminClient();
  if (!service) return invitePage("not_configured", 503);
  if (!(await inviteRateOk(service, request))) return invitePage("busy", 429);
  try {
    const open = await peekInvite(service, ref);
    return open ? inviteConfirmPage(open.companyName, open.recipientHint) : invitePage("invalid", 404);
  } catch (err) {
    console.error("[integrations] invite page failed:", (err as { code?: string }).code ?? (err instanceof Error ? err.name : "error"));
    return invitePage("failed", 500);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ ref: string }> }) {
  if (!sameOrigin(request)) return invitePage("invalid", 403);
  const { ref } = await params;
  if (!INVITE_REF.test(ref)) return invitePage("invalid", 404);
  const service = createSupabaseAdminClient();
  if (!service) return invitePage("not_configured", 503);
  if (!(await inviteRateOk(service, request))) return invitePage("busy", 429);
  const ready = await xeroReady(process.env, service);
  if (!ready || !allowedInviteRedirect(ready.config)) return invitePage("not_configured", 503);
  const form = await request.formData().catch(() => null);
  const action = form?.get("action");
  try {
    const again = async (notice: InviteNotice, status: number) => {
      const open = await peekInvite(service, ref);
      return open ? inviteConfirmPage(open.companyName, open.recipientHint, notice, status) : invitePage("invalid", 404);
    };
    if (action === "send") {
      const issued = await issueInviteCode(service, ref, ready.key);
      if (!issued.ok) return issued.reason === "invalid" ? invitePage("invalid", 404) : again(issued.reason, 429);
      const sent = await sendInviteCodeEmail({ organizationId: issued.organizationId, to: issued.recipient, companyName: issued.companyName, code: issued.code });
      if (!sent.ok) return invitePage("mail_failed", 503);
      return inviteConfirmPage(issued.companyName, maskRecipient(issued.recipient), "code_sent");
    }
    if (action === "verify") {
      const code = cleanInviteCode(form?.get("code"));
      if (!code) return again("enter_code", 400);
      const outcome = await redeemInvite(service, ref, code, ready);
      if (outcome.ok) return NextResponse.redirect(outcome.url, 303);
      if (outcome.reason === "wrong_code") return again("wrong_code", 400);
      if (outcome.reason === "code_expired") return again("code_expired", 400);
      if (outcome.reason === "locked") return invitePage("locked", 403);
      if (outcome.reason === "redirect_not_allowed") return invitePage("not_configured", 503);
      return invitePage("invalid", 404);
    }
    return invitePage("invalid", 400);
  } catch (err) {
    console.error("[integrations] invite open failed:", (err as { code?: string }).code ?? (err instanceof Error ? err.name : "error"));
    return invitePage("failed", 500);
  }
}
