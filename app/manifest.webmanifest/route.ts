import { NextResponse } from "next/server";

import { PRODUCT } from "@/lib/product";

export const dynamic = "force-dynamic";

// Web app manifest: the installed app is always Tolra (name, icon, theme), whichever company the person belongs to.
// Company names and logos show inside the app and on documents, not on the home screen.
export function GET() {
  // Static files made from the Tolra icon (scripts/make-brand-icons.mjs); the maskable one has the mark inside the safe area.
  const icon = (src: string, size: number, purpose: "any" | "maskable") => ({ src, sizes: `${size}x${size}`, type: "image/png", purpose });

  const manifest = {
    id: "/",
    name: PRODUCT.name,
    short_name: PRODUCT.shortName,
    description: PRODUCT.tagline,
    start_url: "/dashboard?source=pwa",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: PRODUCT.appTheme,
    theme_color: PRODUCT.appTheme,
    categories: ["business", "productivity"],
    icons: [icon("/icons/icon-192.png", 192, "any"), icon("/icons/icon-512.png", 512, "any"), icon("/icons/icon-maskable-512.png", 512, "maskable")],
  };

  return NextResponse.json(manifest, {
    headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}
