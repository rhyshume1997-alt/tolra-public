import { NextResponse } from "next/server";

import { AI_HELPER_ROLES } from "@/lib/ai-helper/flag";
import { isErrorResponse, jsonError, requireProfile } from "@/lib/server/auth";

/**
 * The AI admin helper's state for the caller's company (migration 096 ai_helper_status, as the caller): the two switches, the monthly
 * cap and this month's spend, and whether a key is set (an admin also sees its last four characters; the key itself never leaves the
 * server). Off (404) unless AI_HELPER_ENABLED is exactly "true". Office and admin only; a support session gets nothing.
 */
export async function GET() {
  if (process.env.AI_HELPER_ENABLED !== "true") return jsonError("Not found", 404);
  const auth = await requireProfile([...AI_HELPER_ROLES]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't use the AI helper.", 403);
  const { data, error } = await auth.supabase.rpc("ai_helper_status");
  if (error) {
    console.error("[ai-helper] status refused", error.code ?? "error");
    return jsonError("The AI helper is not available right now.", 503);
  }
  return NextResponse.json(data, { headers: { "Cache-Control": "no-store" } });
}
