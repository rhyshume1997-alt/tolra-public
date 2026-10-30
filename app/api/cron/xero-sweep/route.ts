import { NextResponse } from "next/server";

import { runIntegrationSweep } from "@/lib/integrations/sweep";
import { DbError, sweepDeps, xeroReady } from "@/lib/integrations/server";
import { isCronRequest } from "@/lib/server/cron-auth";
import { reportServerError } from "@/lib/server/error-alert";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ROUTE = "/api/cron/xero-sweep";

/**
 * Daily Xero sweep (E2, part): for every company connected to Xero, renews the sign-in (a Xero refresh token lapses after about 60 days
 * unused) and sends what is queued, through lib/integrations/sweep.ts (its own rules are unchanged: one company's failure never stops
 * the others, counts only). Called by Vercel Cron with `Authorization: Bearer <CRON_SECRET>`; anything else gets 401.
 *
 * Equivalent to the Design session's parked bb32873; drop ours if theirs lands.
 *
 * Does nothing where Xero is not set up on the server (no app credentials or encryption key) or where the integrations tables are not
 * in the database: both answer 200 with a skipped reason, so the daily cron never raises a false alarm.
 */
export async function GET(request: Request) {
  if (!isCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return await sweepAll();
  } catch (err) {
    if (err instanceof DbError && /^(PGRST205|42P01)$/.test(err.code ?? "")) return NextResponse.json({ skipped: "database update 084 not applied" });
    return failed(`threw ${err instanceof Error ? err.name : "unknown"}`);
  }
}

async function sweepAll() {
  const ready = xeroReady();
  if (!ready) return NextResponse.json({ skipped: "xero not configured" });
  const admin = createSupabaseAdminClient();
  if (!admin) return failed("no service client");
  const summary = await runIntegrationSweep(sweepDeps(admin, ready));
  console.log(`[cron/xero-sweep] companies=${summary.companies} renewed=${summary.renewed} needReconnect=${summary.needReconnect} sent=${summary.sent} failed=${summary.failed} needsCheck=${summary.needsCheck} errors=${summary.errors}`);
  return NextResponse.json(summary);
}

async function failed(reason: string) {
  console.error(`[cron/xero-sweep] failed: ${reason}`);
  await reportServerError({ route: ROUTE, error: new Error(`Xero sweep failed: ${reason}`), source: "cron" });
  return NextResponse.json({ error: "Sweep failed" }, { status: 500 });
}
