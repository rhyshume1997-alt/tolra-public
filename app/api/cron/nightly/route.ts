import { NextResponse } from "next/server";

import { isCronRequest } from "@/lib/server/cron-auth";
import { type NightlySubtaskResult, isNightlyTaskFailure } from "@/lib/server/cron-nightly";
import { reportServerError } from "@/lib/server/error-alert";

import { GET as runAiHelperPurge } from "../ai-helper-purge/route";
import { GET as runIpPurge } from "../ip-purge/route";
import { GET as runOverviewSnapshot } from "../overview-snapshot/route";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ROUTE = "/api/cron/nightly";

/**
 * The one nightly pass (vercel.json "0 22 * * *", UTC). Production is on Vercel Hobby, which allows two crons, each at most once a day
 * (the other is /api/cron/daily), so this single route runs three jobs in turn and returns their results (counts only):
 *   1. the Overview's owed snapshot (migration 116): 22:00 UTC is still the same London day in winter and summer, which is what that
 *      route expects, so it runs first;
 *   2. the clock-in address purge (migration 078): time-insensitive, moved here from its own 03:17 slot;
 *   3. the AI helper retention purge (migration 133, E9 Q6): requests older than 12 months; skipped while 133 is not applied.
 * Each job is the existing route handler (same guard, same error alerting, fails closed), called in its own try/catch so one failing never
 * stops the others. Called with `Authorization: Bearer <CRON_SECRET>`; anything else gets 401 and nothing is run. The answer is 500 when
 * any job returns a non-2xx status, invalid JSON, an error body, or throws, after all have run.
 *
 * WITH THE PRO PLAN: replace the "nightly" entry in vercel.json's crons with the three thin routes next to this one, which stay in place:
 *   { "path": "/api/cron/overview-snapshot", "schedule": "0 22 * * *" },
 *   { "path": "/api/cron/ip-purge", "schedule": "17 3 * * *" },
 *   { "path": "/api/cron/ai-helper-purge", "schedule": "41 3 * * *" }
 * vercel.json is strict JSON (no comments), so the variant lives here. Never put a cron on Hobby that runs more than once a day: an
 * invalid vercel.json blocks every production deploy.
 */
export async function GET(request: Request) {
  if (!isCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const overviewSnapshot = await settle("overview snapshot", () => runOverviewSnapshot(request));
  const ipPurge = await settle("ip purge", () => runIpPurge(request));
  const aiHelperPurge = await settle("ai helper purge", () => runAiHelperPurge(request));
  const failed = isNightlyTaskFailure(overviewSnapshot) || isNightlyTaskFailure(ipPurge) || isNightlyTaskFailure(aiHelperPurge);
  return NextResponse.json({ overviewSnapshot: overviewSnapshot.body, ipPurge: ipPurge.body, aiHelperPurge: aiHelperPurge.body }, { status: failed ? 500 : 200 });
}

/** One job's status and JSON body. A throw (the handlers catch their own, so this is a backstop) becomes a 500 marker. Never throws. */
async function settle(label: string, job: () => Promise<Response>): Promise<NightlySubtaskResult> {
  try {
    const res = await job();
    try {
      const body = await res.json();
      return { status: res.status, body };
    } catch {
      console.error(`[cron/nightly] ${label} returned non-JSON body (status ${res.status})`);
      return { status: res.status, body: { error: `${label} returned invalid JSON` }, invalidJson: true };
    }
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    console.error(`[cron/nightly] ${label} threw: ${name}`);
    try {
      await reportServerError({ route: ROUTE, error: new Error(`Nightly cron: ${label} threw: ${name}`), source: "cron" });
    } catch {
      /* reporting must never stop the other jobs */
    }
    return { status: 500, body: { error: `${label} failed` } };
  }
}
