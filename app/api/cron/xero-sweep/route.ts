import { NextResponse } from "next/server";

import { runXeroSweepPass } from "@/lib/integrations/xero-pass";
import { isCronRequest } from "@/lib/server/cron-auth";
import { passFailureReason } from "@/lib/server/cron-pass";
import { reportServerError } from "@/lib/server/error-alert";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ROUTE = "/api/cron/xero-sweep";

/**
 * The Xero sweep (E2, part) on its own: for every company connected to Xero, renews the sign-in (a Xero refresh token lapses after about 60
 * days unused) and sends what is queued, through lib/integrations/sweep.ts (its own rules are unchanged). NOT in vercel.json while
 * production is on Vercel Hobby (app/api/cron/daily runs it). Called with `Authorization: Bearer <CRON_SECRET>`; anything else gets 401.
 *
 * Equivalent to the Design session's parked bb32873; drop ours if theirs lands.
 *
 * Does nothing where Xero is not set up on the server or where the integrations tables are not in the database: both answer 200 with a
 * skipped reason, so the cron never raises a false alarm.
 */
export async function GET(request: Request) {
  if (!isCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json(await runXeroSweepPass());
  } catch (err) {
    return failed(passFailureReason(err));
  }
}

async function failed(reason: string) {
  console.error(`[cron/xero-sweep] failed: ${reason}`);
  await reportServerError({ route: ROUTE, error: new Error(`Xero sweep failed: ${reason}`), source: "cron" });
  return NextResponse.json({ error: "Sweep failed" }, { status: 500 });
}
