/**
 * BOUNDARY (module 12, Company look). Pure, no I/O.
 * Inputs: a public brand (or null). Outputs: the installed-app manifest, the icon URLs and the manifest link for the sign-in page.
 * Must not change: the neutral Tolra manifest (null brand gives exactly what app/manifest.webmanifest always returned); what a
 * brand may contain (only the public sign-in fields: name, tagline, primary colour, slug, version).
 */
import { PRODUCT } from "@/lib/product";

/** Server env flag. Exactly "true" turns company-branded installed apps on; unset or anything else is off (neutral Tolra). */
export const BRANDED_APP_ENV_FLAG = "BRANDED_APP_ENABLED";

/** What an installed app may show about a company. Subset of the public sign-in branding: nothing else ever goes into a manifest. */
export type InstalledAppBrand = { slug: string; name: string; tagline: string; primary: string; version: string; hasLogo: boolean };

export type IconPurpose = "any" | "maskable";

export const ICON_SIZES = [32, 48, 180, 192, 512] as const;

/** Company icon URL. Carries the slug and version explicitly, so it never depends on cookies (manifest icon fetches may send none). */
export function companyIconUrl(brand: Pick<InstalledAppBrand, "slug" | "version">, size: number, purpose: IconPurpose = "any") {
  const params = new URLSearchParams({ org: brand.slug, v: brand.version, size: String(size) });
  if (purpose === "maskable") params.set("purpose", "maskable");
  return `/api/pwa-icon?${params.toString()}`;
}

/** The manifest link the sign-in page uses: always names the company the page shows ("-" is never a company: neutral). */
export const manifestHref = (slug: string | null | undefined) => `/manifest.webmanifest?org=${encodeURIComponent(slug || "-")}`;

/** An icon link of this app ("/api/pwa-icon?size=..") pointed at the company the page shows ("-" = neutral); other links are left alone. */
export function iconHrefFor(href: string, slug: string | null | undefined) {
  if (!href.startsWith("/api/pwa-icon?")) return href;
  const url = new URL(href, "https://x.invalid");
  url.searchParams.set("org", slug || "-");
  return `${url.pathname}${url.search}`;
}

const icon = (src: string, size: number, purpose: IconPurpose) => ({ src, sizes: `${size}x${size}`, type: "image/png", purpose });

export function buildManifest(brand: InstalledAppBrand | null) {
  const common = {
    start_url: "/dashboard?source=pwa",
    scope: "/",
    display: "standalone",
    orientation: "any",
    categories: ["business", "productivity"],
  };
  if (!brand) {
    // Static files made from the Tolra icon (scripts/make-brand-icons.mjs); the maskable one has the mark inside the safe area.
    return {
      id: "/",
      name: PRODUCT.name,
      short_name: PRODUCT.shortName,
      description: PRODUCT.tagline,
      ...common,
      background_color: PRODUCT.appTheme,
      theme_color: PRODUCT.appTheme,
      icons: [icon("/icons/icon-192.png", 192, "any"), icon("/icons/icon-512.png", 512, "any"), icon("/icons/icon-maskable-512.png", 512, "maskable")],
    };
  }
  return {
    id: `/?app=${brand.slug}`,
    name: brand.name,
    short_name: brand.name.slice(0, 12).trim() || PRODUCT.shortName,
    description: brand.tagline || PRODUCT.tagline,
    ...common,
    background_color: brand.primary,
    theme_color: brand.primary,
    icons: [icon(companyIconUrl(brand, 192), 192, "any"), icon(companyIconUrl(brand, 512), 512, "any"), icon(companyIconUrl(brand, 512, "maskable"), 512, "maskable")],
  };
}
