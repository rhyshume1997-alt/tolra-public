import { NextResponse } from "next/server";

import { isCronRequest } from "@/lib/server/cron-auth";
import { reportServerError } from "@/lib/server/error-alert";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

const ROUTE = "/api/cron/ai-helper-purge";
/** Rows deleted per call, and the most calls in one run (the next run carries on). */
export const AI_PURGE_BATCH = 1000;
const MAX_BATCHES = 50;

/** True when the database says migration 133's function does not exist (yet): PostgREST PGRST202 or Postgres 42883. */
function functionMissing(error: { code?: string } | null | undefined) {
  return error?.code === "PGRST202" || error?.code === "42883";
}

/**
 * AI helper retention (E9 Q6, docs/DATA-RETENTION.md): AI helper requests, and the suggestion each holds, are kept 12 months. Every
 * night public.ai_helper_purge_requests (migration 133, service role only) deletes those made more than 12 months ago, for every company,
 * oldest first, AI_PURGE_BATCH at a time, and writes one audit row per company it deleted from (a count, no content). Run by
 * /api/cron/nightly; also callable on its own with `Authorization: Bearer <CRON_SECRET>`. Anything else gets 401 and nothing is deleted.
 *
 * Fails closed while 133 is not applied: the function is missing, so the answer is 200 "skipped: not configured" and nothing is
 * deleted or alerted. Any other failure is a 500 and an alert. Safe to run twice (a second run finds nothing). Returns counts only.
 */
export async function GET(request: Request) {
  if (!isCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const admin = createSupabaseAdminClient();
    if (!admin) return failed("no service client");
    let removed = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      const { data, error } = await admin.rpc("ai_helper_purge_requests", { p_limit: AI_PURGE_BATCH });
      if (batch === 0 && functionMissing(error)) {
        console.log("[cron/ai-helper-purge] skipped: migration 133 not applied");
        return NextResponse.json({ skipped: "not configured" });
      }
      if (error || typeof data !== "number") return failed(`purge ${error?.code ?? "bad answer"}`, removed);
      removed += data;
      if (data < AI_PURGE_BATCH) {
        console.log(`[cron/ai-helper-purge] removed=${removed}`);
        return NextResponse.json({ removed, capped: false });
      }
    }
    console.log(`[cron/ai-helper-purge] removed=${removed} capped`);
    return NextResponse.json({ removed, capped: true });
  } catch (err) {
    return failed(`threw ${err instanceof Error ? err.name : "unknown"}`);
  }
}

async function failed(reason: string, removed = 0) {
  console.error(`[cron/ai-helper-purge] failed: ${reason}`);
  await reportServerError({ route: ROUTE, error: new Error(`AI helper purge failed: ${reason}`), source: "cron" });
  return NextResponse.json({ error: "Purge failed", removed }, { status: 500 });
}
