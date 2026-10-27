import { NextResponse } from "next/server";
import { z } from "zod";

import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

const settingsSchema = z.object({
  roundupEnabled: z.boolean(),
  rfqEnabled: z.boolean(),
  monthlyCapPence: z.number().int().min(0).max(100_000),
}).strict();

/**
 * Admin: the company's two AI helper switches and its monthly cap (ai_helper_save_settings, as the caller; audited as
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
  return NextResponse.json(data);
}
