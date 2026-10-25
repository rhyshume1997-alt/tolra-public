import { NextResponse } from "next/server";

import { forbiddenOrigin, isErrorResponse, jsonError, requireProfile, sameOrigin } from "@/lib/server/auth";
import { BRAND_COOKIE, BRAND_COOKIE_MAX_AGE_S, getPublicBrandingMeta } from "@/lib/server/branding";

// Signed in only. Remembers on this device which company's sign-in page to show next time (the tolra_brand cookie: the slug and
// nothing else), so the sign-in page is rendered in that company's branding from the first paint (app/login/page.tsx). The app
// shell calls it after sign-in and after a company switch. It takes no input: the company is always the one THIS session works
// in (my_organizations() run as the caller), and the cookie is set only while that company has "Sign-in page branding" on;
// otherwise it is cleared. The sign-in page never trusts the cookie: it looks the slug up again. (Server components can't set
// cookies; route handlers can.)

const SECURE_COOKIES = process.env.NODE_ENV === "production";
const NO_STORE = { "Cache-Control": "private, no-store" };

export async function POST(request: Request) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const auth = await requireProfile();
  if (isErrorResponse(auth)) return auth;

  const { data: companies, error } = await auth.supabase.rpc("my_organizations");
  if (error) return jsonError("Couldn't read your company.", 500, { headers: NO_STORE });
  const current = ((companies ?? []) as Array<{ organization_id: string; slug: string | null; is_current: boolean }>)
    .find((company) => company.is_current && company.organization_id === auth.profile.organization_id);
  const brand = current?.slug ? await getPublicBrandingMeta(current.slug) : null;

  const response = NextResponse.json({ ok: true }, { headers: NO_STORE });
  if (brand) {
    response.cookies.set(BRAND_COOKIE, brand.slug, { httpOnly: true, secure: SECURE_COOKIES, sameSite: "lax", path: "/", maxAge: BRAND_COOKIE_MAX_AGE_S });
  } else {
    response.cookies.set(BRAND_COOKIE, "", { httpOnly: true, secure: SECURE_COOKIES, sameSite: "lax", path: "/", maxAge: 0 });
  }
  return response;
}
