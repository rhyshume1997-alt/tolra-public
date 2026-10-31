import { NextResponse } from "next/server";

import { isCronRequest } from "@/lib/server/cron-auth";
import { reportServerError } from "@/lib/server/error-alert";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

const ROUTE = "/api/cron/overview-snapshot";

/** True when the database says migration 116's function does not exist (yet): PostgREST PGRST202 or Postgres 42883. */
function functionMissing(error: { code?: string } | null | undefined) {
  return error?.code === "PGRST202" || error?.code === "42883";
}

/**
 * Nightly money-owed snapshot for the owner's Overview sparkline (migration 116): capture_overview_owed() writes today's (London) owed
 * and late figures for every company, from the invoices as they are now. Called by Vercel Cron (vercel.json) with
 * `Authorization: Bearer <CRON_SECRET>`; anything else gets 401 and nothing is read or written.
 *
 * Fails closed while 116 is not applied: the function is missing, so the answer is 200 "skipped: not configured", no row is written and
 * no alert is sent (the app hides the sparkline in that state too). Any other failure is a 500 and an alert. Safe to run twice: a second
 * run the same day replaces that day's figures. Returns counts only, never an amount.
 */
export async function GET(request: Request) {
  if (!isCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const admin = createSupabaseAdminClient();
    if (!admin) return failed("no service client");
    const { data, error } = await admin.rpc("capture_overview_owed");
    if (functionMissing(error)) {
      console.log("[cron/overview-snapshot] skipped: migration 116 not applied");
      return NextResponse.json({ skipped: "not configured" });
    }
    if (error || typeof data !== "number") return failed(`capture ${error?.code ?? "bad answer"}`);
    console.log(`[cron/overview-snapshot] companies=${data}`);
    return NextResponse.json({ companies: data });
  } catch (err) {
    return failed(`threw ${err instanceof Error ? err.name : "unknown"}`);
  }
}

async function failed(reason: string) {
  console.error(`[cron/overview-snapshot] failed: ${reason}`);
  await reportServerError({ route: ROUTE, error: new Error(`Overview snapshot failed: ${reason}`), source: "cron" });
  return NextResponse.json({ error: "Snapshot failed" }, { status: 500 });
}
