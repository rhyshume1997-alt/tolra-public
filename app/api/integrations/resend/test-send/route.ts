import { NextResponse } from "next/server";

import { resendTestSend } from "@/lib/email/resend-test-send";
import { CONNECT_ROLES } from "@/lib/integrations/xero/policy";
import { forbiddenOrigin, isErrorResponse, jsonError, requireProfile, sameOrigin } from "@/lib/server/auth";
import { requireRecentAal2 } from "@/lib/server/admin-users";

export const dynamic = "force-dynamic";
const headers = { "cache-control": "no-store" };

/**
 * Admin > Integrations > Resend > Send a test e-mail. Admin only (CONNECT_ROLES), never a support session, a recent authenticator code
 * (requireRecentAal2 with forceRecent: asked for even while REQUIRE_ADMIN_MFA is off). The request body is NEVER read: the one recipient is
 * the signed-in admin's own address from the session, the text is fixed. Audited with ids and codes only (no address, no body).
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't send a test e-mail.", 403);
  const mfa = await requireRecentAal2(auth, "send a test e-mail", true);
  if (mfa) return mfa;

  const result = await resendTestSend({ organizationId: auth.profile.organization_id, adminEmail: auth.user.email });
  if (result.outcome) {
    // 'SEND' on email_history is an event the database already accepts from an admin (audit_event_allowed); a dedicated event name needs a migration.
    const { error } = await auth.supabase.rpc("write_audit", {
      p_action: "SEND",
      p_entity_table: "email_history",
      p_entity_id: auth.profile.organization_id,
      p_old: null,
      p_new: null,
      p_metadata: { channel: "resend", purpose: "test_send", outcome: result.outcome },
      p_ip: null,
      p_user_agent: null,
    });
    if (error) console.error("[resend-test-send] audit failed", error.code);
  }
  return NextResponse.json(result.body, { status: result.status, headers });
}
