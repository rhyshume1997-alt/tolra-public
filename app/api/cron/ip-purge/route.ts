import { NextResponse } from "next/server";

import { isCronRequest } from "@/lib/server/cron-auth";
import { reportServerError } from "@/lib/server/error-alert";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

/** Rows deleted per call (the same batch size a clock action uses) and the most calls per company in one run. */
const BATCH = 500;
const MAX_BATCHES_PER_COMPANY = 40;

const ROUTE = "/api/cron/ip-purge";

/**
 * Daily purge of expired clock-in addresses (migration 078: kept 30 days, never in the audit log), for every company. Called by
 * Vercel Cron (vercel.json) with `Authorization: Bearer <CRON_SECRET>`; anything else gets 401 and nothing is read or deleted.
 *
 * 078 purges lazily on each clock action of a company, so this only matters for a company nobody clocks in at. site_network_ip_purge
 * works on one company, so each company is purged in batches of 500 (oldest first, rows another transaction holds are skipped).
 * Safe to run twice: it only deletes rows past the retention period, so a second run finds nothing. Returns counts only, never an
 * address, and logs counts only.
 */
export async function GET(request: Request) {
  if (!isCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    return await purgeAll();
  } catch (err) {
    return failed(`threw ${err instanceof Error ? err.name : "unknown"}`);
  }
}

async function purgeAll() {
  const admin = createSupabaseAdminClient();
  if (!admin) return failed("no service client");

  const { data: companies, error: listError } = await admin.from("organizations").select("id").order("id");
  if (listError || !companies) return failed(`company list ${listError?.code ?? "empty"}`);

  let removed = 0;
  let capped = 0;
  for (const company of companies) {
    for (let batch = 0; ; batch++) {
      if (batch === MAX_BATCHES_PER_COMPANY) {
        capped++; // the next run carries on
        break;
      }
      const { data, error } = await admin.rpc("site_network_ip_purge", { p_org: company.id, p_limit: BATCH });
      if (error || typeof data !== "number") return failed(`purge ${error?.code ?? "bad answer"}`, { companies: companies.length, removed });
      removed += data;
      if (data < BATCH) break;
    }
  }

  console.log(`[cron/ip-purge] companies=${companies.length} removed=${removed} capped=${capped}`);
  return NextResponse.json({ companies: companies.length, removed, capped });
}

async function failed(reason: string, counts: { companies?: number; removed?: number } = {}) {
  console.error(`[cron/ip-purge] failed: ${reason}`);
  await reportServerError({ route: ROUTE, error: new Error(`IP purge failed: ${reason}`), source: "cron" });
  return NextResponse.json({ error: "Purge failed", ...counts }, { status: 500 });
}
