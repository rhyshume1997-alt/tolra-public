import { NextResponse } from "next/server";

import { forbiddenOrigin, isErrorResponse, jsonError, mfaRequired, requireProfile, sameOrigin } from "@/lib/server/auth";
import { parseAdminMfaOverview } from "@/lib/mfa-policy";
import { alertsEnabled, reportServerError } from "@/lib/server/error-alert";

/**
 * Proves that "one simulated production failure reaches the owner". Admin only. It raises a made-up error through the same
 * path a real one takes (redaction, the hourly/daily budget, Resend) and says what happened. The message deliberately
 * contains an e-mail address and an id, to show on the received e-mail that they were removed. Run after each deploy; a
 * second run within the hour is rate limited by design ("rate-limited": look in the inbox and spam for the first one).
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  // An active admin of this company (requireProfile: the database's has_org_role; aal2 when the REQUIRE_ADMIN_MFA environment setting is on).
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  // Support access (read-only or elevated) never sends e-mail from here: only the company's own admins test the alert.
  if (auth.session?.support) return jsonError("Support access can't send a test alert. Ask an admin of this company.", 403);
  // The company's own rule (organizations.require_admin_mfa, read through admin_mfa_overview) also needs aal2 here. An unreadable answer refuses.
  const { data: overview, error: overviewError } = await auth.supabase.rpc("admin_mfa_overview");
  const policy = overviewError ? null : parseAdminMfaOverview(overview);
  if (!policy) return jsonError("Service unavailable", 503);
  if (policy.requireAdminMfa) {
    const { data: assurance, error: assuranceError } = await auth.supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (assuranceError || assurance?.currentLevel !== "aal2") return mfaRequired();
  }
  if (!alertsEnabled()) {
    return NextResponse.json({ sent: false, reason: process.env.ALERT_EMAIL_TO ? "not-production" : "disabled", hint: "Set ALERT_EMAIL_TO in the Production environment and redeploy." });
  }
  const result = await reportServerError({
    route: "TEST /api/admin/alert-test",
    error: new Error(`Simulated production failure (alert test) for ${auth.user.email ?? "someone@example.com"} on record ${auth.profile.id}`),
    source: "alert-test",
  });
  return NextResponse.json(result);
}
