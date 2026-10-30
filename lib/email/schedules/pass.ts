// One pass over the e-mail schedules (the body of app/api/cron/email-schedules, and of the email part of app/api/cron/daily).
import "server-only";

import { RUN_BUDGET_MS, liveRunnerDeps } from "@/lib/email/schedules/live";
import { type RunSummary, runDueSchedules } from "@/lib/email/schedules/run";
import { PassFailure } from "@/lib/server/cron-pass";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

/** Runs what is due across companies. Counts only. Throws PassFailure (or any error) only when the whole pass could not run. */
export async function runEmailSchedulesPass(opts: { now?: Date; budgetMs?: number } = {}): Promise<RunSummary> {
  const admin = createSupabaseAdminClient();
  if (!admin) throw new PassFailure("no service client");
  const now = opts.now ?? new Date();
  const summary = await runDueSchedules(liveRunnerDeps(admin, Date.now(), opts.budgetMs ?? RUN_BUDGET_MS), now);
  if (!summary.skipped) console.log(`[cron/email-schedules] schedules=${summary.schedules} due=${summary.due} ran=${summary.ran} emails=${summary.emails} drafted=${summary.drafted} failed=${summary.failed} errors=${summary.errors}`);
  return summary;
}
