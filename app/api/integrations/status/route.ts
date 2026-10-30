import { NextResponse } from "next/server";

import { databaseHas107, getAppCredentials, xeroEnvProblem } from "@/lib/integrations/app-credentials";
import { CONNECT_ROLES } from "@/lib/integrations/xero/policy";
import { isErrorResponse, requireProfile } from "@/lib/server/auth";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

export const dynamic = "force-dynamic";

/**
 * Admin > Integrations (107): what the page may offer. For each provider whether the app's details exist (the platform owner's stored
 * ones, or the server's environment: never a value), and whether the database has 107 (the Microsoft 365 card and the accountant's link
 * need it; Xero works without it, as before). Admin only, two-step as every admin route.
 */
export async function GET() {
  const auth = await requireProfile([...CONNECT_ROLES]);
  if (isErrorResponse(auth)) return auth;
  const service = createSupabaseAdminClient();
  const has107 = await databaseHas107(service);
  const [xero, microsoft] = await Promise.all([
    getAppCredentials("xero", { service }).catch(() => null),
    has107 === false ? Promise.resolve(null) : getAppCredentials("microsoft", { service }).catch(() => null),
  ]);
  return NextResponse.json({
    db107: has107 !== false,
    xero: xero ? { configured: true } : { configured: false, problem: xeroEnvProblem() },
    microsoft: { configured: Boolean(microsoft) },
  }, { headers: { "cache-control": "no-store" } });
}
