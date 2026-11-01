import { NextResponse } from "next/server";

import { readCompanyFinanceCheck } from "@/lib/ai/finance-check/flag";
import { readCompanyAssistant } from "@/lib/ai-helper/assistant";
import { AI_HELPER_ROLES } from "@/lib/ai-helper/flag";
import { isErrorResponse, jsonError, requireProfile } from "@/lib/server/auth";

/**
 * The AI admin helper's state for the caller's company (migration 101 ai_helper_status, as the caller): the two switches, the monthly
 * cap and this month's spend, and whether a key is set (an admin also sees its last four characters; the key itself never leaves the
 * server). Also the company's finance-check switch (finance_check_enabled, migration 106) and whether the database can hold it at all
 * (`finance_check_available`; false until 106 is applied, when the AI section leaves that feature out). Likewise the assistant (G3,
 * migration 133): `assistant_enabled`, and `assistant_available` only when this server has AI_ASSISTANT_ENABLED exactly "true" and the
 * database has the switch. Off (404) unless AI_HELPER_ENABLED is exactly "true". Office and admin only; a support session gets nothing.
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
  const finance = await readCompanyFinanceCheck(auth.supabase, auth.profile.organization_id);
  const assistant = process.env.AI_ASSISTANT_ENABLED === "true" ? await readCompanyAssistant(auth.supabase, auth.profile.organization_id) : { available: false, enabled: false };
  return NextResponse.json({ ...(data as Record<string, unknown>), finance_check_enabled: finance.enabled, finance_check_available: finance.available,
    assistant_enabled: assistant.enabled, assistant_available: assistant.available }, { headers: { "Cache-Control": "no-store" } });
}
