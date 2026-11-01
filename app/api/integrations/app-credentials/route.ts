import { NextResponse } from "next/server";

import {
  APP_PROVIDERS, type AppProvider, INVITE_CALLBACK_PATH, PROVIDER_NAME, appSecretContext, defaultRedirectUri, envCredentials, last4, missingDbObject, siteOrigin,
} from "@/lib/integrations/app-credentials";
import { KEY_VERSION, encryptSecret, encryptionKey } from "@/lib/integrations/crypto";
import { isErrorResponse, jsonError, mfaRequired, readJson } from "@/lib/server/auth";
import { requirePlatformOwner } from "@/lib/server/platform";

export const dynamic = "force-dynamic";

// Platform > App connections (E2/E7, migration 107): the client id and client secret of Tolra's one app at Xero and at Microsoft,
// entered ONCE by the platform owner; each company then just clicks Connect. Platform owner only, two-step (lib/server/platform.ts:
// same origin, signed in, is_platform_admin(), aal2; the database's own functions check the owner list and aal2 again). The secret is
// encrypted here with INTEGRATIONS_ENCRYPTION_KEY before it reaches the database and is never sent back: only the client id and the
// secret's last four characters are shown. Each answer also carries the exact redirect URI(s) to register at the provider.

type Row = { provider: AppProvider; client_id: string; client_secret_last4: string; redirect_uri: string | null; updated_at: string };

function redirects(provider: AppProvider): string[] {
  const own = defaultRedirectUri(provider);
  const origin = siteOrigin();
  return [own, provider === "xero" && origin ? `${origin}${INVITE_CALLBACK_PATH}` : null].filter((v): v is string => Boolean(v));
}

function dbRefusal(error: { code?: string; message?: string; hint?: string }) {
  if (missingDbObject(error)) return jsonError("Not available until database update 107 is applied.", 503);
  if (error.code === "42501") return error.hint === "mfa_required" ? mfaRequired() : jsonError("Forbidden", 403);
  if (error.code === "22023") return jsonError(error.message ?? "Invalid request", 400);
  console.error("[platform] app credentials refused:", error.code ?? "error");
  return jsonError("Couldn't save the app details. Try again.", 500);
}

/** What is stored per provider (client id, last 4, when), whether the server's environment also has them, and the redirect URIs to register. */
export async function GET(request: Request) {
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  const { data, error } = await ctx.supabase.rpc("integration_app_credentials_list");
  const missing = Boolean(error && missingDbObject(error));
  if (error && !missing) return dbRefusal(error);
  const rows = ((missing ? [] : data) ?? []) as Row[];
  return NextResponse.json({
    db107: !missing,
    siteUrlSet: Boolean(siteOrigin()),
    providers: APP_PROVIDERS.map((provider) => {
      const row = rows.find((r) => r.provider === provider) ?? null;
      return {
        provider, name: PROVIDER_NAME[provider],
        stored: row ? { clientId: row.client_id, secretLast4: row.client_secret_last4, updatedAt: row.updated_at } : null,
        fromEnvironment: Boolean(envCredentials(provider)),
        redirectUris: redirects(provider),
      };
    }),
  }, { headers: { "cache-control": "no-store" } });
}

/** Save { provider, clientId, clientSecret? } (no clientSecret: keep the stored one). */
export async function POST(request: Request) {
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  const json = await readJson(request, 8 * 1024);
  if (!json.ok) return json.response;
  const body = (json.data && typeof json.data === "object" ? json.data : {}) as Record<string, unknown>;
  const provider = body.provider;
  if (provider !== "xero" && provider !== "microsoft") return jsonError("Choose Xero or Microsoft 365.", 400);
  const clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
  const secret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
  if (!clientId || clientId.length > 200 || /[\s\p{Cc}]/u.test(clientId)) return jsonError("Enter the client id exactly as the provider shows it.", 400);
  if (secret.length > 1000 || /[\p{Cc}]/u.test(secret)) return jsonError("Enter the client secret exactly as the provider shows it.", 400);
  const redirectUri = defaultRedirectUri(provider);
  if (!redirectUri) return jsonError("Not set up yet: the server's site address (NEXT_PUBLIC_SITE_URL) is missing.", 503);
  let secretEnc: string | null = null;
  if (secret) {
    try {
      secretEnc = encryptSecret(secret, appSecretContext(provider), encryptionKey());
    } catch {
      return jsonError("Not set up yet: the server's encryption key (INTEGRATIONS_ENCRYPTION_KEY) is missing.", 503);
    }
  }
  const { error } = await ctx.supabase.rpc("integration_app_credentials_save", {
    p_provider: provider, p_client_id: clientId, p_secret_enc: secretEnc, p_secret_last4: secret ? last4(secret) : null, p_redirect_uri: redirectUri, p_key_version: KEY_VERSION,
  });
  if (error) return dbRefusal(error);
  return NextResponse.json({ ok: true, provider, clientId, secretLast4: secret ? last4(secret) : undefined });
}

/** Remove ?provider=xero|microsoft (the environment's values, if any, apply again). */
export async function DELETE(request: Request) {
  const ctx = await requirePlatformOwner(request);
  if (isErrorResponse(ctx)) return ctx;
  const provider = new URL(request.url).searchParams.get("provider");
  if (provider !== "xero" && provider !== "microsoft") return jsonError("Choose Xero or Microsoft 365.", 400);
  const { data, error } = await ctx.supabase.rpc("integration_app_credentials_remove", { p_provider: provider });
  if (error) return dbRefusal(error);
  return NextResponse.json({ ok: true, removed: data === true });
}
