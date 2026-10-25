import "server-only";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { hexOr, isOrgSlug, type LoginBranding, PRODUCT_BRANDING, slugFromHost } from "@/lib/branding";
import { PNG_SIGNATURE } from "@/lib/png";
import { createSupabaseAdminClient } from "@/lib/server/supabase-admin";

// Used by /api/branding (the sign-in page). Only public fields leave here: name, tagline, colours, logo. A company is
// shown to someone signed out only when it is ACTIVE and its admin switched "Sign-in page branding" on. (The installed
// app's name and icon are always Tolra: app/manifest.webmanifest, lib/server/app-icon.tsx.)

const LOGO_BUCKET = "org-logos";
const MAX_LOGO_BYTES = 1024 * 1024;

export type Image = { bytes: Buffer; type: "image/png" | "image/jpeg" };

export type AppBrand = Omit<LoginBranding, "logo"> & {
  /** The logo itself; null when there is none, or when it was not asked for (getPublicBrandingMeta). */
  logo: Image | null;
  /** A logo path inside the organisation's own folder is set (the file itself is checked only when it is served). */
  hasLogo: boolean;
  /** Changes whenever the name, colours or logo change: busts cached logos. */
  version: string;
};

type OrgRow = { id: string; name: string; slug: string; status: string };

