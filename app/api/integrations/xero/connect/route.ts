import { NextResponse } from "next/server";

import { xeroEnvProblem } from "@/lib/integrations/app-credentials";
import { DbError, beginConnect, xeroReady } from "@/lib/integrations/server";
import { CONNECT_ROLES } from "@/lib/integrations/xero/policy";
import { forbiddenOrigin, isErrorResponse, jsonError, requireProfile, sameOrigin } from "@/lib/server/auth";

/**
 * Admin > Integrations > Connect (G22). Admin only (Xero question 9: lib/integrations/xero/policy.ts), two-step sign-in as for every admin
 * route; the database checks both again. Keeps a single-use state and PKCE verifier for this admin and company (10 minutes) and answers
 * with Xero's sign-in URL; the browser goes there. Nothing secret is sent to the browser.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return auth;
  // Support access (the platform owner inside a company, read-only or elevated) never connects Xero (Rhys, Wed 21 Oct: Xero is an
  // admin's), refused before any Xero or database call, as on disconnect, mappings and send. The database's support_read_only trigger
  // stops only a read-only session; an elevated one would otherwise get through.
  if (auth.session?.support) return jsonError("Support access can't change Xero settings.", 403);
  const ready = await xeroReady();
  if (!ready) return jsonError(["Xero is not set up on this server yet.", xeroEnvProblem()].filter(Boolean).join(" "), 503);
  try {
    return NextResponse.json({ url: await beginConnect(auth.supabase, auth.profile.organization_id, ready) });
  } catch (err) {
    if (err instanceof DbError && err.code === "42501") return jsonError(err.hint === "mfa_required" ? "Confirm your authenticator code first." : "Forbidden", 403);
    if (err instanceof DbError && err.hint === "too_many_attempts") return jsonError(err.message, 429);
    console.error("[integrations] connect start failed:", err instanceof DbError ? err.code : "error");
    return jsonError("Could not start the connection to Xero.", 500);
  }
}
