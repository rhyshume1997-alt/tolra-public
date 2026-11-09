import { NextResponse } from "next/server";
import { z } from "zod";
import { adminMfaRequired } from "@/lib/mfa-policy";
import { requireRecentAal2 } from "@/lib/server/admin-users";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  if (process.env.AI_HELPER_ENABLED !== "true") return jsonError("Not found", 404);
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change the AI helper.", 403);
  const json = await readJson(request, 1024);
  if (!json.ok) return json.response;
  const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(json.data);
  if (!parsed.success) return jsonError("Choose on or off.", 400);
  // F1: turning Tolra-provided AI ON needs a recent authenticator code (G1). Turning it off never does (the way out stays open).
  if (parsed.data.enabled && adminMfaRequired()) {
    const refused = await requireRecentAal2(auth, "turn on AI");
    if (refused) return refused;
  }
  const { error } = await auth.supabase.rpc("ai_helper_set_tolra_mode", { p_enabled: parsed.data.enabled });
  if (error) return jsonError("Tolra AI could not be changed. It may not be available yet.", error.code === "42501" ? 403 : 503);
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
