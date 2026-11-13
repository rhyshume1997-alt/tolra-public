import "server-only";
// BOUNDARY: QuickBooks-specific accounting logic only (config incl. QUICKBOOKS_ENVIRONMENT, authorise URL, Basic-auth token request, CompanyInfo/realmId identity, invoice query).
// Inputs: env map, CloudConfig, OAuth state, bearer token, realm/tenant id, invoice number, and the shared `call` JSON fetcher from cloud-adapters.
// Outputs: values in the exact shapes cloud-adapters.ts returned before the split.
// MUST NOT CHANGE: URLs, scope, headers, error classification, redirect-path checks. Shared helpers stay in cloud-adapters.ts.
import { AccountingError, moneyPence, type CloudConfig, type CloudTokens } from "@/lib/accounting/cloud-adapters";
import type { BalanceEvidence } from "@/lib/accounting/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the untyped json() result in cloud-adapters.ts
export type JsonCall = (fetchImpl: typeof fetch, url: string, init: RequestInit) => Promise<any>;

export const QUICKBOOKS_SETTINGS = { authorize: "https://appcenter.intuit.com/connect/oauth2", token: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", revoke: "https://developer.api.intuit.com/v2/oauth2/tokens/revoke", scope: "com.intuit.quickbooks.accounting", prefix: "QUICKBOOKS" } as const;

export function quickbooksConfig(env: Record<string, string | undefined>): CloudConfig | null {
  const prefix = QUICKBOOKS_SETTINGS.prefix;
  const clientId = env[`${prefix}_CLIENT_ID`]?.trim();
  const clientSecret = env[`${prefix}_CLIENT_SECRET`]?.trim();
  const redirectUri = env[`${prefix}_REDIRECT_URI`]?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  try {
    const url = new URL(redirectUri);
    if (url.username || url.password || url.search || url.hash || url.pathname !== `/api/accounting/quickbooks/callback`) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) return null;
  } catch { return null; }
  // QBO stays on its free developer sandbox until an operator explicitly configures production.
  return { clientId, clientSecret, redirectUri, sandbox: env.QUICKBOOKS_ENVIRONMENT !== "production" };
}

export function quickbooksAuthorize(config: CloudConfig, state: string) {
  const url = new URL(QUICKBOOKS_SETTINGS.authorize);
  for (const [key, value] of Object.entries({ response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri, scope: QUICKBOOKS_SETTINGS.scope, state })) url.searchParams.set(key, value);
  // Sage and QBO use their documented confidential-client code flow (no invented PKCE parameters).
  return url.toString();
}

export async function quickbooksTokens(_call: JsonCall, config: CloudConfig, grant: { code: string; verifier: string } | { refreshToken: string }, fetchImpl: typeof fetch): Promise<CloudTokens> {
  const body = new URLSearchParams("code" in grant ? { grant_type: "authorization_code", code: grant.code, redirect_uri: config.redirectUri } : { grant_type: "refresh_token", refresh_token: grant.refreshToken });
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/x-www-form-urlencoded" };
  headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  let response: Response;
  try { response = await fetchImpl(QUICKBOOKS_SETTINGS.token, { method: "POST", headers, body, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
  catch { throw new AccountingError("unavailable"); }
  if (!response.ok) {
    // Only the OAuth `error` code is read: invalid_grant means the refresh token is spent (connect again); invalid_client, 5xx and the rest are not the company's fault.
    let code: unknown = null;
    try { code = ((await response.json()) as { error?: unknown } | null)?.error; } catch { code = null; }
    throw new AccountingError(code === "invalid_grant" ? "refused" : "unavailable");
  }
  let result: { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  try { result = await response.json(); } catch { throw new AccountingError("invalid"); }
  const seconds = Number(result?.expires_in);
  if (typeof result?.access_token !== "string" || !result.access_token || typeof result.refresh_token !== "string" || !result.refresh_token || !Number.isFinite(seconds) || seconds <= 0) throw new AccountingError("invalid");
  return { accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt: new Date(Date.now() + seconds * 1000) };
}

/** Revokes a refresh token at Intuit. True only on HTTP 200; the response body is never read and nothing is thrown. */
export async function quickbooksRevoke(config: CloudConfig, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(QUICKBOOKS_SETTINGS.revoke, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", authorization: `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}` },
      body: JSON.stringify({ token: refreshToken }), redirect: "error", signal: AbortSignal.timeout(15_000),
    });
    return response.status === 200;
  } catch { return false; }
}

const qboBase = (config: CloudConfig) => `https://${config.sandbox ? "sandbox-" : ""}quickbooks.api.intuit.com/v3/company/`;

export async function quickbooksTenant(call: JsonCall, config: CloudConfig, token: string, realm: string | null, fetchImpl: typeof fetch): Promise<{ id: string; name: string }> {
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  if (!realm || !/^\d{1,30}$/.test(realm)) throw new AccountingError("invalid");
  const result = await call(fetchImpl, `${qboBase(config)}${realm}/companyinfo/${realm}`, { headers });
  const name: unknown = result?.CompanyInfo?.CompanyName;
  if (result?.Fault || typeof name !== "string" || !name.trim()) throw new AccountingError("invalid");
  return { id: realm, name: name.trim() };
}

export async function quickbooksBalance(call: JsonCall, config: CloudConfig, token: string, tenant: string, number: string, fetchImpl: typeof fetch): Promise<BalanceEvidence | null> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
  if (!/^\d{1,30}$/.test(tenant)) throw new AccountingError("invalid");
  const literal = number.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const url = `${qboBase(config)}${tenant}/query?query=${encodeURIComponent(`select * from Invoice where DocNumber = '${literal}'`)}`;
  const result = await call(fetchImpl, url, { method: "GET", headers });
  const raw: unknown = result.QueryResponse?.Invoice;
  if (raw === undefined) return null;
  if (!Array.isArray(raw)) throw new AccountingError("invalid");
  if (raw.length >= 100) throw new AccountingError("ambiguous");
  const rows = raw.filter((r) => r.DocNumber === number);
  if (rows.length > 1) throw new AccountingError("ambiguous");
  if (!rows.length) return null;
  const row = rows[0];
  if (row.CurrencyRef?.value !== "GBP") throw new AccountingError("invalid");
  const totalPence = moneyPence(row.TotalAmt);
  const outstandingPence = moneyPence(row.Balance);
  if (totalPence < 0 || outstandingPence < 0 || outstandingPence > totalPence) throw new AccountingError("invalid");
  return { invoiceNumber: number, totalPence, outstandingPence, currency: "GBP", reviewOnly: true };
}
