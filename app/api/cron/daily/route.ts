import { NextResponse } from "next/server";

import { runEmailSchedulesPass } from "@/lib/email/schedules/pass";
import { runXeroSweepPass } from "@/lib/integrations/xero-pass";
import { isCronRequest } from "@/lib/server/cron-auth";
import { passFailureReason } from "@/lib/server/cron-pass";
import { reportServerError } from "@/lib/server/error-alert";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ROUTE = "/api/cron/daily";
/** The e-mail pass stops sending after this long, so the Xero sweep that follows still fits in maxDuration. */
const EMAIL_BUDGET_MS = 30_000;

/**
 * The one daily pass (vercel.json "0 5 * * *", UTC: 05:00 UK in winter, 06:00 in summer). Production is on Vercel Hobby, which allows two
 * crons, each at most once a day, so this single route runs both jobs in turn, each in its own try/catch (one failing never stops the
 * other), and returns both results (counts only):
 *   1. the e-mail schedules (invoice reminders, timesheet e-mails; migration 108): everything whose chosen time has passed since the last
 *      pass is sent now, once (lib/email/schedules/due.ts);
 *   2. the Xero sweep (lib/integrations/sweep.ts).
 * Called with `Authorization: Bearer <CRON_SECRET>`; anything else gets 401 and nothing is read. A failure is reported and answered 500
 * AFTER both jobs have run.
 *
 * WITH THE PRO PLAN (exact-time sending; Rhys switches this on): replace the "daily" entry in vercel.json's crons with these two
 *   { "path": "/api/cron/email-schedules", "schedule": "0,15,30,45 * * * *" },
 *   { "path": "/api/cron/xero-sweep", "schedule": "41 4 * * *" }
 * (every 15 minutes; the two thin routes next to this one, same guard and same code), and set EXACT_TIME_SENDING = true in lib/email/schedules/form.ts so
 * Settings stops saying "sent at the next daily run". vercel.json is strict JSON (no comments), so the variant lives here. Never put a
 * cron on Hobby that runs more than once a day: an invalid vercel.json blocks every production deploy.
 */
export async function GET(request: Request) {
  if (!isCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const emailSchedules = await settle("e-mail schedules", () => runEmailSchedulesPass({ budgetMs: EMAIL_BUDGET_MS }));
  const xeroSweep = await settle("Xero sweep", () => runXeroSweepPass());
  const failed = "error" in emailSchedules || "error" in xeroSweep;
  return NextResponse.json({ emailSchedules, xeroSweep }, { status: failed ? 500 : 200 });
}

/** One job's result, or { error } (reported, with a safe reason) when it could not run at all. Never throws. */
async function settle<T extends object>(label: string, job: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await job();
  } catch (err) {
    const reason = passFailureReason(err);
    console.error(`[cron/daily] ${label} failed: ${reason}`);
    try {
      await reportServerError({ route: ROUTE, error: new Error(`Daily cron: ${label} failed: ${reason}`), source: "cron" });
    } catch {
      /* reporting must never stop the other job */
    }
    return { error: `${label} failed` };
  }
}
