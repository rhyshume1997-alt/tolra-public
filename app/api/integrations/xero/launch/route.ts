import { NextResponse } from "next/server";
import { z } from "zod";

import { requireRecentAal2 } from "@/lib/server/admin-users";
import type { AuthContext } from "@/lib/server/auth";
import { forbiddenOrigin, isErrorResponse, jsonError, mfaRecentRequired, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

/**
 * The company's Xero transfer switch (release 149): a persisted, per-company, server-side setting, off until an admin turns it on, and
 * separate from Connected. GET: where it stands. POST {enabled}: turn it on or off. Admin of this company only, never a support session;
 * ON also needs the second step with a RECENT authenticator code (requireRecentAal2, forced even while REQUIRE_ADMIN_MFA is off), a
 * connected company and finished mapping (the database refuses otherwise). OFF never needs a fresh code: the way out stays open.
 * The database function behind it checks admin, support, aal2 and the rest again, and the function that claims a send judges the switch itself.
 * GET also returns the connected organisation {tenantId, name}. ON also needs confirmTenantId equal to the stored tenant id (else 409
 * confirm_organisation, before the database call, nothing written, no audit); OFF is never blocked. This check is route-level (the database
 * function is unchanged). Inputs: {enabled, confirmTenantId?}. Must not change: the admin, support, fresh-code and OFF rules above.
 */
async function connectedOrganisation(auth: AuthContext) {
  const { data, error } = await auth.supabase.from("integration_connections").select("tenant_id,tenant_name").eq("organization_id", auth.profile.organization_id).eq("provider", "xero").maybeSingle();
  if (error) return { error: true as const };
  const row = data as { tenant_id: string | null; tenant_name: string | null } | null;
  return { error: false as const, tenantId: row?.tenant_id ?? null, name: row?.tenant_name ?? null };
}

export async function GET() {
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change Xero transfers.", 403);
  const { data, error } = await auth.supabase.rpc("integration_xero_launch_status");
  if (error) return jsonError("Xero transfer controls are not available. Nothing was changed.", 503);
  const org = await connectedOrganisation(auth);
  const organisation = !org.error && org.tenantId ? { tenantId: org.tenantId, name: org.name } : null;
  return NextResponse.json({ ...(data as object), organisation }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change Xero transfers.", 403);
  const json = await readJson(request, 1024);
  if (!json.ok) return json.response;
  const parsed = z.object({ enabled: z.boolean(), confirmTenantId: z.string().min(1).max(200).optional() }).strict().safeParse(json.data);
  if (!parsed.success) return jsonError("Choose on or off.", 400);
  let confirmedName: string | null = null;
  if (parsed.data.enabled) {
    const refused = await requireRecentAal2(auth, "turn Xero transfers on", true);
    if (refused) return refused;
    const org = await connectedOrganisation(auth);
    if (org.error) return jsonError("Xero transfers were not changed: the connected organisation could not be read.", 503);
    confirmedName = org.name;
    if (!org.tenantId || parsed.data.confirmTenantId !== org.tenantId) {
      return NextResponse.json({ error: "Confirm the Xero organisation this company is connected to before turning transfers on.", code: "confirm_organisation" }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
  }
  const { error } = await auth.supabase.rpc("integration_xero_set_transfers", { p_enabled: parsed.data.enabled });
  if (error) {
    const hint = (error as { hint?: string }).hint;
    if (hint === "mfa_recent_required") return mfaRecentRequired("turn Xero transfers on");
    if (hint === "not_connected") return jsonError("Connect this company to Xero first.", 409);
    if (hint === "not_mapped") return jsonError("Finish the Xero mapping first.", 409);
    return jsonError("Xero transfers were not changed. Check your admin sign-in and the connection.", error.code === "42501" ? 403 : 409);
  }
  if (parsed.data.enabled) {
    // The confirmed organisation, by name only (no tenant id, no token), as the picker's audit row does.
    const { error: auditError } = await auth.supabase.rpc("write_audit", {
      p_action: "ORGANIZATION_SETTINGS_UPDATE", p_entity_table: "organization_settings", p_entity_id: auth.profile.organization_id, p_old: null, p_new: null,
      p_metadata: { integration: "xero", purpose: "xero_organisation_confirmed", organisation: confirmedName }, p_ip: null, p_user_agent: null,
    });
    if (auditError) console.error("[integrations] xero confirm audit failed", auditError.code);
  }
  return NextResponse.json({ enabled: parsed.data.enabled }, { headers: { "Cache-Control": "no-store" } });
}
