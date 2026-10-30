import { finishInviteConnect, invitePage, inviteRateOk } from "@/lib/integrations/invite";
import { xeroReady } from "@/lib/integrations/server";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * Xero sends the accountant back here (E2, migration 107; registered at Xero as a second redirect URI,
 * `${NEXT_PUBLIC_SITE_URL}/api/integrations/invite/callback`). PUBLIC, no Tolra session: the state must be one a connect link started in
 * the last 10 minutes (integration_oauth_consume_invite: single use, invite states only; an admin's own Connect state is never accepted
 * here; rate limited per IP with the link's page, failing closed). The connection is completed for that link's company only, as the admin who made the link (still an admin: the database checks),
 * exactly as an admin's own Connect is (lib/integrations/server.ts completeConnect). A fixed page says the outcome; no token, code or
 * state appears in it or in any log.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return invitePage("cancelled");
  if (!code || !state || code.length > 2000 || state.length > 200) return invitePage("invalid", 400);
  const service = createSupabaseAdminClient();
  if (!service) return invitePage("not_configured", 503);
  if (!(await inviteRateOk(service, request))) return invitePage("busy", 429);
  const ready = await xeroReady(process.env, service);
  if (!ready) return invitePage("not_configured", 503);
  try {
    const outcome = await finishInviteConnect(service, state, code, ready);
    return invitePage(outcome.ok ? "connected" : outcome.reason, outcome.ok ? 200 : 409);
  } catch (err) {
    const hint = (err as { hint?: string }).hint;
    console.error("[integrations] invite callback failed:", hint ?? (err as { code?: string }).code ?? (err instanceof Error ? err.name : "error"));
    return invitePage("failed", 500);
  }
}
