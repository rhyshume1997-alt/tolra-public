import type { CompanyProfile } from "@/lib/company";

/** The per-line choices offered on documents. "exempt" = outside the scope of VAT. */
export const VAT_CHOICES = ["20", "5", "0", "exempt"] as const;
export type VatChoice = (typeof VAT_CHOICES)[number];

export const VAT_CHOICE_LABELS: Record<VatChoice, string> = { "20": "20%", "5": "5%", "0": "0%", exempt: "Exempt" };

/** Stored line fields (vat_pct, vat_exempt) -> the select's value. */
export function toVatChoice(vatPct: number | null | undefined, vatExempt?: boolean | null, fallback: VatChoice = "20"): VatChoice {
  if (vatExempt) return "exempt";
  const pct = vatPct === null || vatPct === undefined ? null : String(Number(vatPct));
  return (VAT_CHOICES as readonly string[]).includes(pct ?? "") ? (pct as VatChoice) : fallback;
}

/** The select's value -> stored line fields. */
export function fromVatChoice(choice: VatChoice): { vatPct: number; vatExempt: boolean } {
  return choice === "exempt" ? { vatPct: 0, vatExempt: true } : { vatPct: Number(choice), vatExempt: false };
}

/** The organisation's VAT setup. Not VAT registered = no document gets VAT. */
export function companyVat(company: Pick<CompanyProfile, "vatRegistered" | "defaultVatRate"> | null | undefined) {
  const registered = company?.vatRegistered !== false;
  const rate = company?.defaultVatRate ?? 20;
  const defaultChoice = toVatChoice(rate, false, "20");
  return { registered, standardRate: rate, defaultChoice };
}

/** The line choice a document's lines print with, e.g. "20", "5", "0" or "Exempt". */
export function vatColumnText(vatPct: number | undefined, vatExempt?: boolean, standardRate = 20) {
  return vatExempt ? "Exempt" : String(vatPct ?? standardRate);
}
