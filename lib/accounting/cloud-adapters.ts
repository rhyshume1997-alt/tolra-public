import "server-only";
// BOUNDARY: thin public entry for cloud accounting adapters. Keeps shared helpers (AccountingError, json fetcher, moneyPence) and the Xero branches;
// Sage and QuickBooks logic lives in lib/accounting/providers/{sage,quickbooks}.ts.
// Inputs/outputs: unchanged exported names, types and signatures. MUST NOT CHANGE: exported surface, URLs, scopes, headers, timeouts, error classification.
import { authorizeUrl, exchangeCode, listConnections, chooseConnection, refreshTokens, type XeroConfig } from "@/lib/integrations/xero/oauth";
import { xeroString } from "@/lib/integrations/xero/client";
import type { AccountingId, BalanceEvidence } from "@/lib/accounting/types";
import { sageConfig, sageAuthorize, sageTokens, sageTenant, sageBalance } from "@/lib/accounting/providers/sage";
import { quickbooksConfig, quickbooksAuthorize, quickbooksTokens, quickbooksTenant, quickbooksBalance } from "@/lib/accounting/providers/quickbooks";
export type CloudConfig = XeroConfig & { sandbox?: boolean };
export type CloudTokens = { accessToken: string; refreshToken: string; expiresAt: Date };
export class AccountingError extends Error {
  constructor(readonly reason: "unavailable" | "refused" | "ambiguous" | "invalid" = "unavailable") { super(`Accounting connection: ${reason}`); }
}
export function cloudConfig(id: Exclude<AccountingId, "xero">, env: Record<string, string | undefined> = process.env): CloudConfig | null {
  return id === "sage" ? sageConfig(env) : quickbooksConfig(env);
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
  return id === "sage" ? sageAuthorize(config, state, challenge) : quickbooksAuthorize(config, state);
}
export async function cloudTokens(id: AccountingId, config: CloudConfig, grant: { code: string; verifier: string } | { refreshToken: string }, fetchImpl = fetch): Promise<CloudTokens> {
  if (id === "xero") return "code" in grant ? exchangeCode(config, grant.code, grant.verifier, fetchImpl) : refreshTokens(config, grant.refreshToken, fetchImpl);
  return id === "sage" ? sageTokens(json, config, grant, fetchImpl) : quickbooksTokens(json, config, grant, fetchImpl);
}
export async function cloudTenant(id: AccountingId, config: CloudConfig, token: string, realm: string | null, fetchImpl = fetch): Promise<{ id: string; name: string }> {
  if (id === "xero") {
    const result = chooseConnection(await listConnections(token, fetchImpl), null);
    if (!result.ok) throw new AccountingError("ambiguous");
    return { id: result.connection.tenantId, name: result.connection.tenantName };
  }
  return id === "sage" ? sageTenant(json, token, fetchImpl) : quickbooksTenant(json, config, token, realm, fetchImpl);
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
  if (id === "sage") return sageBalance(json, token, tenant, number, fetchImpl);
  if (id === "quickbooks") return quickbooksBalance(json, config, token, tenant, number, fetchImpl);
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: "application/json", "xero-tenant-id": tenant };
  const url = `https://api.xero.com/api.xro/2.0/Invoices?where=${encodeURIComponent(`Type=="ACCREC"&&InvoiceNumber==${xeroString(number)}`)}`;
  const result = await json(fetchImpl, url, { method: "GET", headers });
  const raw: unknown = result.Invoices;
  if (!Array.isArray(raw)) throw new AccountingError("invalid");
  const rows = raw.filter((r) => r.InvoiceNumber === number);
  if (rows.length > 1) throw new AccountingError("ambiguous");
  if (!rows.length) return null;
  const row = rows[0];
  if (row.CurrencyCode !== "GBP") throw new AccountingError("invalid");
  const totalPence = moneyPence(row.Total);
  const outstandingPence = moneyPence(row.AmountDue);
  if (totalPence < 0 || outstandingPence < 0 || outstandingPence > totalPence) throw new AccountingError("invalid");
  return { invoiceNumber: number, totalPence, outstandingPence, currency: "GBP", reviewOnly: true };
}
