/**
 * What the app wears until it knows whose company it is. The company profile arrives a moment after the page (it is its own read), and
 * until then the header used to say "Tolra" and the sidebar and buttons used the product's navy, so a company with other colours saw a
 * flash of the wrong name and the wrong blue. Until the profile is known the header shows a placeholder and the colours are a plain
 * neutral (neither the product's nor any company's); once it is known they are the company's, or the product's when it has none.
 */
import { PRODUCT_BRANDING, hexOr, textOn } from "@/lib/branding";

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
