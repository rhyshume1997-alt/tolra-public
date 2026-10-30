/** Where invite and password-reset emails send people: the page that lets them choose a password. */
export const SET_PASSWORD_PATH = "/auth/set-password";

/** The live site: Vercel Production, or a production build run outside Vercel (no VERCEL_ENV). A Vercel Preview is not. */
export function isProductionDeployment(env: Record<string, string | undefined> = process.env) {
  return env.VERCEL_ENV ? env.VERCEL_ENV === "production" : env.NODE_ENV === "production";
}

/**
 * Absolute set-password URL. Prefers NEXT_PUBLIC_SITE_URL so every email points at the real site, not a preview.
 * In production the link never comes from the request (an Origin or X-Forwarded-Host chosen by whoever asked would send the
 * person's reset link to them, audit S1/C8): null when NEXT_PUBLIC_SITE_URL is unset there, and the caller sends nothing.
 * Locally and in a preview `fallbackOrigin` is used as before.
 */
export function setPasswordUrl(fallbackOrigin?: string, env: Record<string, string | undefined> = process.env): string | null {
  const site = env.NEXT_PUBLIC_SITE_URL;
  if (!site && isProductionDeployment(env)) return null;
  const origin = site || fallbackOrigin || (typeof window !== "undefined" ? window.location.origin : "");
  return `${origin.replace(/\/$/, "")}${SET_PASSWORD_PATH}`;
}
