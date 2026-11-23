import { NextResponse } from "next/server";

import { parseOverview, platformCompaniesEnabled } from "@/lib/platform/companies";
import { isErrorResponse, jsonError } from "@/lib/server/auth";
import { requirePlatformOwner } from "@/lib/server/platform";

// The platform owner's Companies panel reads every company with its counts: GET. OFF unless PLATFORM_COMPANIES_ENABLED is exactly "true".
// Order: requirePlatformOwner (same origin, signed in, is_platform_admin(), aal2; the owner guard is first in every route) -> the switch (an
// off switch answers 404 before any database call, so only a platform owner can ever see that the panel exists) -> ONE call to release 164's
// platform_company_overview() with the owner's OWN session, which checks owner and the second step again in the database. Counts only: no
// company data, no names of people, no database message is returned. The service role is never used here.

export async function GET(request: Request) {
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  if (!platformCompaniesEnabled()) return jsonError("Not found", 404);
  const { data, error } = await ctx.supabase.rpc("platform_company_overview");
  if (error) {
    console.error("[platform] company overview refused", error.code ?? "no-code", error.hint ?? "");
    return jsonError(error.code === "42501" ? "Forbidden" : "Couldn't load the companies. Try again.", error.code === "42501" ? 403 : 500);
  }
  return NextResponse.json({ companies: parseOverview(data) }, { headers: { "Cache-Control": "no-store" } });
}
