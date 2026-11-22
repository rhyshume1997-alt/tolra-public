import { NextResponse } from "next/server";

import { checkStatusInput, parseStatusResult, platformCompaniesEnabled, statusRefusal } from "@/lib/platform/companies";
import { recentSecondStep } from "@/lib/mfa-policy";
import { isErrorResponse, jsonError, mfaRecentRequired, readJson } from "@/lib/server/auth";
import { requirePlatformOwner } from "@/lib/server/platform";

// The platform owner closes or reopens ONE company: POST { organizationId, status: "closed" | "active", confirmName, reason }. OFF unless
// PLATFORM_COMPANIES_ENABLED is exactly "true" (404 right after the owner guard, before any database call). Order: requirePlatformOwner -> the switch -> to CLOSE, an authenticator code under 15 minutes old
// (mfa_recent_required before anything is sent) -> a checked input -> ONE call to release 164's platform_set_organization_status with the
// owner's OWN session. The database checks owner, the second step, the fresh code, the exact typed name, the reason, and that the owner is not
// inside that company, and writes the audit event. Nothing is deleted: only the company's status changes. Server logs carry the company id and
// the new status, never the reason text or a database message.

export async function POST(request: Request) {
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  if (!platformCompaniesEnabled()) return jsonError("Not found", 404);
  const { supabase, user } = ctx;

  const json = await readJson(request, 4 * 1024);
  if (!json.ok) return json.response;
  const checked = checkStatusInput(json.data);
  if (!checked.ok) return jsonError(checked.error, 400);
  const { organizationId, status, confirmName, reason } = checked.value;

  if (status === "closed") {
    const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assuranceError || !recentSecondStep(assurance?.currentAuthenticationMethods)) return mfaRecentRequired("close a company");
  }

  const { data, error } = await supabase.rpc("platform_set_organization_status", { p_org: organizationId, p_status: status, p_confirm_name: confirmName, p_reason: reason });
  if (error) {
    console.error("[platform] company status refused", error.code ?? "no-code", error.hint ?? "");
    const refusal = statusRefusal(error);
    return NextResponse.json({ error: refusal.error, ...(refusal.code ? { code: refusal.code } : {}) }, { status: refusal.status });
  }
  const result = parseStatusResult(data);
  if (!result) return jsonError("Couldn't confirm the change. Check the company's list before trying again.", 500);
  console.info(JSON.stringify({ event: "platform.company_status", actor: user.id, organization_id: organizationId, status: result.status, changed: result.changed }));
  return NextResponse.json({ ok: true, ...result }, { headers: { "Cache-Control": "no-store" } });
}
