import { NextResponse } from "next/server";

// Answered by the live app for the outage check (.github/workflows/uptime-check.yml) and any free pinger (docs/MONITORING.md).
// Says only whether the app is up and can reach its database: no counts, no names, no versions. No sign-in needed.
export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return NextResponse.json({ ok: false, database: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  let database = false;
  try {
    // The auth service's own health endpoint: needs no table and no data.
    const response = await fetch(`${url}/auth/v1/health`, { headers: { apikey: key }, cache: "no-store", signal: AbortSignal.timeout(5000) });
    database = response.ok;
  } catch {
    database = false;
  }
  return NextResponse.json({ ok: database, database }, { status: database ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
