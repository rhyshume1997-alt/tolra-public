import { NextResponse } from "next/server";
import { z } from "zod";

import { IntegrationCryptoError, encryptSecret } from "@/lib/integrations/crypto";
import { forbiddenOrigin, isErrorResponse, jsonError, readJson, requireProfile, sameOrigin } from "@/lib/server/auth";

// An Anthropic API key's shape. Checked for form only: the first request tells whether the service accepts it.
const keySchema = z.object({ key: z.string().trim().regex(/^sk-ant-[A-Za-z0-9_-]{20,200}$/) }).strict();

/**
 * Admin: the company's own Anthropic API key (one account per company, owned by that business). POST stores it encrypted by THIS
 * server (lib/integrations/crypto.ts, INTEGRATIONS_ENCRYPTION_KEY; bound to the company, so it decrypts for no other); DELETE removes
 * it. The key is never logged, never stored in plain text and never sent back: the answer is the status (set, last four characters).
 * Off (404) unless AI_HELPER_ENABLED is exactly "true".
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  if (process.env.AI_HELPER_ENABLED !== "true") return jsonError("Not found", 404);
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change the AI helper.", 403);

  const json = await readJson(request, 1024);
  if (!json.ok) return json.response;
  const parsed = keySchema.safeParse(json.data);
  if (!parsed.success) return jsonError("That doesn't look like an Anthropic API key (it starts with sk-ant-).", 400);
  const key = parsed.data.key;
  let stored: string;
  try {
    stored = encryptSecret(key, { organizationId: auth.profile.organization_id, provider: "anthropic", purpose: "api_key" });
  } catch (err) {
    console.error("[ai-helper] key not stored", err instanceof IntegrationCryptoError ? err.code : "error");
    return jsonError("This server has no encryption key set (INTEGRATIONS_ENCRYPTION_KEY), so the key was not stored.", 503);
  }
  const { data, error } = await auth.supabase.rpc("ai_helper_set_key", { p_key_enc: stored, p_last4: key.slice(-4) });
  if (error) {
    console.error("[ai-helper] key refused", error.code ?? "error");
    return jsonError("The key could not be saved.", error.code === "42501" ? 403 : 503);
  }
  return NextResponse.json(data);
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  if (process.env.AI_HELPER_ENABLED !== "true") return jsonError("Not found", 404);
  const auth = await requireProfile(["admin"]);
  if (isErrorResponse(auth)) return auth;
  if (auth.session?.support) return jsonError("Support access can't change the AI helper.", 403);
  const { data, error } = await auth.supabase.rpc("ai_helper_set_key", { p_key_enc: null, p_last4: null });
  if (error) {
    console.error("[ai-helper] key removal refused", error.code ?? "error");
    return jsonError("The key could not be removed.", error.code === "42501" ? 403 : 503);
  }
  return NextResponse.json(data);
}
