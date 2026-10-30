import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { IntegrationCryptoError, decryptSecret, encryptionKey } from "@/lib/integrations/crypto";

// App-level credentials for each provider (migration 107, E2/E7; Rhys, Fri 30 Oct): the client id and client secret of Tolra's ONE
// registered app at Xero and at Microsoft, entered once by the platform owner (Platform > App connections) and kept by the server in
// public.integration_app_credentials (the secret encrypted with INTEGRATIONS_ENCRYPTION_KEY; the table has no API grant). Each company
// then just clicks Connect. Order: the stored row, else the environment (XERO_CLIENT_ID / XERO_CLIENT_SECRET / XERO_REDIRECT_URI;
// MS_CLIENT_ID / MS_CLIENT_SECRET with the redirect derived from NEXT_PUBLIC_SITE_URL), else nothing ("Not set up yet"). Before 107 is
// applied the table is missing and the environment is used, exactly as before. The secret never leaves the server.

export type AppProvider = "xero" | "microsoft";
export const APP_PROVIDERS: readonly AppProvider[] = ["xero", "microsoft"];
export const PROVIDER_NAME: Record<AppProvider, string> = { xero: "Xero", microsoft: "Microsoft 365" };

/** The callback each provider sends the admin back to (registered at the provider exactly as `${NEXT_PUBLIC_SITE_URL}${path}`). */
export const CALLBACK_PATH: Record<AppProvider, string> = {
  xero: "/api/integrations/xero/callback",
  microsoft: "/api/integrations/microsoft/callback",
};
/** The accountant's link comes back here (no Tolra session): registered at Xero as a second redirect URI. */
export const INVITE_CALLBACK_PATH = "/api/integrations/invite/callback";

export type AppCredentials = { provider: AppProvider; clientId: string; clientSecret: string; redirectUri: string; source: "stored" | "env" };
type Env = Record<string, string | undefined>;

/** https, or http on localhost / 127.0.0.1 for development. */
function allowedOrigin(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
}

/** NEXT_PUBLIC_SITE_URL as an origin (no path, no trailing slash), or null when unset or not https / localhost. */
export function siteOrigin(env: Env = process.env): string | null {
  const raw = env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return allowedOrigin(url) ? url.origin : null;
  } catch {
    return null;
  }
}

/** The redirect URI to register at the provider (and the one Tolra sends): `${NEXT_PUBLIC_SITE_URL}/api/integrations/<provider>/callback`. */
export function defaultRedirectUri(provider: AppProvider, env: Env = process.env): string | null {
  const origin = siteOrigin(env);
  return origin ? `${origin}${CALLBACK_PATH[provider]}` : null;
}

/** A redirect URI Tolra will use: https (or localhost) and ending in the provider's own callback path. */
export function validRedirectUri(provider: AppProvider, value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!allowedOrigin(url) || url.pathname !== CALLBACK_PATH[provider] || url.search || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The accountant's callback on the same origin as the provider's own redirect URI. */
export function inviteRedirectUri(redirectUri: string): string {
  return `${new URL(redirectUri).origin}${INVITE_CALLBACK_PATH}`;
}

/** The environment's credentials (the fallback). */
export function envCredentials(provider: AppProvider, env: Env = process.env): AppCredentials | null {
  const clientId = (provider === "xero" ? env.XERO_CLIENT_ID : env.MS_CLIENT_ID)?.trim();
  const clientSecret = (provider === "xero" ? env.XERO_CLIENT_SECRET : env.MS_CLIENT_SECRET)?.trim();
  const redirectUri = validRedirectUri(provider, provider === "xero" ? (env.XERO_REDIRECT_URI?.trim() || defaultRedirectUri("xero", env)) : defaultRedirectUri("microsoft", env));
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { provider, clientId, clientSecret, redirectUri, source: "env" };
}

/**
 * The database doesn't have the table or function (yet): the same codes lib/db-features.ts lists (that module is the browser's; it pulls in
 * the browser client, so the server keeps its own copy of the rule).
 */
export function missingDbObject(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  if (error.code && ["PGRST202", "PGRST204", "PGRST205", "42883", "42P01", "42703"].includes(error.code)) return true;
  return /could not find the .* in the schema cache|(function|relation|column) .* does not exist/i.test(error.message ?? "");
}

type StoredRow = { provider: string; client_id: string; client_secret_enc: string; redirect_uri: string | null };

/** The AAD context the client secret is encrypted under: platform level, per provider. */
export const appSecretContext = (provider: AppProvider) => ({ organizationId: "platform", provider, purpose: "client_secret" as const });

/**
 * The stored row: { row } (null when none), or { missing: true } when the database doesn't have 107 yet, or { error: true } when the
 * read failed for another reason (the environment is then used, and the failure logged by code only).
 */
export async function readStoredRow(service: SupabaseClient, provider: AppProvider): Promise<{ row: StoredRow | null } | { missing: true } | { error: true }> {
  const { data, error } = await service.from("integration_app_credentials").select("provider, client_id, client_secret_enc, redirect_uri").eq("provider", provider).maybeSingle();
  if (error) {
    if (missingDbObject(error)) return { missing: true };
    console.error("[integrations] app credentials read failed:", error.code ?? "error");
    return { error: true };
  }
  return { row: (data as StoredRow | null) ?? null };
}

export type AppCredentialDeps = { service: SupabaseClient | null; env?: Env; key?: Buffer };

/** The app's credentials for `provider`: the platform owner's stored row if present, else the environment, else null. Server only. */
export async function getAppCredentials(provider: AppProvider, deps: AppCredentialDeps): Promise<AppCredentials | null> {
  const env = deps.env ?? process.env;
  if (deps.service) {
    const stored = await readStoredRow(deps.service, provider);
    if ("row" in stored && stored.row) {
      const redirectUri = validRedirectUri(provider, stored.row.redirect_uri) ?? defaultRedirectUri(provider, env);
      try {
        const clientSecret = decryptSecret(stored.row.client_secret_enc, appSecretContext(provider), deps.key ?? encryptionKey(env));
        if (redirectUri) return { provider, clientId: stored.row.client_id, clientSecret, redirectUri, source: "stored" };
        console.error("[integrations] app credentials stored but NEXT_PUBLIC_SITE_URL is not set: no redirect URI");
      } catch (err) {
        // The key changed or is missing: the stored secret can't be used. Say so (no value) and fall back to the environment.
        console.error("[integrations] stored app credentials can't be read:", err instanceof IntegrationCryptoError ? err.code : "error");
      }
    }
  }
  return envCredentials(provider, env);
}

/** "Does the database have 107?" for the server: true / false, or null when it can't tell (a read error that isn't "missing"). */
export async function databaseHas107(service: SupabaseClient | null): Promise<boolean | null> {
  if (!service) return null;
  const { error } = await service.from("integration_connect_invites").select("id").limit(1);
  if (!error) return true;
  return missingDbObject(error) ? false : null;
}

/** The last four characters of a secret, as the owner's screen shows them (never more). */
export function last4(secret: string): string {
  const s = secret.trim().replace(/[\s\p{Cc}]/gu, "*");
  return s.length >= 4 ? s.slice(-4) : s.padStart(4, "*");
}
