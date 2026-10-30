import { NextResponse } from "next/server";

import { INVITE_TOKEN, inviteConfirmPage, invitePage, inviteRateOk, peekInvite, redeemInvite } from "@/lib/integrations/invite";
import { xeroReady } from "@/lib/integrations/server";
import { sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * The accountant opens the connect link (E2, migration 107): PUBLIC, no Tolra session. Rate limited per IP (20 in 15 minutes, with the
 * callback; fails closed).
 * GET: a page "Connect <company> to Xero" with one Continue button, for an open link only (integration_invite_peek). NOTHING is used up:
 *   a mail scanner (Safe Links) or a chat preview fetching the link doesn't burn it. Any other link gets the same fixed page.
 * POST (that button, same origin): the link is used up (integration_invite_redeem, server only: unused, not cancelled, unexpired, its
 *   admin still an admin), a 10-minute OAuth state is kept, bound to that company, that admin and the link, and the browser is sent
 *   straight to Xero. Xero not set up: nothing is used up.
 */
export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!INVITE_TOKEN.test(token)) return invitePage("invalid", 404);
  const service = createSupabaseAdminClient();
  if (!service) return invitePage("not_configured", 503);
  if (!(await inviteRateOk(service, request))) return invitePage("busy", 429);
  try {
    const open = await peekInvite(service, token);
    return open ? inviteConfirmPage(open.companyName) : invitePage("invalid", 404);
  } catch (err) {
    console.error("[integrations] invite page failed:", (err as { code?: string }).code ?? (err instanceof Error ? err.name : "error"));
    return invitePage("failed", 500);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  if (!sameOrigin(request)) return invitePage("invalid", 403);
  const { token } = await params;
  if (!INVITE_TOKEN.test(token)) return invitePage("invalid", 404);
  const service = createSupabaseAdminClient();
  if (!service) return invitePage("not_configured", 503);
  if (!(await inviteRateOk(service, request))) return invitePage("busy", 429);
  const ready = await xeroReady(process.env, service);
  if (!ready) return invitePage("not_configured", 503);
  try {
    const outcome = await redeemInvite(service, token, ready);
    if (!outcome.ok) return invitePage("invalid", 404);
    return NextResponse.redirect(outcome.url, 303);
  } catch (err) {
    console.error("[integrations] invite open failed:", (err as { code?: string }).code ?? (err instanceof Error ? err.name : "error"));
    return invitePage("failed", 500);
  }
}
