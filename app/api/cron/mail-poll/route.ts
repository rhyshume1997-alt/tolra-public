import { NextResponse } from "next/server";

import { microsoftReady } from "@/lib/integrations/microsoft/client";
import { runMailboxPollPass } from "@/lib/integrations/microsoft/inbox";
import { isCronRequest } from "@/lib/server/cron-auth";
import { passFailureReason } from "@/lib/server/cron-pass";
import { reportServerError } from "@/lib/server/error-alert";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ROUTE = "/api/cron/mail-poll";
/** New companies are not started after this long, so the pass fits in maxDuration. */
const BUDGET_MS = 40_000;

/**
 * Reads every company's own inbox through its delegated Microsoft 365 connection (C1, migration 127): one company at a time, each with
 * only its own sign-in, rows and cursor (lib/integrations/microsoft/inbox.ts). GET only at Microsoft. Counts only in the answer.
 * NOT in vercel.json: production is on Vercel Hobby (two daily crons, both used); Rhys decides when and how often it runs. Called with
 * `Authorization: Bearer <CRON_SECRET>`; anything else gets 401. Not set up on the server, or 127 not applied: 200 with a skipped reason.
 */
export async function GET(request: Request) {
  if (!isCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const service = createSupabaseAdminClient();
    const ready = service ? await microsoftReady(service) : null;
    if (!service || !ready) return NextResponse.json({ skipped: "Microsoft 365 is not set up on this server" });
    return NextResponse.json(await runMailboxPollPass({ service, ready, budgetMs: BUDGET_MS }));
  } catch (err) {
    const reason = passFailureReason(err);
    console.error(`[cron/mail-poll] failed: ${reason}`);
    await reportServerError({ route: ROUTE, error: new Error(`Mailbox pass failed: ${reason}`), source: "cron" }).catch(() => undefined);
    return NextResponse.json({ error: "Mailbox pass failed" }, { status: 500 });
  }
}
