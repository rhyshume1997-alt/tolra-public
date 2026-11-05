import { finishInviteConnect, invitePage, inviteRateOk, logInviteRefusal } from "@/lib/integrations/invite";
import { xeroReady } from "@/lib/integrations/server";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * Xero sends the accountant back here (E2, migration 107; registered at Xero as a second redirect URI,
 * `${NEXT_PUBLIC_SITE_URL}/api/integrations/invite/callback`). PUBLIC, no Tolra session: the state must be one a connect link started in
 * the last 10 minutes (integration_oauth_consume_invite: single use, invite states only; an admin's own Connect state is never accepted
 * here; rate limited per IP with the link's page, failing closed). The connection is completed for that link's company only, as the admin who made the link (still an admin: the database checks),
 * exactly as an admin's own Connect is (lib/integrations/server.ts completeConnect). A fixed page says the outcome; no token, code or
 * state appears in it or in any log (only a short fixed word, never database text, is logged).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const service = createSupabaseAdminClient();
  if (url.searchParams.get("error")) return invitePage("cancelled", 200, await logInviteRefusal(service, "callback", "callback_error"));
  if (!code || !state || code.length > 2000 || state.length > 200) return invitePage("invalid", 400, await logInviteRefusal(service, "callback", "callback_state"));
  if (!service) return invitePage("not_configured", 503);
  if (!(await inviteRateOk(service, request))) return invitePage("busy", 429, await logInviteRefusal(service, "request", "rate_limited"));
  const ready = await xeroReady(process.env, service);
  if (!ready) return invitePage("not_configured", 503);
  try {
    const outcome = await finishInviteConnect(service, state, code, ready);
    if (outcome.ok) return invitePage("connected");
    return invitePage(outcome.reason, 409, outcome.correlationId ?? await logInviteRefusal(service, "callback", "callback_error"));
  } catch (err) {
    // Only a short fixed word (a hint such as "tenant_in_use" or an error code) is logged: never the database's or Xero's own text.
    const hint = (err as { hint?: string }).hint;
    const word = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_]{1,40}$/.test(v) ? v : undefined);
    const id = await logInviteRefusal(service, "callback", "callback_error");
    console.error("[integrations] invite callback failed:", id, word(hint) ?? word((err as { code?: string }).code) ?? (err instanceof Error && word(err.name)) ?? "error");
    return invitePage("failed", 500, id);
  }
}