/** One company's logo from its own folder of the private bucket (with the service role, callers must already have checked who may see it). */
export async function loadLogo(admin: SupabaseClient, orgId: string, logoPath: unknown): Promise<Image | null> {
  const path = typeof logoPath === "string" ? logoPath : "";
  // Only a file inside this organisation's own folder.
  if (!path.startsWith(`${orgId}/`) || path.includes("..")) return null;
  const { data: file } = await admin.storage.from(LOGO_BUCKET).download(path);
  if (!file || file.size > MAX_LOGO_BYTES) return null;
  const bytes = Buffer.from(await file.arrayBuffer());
  // Trust the file's own signature, not a stored content type: PNG or JPEG only.
  if (bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return { bytes, type: "image/png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { bytes, type: "image/jpeg" };
  return null;
}

/** `onlyVersion`: with a logo asked for, it is downloaded only when the brand's version is exactly this (else the brand comes back without it). */
async function brandFor(admin: SupabaseClient, org: OrgRow, requireOptIn: boolean, withLogo: boolean, onlyVersion?: string): Promise<AppBrand | null> {
  if (org.status !== "active") return null;
  const { data: settings } = await admin.from("organization_settings").select("company_profile").eq("organization_id", org.id).maybeSingle();
  const profile = (settings?.company_profile ?? {}) as Record<string, unknown>;
  if (requireOptIn && profile.brandedLogin !== true) return null;

  const name = String((typeof profile.name === "string" && profile.name.trim()) || org.name).slice(0, 120);
  const tagline = typeof profile.loginTagline === "string" ? profile.loginTagline.trim().slice(0, 120) : "";
  const primary = hexOr(profile.brandPrimary, PRODUCT_BRANDING.primary);
  const accent = hexOr(profile.brandAccent, PRODUCT_BRANDING.accent);
  const logoPath = typeof profile.logoPath === "string" ? profile.logoPath : "";
  const style = profile.loginStyle === "dark" ? "dark" : "light";
  const eyebrow = typeof profile.loginEyebrow === "string" ? profile.loginEyebrow.trim().slice(0, 80) : "";
  const version = createHash("sha256").update([org.slug, name, tagline, primary, accent, style, eyebrow, logoPath].join("|")).digest("hex").slice(0, 12);
  const hasLogo = logoPath.startsWith(`${org.id}/`) && !logoPath.includes("..");
  const logo = withLogo && hasLogo && (onlyVersion === undefined || onlyVersion === version) ? await loadLogo(admin, org.id, logoPath) : null;
  return { slug: org.slug, name, tagline, primary, accent, style, eyebrow, logo, hasLogo, version };
}

async function brandBySlug(slug: string | null | undefined, requireOptIn: boolean, withLogo = true, onlyVersion?: string): Promise<AppBrand | null> {
  if (!isOrgSlug(slug)) return null;
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data: org } = await admin.from("organizations").select("id, name, slug, status").eq("slug", slug).maybeSingle<OrgRow>();
  return org ? brandFor(admin, org, requireOptIn, withLogo, onlyVersion) : null;
}

/** Public sign-in branding for a slug (opt-in only), or null. */
export const getPublicBranding = (slug: string | null | undefined) => brandBySlug(slug, true);

/** The same answer without downloading the logo (the sign-in page links to /api/branding/logo instead). */
export const getPublicBrandingMeta = (slug: string | null | undefined) => brandBySlug(slug, true, false);

/**
 * The opted-in company's logo, but only when `version` is its CURRENT version. The metadata is read first and the file is downloaded
 * (with the service role) only on a match, so a caller guessing versions cannot make the server fetch from storage.
 */
export async function getPublicLogo(slug: string | null | undefined, version: string): Promise<{ logo: Image; version: string } | null> {
  const brand = await brandBySlug(slug, true, true, version);
  return brand?.logo && brand.version === version ? { logo: brand.logo, version: brand.version } : null;
}

/** The slug asked for by ?org, else the company subdomain. */
export function requestedSlug(request: Request) {
  const value = new URL(request.url).searchParams.get("org")?.trim().toLowerCase();
  return value || slugFromHost(request.headers.get("host"), process.env.TENANT_ROOT_DOMAIN);
}

export const logoDataUrl = (logo: AppBrand["logo"]) => (logo ? `data:${logo.type};base64,${logo.bytes.toString("base64")}` : null);

/**
 * This device's last branded company (slug only: no ids, nothing about the person). Set only by POST /api/branding/remember for the
 * signed-in session's own company, and only while that company has branded sign-in on. Never trusted: the sign-in page looks the
 * slug up again exactly like ?org, so an unknown or not-opted-in slug gets the neutral page.
 */
export const BRAND_COOKIE = "tolra_brand";
export const BRAND_COOKIE_MAX_AGE_S = 60 * 60 * 24 * 365;

/**
 * Which company the sign-in page asks for: ?org, else the company subdomain, else this device's brand cookie. Only one is looked
 * up. A non-empty ?org always wins, even one that does not resolve (as /api/branding does), so a link shows what it names.
 */
export function loginSlug(input: { org?: string | null; host?: string | null; cookie?: string | null }, rootDomain = process.env.TENANT_ROOT_DOMAIN) {
  const asked = input.org?.trim().toLowerCase();
  if (asked) return asked;
  const fromHost = slugFromHost(input.host, rootDomain);
  if (fromHost) return fromHost;
  const remembered = input.cookie?.trim().toLowerCase();
  return isOrgSlug(remembered) ? remembered : null;
}

/** The public sign-in logo at a cacheable URL (app/api/branding/logo): served only while `version` is the current one. */
export const publicLogoUrl = (slug: string, version: string) => `/api/branding/logo?org=${encodeURIComponent(slug)}&v=${encodeURIComponent(version)}`;

const LOGIN_LOOKUP_TIMEOUT_MS = 1500;

/**
 * The sign-in page's branding, read on the server so the first paint is already right. The same public fields and the same
 * opt-in rule as /api/branding; the logo is a URL, not the image. Anything that does not resolve (unknown, not opted in,
 * inactive, an error or a slow answer) is null: the neutral page.
 */
export async function loginBranding(slug: string | null): Promise<LoginBranding | null> {
  if (!slug) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const brand = await Promise.race([
      getPublicBrandingMeta(slug),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), LOGIN_LOOKUP_TIMEOUT_MS); }),
    ]);
    if (!brand) return null;
    return {
      slug: brand.slug,
      name: brand.name,
      tagline: brand.tagline,
      primary: brand.primary,
      accent: brand.accent,
      logo: brand.hasLogo ? publicLogoUrl(brand.slug, brand.version) : null,
      style: brand.style,
      eyebrow: brand.eyebrow,
    };
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
