import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { ProviderError } from "@/lib/integrations/types";

// Xero OAuth 2.0 (authorisation code, with PKCE, client secret server-side only). Configuration (all of these, or Xero is off):
// XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REDIRECT_URI (exactly as registered on the Xero app: https, or http://localhost for
// development) and INTEGRATIONS_ENCRYPTION_KEY (lib/integrations/crypto.ts). Rhys sets them in Vercel; nothing here invents a value.
// One Xero developer app serves both companies; each company consents to its own Xero organisation. Errors carry a safe message only:
// never the secret, a token or a code.

export const XERO_AUTHORIZE_URL = "https://login.xero.com/identity/connect/authorize";
export const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
export const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";
/**
 * offline_access (refresh tokens), invoices and credit notes, contacts, and reading the chart of accounts and tax rates (the mapping
 * page). Xero moved apps created from March 2026 to granular scopes: check these names against the app's scopes in the Xero developer
 * portal before the demo-company test (Lot B §2.6). Nothing here asks for payments or bank access.
 */
export const XERO_SCOPES = ["offline_access", "accounting.invoices", "accounting.contacts", "accounting.settings.read"] as const;
const TIMEOUT_MS = 15_000;

export type XeroConfig = { clientId: string; clientSecret: string; redirectUri: string };

/** null when Xero isn't configured (the Integrations page then says so and Connect is refused). */
export function xeroConfig(env: Record<string, string | undefined> = process.env): XeroConfig | null {
  const clientId = env.XERO_CLIENT_ID?.trim();
  const clientSecret = env.XERO_CLIENT_SECRET?.trim();
  const redirectUri = env.XERO_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  const local = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !local) return null;
  if (!url.pathname.endsWith("/api/integrations/xero/callback")) return null;
  return { clientId, clientSecret, redirectUri };
}

/** A random state (sent to Xero), its SHA-256 (kept in the database) and a PKCE verifier with its S256 challenge. */
export function newAuthorisation() {
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  return { state, stateHash: hashState(state), verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function hashState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

export function authorizeUrl(config: XeroConfig, state: string, challenge: string): string {
  const url = new URL(XERO_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", XERO_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type TokenSet = { accessToken: string; refreshToken: string; expiresAt: Date; authEventId: string | null };

/** The refresh token was refused (revoked, unused for 60 days, or already used): the company must connect again. */
export class XeroAuthError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "XeroAuthError";
  }
}

/** The authentication_event_id claim of Xero's access token (which connections this consent made). Not a security check: the token came from Xero's token endpoint over TLS. */
export function authEventId(accessToken: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { authentication_event_id?: unknown };
    return typeof payload.authentication_event_id === "string" ? payload.authentication_event_id : null;
  } catch {
    return null;
  }
}

async function tokenCall(config: XeroConfig, body: Record<string, string>, fetchImpl: typeof fetch, now: () => number): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetchImpl(XERO_TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new ProviderError("Could not reach Xero sign-in", "unknown", 502);
  }
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; error?: unknown } | null;
  if (!res.ok || typeof json?.access_token !== "string" || typeof json?.refresh_token !== "string") {
    // Xero's error code (invalid_grant, invalid_client, ...) is safe to keep; its description can echo identifiers, so it is dropped.
    const code = typeof json?.error === "string" ? json.error.slice(0, 64) : `http_${res.status}`;
    if (code === "invalid_grant") throw new XeroAuthError("Xero refused the stored sign-in: connect again", code);
    if (res.status >= 500) throw new ProviderError("Xero sign-in is not answering", "unknown", res.status);
    throw new XeroAuthError(`Xero sign-in failed (${code})`, code);
  }
  const seconds = typeof json.expires_in === "number" && json.expires_in > 0 ? json.expires_in : 1800;
  return { accessToken: json.access_token, refreshToken: json.refresh_token, expiresAt: new Date(now() + seconds * 1000), authEventId: authEventId(json.access_token) };
}

