import { NextResponse } from "next/server";

import { disconnectMicrosoft } from "@/lib/integrations/microsoft/connect";
import { DbError } from "@/lib/integrations/server";
import { CONNECT_ROLES } from "@/lib/integrations/xero/policy";
import { forbiddenOrigin, isErrorResponse, jsonError, requireProfile, sameOrigin } from "@/lib/server/auth";

/**
 * Admin > Integrations > Microsoft 365 > Disconnect (E7). Admin only, two-step, never a support session. The database disconnects as
 * the signed-in admin (084's integration_disconnect: the tokens are deleted). Tolra then sends no mail as that mailbox. The consent can
 * also be removed at Microsoft (myapps.microsoft.com, or the tenant's Enterprise applications).
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change Microsoft 365 settings.", 403);
  try {
    await disconnectMicrosoft(auth.supabase);
    return NextResponse.json({ status: "disconnected" });
  } catch (err) {
    if (err instanceof DbError && err.code === "42501") return jsonError(err.hint === "mfa_required" ? "Confirm your authenticator code first." : "Forbidden", 403);
    if (err instanceof DbError && err.hint === "not_connected") return jsonError("This company is not connected.", 409);
    console.error("[integrations] Microsoft disconnect failed:", err instanceof DbError ? err.code : "error");
    return jsonError("Could not disconnect from Microsoft 365.", 500);
  }
}
