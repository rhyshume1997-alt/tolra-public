import { NextResponse } from "next/server";

import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

// Answered by the live app for the outage check (.github/workflows/uptime-check.yml) and any free pinger (docs/MONITORING.md).
// Says only whether the app is up and can reach its database: no counts, no names, no versions. No sign-in needed.
// Healthy needs BOTH: the auth service answers, and PostgREST + Postgres run a query.
export const dynamic = "force-dynamic";

const TIMEOUT_MS = 5000;

async function authAnswers(url: string, key: string): Promise<boolean> {
  try {
    // The auth service's own health endpoint: needs no table and no data.
    const response = await fetch(`${url}/auth/v1/health`, { headers: { apikey: key }, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return response.ok;
  } catch {
    return false;
  }
}

async function databaseAnswers(): Promise<boolean> {
  try {
    const admin = createSupabaseAdminClient();
    if (!admin) return false;
    // booking_day_plan_ok (migration 038) is a pure IMMUTABLE function: it reads no table, so no company data is touched and the
    // answer does not depend on any table grant. A NULL plan always answers true. Only the success of the call is used; the value
    // is never returned. Executable by service_role, so no migration is needed. Not in the gateway-retry list: a 5xx fails at once.
    const { data, error } = await admin.rpc("booking_day_plan_ok", { p_plan: null, p_estimated_hours: 1 }).abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    return !error && data === true;
  } catch {
    return false;
  }
}

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, database: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  const [auth, query] = await Promise.all([authAnswers(url, key), databaseAnswers()]);
  const database = auth && query;
  return NextResponse.json({ ok: database, database }, { status: database ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
