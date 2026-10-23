/** Where invite and password-reset emails send people: the page that lets them choose a password. */
export const SET_PASSWORD_PATH = "/auth/set-password";

/** Absolute set-password URL. Prefers NEXT_PUBLIC_SITE_URL so every email points at the real site, not a preview. */
export function setPasswordUrl(fallbackOrigin?: string) {
  const origin = process.env.NEXT_PUBLIC_SITE_URL || fallbackOrigin || (typeof window !== "undefined" ? window.location.origin : "");
  return `${origin.replace(/\/$/, "")}${SET_PASSWORD_PATH}`;
}
