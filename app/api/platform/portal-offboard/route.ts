import { NextResponse } from "next/server";

import { recentSecondStep } from "@/lib/mfa-policy";
import { checkOffboardInput, offboardRefusal, parseOffboardResult } from "@/lib/platform/portal-offboard";
import { isErrorResponse, jsonError, mfaRecentRequired, readJson } from "@/lib/server/auth";
import { requirePlatformOwner } from "@/lib/server/platform";

// The platform owner removes ONE company's customer-portal links and portal switch: POST { organizationId, reason }.
// Order: requirePlatformOwner (same origin, signed in, is_platform_admin(), aal2) -> an authenticator code under 15 minutes old
// (mfa_recent_required before anything is sent) -> a checked company id and reason -> ONE call to release 153's
// platform_offboard_document_customer_links with the owner's OWN session. The database checks owner, aal2, the fresh code, read-only
// support sessions, the reason and the company again, removes the links and switch, and writes the audit event. The service role
// (made by requirePlatformOwner for the limiter elsewhere) is never used here. This route never deletes a company, a document, a
// customer or an audit row. Database messages are never returned.

export async function POST(request: Request) {
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  const { supabase, user } = ctx;

  const { data: assurance, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (assuranceError || !recentSecondStep(assurance?.currentAuthenticationMethods)) return mfaRecentRequired("remove a company's portal links");

  const json = await readJson(request, 4 * 1024);
  if (!json.ok) return json.response;
  const checked = checkOffboardInput(json.data);
  if (!checked.ok) return jsonError(checked.error, 400);
  const { organizationId, reason } = checked.value;

  const { data, error } = await supabase.rpc("platform_offboard_document_customer_links", { p_org: organizationId, p_reason: reason });
  if (error) {
    console.error("[platform] portal offboard refused", error.code ?? "no-code", error.hint ?? "");
    const refusal = offboardRefusal(error);
    return NextResponse.json({ error: refusal.error, ...(refusal.code ? { code: refusal.code } : {}) }, { status: refusal.status });
  }
  const result = parseOffboardResult(data);
  if (!result) return jsonError("Couldn't confirm the removal. Check the company's audit log before trying again.", 500);

  // No raw IP address in this record (PM ruling). Keeps actor, company, action, timestamp and reason.
  console.info(JSON.stringify({ event: "platform.portal_offboarded", action: "portal_offboard", actor: user.id, organization_id: organizationId, reason, removed_links: result.removedLinks, at: new Date().toISOString() }));
  return NextResponse.json({ ok: true, removedLinks: result.removedLinks, removedSwitch: result.removedSwitch, organizationId: result.organizationId }, { headers: { "Cache-Control": "no-store" } });
}
