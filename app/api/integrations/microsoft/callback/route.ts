import { NextResponse } from "next/server";

import { microsoftReady } from "@/lib/integrations/microsoft/client";
import { finishMicrosoftConnect } from "@/lib/integrations/microsoft/connect";
import { CONNECT_ROLES } from "@/lib/integrations/xero/policy";
import { isErrorResponse, requireProfile } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * Microsoft sends the admin back here after they sign in and consent (redirect URI `${NEXT_PUBLIC_SITE_URL}/api/integrations/microsoft/callback`).
 * The state must be the one this admin started for this company in the last 10 minutes (single use; the database checks), and they must
 * still be an admin; the code is exchanged server-side (client secret, PKCE), the mailbox read, the tokens encrypted and stored, and the
 * admin sent back to Admin > Integrations with the outcome. No token, code or state appears in the redirect or in any log.
 */
export async function GET(request: Request) {
  const back = (outcome: string) => NextResponse.redirect(new URL(`/admin/integrations?microsoft=${encodeURIComponent(outcome)}`, request.url), 303);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return back(url.searchParams.get("error") === "access_denied" ? "cancelled" : "refused");
  if (!code || !state || code.length > 4000 || state.length > 200) return back("invalid");

  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return back(auth.status === 401 ? "signed_out" : "forbidden");
  if (auth.session?.support) return back("forbidden");
  const service = createSupabaseAdminClient();
  const ready = await microsoftReady(service);
  if (!ready || !service) return back("not_configured");
  try {
    const outcome = await finishMicrosoftConnect(service, auth.profile.organization_id, auth.user.id, state, code, ready);
    return back(outcome.ok ? "connected" : outcome.reason);
  } catch (err) {
    const hint = (err as { hint?: string }).hint;
    console.error("[integrations] Microsoft connect callback failed:", hint ?? (err as { code?: string }).code ?? (err instanceof Error ? err.name : "error"));
    return back(hint === "oauth_state_invalid" ? "expired" : "failed");
  }
}
