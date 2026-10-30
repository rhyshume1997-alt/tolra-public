import { NextResponse } from "next/server";

import { liveRunnerDeps } from "@/lib/email/schedules/live";
import { runDueSchedules } from "@/lib/email/schedules/run";
import { isCronRequest } from "@/lib/server/cron-auth";
import { reportServerError } from "@/lib/server/error-alert";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ROUTE = "/api/cron/email-schedules";

/**
 * Every 15 minutes (vercel.json): finds the e-mail schedules (migration 108: invoice reminders, timesheet e-mails) that are due, across
 * companies, and runs them. Called by Vercel Cron with `Authorization: Bearer <CRON_SECRET>`; anything else gets 401 and nothing is read.
 *
 * Does nothing until a company turns a schedule on (they all start off) and sends nothing unless a mailer is configured (without one the
 * mailer only drafts). One company's failure never stops the others and never makes this route throw: it is counted and the answer is
 * still 200. While migration 108 is not applied (production applies migrations by hand after the app deploys) it answers 200 with
 * { skipped: "database update 108 not applied" }. Safe to run twice: a period is claimed in the database before anything is sent, and an
 * invoice is reminded at most once per period. Returns counts only.
 */
export async function GET(request: Request) {
  if (!isCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return await runAll();
  } catch (err) {
    return failed(`threw ${err instanceof Error ? err.name : "unknown"}`);
  }
}

async function runAll() {
  const admin = createSupabaseAdminClient();
  if (!admin) return failed("no service client");
  const summary = await runDueSchedules(liveRunnerDeps(admin), new Date());
  if (!summary.skipped) console.log(`[cron/email-schedules] schedules=${summary.schedules} due=${summary.due} ran=${summary.ran} emails=${summary.emails} drafted=${summary.drafted} failed=${summary.failed} errors=${summary.errors}`);
  return NextResponse.json(summary);
}

async function failed(reason: string) {
  console.error(`[cron/email-schedules] failed: ${reason}`);
  await reportServerError({ route: ROUTE, error: new Error(`E-mail schedules failed: ${reason}`), source: "cron" });
  return NextResponse.json({ error: "E-mail schedules failed" }, { status: 500 });
}
