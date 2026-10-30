import { NextResponse } from "next/server";

import { companyXeroToken, xeroReady } from "@/lib/integrations/server";
import { ProviderError } from "@/lib/integrations/types";
import { readOrganisationName } from "@/lib/integrations/xero/client";
import { CONNECT_ROLES } from "@/lib/integrations/xero/policy";
import { forbiddenOrigin, isErrorResponse, jsonError, requireProfile, sameOrigin } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

/**
 * Admin > Integrations > Xero > Test (107): reads the connected organisation's name from Xero now, with this company's stored sign-in
 * (renewed if due). Answers "Working: <name>" or Xero's exact reason. Admin only, two-step; never a support session (it reads through the
 * company's Xero). Read only: nothing is sent or changed.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change Xero settings.", 403);
  const ready = await xeroReady();
  const service = createSupabaseAdminClient();
  if (!ready || !service) return jsonError("Xero is not set up on this server yet.", 503);
  try {
    const conn = await companyXeroToken(service, auth.profile.organization_id, ready);
    if (!conn) return jsonError("Not connected: connect this company to Xero first (or connect again).", 409);
    const name = await readOrganisationName(conn.token, conn.tenantId);
    return NextResponse.json({ ok: true, name, message: `Working: ${name}` });
  } catch (err) {
    if (err instanceof ProviderError) return jsonError(err.message, 502);
    console.error("[integrations] Xero test failed:", (err as { code?: string }).code ?? (err instanceof Error ? err.name : "error"));
    return jsonError("Couldn't test the Xero connection. Try again.", 500);
  }
}
