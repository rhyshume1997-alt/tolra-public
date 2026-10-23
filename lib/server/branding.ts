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
  logo: Image | null;
  /** Changes whenever the name, colours or logo change: busts cached logos. */
  version: string;
};

type OrgRow = { id: string; name: string; slug: string; status: string };

/** One company's logo from its own folder of the private bucket (service role: callers must already have checked who may see it). */
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

async function brandFor(admin: SupabaseClient, org: OrgRow, requireOptIn: boolean): Promise<AppBrand | null> {
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
  const logo = await loadLogo(admin, org.id, logoPath);
  return { slug: org.slug, name, tagline, primary, accent, style, eyebrow, logo, version };
}

async function brandBySlug(slug: string | null | undefined, requireOptIn: boolean): Promise<AppBrand | null> {
  if (!isOrgSlug(slug)) return null;
  const admin = createSupabaseAdminClient();
  if (!admin) return null;
  const { data: org } = await admin.from("organizations").select("id, name, slug, status").eq("slug", slug).maybeSingle<OrgRow>();
  return org ? brandFor(admin, org, requireOptIn) : null;
}

/** Public sign-in branding for a slug (opt-in only), or null. */
export const getPublicBranding = (slug: string | null | undefined) => brandBySlug(slug, true);

/** The slug asked for by ?org, else the company subdomain. */
export function requestedSlug(request: Request) {
  const value = new URL(request.url).searchParams.get("org")?.trim().toLowerCase();
  return value || slugFromHost(request.headers.get("host"), process.env.TENANT_ROOT_DOMAIN);
}

export const logoDataUrl = (logo: AppBrand["logo"]) => (logo ? `data:${logo.type};base64,${logo.bytes.toString("base64")}` : null);
