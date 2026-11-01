// One pass of the Xero sweep (the body of app/api/cron/xero-sweep, and of the Xero part of app/api/cron/daily). lib/integrations/sweep.ts keeps
// its own rules; this only builds its dependencies. Equivalent to the Design session's parked bb32873; drop ours if theirs lands.
import "server-only";

import { type SweepSummary, runIntegrationSweep } from "@/lib/integrations/sweep";
import { DbError, sweepDeps, xeroReady } from "@/lib/integrations/server";
import { PassFailure } from "@/lib/server/cron-pass";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

/** The sweep's counts, or why it did nothing (Xero not set up on this server; the integrations tables not in the database). */
export async function runXeroSweepPass(): Promise<SweepSummary | { skipped: string }> {
  const ready = xeroReady();
  if (!ready) return { skipped: "xero not configured" };
  const admin = createSupabaseAdminClient();
  if (!admin) throw new PassFailure("no service client");
  let summary: SweepSummary;
  try {
    summary = await runIntegrationSweep(sweepDeps(admin, ready));
  } catch (err) {
    if (err instanceof DbError && /^(PGRST205|42P01)$/.test(err.code ?? "")) return { skipped: "database update 084 not applied" };
    throw err;
  }
  console.log(`[cron/xero-sweep] companies=${summary.companies} renewed=${summary.renewed} needReconnect=${summary.needReconnect} sent=${summary.sent} failed=${summary.failed} needsCheck=${summary.needsCheck} errors=${summary.errors}`);
  return summary;
}
