/**
 * Sign-in page branding. Each organisation can show its own logo, colours and tagline on the login page, reached as
 * /login?org=<slug> or <slug>.<TENANT_ROOT_DOMAIN>. Everything here is public by design (it is shown before sign-in),
 * so only these fields ever leave the server, and only for organisations that switched branded sign-in on.
 */

import { PRODUCT } from "@/lib/product";

export type LoginBranding = {
  slug: string;
  name: string;
  tagline: string;
  /** #rrggbb. */
  primary: string;
  /** #rrggbb. */
  accent: string;
  /** data: URL of the organisation's own logo, or null. */
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
