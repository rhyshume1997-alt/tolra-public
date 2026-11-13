import "server-only";

/**
 * BOUNDARY: lib/portal/cookie.ts. Inputs: a session token (from crypto.ts) and an env. Outputs: the portal session cookie as
 * {name, value, ...options} for NextResponse.cookies.set, and its clearing form. Separate from the staff `sb-*` cookies.
 * Production: `__Host-tolra_portal`, Secure, HttpOnly, SameSite=Strict, Path=/, no Domain, 8 hours (the 30-minute idle limit is the
 * database's). Outside production the cookie is `tolra_portal` and not Secure, because browsers refuse a __Host- cookie without Secure on
 * plain http (local dev, e2e). Must not set a Domain, widen SameSite, or hold anything but the random token.
 */
export const PORTAL_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;

export type PortalCookie = { name: string; value: string; httpOnly: true; secure: boolean; sameSite: "strict"; path: "/"; maxAge: number };
type Env = Record<string, string | undefined>;

const isProduction = (env: Env) => env.NODE_ENV === "production";
export const portalCookieName = (env: Env = process.env): string => (isProduction(env) ? "__Host-tolra_portal" : "tolra_portal");

export function portalSessionCookie(token: string, env: Env = process.env): PortalCookie {
  return { name: portalCookieName(env), value: token, httpOnly: true, secure: isProduction(env), sameSite: "strict", path: "/", maxAge: PORTAL_COOKIE_MAX_AGE_SECONDS };
}
export function clearPortalSessionCookie(env: Env = process.env): PortalCookie {
  return { ...portalSessionCookie("", env), maxAge: 0 };
}
