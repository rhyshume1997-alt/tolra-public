import { NextResponse } from "next/server";

import { runEmailSchedulesPass } from "@/lib/email/schedules/pass";
import { isCronRequest } from "@/lib/server/cron-auth";
import { passFailureReason } from "@/lib/server/cron-pass";
import { reportServerError } from "@/lib/server/error-alert";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ROUTE = "/api/cron/email-schedules";

/**
 * The e-mail schedules (migration 108: invoice reminders, timesheet e-mails) on their own: finds the schedules that are due, across
 * companies, and runs them. NOT in vercel.json while production is on Vercel Hobby (one daily route, app/api/cron/daily, runs this pass
 * and the Xero sweep). On Pro, list this route every 15 minutes there (see app/api/cron/daily/route.ts). Called with
 * `Authorization: Bearer <CRON_SECRET>`; anything else gets 401 and nothing is read.
 *
 * Does nothing until a company turns a schedule on (they all start off) and sends nothing unless a mailer is configured (without one the
 * mailer only drafts). One company's failure never stops the others and never makes this route throw: it is counted and the answer is
 * still 200. While migration 108 is not applied it answers 200 with { skipped: "database update 108 not applied" }. Safe to run twice:
 * a period is claimed in the database before anything is sent, and an invoice is reminded at most once per period. Counts only.
 */
export async function GET(request: Request) {
  if (!isCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await runEmailSchedulesPass());
  } catch (err) {
    return failed(passFailureReason(err));
  }
}

async function failed(reason: string) {
  console.error(`[cron/email-schedules] failed: ${reason}`);
  await reportServerError({ route: ROUTE, error: new Error(`E-mail schedules failed: ${reason}`), source: "cron" });
  return NextResponse.json({ error: "E-mail schedules failed" }, { status: 500 });
}
