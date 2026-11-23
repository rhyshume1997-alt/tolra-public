import { companyIconResponse } from "@/lib/company-look/company-icon";
import { ICON_SIZES } from "@/lib/company-look/installed-app";
import { BRANDED_CACHE, brandedAppEnabled, installedAppBrand, installedAppSlug } from "@/lib/company-look/installed-app-server";
import { appIconResponse } from "@/lib/server/app-icon";
import { getPublicLogo } from "@/lib/server/branding";

export const dynamic = "force-dynamic";

// App icons for the manifest, apple-touch-icon and favicon. Tolra's own icon (lib/server/app-icon.tsx) unless the server flag
// BRANDED_APP_ENABLED is on AND the company is active with sign-in branding on AND has a logo: then its logo on its brand colour
// (module 13, lib/company-look). Explicit ?org= wins over the cookie (as for the manifest). Every other case is the Tolra icon.
export async function GET(request: Request) {
  if (!brandedAppEnabled()) return appIconResponse(request);
  const asked = Number(new URL(request.url).searchParams.get("size"));
  const size = (ICON_SIZES as readonly number[]).includes(asked) ? asked : 192;
  const brand = await installedAppBrand(installedAppSlug(request));
  const found = brand?.hasLogo ? await getPublicLogo(brand.slug, brand.version).catch(() => null) : null;
  if (!brand || !found) {
    const response = appIconResponse(request);
    response.headers.set("Cache-Control", BRANDED_CACHE["Cache-Control"]);
    response.headers.set("Vary", BRANDED_CACHE.Vary);
    return response;
  }
  const maskable = new URL(request.url).searchParams.get("purpose") === "maskable";
  return companyIconResponse({ primary: brand.primary, logo: found.logo, size, maskable, headers: { ...BRANDED_CACHE } });
}
