import { NextResponse } from "next/server";
import { z } from "zod";
import { TOLRA_AI_KEY_CONTEXT } from "@/lib/ai-helper/tolra-key-context";
import { encryptSecret } from "@/lib/integrations/crypto";
import { isErrorResponse, jsonError, readJson } from "@/lib/server/auth";
import { requirePlatformOwner } from "@/lib/server/platform";

const schema = z.object({ enabled: z.boolean(), key: z.string().trim().regex(/^sk-ant-[A-Za-z0-9_-]{20,200}$/).optional() }).strict();
const headers = { "Cache-Control": "no-store" };
const visibleStatus = z.object({ enabled: z.boolean(), key_set: z.boolean() });

function statusResponse(data: unknown) {
  // Whitelist even the database's answer: no saved key/ciphertext can escape if
  // extra fields are added to an RPC later.
  const parsed = visibleStatus.safeParse(data);
  return parsed.success ? NextResponse.json(parsed.data, { headers }) : jsonError("Could not read Tolra AI settings.", 503);
}

// requirePlatformOwner includes same-origin, owner membership and MFA checks.
export async function GET(request: Request) {
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  const { data, error } = await ctx.admin.rpc("ai_helper_tolra_owner_status");
  if (error) return jsonError("Tolra AI is not set up on this server yet.", 503);
  return statusResponse(data);
}

export async function POST(request: Request) {
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  const json = await readJson(request, 1024);
  if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.data);
  if (!parsed.success) return jsonError("Choose on or off and enter a valid Anthropic key if replacing it.", 400);
  let encrypted: string | null = null;
  if (parsed.data.key) {
    try { encrypted = encryptSecret(parsed.data.key, TOLRA_AI_KEY_CONTEXT); }
    catch { return jsonError("The server cannot store keys securely yet. Nothing was saved.", 503); }
  }
  const { data, error } = await ctx.admin.rpc("ai_helper_tolra_configure", { p_enabled: parsed.data.enabled, p_key_enc: encrypted, p_owner: ctx.user.id });
  if (error) return jsonError("Could not save Tolra AI. To switch it on, add a provider key first.", error.code === "22023" ? 400 : 503);
  // The RPC returns only enabled/key_set; no saved key or part of a key.
  return statusResponse(data);
}
