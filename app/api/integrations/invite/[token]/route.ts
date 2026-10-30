import { NextResponse } from "next/server";

import { INVITE_TOKEN, invitePage, redeemInvite } from "@/lib/integrations/invite";
import { xeroReady } from "@/lib/integrations/server";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * The accountant opens the connect link (E2, migration 107): PUBLIC, no Tolra session. The token's SHA-256 must match an unused,
 * unexpired link whose admin is still an admin (integration_invite_redeem, server only); it is used up at once (a second open is
 * refused) and a 10-minute OAuth state is kept, bound to that company, that admin and the link. The browser is sent straight to Xero.
 * Nothing about the company is shown; a bad link gets the same fixed page whatever the reason. Xero not set up: the link is not used up.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!INVITE_TOKEN.test(token)) return invitePage("invalid", 404);
  const service = createSupabaseAdminClient();
  const ready = await xeroReady(process.env, service);
  if (!service || !ready) return invitePage("not_configured", 503);
  try {
    const outcome = await redeemInvite(service, token, ready);
    if (!outcome.ok) return invitePage("invalid", 404);
    return NextResponse.redirect(outcome.url, 303);
  } catch (err) {
    console.error("[integrations] invite open failed:", (err as { code?: string }).code ?? (err instanceof Error ? err.name : "error"));
    return invitePage("failed", 500);
  }
}
