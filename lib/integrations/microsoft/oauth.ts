import "server-only";

import { ProviderError } from "@/lib/integrations/types";
import type { AppCredentials } from "@/lib/integrations/app-credentials";

// Microsoft 365, delegated (E7; Rhys, Fri 30 Oct): the Microsoft identity platform's authorisation code flow with PKCE and the client
// secret server-side only. A company's admin (or whoever owns the mailbox) signs in at Microsoft and consents; Tolra then sends and
// reads mail AS that mailbox. One Tolra app registration (multi-tenant: "Accounts in any organizational directory") serves every company.
// The tenant segment is "organizations" (work or school accounts only) unless MS_TENANT_ID names one directory. Scopes asked at Connect
// (C1, migration 127): offline_access (refresh tokens), Mail.Send, Mail.Read (read only: the connected user's own mailbox through /me;
// never Mail.ReadWrite, so nothing can mark, move or delete mail), User.Read. A connection made before C1 consented to Mail.Send only:
// its refresh asks for MICROSOFT_SEND_SCOPES (asking for a scope it never consented to would be refused, and sending would stop) until an
// admin reconnects to allow reading mail. Errors carry a safe message only: never the secret, a token or a code.

export const MICROSOFT_LOGIN = "https://login.microsoftonline.com";
/** What a connection made before C1 consented to (sending only). */
export const MICROSOFT_SEND_SCOPES = ["offline_access", "Mail.Send", "User.Read"] as const;
/** What Connect asks for now: sending and read-only inbox access. */
export const MICROSOFT_SCOPES = ["offline_access", "Mail.Send", "Mail.Read", "User.Read"] as const;
export type MicrosoftScopes = readonly string[];

/** true when Microsoft's granted scope list (the token response's `scope`) includes delegated Mail.Read (bare or as a Graph URI). */
export function grantsMailRead(scope: string | null | undefined): boolean {
  return (scope ?? "").split(/\s+/).some((s) => s.replace(/^https:\/\/graph\.microsoft\.com\//i, "").toLowerCase() === "mail.read");
}
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

/** scope: the scopes Microsoft granted, as it listed them (null when it didn't say). */
export type MicrosoftTokenSet = { accessToken: string; refreshToken: string; expiresAt: Date; scope: string | null };

/** Microsoft refused the grant (invalid_grant: revoked, expired, consent withdrawn) or the app's details (invalid_client). */
export class MicrosoftAuthError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "MicrosoftAuthError";
  }
}

async function tokenCall(config: MicrosoftConfig, scopes: MicrosoftScopes, body: Record<string, string>, fetchImpl: typeof fetch, now: () => number, keepRefresh?: string): Promise<MicrosoftTokenSet> {
  let res: Response;
  try {
    res = await fetchImpl(tokenEndpoint(config.tenant), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, scope: scopes.join(" "), ...body }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError("Could not reach Microsoft sign-in", "unknown", 502);
  }
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; error?: unknown } | null;
  const refresh = typeof json?.refresh_token === "string" ? json.refresh_token : keepRefresh;
  if (!res.ok || typeof json?.access_token !== "string" || !refresh) {
    // Microsoft's error code (invalid_grant, invalid_client, ...) is safe to keep; its description can echo identifiers, so it is dropped.
    const code = typeof json?.error === "string" ? json.error.slice(0, 64) : `http_${res.status}`;
    if (code === "invalid_grant") throw new MicrosoftAuthError("Microsoft refused the stored sign-in: connect again", code);
    if (res.status >= 500) throw new ProviderError("Microsoft sign-in is not answering", "unknown", res.status);
    throw new MicrosoftAuthError(`Microsoft sign-in failed (${code})`, code);
  }
  const seconds = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 3600;
  return { accessToken: json.access_token, refreshToken: refresh, expiresAt: new Date(now() + seconds * 1000), scope: typeof json.scope === "string" ? json.scope.slice(0, 2000) : null };
}

export function exchangeCode(config: MicrosoftConfig, code: string, verifier: string, fetchImpl: typeof fetch = fetch, now = Date.now): Promise<MicrosoftTokenSet> {
  return tokenCall(config, MICROSOFT_SCOPES, { grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: verifier }, fetchImpl, now);
}

/**
 * Microsoft usually returns a new refresh token (it is stored before the new access token is used); when it doesn't, the old one is kept.
 * scopes: what this connection consented to (MICROSOFT_SCOPES once it allowed reading mail, else MICROSOFT_SEND_SCOPES).
 */
export function refreshTokens(config: MicrosoftConfig, refreshToken: string, fetchImpl: typeof fetch = fetch, now = Date.now,
                              scopes: MicrosoftScopes = MICROSOFT_SEND_SCOPES): Promise<MicrosoftTokenSet> {
  return tokenCall(config, scopes, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl, now, refreshToken);
}
