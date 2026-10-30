import { NextResponse } from "next/server";

import { microsoftReady } from "@/lib/integrations/microsoft/client";
import { beginMicrosoftConnect } from "@/lib/integrations/microsoft/connect";
import { DbError } from "@/lib/integrations/server";
import { CONNECT_ROLES } from "@/lib/integrations/xero/policy";
import { forbiddenOrigin, isErrorResponse, jsonError, requireProfile, sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * Admin > Integrations > Microsoft 365 > Connect (E7, migration 107). Admin only, two-step, own company, never a support session (the
 * database checks all of it again in integration_oauth_start). Keeps a single-use state and PKCE verifier for 10 minutes and answers
 * with Microsoft's sign-in URL; the browser goes there. Nothing secret is sent to the browser.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change Microsoft 365 settings.", 403);
  const ready = await microsoftReady(createSupabaseAdminClient());
  if (!ready) return jsonError("Not set up yet: the owner must enter the Microsoft 365 app details.", 503);
  try {
    return NextResponse.json({ url: await beginMicrosoftConnect(auth.supabase, auth.profile.organization_id, ready) });
  } catch (err) {
    if (err instanceof DbError && err.code === "42501") return jsonError(err.hint === "mfa_required" ? "Confirm your authenticator code first." : "Forbidden", 403);
    if (err instanceof DbError && err.hint === "too_many_attempts") return jsonError(err.message, 429);
    if (err instanceof DbError && (err.code === "PGRST202" || err.code === "42883")) return jsonError("Not available until database update 107 is applied.", 503);
    console.error("[integrations] Microsoft connect start failed:", err instanceof DbError ? err.code : "error");
    return jsonError("Could not start the connection to Microsoft 365.", 500);
  }
}
