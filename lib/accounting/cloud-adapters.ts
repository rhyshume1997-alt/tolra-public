import "server-only";
import { authorizeUrl, exchangeCode, listConnections, chooseConnection, refreshTokens, type XeroConfig } from "@/lib/integrations/xero/oauth";
import { xeroString } from "@/lib/integrations/xero/client";
import type { AccountingId, BalanceEvidence } from "@/lib/accounting/types";

export type CloudConfig = XeroConfig & { sandbox?: boolean };
export type CloudTokens = { accessToken: string; refreshToken: string; expiresAt: Date };
export class AccountingError extends Error {
  constructor(readonly reason: "unavailable" | "refused" | "ambiguous" | "invalid" = "unavailable") { super(`Accounting connection: ${reason}`); }
}
const SETTINGS = {
  sage: { authorize: "https://www.sageone.com/oauth2/auth/central", token: "https://oauth.accounting.sage.com/token", scope: "full_access", prefix: "SAGE" },
  quickbooks: { authorize: "https://appcenter.intuit.com/connect/oauth2", token: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer", scope: "com.intuit.quickbooks.accounting", prefix: "QUICKBOOKS" },
} as const;
export function cloudConfig(id: Exclude<AccountingId, "xero">, env: Record<string, string | undefined> = process.env): CloudConfig | null {
  const prefix = SETTINGS[id].prefix;
  const clientId = env[`${prefix}_CLIENT_ID`]?.trim();
  const clientSecret = env[`${prefix}_CLIENT_SECRET`]?.trim();
  const redirectUri = env[`${prefix}_REDIRECT_URI`]?.trim();
  if (!clientId || !clientSecret || !redirectUri) return null;
  try {
    const url = new URL(redirectUri);
    if (url.username || url.password || url.search || url.hash || url.pathname !== `/api/accounting/${id}/callback`) return null;
    if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "localhost")) return null;
  } catch { return null; }
  // QBO stays on its free developer sandbox until an operator explicitly configures production.
  return { clientId, clientSecret, redirectUri, sandbox: id === "quickbooks" && env.QUICKBOOKS_ENVIRONMENT !== "production" };
}
async function json(fetchImpl: typeof fetch, url: string, init: RequestInit) {
  let response: Response;
  try { response = await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) }); }
  catch { throw new AccountingError(); }
  if (!response.ok) throw new AccountingError(response.status === 400 || response.status === 401 || response.status === 403 ? "refused" : "unavailable");
  try { return await response.json(); } catch { throw new AccountingError("invalid"); }
}
export function cloudAuthorize(id: AccountingId, config: CloudConfig, state: string, challenge: string) {
  if (id === "xero") return authorizeUrl(config, state, challenge);
  const url = new URL(SETTINGS[id].authorize);
  for (const [key, value] of Object.entries({ response_type: "code", client_id: config.clientId, redirect_uri: config.redirectUri, scope: SETTINGS[id].scope, state })) url.searchParams.set(key, value);
  // Sage and QBO use their documented confidential-client code flow (no invented PKCE parameters).
  return url.toString();
}
export async function cloudTokens(id: AccountingId, config: CloudConfig, grant: { code: string; verifier: string } | { refreshToken: string }, fetchImpl = fetch): Promise<CloudTokens> {
  if (id === "xero") return "code" in grant ? exchangeCode(config, grant.code, grant.verifier, fetchImpl) : refreshTokens(config, grant.refreshToken, fetchImpl);
  const body = new URLSearchParams("code" in grant ? { grant_type: "authorization_code", code: grant.code, redirect_uri: config.redirectUri } : { grant_type: "refresh_token", refresh_token: grant.refreshToken });
  const headers: Record<string, string> = { accept: "application/json", "content-type": "application/x-www-form-urlencoded" };
  if (id === "quickbooks") headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  else { body.set("client_id", config.clientId); body.set("client_secret", config.clientSecret); }
  const result = await json(fetchImpl, SETTINGS[id].token, { method: "POST", headers, body });
  const seconds = Number(result.expires_in);
  if (typeof result.access_token !== "string" || !result.access_token || typeof result.refresh_token !== "string" || !result.refresh_token || !Number.isFinite(seconds) || seconds <= 0) throw new AccountingError("invalid");
  return { accessToken: result.access_token, refreshToken: result.refresh_token, expiresAt: new Date(Date.now() + seconds * 1000) };
}
const qboBase = (config: CloudConfig) => `https://${config.sandbox ? "sandbox-" : ""}quickbooks.api.intuit.com/v3/company/`;
export async function cloudTenant(id: AccountingId, config: CloudConfig, token: string, realm: string | null, fetchImpl = fetch): Promise<{ id: string; name: string }> {
  if (id === "xero") {
    const result = chooseConnection(await listConnections(token, fetchImpl), null);
    if (!result.ok) throw new AccountingError("ambiguous");
    return { id: result.connection.tenantId, name: result.connection.tenantName };
  }
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" };
  if (id === "sage") {
    const result = await json(fetchImpl, "https://api.accounting.sage.com/v3.1/businesses", { headers });
    if (!Array.isArray(result.$items) || result.$next || result.$items.length !== 1) throw new AccountingError("ambiguous");
    const business = result.$items[0];
    if (typeof business.id !== "string" || !business.id || typeof business.name !== "string") throw new AccountingError("invalid");
    return { id: business.id, name: business.name };
  }
  if (!realm || !/^\d{1,30}$/.test(realm)) throw new AccountingError("invalid");
  const result = await json(fetchImpl, `${qboBase(config)}${realm}/companyinfo/${realm}`, { headers });
  if (!result.CompanyInfo || typeof result.CompanyInfo.CompanyName !== "string") throw new AccountingError("invalid");
  return { id: realm, name: result.CompanyInfo.CompanyName };
}
export function moneyPence(value: unknown): number {
  if ((typeof value !== "string" && typeof value !== "number") || !/^-?\d+(?:\.\d{1,2})?$/.test(String(value))) throw new AccountingError("invalid");
  const text = String(value);
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace(/^-/, "").split(".");
  const exact = (BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"))) * BigInt(negative ? -1 : 1);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < BigInt(Number.MIN_SAFE_INTEGER)) throw new AccountingError("invalid");
  return Number(exact);
}
export async function cloudBalance(id: AccountingId, config: CloudConfig, token: string, tenant: string, number: string, fetchImpl = fetch): Promise<BalanceEvidence | null> {
  if (!number || number.length > 100 || /[\u0000-\u001f]/.test(number)) throw new AccountingError("invalid");
  let url: string;
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json" };
  if (id === "xero") {
    headers["xero-tenant-id"] = tenant;
    url = `https://api.xero.com/api.xro/2.0/Invoices?where=${encodeURIComponent(`Type=="ACCREC"&&InvoiceNumber==${xeroString(number)}`)}`;
  } else if (id === "sage") {
    headers["X-Business"] = tenant;
    url = `https://api.accounting.sage.com/v3.1/sales_invoices?search=${encodeURIComponent(number)}&attributes=invoice_number,total_amount,outstanding_amount,currency`;
  } else {
    if (!/^\d{1,30}$/.test(tenant)) throw new AccountingError("invalid");
    const literal = number.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    url = `${qboBase(config)}${tenant}/query?query=${encodeURIComponent(`select * from Invoice where DocNumber = '${literal}'`)}`;
  }
  const result = await json(fetchImpl, url, { method: "GET", headers });
  const raw: unknown = id === "xero" ? result.Invoices : id === "sage" ? result.$items : result.QueryResponse?.Invoice;
  if (raw === undefined && id === "quickbooks") return null;
  if (!Array.isArray(raw)) throw new AccountingError("invalid");
  if ((id === "sage" && result.$next) || (id === "quickbooks" && raw.length >= 100)) throw new AccountingError("ambiguous");
  const rows = raw.filter((r) => (id === "xero" ? r.InvoiceNumber : id === "sage" ? r.invoice_number : r.DocNumber) === number);
  if (rows.length > 1) throw new AccountingError("ambiguous");
  if (!rows.length) return null;
  const row = rows[0];
  const currency = id === "xero" ? row.CurrencyCode : id === "sage" ? row.currency?.id : row.CurrencyRef?.value;
  if (currency !== "GBP") throw new AccountingError("invalid");
  const totalPence = moneyPence(id === "xero" ? row.Total : id === "sage" ? row.total_amount : row.TotalAmt);
  const outstandingPence = moneyPence(id === "xero" ? row.AmountDue : id === "sage" ? row.outstanding_amount : row.Balance);
  if (totalPence < 0 || outstandingPence < 0 || outstandingPence > totalPence) throw new AccountingError("invalid");
  return { invoiceNumber: number, totalPence, outstandingPence, currency: "GBP", reviewOnly: true };
}
