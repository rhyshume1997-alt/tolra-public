import "server-only";

import { BRAND_COOKIE, getPublicBrandingMeta, loginSlug } from "@/lib/server/branding";
import { BRANDED_APP_ENV_FLAG, type InstalledAppBrand } from "@/lib/company-look/installed-app";

/**
 * BOUNDARY (module 13, Company look). Inputs: a company slug (from ?org, the host or this device's brand cookie).
 * Output: that company's installed-app brand, or null (= neutral Tolra). Read-only; writes nothing, calls no AI, sends no email.
 * Must not change: the rules below. A brand is returned only when ALL hold: the server flag is exactly "true", the company is
 * ACTIVE, and its admin switched "Sign-in page branding" on (the same opt-in and the same public fields as /api/branding).
 * Unknown, inactive, opted-out or flag-off all give the same null, so none of them can be told apart from outside.
 */

export const brandedAppEnabled = () => process.env[BRANDED_APP_ENV_FLAG] === "true";

export async function installedAppBrand(slug: string | null | undefined): Promise<InstalledAppBrand | null> {
  if (!brandedAppEnabled() || !slug) return null;
  try {
    const brand = await getPublicBrandingMeta(slug);
    if (!brand) return null;
    return { slug: brand.slug, name: brand.name, tagline: brand.tagline, primary: brand.primary, version: brand.version, hasLogo: brand.hasLogo };
  } catch {
    return null;
  }
}

/** Same precedence as the sign-in page: a non-empty ?org wins (even one that does not resolve), else the company host, else the cookie. */
export function installedAppSlug(request: Request, cookieHeader?: string | null) {
  const url = new URL(request.url);
  const cookie = (cookieHeader ?? request.headers.get("cookie") ?? "")
    .split(";").map((part) => part.trim()).find((part) => part.startsWith(`${BRAND_COOKIE}=`))?.slice(BRAND_COOKIE.length + 1) ?? null;
  return loginSlug({ org: url.searchParams.get("org"), host: request.headers.get("host"), cookie });
}

/** Responses that can differ by company must not be shared between companies by a cache. */
export const BRANDED_CACHE = { "Cache-Control": "private, max-age=60", Vary: "Cookie" } as const;
