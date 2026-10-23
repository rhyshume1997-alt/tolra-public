import { NextResponse } from "next/server";

import type { LoginBranding } from "@/lib/branding";
import { getPublicBranding, logoDataUrl, requestedSlug } from "@/lib/server/branding";

// Public (no sign-in): the sign-in page asks which brand to show. Answers only for an ACTIVE organisation whose admin
// switched "Sign-in page branding" on, and only with the public fields below (name, tagline, colours, logo).
// Anything else, including unknown slugs, gets the same empty answer (200 with null: the page simply stays neutral,
// and the browser logs no error), so it can't be used to learn more about a company.

// Both answers may be cached for one minute only and must be revalidated after that, so a branding change (or a
// company that now exists) shows on the sign-in page within a minute.
const CACHE = { "Cache-Control": "public, max-age=60, must-revalidate" };
const notFound = () => NextResponse.json(null, { status: 200, headers: CACHE });

export async function GET(request: Request) {
  const brand = await getPublicBranding(requestedSlug(request));
  if (!brand) return notFound();
  const body: LoginBranding = {
    slug: brand.slug,
    name: brand.name,
    tagline: brand.tagline,
    primary: brand.primary,
    accent: brand.accent,
    logo: logoDataUrl(brand.logo),
    style: brand.style,
    eyebrow: brand.eyebrow,
  };
  return NextResponse.json(body, { headers: CACHE });
}
