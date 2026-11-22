import { NextResponse } from "next/server";

import { buildManifest } from "@/lib/company-look/installed-app";
import { BRANDED_CACHE, brandedAppEnabled, installedAppBrand, installedAppSlug } from "@/lib/company-look/installed-app-server";

export const dynamic = "force-dynamic";

// Web app manifest (module 13, Company look). With the server flag BRANDED_APP_ENABLED off (the default) it is always Tolra, exactly as
// before. With it on, a company that is active and has "Sign-in page branding" on gets its own name, theme colour and icons; anything
// else (no company, unknown, inactive, opted out) gets the same neutral Tolra answer. Only the public sign-in fields are ever used.
const HEADERS = { "Content-Type": "application/manifest+json; charset=utf-8" };

export async function GET(request: Request) {
  if (!brandedAppEnabled()) {
    return NextResponse.json(buildManifest(null), { headers: { ...HEADERS, "Cache-Control": "public, max-age=300" } });
  }
  const brand = await installedAppBrand(installedAppSlug(request));
  return NextResponse.json(buildManifest(brand), { headers: { ...HEADERS, ...BRANDED_CACHE } });
}
