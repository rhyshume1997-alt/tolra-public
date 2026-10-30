import { NextResponse } from "next/server";
import { z } from "zod";

import { readCompanyFinanceCheck } from "@/lib/ai/finance-check/flag";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

const settingsSchema = z.object({
  roundupEnabled: z.boolean(),
  rfqEnabled: z.boolean(),
  // The finance check's per-company switch (migration 106). Left out when the database has no such column yet.
  financeCheckEnabled: z.boolean().optional(),
  monthlyCapPence: z.number().int().min(0).max(100_000),
}).strict();

// "No such function" / "no such column": the database does not have the per-company finance-check switch yet (migration 106).
const MISSING_FINANCE_SWITCH = new Set(["42883", "42703", "PGRST202", "PGRST204"]);

/**
 * Admin: the company's AI switches (round-up, RFQ and, when the database has it, the finance check) and its monthly cap (ai_helper_save_settings, as the caller; audited as
 * ai_helper_settings_updated and by the settings row's own audit). Off (404) unless AI_HELPER_ENABLED is exactly "true".
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  if (process.env.AI_HELPER_ENABLED !== "true") return jsonError("Not found", 404);
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change the AI helper.", 403);

  const json = await readJson(request, 2 * 1024);
  if (!json.ok) return json.response;
  const parsed = settingsSchema.safeParse(json.data);
  if (!parsed.success) return jsonError("Invalid request", 400);
  const { data, error } = await auth.supabase.rpc("ai_helper_save_settings", {
    p_roundup: parsed.data.roundupEnabled, p_rfq: parsed.data.rfqEnabled, p_cap_pence: parsed.data.monthlyCapPence,
  });
  if (error) {
    console.error("[ai-helper] settings refused", error.code ?? "error");
    return jsonError("The AI helper settings could not be saved.", error.code === "42501" ? 403 : 503);
  }
  // The finance check second, so a refused save above never leaves it changed. If only this write fails the other settings ARE saved:
  // the answer carries them plus a warning, and says what the finance check really is (a database without the switch yet, or a
  // refusal, leaves finance_check_enabled as it was).
  let warning: string | undefined;
  if (parsed.data.financeCheckEnabled !== undefined) {
    const { error: financeError } = await auth.supabase.rpc("ai_helper_set_finance_check", { p_enabled: parsed.data.financeCheckEnabled });
    if (financeError) {
      if (!MISSING_FINANCE_SWITCH.has(financeError.code ?? "")) console.error("[ai-helper] finance check switch refused", financeError.code ?? "error");
      warning = MISSING_FINANCE_SWITCH.has(financeError.code ?? "")
        ? "Saved, but the finance check could not be changed yet: the database has not been updated for it."
        : "Saved, but the finance check switch could not be changed. Try again.";
    }
  }
  const finance = await readCompanyFinanceCheck(auth.supabase, auth.profile.organization_id);
  return NextResponse.json({ ...(data as Record<string, unknown>), finance_check_enabled: finance.enabled, finance_check_available: finance.available, ...(warning ? { warning } : {}) });
}
