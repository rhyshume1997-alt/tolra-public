import { NextResponse } from "next/server";

import { microsoftReady } from "@/lib/integrations/microsoft/client";
import { testMicrosoft } from "@/lib/integrations/microsoft/connect";
import { ProviderError } from "@/lib/integrations/types";
import { CONNECT_ROLES } from "@/lib/integrations/xero/policy";
import { forbiddenOrigin, isErrorResponse, jsonError, requireProfile, sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * Admin > Integrations > Microsoft 365 > Test (E7): reads the signed-in mailbox's profile from Microsoft Graph now (GET /me), with this
 * company's stored sign-in (renewed if due). "Working: <mailbox>" or Microsoft's exact reason. Admin only, two-step, never a support
 * session. Read only: no mail is sent.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change Microsoft 365 settings.", 403);
  const service = createSupabaseAdminClient();
  const ready = await microsoftReady(service);
  if (!ready || !service) return jsonError("Not set up yet: the owner must enter the Microsoft 365 app details.", 503);
  try {
    const result = await testMicrosoft(service, auth.profile.organization_id, ready);
    if (!result) return jsonError("Not connected: connect this company to Microsoft 365 first (or connect again).", 409);
    return NextResponse.json({ ok: true, name: result.mailbox, message: `Working: ${result.mailbox}` });
  } catch (err) {
    if (err instanceof ProviderError || (err instanceof Error && err.name === "MicrosoftAuthError")) return jsonError(err.message, 502);
    console.error("[integrations] Microsoft test failed:", (err as { code?: string }).code ?? (err instanceof Error ? err.name : "error"));
    return jsonError("Couldn't test the Microsoft 365 connection. Try again.", 500);
  }
}
