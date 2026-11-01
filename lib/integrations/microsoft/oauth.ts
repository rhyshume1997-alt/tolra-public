import "server-only";

import { ProviderError } from "@/lib/integrations/types";
import type { AppCredentials } from "@/lib/integrations/app-credentials";

// Microsoft 365, delegated (E7; Rhys, Fri 30 Oct): the Microsoft identity platform's authorisation code flow with PKCE and the client
// secret server-side only. A company's admin (or whoever owns the mailbox) signs in at Microsoft and consents; Tolra then sends and
// reads mail AS that mailbox. One Tolra app registration (multi-tenant: "Accounts in any organizational directory") serves every company.
// The tenant segment is "organizations" (work or school accounts only) unless MS_TENANT_ID names one directory. Scopes: offline_access
// (refresh tokens), Mail.Send, User.Read (nothing reads mail: Tolra only sends). Errors carry a safe message only: never the secret, a token or a code.

export const MICROSOFT_LOGIN = "https://login.microsoftonline.com";
export const MICROSOFT_SCOPES = ["offline_access", "Mail.Send", "User.Read"] as const;
/**
 * EVERY permission on Tolra's Microsoft app registration (Microsoft Graph, Delegated), and nothing else: the sign-in's MICROSOFT_SCOPES
 * plus Mail.Read. The administrator's approval link uses Graph's `.default` scope, which approves every permission the registration
 * lists, so this is what the approval page shows in plain words and what Platform > App connections says to register (runbook 29).
 */
export const MICROSOFT_REGISTRATION_SCOPES = ["offline_access", "User.Read", "Mail.Send", "Mail.Read"] as const;
const TIMEOUT_MS = 15_000;

export type MicrosoftConfig = { clientId: string; clientSecret: string; redirectUri: string; tenant: string };

/** The directory segment: MS_TENANT_ID when it is a GUID or a domain, else "organizations". */
export function microsoftTenant(env: Record<string, string | undefined> = process.env): string {
  const t = env.MS_TENANT_ID?.trim();
  if (t && (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t) || /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(t) || t === "common" || t === "organizations")) return t;
  return "organizations";
}

export function microsoftConfigFrom(creds: AppCredentials, env: Record<string, string | undefined> = process.env): MicrosoftConfig {
  return { clientId: creds.clientId, clientSecret: creds.clientSecret, redirectUri: creds.redirectUri, tenant: microsoftTenant(env) };
}

export const authorizeEndpoint = (tenant: string) => `${MICROSOFT_LOGIN}/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`;
export const tokenEndpoint = (tenant: string) => `${MICROSOFT_LOGIN}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;

export function authorizeUrl(config: MicrosoftConfig, state: string, challenge: string): string {
  const url = new URL(authorizeEndpoint(config.tenant));
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", MICROSOFT_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export type MicrosoftTokenSet = { accessToken: string; refreshToken: string; expiresAt: Date };

/** Microsoft refused the grant (invalid_grant: revoked, expired, consent withdrawn) or the app's details (invalid_client). */
export class MicrosoftAuthError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "MicrosoftAuthError";
  }
}

async function tokenCall(config: MicrosoftConfig, body: Record<string, string>, fetchImpl: typeof fetch, now: () => number, keepRefresh?: string): Promise<MicrosoftTokenSet> {
  let res: Response;
  try {
    res = await fetchImpl(tokenEndpoint(config.tenant), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, scope: MICROSOFT_SCOPES.join(" "), ...body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError("Could not reach Microsoft sign-in", "unknown", 502);
  }
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown } | null;
  const refresh = typeof json?.refresh_token === "string" ? json.refresh_token : keepRefresh;
  if (!res.ok || typeof json?.access_token !== "string" || !refresh) {
    // Microsoft's error code (invalid_grant, invalid_client, ...) is safe to keep; its description can echo identifiers, so it is dropped.
    const code = typeof json?.error === "string" ? json.error.slice(0, 64) : `http_${res.status}`;
    if (code === "invalid_grant") throw new MicrosoftAuthError("Microsoft refused the stored sign-in: connect again", code);
    if (res.status >= 500) throw new ProviderError("Microsoft sign-in is not answering", "unknown", res.status);
    throw new MicrosoftAuthError(`Microsoft sign-in failed (${code})`, code);
  }
  const seconds = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  return { accessToken: json.access_token, refreshToken: refresh, expiresAt: new Date(now() + seconds * 1000) };
}

export function exchangeCode(config: MicrosoftConfig, code: string, verifier: string, fetchImpl: typeof fetch = fetch, now = Date.now): Promise<MicrosoftTokenSet> {
  return tokenCall(config, { grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: verifier }, fetchImpl, now);
}

/** Microsoft usually returns a new refresh token (it is stored before the new access token is used); when it doesn't, the old one is kept. */
export function refreshTokens(config: MicrosoftConfig, refreshToken: string, fetchImpl: typeof fetch = fetch, now = Date.now): Promise<MicrosoftTokenSet> {
  return tokenCall(config, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl, now, refreshToken);
}
