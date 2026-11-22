import { NextResponse } from "next/server";

import { accountingStatuses } from "@/lib/integrations/accounting-status";
import type { IntegrationOverview } from "@/lib/integrations/overview";
import { xeroReady } from "@/lib/integrations/server";
import { isErrorResponse, jsonError, requireProfile } from "@/lib/server/auth";

/** Admin-only, read-only: what is set up and the recorded transfers. No provider is called and no secret is returned. */
export async function GET() {
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access cannot read accounting status.", 403);
  const org = auth.profile.organization_id;
  const sends = () => auth.supabase.from("integration_sends").select("status,updated_at").eq("organization_id", org).eq("provider", "xero");
  const [config, overview, launch, last, failure] = await Promise.all([
    xeroReady().then(Boolean).catch(() => null),
    auth.supabase.rpc("integration_overview", { p_provider: "xero" }),
    auth.supabase.rpc("integration_xero_launch_status"),
    sends().order("updated_at", { ascending: false }).limit(1),
    sends().in("status", ["failed", "needs_check"]).order("updated_at", { ascending: false }).limit(1),
  ]);
  // The company's own switch (release 149), separate from Connected. Unreadable (149 not applied, or an error) is null: Unknown, never On or Off.
  const enabled = !launch.error && typeof launch.data?.enabled === "boolean" ? (launch.data.enabled as boolean) : null;
  const ov = (r: { error: unknown; data: unknown }) => (r.error ? null : (r.data as IntegrationOverview));
  return NextResponse.json({
    providers: accountingStatuses({
      configured: config, overview: ov(overview), enabled,
      last: last.error ? null : last.data?.[0] ?? null, lastReadOk: !last.error,
      lastFailure: failure.error ? null : failure.data?.[0] ?? null, failureReadOk: !failure.error,
    }),
  }, { headers: { "cache-control": "no-store" } });
}
