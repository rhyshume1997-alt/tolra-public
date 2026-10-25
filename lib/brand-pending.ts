/**
 * What the app wears until it knows whose company it is. The company profile arrives a moment after the page (it is its own read), and
 * until then the header used to say "Tolra" and the sidebar and buttons used the product's navy, so a company with other colours saw a
 * flash of the wrong name and the wrong blue. Until the profile is known the header shows a placeholder and the colours are a plain
 * neutral (neither the product's nor any company's); once it is known they are the company's, or the product's when it has none.
 */
import { PRODUCT_BRANDING, companyLogoUrl, hexOr, isHexColour, textOn } from "@/lib/branding";

/** Plain slate: not the product navy, not a company colour. */
export const NEUTRAL_BRAND = { primary: "#475569", accent: "#64748b" } as const;

/** True while the company is still being read: no profile yet and the read has not finished. */
export function isCompanyPending(profile: unknown, loading: boolean): boolean {
  return !profile && loading;
}

/** The three colour tokens the shell sets (--brand, --brand-accent, --brand-ink). */
export function shellColours(profile: { brandPrimary?: string | null; brandAccent?: string | null } | null | undefined, loading: boolean): { primary: string; accent: string; ink: string } {
  if (isCompanyPending(profile, loading)) return { primary: NEUTRAL_BRAND.primary, accent: NEUTRAL_BRAND.accent, ink: textOn(NEUTRAL_BRAND.primary) };
  const primary = hexOr(profile?.brandPrimary, PRODUCT_BRANDING.primary);
  const accent = hexOr(profile?.brandAccent, PRODUCT_BRANDING.accent);
  return { primary, accent, ink: textOn(primary) };
}

/**
 * The only part of a company's stored profile the server hands to the browser before it hydrates (it ends up in the page HTML):
 * the name, the two brand colours and the logo's URL. Nothing else (no address, VAT number, bank details, terms): the browser reads
 * the full profile itself, as the signed-in user, exactly as before.
 */
export type ShellBrand = { name: string; brandPrimary: string; brandAccent: string; logoUrl?: string };

/** The shell's brand from a stored company_profile, or null when it has no name to show (the browser then reads it as before). */
export function shellBrandFrom(organizationId: string, raw: unknown): ShellBrand | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const text = (key: string) => (typeof v[key] === "string" ? (v[key] as string) : "");
  // The same name the app shows once the full profile is read (lib/company.ts parseCompanyProfile). Mirrors its completeness rule
  // (document name, an address line, a VAT number when VAT registered): an incomplete profile parses to null there, so holding a
  // brand here would flash the company's name and colours and then switch to the product's.
  const name = text("name") || text("documentName");
  const documentName = text("documentName") || text("name");
  const hasAddress = Array.isArray(v.addressLines) && v.addressLines.map(String).some(Boolean);
  const vatOk = v.vatRegistered === false || Boolean(text("vatNumber"));
  if (!name || !documentName || !hasAddress || !vatOk) return null;
  return {
    name,
    brandPrimary: isHexColour(v.brandPrimary) ? v.brandPrimary.toLowerCase() : "",
    brandAccent: isHexColour(v.brandAccent) ? v.brandAccent.toLowerCase() : "",
    logoUrl: companyLogoUrl(organizationId, text("logoPath")),
  };
}
