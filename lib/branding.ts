/**
 * Sign-in page branding. Each organisation can show its own logo, colours and tagline on the login page, reached as
 * /login?org=<slug> or <slug>.<TENANT_ROOT_DOMAIN>. Everything here is public by design (it is shown before sign-in),
 * so only these fields ever leave the server, and only for organisations that switched branded sign-in on.
 */

import { PRODUCT } from "@/lib/product";

/**
 * Browser storage key of the last branded sign-in link, from before the brand cookie (app/api/branding/remember). The sign-in page
 * still reads it on a device with no cookie yet; the app removes it once the cookie has been set.
 */
export const LAST_ORG_KEY = "qf.login.org";

export type LoginBranding = {
  slug: string;
  name: string;
  tagline: string;
  /** #rrggbb. */
  primary: string;
  /** #rrggbb. */
  accent: string;
  /** The organisation's own logo (a cacheable /api/branding/logo URL, or a data: URL from /api/branding), or null. */
  logo: string | null;
  /** Sign-in page look: "light" (default) or "dark" (website style). */
  style: "light" | "dark";
  /** Small uppercase line above the headline on the dark style ("" for none). */
  eyebrow: string;
};

/** Neutral product look (lib/product.ts), used when no organisation (or an unknown one) is asked for. */
export const PRODUCT_BRANDING: Omit<LoginBranding, "slug" | "logo" | "style" | "eyebrow"> = {
  name: PRODUCT.name,
  tagline: PRODUCT.tagline,
  primary: PRODUCT.primary,
  accent: PRODUCT.accent,
};

const HEX = /^#[0-9a-f]{6}$/i;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const isHexColour = (value: unknown): value is string => typeof value === "string" && HEX.test(value);
export const isOrgSlug = (value: unknown): value is string => typeof value === "string" && SLUG.test(value);

/** Normalises a stored colour; anything that isn't #rrggbb falls back (never reaches CSS unchecked). */
export function hexOr(value: unknown, fallback: string) {
  return isHexColour(value) ? value.toLowerCase() : fallback;
}

function channel(hex: string, start: number) {
  const c = parseInt(hex.slice(start, start + 2), 16) / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of #rrggbb. */
export function luminance(hex: string) {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** White or near-black text, whichever reads better on `background`. */
export function textOn(background: string) {
  const l = luminance(background);
  const contrastWhite = 1.05 / (l + 0.05);
  const contrastDark = (l + 0.05) / 0.05;
  return contrastWhite >= contrastDark ? "#ffffff" : "#0f172a";
}

/** The organisation slug from a host like "jnr-engineering.example.co.uk", given the root domain; null otherwise. */
export function slugFromHost(host: string | null | undefined, rootDomain: string | null | undefined) {
  if (!host || !rootDomain) return null;
  const hostname = host.split(":")[0].toLowerCase();
  const root = rootDomain.toLowerCase().replace(/^\./, "");
  if (!hostname.endsWith(`.${root}`)) return null;
  const sub = hostname.slice(0, -(root.length + 1));
  if (!sub || sub.includes(".") || sub === "www" || sub === "app") return null;
  return isOrgSlug(sub) ? sub : null;
}

/**
 * Short cache-busting version of a logo's object path. Uploads always get a new, timestamped path (Settings > Company details),
 * so a new logo always gets a new version. Not a secret and not a check: the logo routes authorise on their own.
 */
export function logoVersion(path: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * The signed-in company's own logo at a cacheable URL (app/api/company-logo), or undefined when the path is not inside the
 * organisation's own folder. The route serves it only to a session working in that organisation.
 */
export function companyLogoUrl(organizationId: string | null | undefined, path: string | null | undefined) {
  if (!organizationId || !path || !path.startsWith(`${organizationId}/`) || path.includes("..")) return undefined;
  return `/api/company-logo?org=${encodeURIComponent(organizationId)}&v=${logoVersion(path)}`;
}
