// Admin > Integrations > Mappings (G22, Lot B PR 2; no migration): the sales and credit-note account codes, and one Xero tax rate for each
// Tolra VAT rate, stored by migration 084's integration_set_mapping. Pure (no database, no Xero), so it is unit tested; the server route
// (app/api/integrations/xero/mappings) and the page use the same rules. The database stays the gate: nothing sends while 084's
// integration_unmapped is not empty; this only says plainly what is missing and refuses a tax rate whose percentage is not Tolra's.

import { vatKeyLabel } from "@/lib/integrations/overview";

export type MappingKind = "sales_account" | "credit_account" | "tax_rate";

/** A row of integration_mappings as an admin reads it (084: admins of the company, SELECT only). */
export type MappingRow = { kind: MappingKind; tolra_key: string; external_code: string; external_name: string | null };

/** revenue: usable on sales (Xero's CanApplyToRevenue); active: not archived (Xero's Status ACTIVE). */
export type XeroTaxRate = { code: string; name: string; rate: number; revenue: boolean; active: boolean };
/** revenue: a sales-type account (Xero class REVENUE). The client only lists active accounts. */
export type XeroAccount = { code: string; name: string; type: string; revenue: boolean };

/** What the page may offer and the server may accept: tax rates usable on sales and active; revenue accounts. */
export const usableTaxRates = (rates: XeroTaxRate[]) => rates.filter((r) => r.revenue && r.active);
export const usableAccounts = (accounts: XeroAccount[]) => accounts.filter((a) => a.revenue);

/** The Tolra VAT rates every company has, in the order the page lists them (084's VAT keys). */
export const STANDARD_VAT_KEYS = ["20", "5", "0", "exempt", "no_vat"] as const;

const VAT_KEY = /^(exempt|no_vat|[0-9]{1,3}(\.[0-9]{1,2})?)$/;
export const isVatKey = (key: string) => VAT_KEY.test(key);

/** The VAT rates the page lists: the five every company has, then any other rate in use (an older 17.5%) or already mapped. */
export function vatKeysToShow(rows: MappingRow[], unmapped: string[]): string[] {
  const keys = new Set<string>(STANDARD_VAT_KEYS);
  for (const u of unmapped) if (u.startsWith("vat:") && isVatKey(u.slice(4))) keys.add(u.slice(4));
  for (const r of rows) if (r.kind === "tax_rate" && isVatKey(r.tolra_key)) keys.add(r.tolra_key);
  const extra = [...keys].filter((k) => !(STANDARD_VAT_KEYS as readonly string[]).includes(k)).sort((a, b) => Number(b) - Number(a));
  return [...STANDARD_VAT_KEYS, ...extra];
}

export function mappedCode(rows: MappingRow[], kind: MappingKind, tolraKey = ""): MappingRow | null {
  return rows.find((r) => r.kind === kind && (kind !== "tax_rate" || r.tolra_key === tolraKey)) ?? null;
}

/**
 * What still stops sending, in plain words. Both account codes are always needed (Rhys, 21 Oct); a VAT rate is needed once a waiting
 * document uses it (084's integration_unmapped, from integration_overview's "unmapped"). `rows` are the mappings as saved now, so a
 * mapping saved since the overview was read counts as done.
 */
export function mappingCompleteness(rows: MappingRow[], unmapped: string[]): { ready: boolean; missing: string[]; message: string | null } {
  const missing: string[] = [];
  if (!mappedCode(rows, "sales_account")) missing.push("the sales account");
  if (!mappedCode(rows, "credit_account")) missing.push("the credit note account");
  const usedVat = [...new Set(unmapped.filter((u) => u.startsWith("vat:")).map((u) => u.slice(4)))];
  for (const key of usedVat) if (!mappedCode(rows, "tax_rate", key)) missing.push(`VAT ${vatKeyLabel(key)}`);
  return { ready: missing.length === 0, missing, message: missing.length ? `Nothing is sent to Xero until these are set: ${missing.join(", ")}.` : null };
}

/** The percentage a Tolra VAT key charges: 20 for "20"; 0 for "0", exempt and no VAT. */
export function tolraVatPercent(key: string): number {
  if (key === "exempt" || key === "no_vat") return 0;
  return Number(key);
}

const samePercent = (a: number, b: number) => Math.abs(a - b) < 0.005;

/** Xero's tax rates whose percentage matches the Tolra VAT rate: the only ones the page offers for it. */
export function matchingTaxRates(key: string, rates: XeroTaxRate[]): XeroTaxRate[] {
  const want = tolraVatPercent(key);
  return usableTaxRates(rates).filter((r) => Number.isFinite(r.rate) && samePercent(r.rate, want));
}

const pct = (n: number) => `${Number(n.toFixed(2))}%`;

/**
 * The cross-check when a tax rate mapping is saved (the PR 1 verifier's should-fix): the Xero tax rate must exist in the organisation's
 * list (read from Xero on the server) and charge the same percentage as the Tolra rate; otherwise it is refused with a plain reason.
 */
export function checkTaxRate(key: string, code: string, rates: XeroTaxRate[]): { ok: true; rate: XeroTaxRate } | { ok: false; message: string } {
  if (!isVatKey(key)) return { ok: false, message: "Choose a Tolra VAT rate." };
  const rate = rates.find((r) => r.code === code);
  if (!rate) return { ok: false, message: "That tax rate isn't in this company's Xero. Pick one from the list." };
  if (!rate.active) return { ok: false, message: `Not saved: Xero's "${rate.name || rate.code}" is archived in Xero. Pick an active tax rate.` };
  if (!rate.revenue) return { ok: false, message: `Not saved: Xero's "${rate.name || rate.code}" can't be used on sales (it is for purchases). Pick a tax rate for sales.` };
  const want = tolraVatPercent(key);
  if (!Number.isFinite(rate.rate) || !samePercent(rate.rate, want)) {
    return { ok: false, message: `Not saved: Xero's "${rate.name || rate.code}" is ${pct(rate.rate)}, but Tolra's VAT ${vatKeyLabel(key)} is ${pct(want)}. Pick a Xero tax rate of ${pct(want)}.` };
  }
  return { ok: true, rate };
}

/** An account code being saved must be one of the organisation's active accounts in Xero. */
export function checkAccount(code: string, accounts: XeroAccount[]): { ok: true; account: XeroAccount } | { ok: false; message: string } {
  const account = accounts.find((a) => a.code === code);
  if (!account) return { ok: false, message: "That account isn't in this company's Xero (or is archived). Pick one from the list." };
  if (!account.revenue) return { ok: false, message: `Not saved: ${account.code} ${account.name} isn't a sales (revenue) account in Xero. Pick a revenue account.` };
  return { ok: true, account };
}

/** The request body the page sends to save one mapping; anything else is refused. A blank code removes the mapping. */
export function parseMappingRequest(body: unknown): { kind: MappingKind; tolraKey: string; code: string } | null {
  if (!body || typeof body !== "object") return null;
  const { kind, tolraKey, code } = body as Record<string, unknown>;
  if (kind !== "sales_account" && kind !== "credit_account" && kind !== "tax_rate") return null;
  if (typeof code !== "string" || code.length > 50) return null;
  const key = kind === "tax_rate" ? (typeof tolraKey === "string" ? tolraKey.trim().toLowerCase() : "") : "";
  if (kind === "tax_rate" && !isVatKey(key)) return null;
  return { kind, tolraKey: key, code: code.trim() };
}
