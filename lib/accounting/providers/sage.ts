import "server-only";
// BOUNDARY: Sage-specific accounting logic only (config/env, authorise URL, token request, /businesses identity, invoice check).
// Inputs: env map, CloudConfig, OAuth state, bearer token, tenant id, invoice number, and the shared `call` JSON fetcher from cloud-adapters.
// Outputs: values in the exact shapes cloud-adapters.ts returned before the split.
// Scope is readonly, filter is apiv3.1; business name comes from documented `displayed_as` (legacy `name` fallback).
// MUST NOT CHANGE: URLs, headers, error classification, redirect-path checks. Shared helpers stay in cloud-adapters.ts.
import { AccountingError, moneyPence, type CloudConfig, type CloudTokens } from "@/lib/accounting/cloud-adapters";
import type { BalanceEvidence } from "@/lib/accounting/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the untyped json() result in cloud-adapters.ts
export type JsonCall = (fetchImpl: typeof fetch, url: string, init: RequestInit) => Promise<any>;

export const SAGE_SETTINGS = { authorize: "https://www.sageone.com/oauth2/auth/central", token: "https://oauth.accounting.sage.com/token", scope: "readonly", prefix: "SAGE" } as const;

export function sageConfig(env: Record<string, string | undefined>): CloudConfig | null {
  const prefix = SAGE_SETTINGS.prefix;
  const clientId = env[`${prefix}_CLIENT_ID`]?.trim();
  const clientSecret = env[`${prefix}_CLIENT_SECRET`]?.trim();
  const redirectUri = env[`${prefix}_REDIRECT_URI`]?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  try {
    const url = new URL(redirectUri);
    if (url.username || url.password || url.search || url.hash || url.pathname !== `/api/accounting/sage/callback`) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) return null;
  } catch { return null; }
  return { clientId, clientSecret, redirectUri, sandbox: false };
}

export function sageAuthorize(config: CloudConfig, state: string) {
  const url = new URL(SAGE_SETTINGS.authorize);
  for (const [key, value] of Object.entries({ response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri, scope: SAGE_SETTINGS.scope, filter: "apiv3.1", state })) url.searchParams.set(key, value);
  // Sage v3.1 documented confidential-client code flow: readonly scope, filter=apiv3.1 (no PKCE yet).
  return url.toString();
}

export async function sageTokens(call: JsonCall, config: CloudConfig, grant: { code: string; verifier: string } | { refreshToken: string }, fetchImpl: typeof fetch): Promise<CloudTokens> {
  const body = new URLSearchParams("code" in grant ? { grant_type: "authorization_code", code: grant.code, redirect_uri: config.redirectUri } : { grant_type: "refresh_token", refresh_token: grant.refreshToken });
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/x-www-form-urlencoded" };
  body.set("client_id", config.clientId); body.set("client_secret", config.clientSecret);
  const result = await call(fetchImpl, SAGE_SETTINGS.token, { method: "POST", headers, body });
  const seconds = Number(result.expires_in);
  if (typeof result.access_token !== "string" || !result.access_token || typeof result.refresh_token !== "string" || !result.refresh_token || !Number.isFinite(seconds) || seconds <= 0) throw new AccountingError("invalid");
  return { accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt: new Date(Date.now() + seconds * 1000) };
}

export async function sageTenant(call: JsonCall, token: string, fetchImpl: typeof fetch): Promise<{ id: string; name: string }> {
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  const result = await call(fetchImpl, "https://api.accounting.sage.com/v3.1/businesses", { headers });
  if (!Array.isArray(result.$items) || result.$next || result.$items.length !== 1) throw new AccountingError("ambiguous");
  const business = result.$items[0];
  const rawName = business?.displayed_as !== undefined ? business.displayed_as : business?.name;
  if (typeof business?.id !== "string" || !business.id.trim() || typeof rawName !== "string" || !rawName.trim()) throw new AccountingError("invalid");
  return { id: business.id.trim(), name: rawName.trim() };
}

export async function sageBalance(call: JsonCall, token: string, tenant: string, number: string, fetchImpl: typeof fetch): Promise<BalanceEvidence | null> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
  headers["X-Business"] = tenant;
  const url = `https://api.accounting.sage.com/v3.1/sales_invoices?search=${encodeURIComponent(number)}&attributes=invoice_number,total_amount,outstanding_amount,currency`;
  const result = await call(fetchImpl, url, { method: "GET", headers });
  const raw: unknown = result.$items;
  if (!Array.isArray(raw)) throw new AccountingError("invalid");
  if (result.$next) throw new AccountingError("ambiguous");
  const rows = raw.filter((r) => r.invoice_number === number);
  if (rows.length > 1) throw new AccountingError("ambiguous");
  if (!rows.length) return null;
  const row = rows[0];
  if (row.currency?.id !== "GBP") throw new AccountingError("invalid");
  const totalPence = moneyPence(row.total_amount);
  const outstandingPence = moneyPence(row.outstanding_amount);
  if (totalPence < 0 || outstandingPence < 0 || outstandingPence > totalPence) throw new AccountingError("invalid");
  return { invoiceNumber: number, totalPence, outstandingPence, currency: "GBP", reviewOnly: true };
}
