import { NextResponse } from "next/server";

import { finishConnect, xeroReady } from "@/lib/integrations/server";
import { CONNECT_ROLES } from "@/lib/integrations/xero/policy";
import { isErrorResponse, requireProfile } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * Xero sends the admin back here after they consent. The state must be the one this admin started for this company in the last 10
 * minutes (single use; the database checks), and the admin must still be an admin; the code is exchanged server-side (client secret,
 * PKCE), the tokens are encrypted and stored, and the admin is sent back to Admin > Integrations with the outcome. No token, code or state
 * appears in the redirect or in any log.
 */
export async function GET(request: Request) {
  const back = (outcome: string) => NextResponse.redirect(new URL(`/admin/integrations?xero=${encodeURIComponent(outcome)}`, request.url), 303);
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error")) return back("cancelled");
  if (!code || !state || code.length > 2000 || state.length > 200) return back("invalid");

  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return back(auth.status === 401 ? "signed_out" : "forbidden");
  // Support access never finishes a connection either (see connect): refused before the service-role client is made.
  if (auth.session?.support) return back("forbidden");
  const ready = await xeroReady();
  const service = createSupabaseAdminClient();
  if (!ready || !service) return back("not_configured");
  try {
    const outcome = await finishConnect(service, auth.profile.organization_id, auth.user.id, state, code, ready);
    return back(outcome.ok ? "connected" : outcome.reason);
  } catch (err) {
    const hint = (err as { hint?: string }).hint;
    console.error("[integrations] connect callback failed:", hint ?? (err as { code?: string }).code ?? (err instanceof Error ? err.name : "error"));
    return back(hint === "oauth_state_invalid" ? "expired" : "failed");
  }
}