export function exchangeCode(config: XeroConfig, code: string, verifier: string, fetchImpl: typeof fetch = fetch, now = Date.now): Promise<TokenSet> {
  return tokenCall(config, { grant_type: "authorization_code", code, redirect_uri: config.redirectUri, code_verifier: verifier }, fetchImpl, now);
}

/** Refresh tokens are single use and rotate: the caller stores the new one before it uses the new access token (lib/integrations/tokens.ts). */
export function refreshTokens(config: XeroConfig, refreshToken: string, fetchImpl: typeof fetch = fetch, now = Date.now): Promise<TokenSet> {
  return tokenCall(config, { grant_type: "refresh_token", refresh_token: refreshToken }, fetchImpl, now);
}

export type XeroConnection = { id: string; tenantId: string; tenantName: string; tenantType: string; authEventId: string | null; createdDateUtc: string | null };

export async function listConnections(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<XeroConnection[]> {
  let res: Response;
  try {
    res = await fetchImpl(XERO_CONNECTIONS_URL, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ProviderError("Could not reach Xero", "unknown", 502);
  }
  if (!res.ok) throw new ProviderError(`Xero did not list the connected organisations (HTTP ${res.status})`, res.status >= 500 ? "unknown" : "failed", res.status);
  const json = (await res.json().catch(() => [])) as unknown;
  if (!Array.isArray(json)) return [];
  return json.flatMap((c: Record<string, unknown>) => (typeof c.id === "string" && typeof c.tenantId === "string"
    ? [{ id: c.id, tenantId: c.tenantId, tenantName: typeof c.tenantName === "string" ? c.tenantName : "", tenantType: typeof c.tenantType === "string" ? c.tenantType : "",
      authEventId: typeof c.authEventId === "string" ? c.authEventId : null, createdDateUtc: typeof c.createdDateUtc === "string" ? c.createdDateUtc : null }]
    : []));
}

/**
 * The organisation this consent connected. Xero lists every organisation the Xero user has connected to this app; the ones this consent
 * made carry its authentication event id. Exactly one organisation must have been chosen: more than one is refused (the admin connects
 * again and ticks one), never guessed.
 */
export function chooseConnection(connections: XeroConnection[], eventId: string | null): { ok: true; connection: XeroConnection } | { ok: false; reason: "none" | "several"; fresh: XeroConnection[] } {
  const orgs = connections.filter((c) => c.tenantType === "ORGANISATION");
  const fresh = eventId ? orgs.filter((c) => c.authEventId === eventId) : orgs.length === 1 ? orgs : [];
  if (fresh.length === 1) return { ok: true, connection: fresh[0] };
  return { ok: false, reason: fresh.length ? "several" : "none", fresh };
}

/** How recently a connection must have been made to count as made by this consent (a Connect is at most 10 minutes, 084's state). */
export const FRESH_CONNECTION_MS = 15 * 60_000;

/**
 * Of the connections a refused Connect touched, the ones it is safe to remove again at Xero: only a connection THIS consent newly
 * created (made within the last FRESH_CONNECTION_MS) for an organisation no Tolra company uses. Xero keeps one connection per user per
 * organisation and a repeat consent updates it, so a connection that existed before, or whose organisation is linked to any Tolra company
 * (another company's live link included), is never removed: removing it would cut that company off.
 */
export function removableConnections(connections: XeroConnection[], linkedTenantIds: ReadonlySet<string>, now: number = Date.now()): XeroConnection[] {
  return connections.filter((c) => {
    if (linkedTenantIds.has(c.tenantId)) return false;
    const created = c.createdDateUtc ? Date.parse(c.createdDateUtc.endsWith("Z") || /[+-]\d\d:?\d\d$/.test(c.createdDateUtc) ? c.createdDateUtc : `${c.createdDateUtc}Z`) : NaN;
    return Number.isFinite(created) && now - created >= -60_000 && now - created <= FRESH_CONNECTION_MS;
  });
}

/** Removes this app's connection to one organisation (only that tenant; other companies' connections are untouched). Best effort. */
export async function deleteConnection(accessToken: string, connectionId: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${XERO_CONNECTIONS_URL}/${encodeURIComponent(connectionId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}
