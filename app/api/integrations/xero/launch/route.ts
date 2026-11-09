import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRecentAal2 } from "@/lib/server/admin-users";
import { forbiddenOrigin, isErrorResponse, jsonError, mfaRecentRequired, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

/**
 * The company's Xero transfer switch (release 149): a persisted, per-company, server-side setting, off until an admin turns it on, and
 * separate from Connected. GET: where it stands. POST {enabled}: turn it on or off. Admin of this company only, never a support session;
 * ON also needs the second step with a RECENT authenticator code (requireRecentAal2, forced even while REQUIRE_ADMIN_MFA is off), a
 * connected company and finished mapping (the database refuses otherwise). OFF never needs a fresh code: the way out stays open.
 * The database function behind it checks admin, support, aal2 and the rest again, and the function that claims a send judges the switch itself.
 */
export async function GET() {
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change Xero transfers.", 403);
  const { data, error } = await auth.supabase.rpc("integration_xero_launch_status");
  if (error) return jsonError("Xero transfer controls are not available. Nothing was changed.", 503);
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change Xero transfers.", 403);
  const json = await readJson(request, 1024);
  if (!json.ok) return json.response;
  const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(json.data);
  if (!parsed.success) return jsonError("Choose on or off.", 400);
  if (parsed.data.enabled) {
    const refused = await requireRecentAal2(auth, "turn Xero transfers on", true);
    if (refused) return refused;
  }
  const { error } = await auth.supabase.rpc("integration_xero_set_transfers", { p_enabled: parsed.data.enabled });
  if (error) {
    const hint = (error as { hint?: string }).hint;
    if (hint === "mfa_recent_required") return mfaRecentRequired("turn Xero transfers on");
    if (hint === "not_connected") return jsonError("Connect this company to Xero first.", 409);
    if (hint === "not_mapped") return jsonError("Finish the Xero mapping first.", 409);
    return jsonError("Xero transfers were not changed. Check your admin sign-in and the connection.", error.code === "42501" ? 403 : 409);
  }
  return NextResponse.json({ enabled: parsed.data.enabled }, { headers: { "Cache-Control": "no-store" } });
}
