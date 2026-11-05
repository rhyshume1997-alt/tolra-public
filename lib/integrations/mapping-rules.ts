/** Provider-independent mapping gates and penny reconciliation. No network, credentials or provider payload shapes. */
import type { IntegrationDocument, Mappings, Totals } from "@/lib/integrations/types";

const cents = (n: number) => Math.round(Number(n) * 100);
export const accountingMoney = (n: number) => cents(n) / 100;

/** What is not mapped for this document: "account:sales" / "account:credit" and "vat:<key>" (the database's gate says the same). */
export function missingMappings(doc: IntegrationDocument, mappings: Mappings): string[] {
  const missing = new Set<string>();
  if (doc.doc_type === "invoice" && !mappings.salesAccount) missing.add("account:sales");
  if (doc.doc_type === "credit_note" && !mappings.creditAccount) missing.add("account:credit");
  for (const line of doc.lines) {
    if (line.text_only || line.vat_key === null) continue;
    if (!mappings.taxRates[line.vat_key]) missing.add(`vat:${line.vat_key}`);
  }
  return [...missing].sort();
}

export class UnmappedError extends Error {
  constructor(readonly missing: string[]) {
    super(`Not mapped yet: ${missing.join(", ")}`);
    this.name = "UnmappedError";
  }
}


/** Tolra's totals as Xero states them: net of every line (carriage included), VAT, total. */
export function expectedTotals(doc: IntegrationDocument): Totals {
  const subTotal = accountingMoney(Number(doc.subtotal) + Number(doc.carriage || 0));
  return { subTotal, totalTax: accountingMoney(doc.vat), total: accountingMoney(doc.total) };
}

/** null when Xero's totals are Tolra's to the penny; otherwise the difference, said plainly. Never rounded away. */
export function totalsDifference(expected: Totals, got: Totals): string | null {
  const parts: string[] = [];
  const cmp = (label: string, a: number, b: number) => {
    if (cents(a) !== cents(b)) parts.push(`${label} Tolra ${accountingMoney(a).toFixed(2)}, Xero ${accountingMoney(b).toFixed(2)}`);
  };
  cmp("net", expected.subTotal, got.subTotal);
  cmp("VAT", expected.totalTax, got.totalTax);
  cmp("total", expected.total, got.total);
  return parts.length ? `Totals differ: ${parts.join("; ")}` : null;
}
