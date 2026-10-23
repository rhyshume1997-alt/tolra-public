import { NextResponse } from "next/server";

import { DbError, disconnectCompany, xeroReady } from "@/lib/integrations/server";
import { CONNECT_ROLES } from "@/lib/integrations/xero/policy";
import { forbiddenOrigin, isErrorResponse, jsonError, requireProfile, sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * Admin > Integrations > Disconnect (G22; Xero question 9: admins only). The database disconnects as the signed-in admin (admin and
 * two-step checked there): the tokens are deleted, anything not yet sent is skipped, the send log stays. Then this app's connection to that
 * one Xero organisation is removed at Xero (best effort; the admin can also remove it in Xero).
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return auth;
  // Support access (the platform owner inside a company) holds an admin membership but never changes or reads through this company's Xero:
  // refused before any Xero or database call, as on the Admin > Users routes. The database's connect functions exclude support too.
  if (auth.session?.support) return jsonError("Support access can't change Xero settings.", 403);
  const service = createSupabaseAdminClient();
  if (!service) return jsonError("Service unavailable", 503);
  try {
    const result = await disconnectCompany(auth.supabase, service, auth.profile.organization_id, xeroReady());
    return NextResponse.json({ status: "disconnected", removedAtXero: result.removedAtXero });
  } catch (err) {
    if (err instanceof DbError && err.code === "42501") return jsonError(err.hint === "mfa_required" ? "Confirm your authenticator code first." : "Forbidden", 403);
    if (err instanceof DbError && err.hint === "not_connected") return jsonError("This company is not connected.", 409);
    console.error("[integrations] disconnect failed:", err instanceof DbError ? err.code : "error");
    return jsonError("Could not disconnect from Xero.", 500);
  }
}
