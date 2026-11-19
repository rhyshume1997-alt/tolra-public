/**
 * Cloudflare Turnstile on sign-in (audit F1). Inputs: NEXT_PUBLIC_TURNSTILE_SITE_KEY (public, build time) and the form's
 * `cf-turnstile-response` field. Outputs: whether the widget is on, the token to hand to Supabase, and the refusal text.
 * Off by default: with no site key nothing renders and nothing is sent, so sign-in behaves exactly as before.
 * The check itself is Supabase's own CAPTCHA protection (Auth > Attack Protection), which also covers direct calls made with the
 * public anon key. Must not change: the app's own limits in app/api/auth/signin/route.ts, or the identical wrong-credentials answer.
 */

export const TURNSTILE_FIELD = "cf-turnstile-response";
export const CAPTCHA_REQUIRED_MESSAGE = "Please complete the security check and try again.";
const MAX_TOKEN_LENGTH = 2048;

/** The public site key, or null when the check is off. */
export function turnstileSiteKey(): string | null {
  const key = (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "").trim();
  return key || null;
}

/** A usable token from untrusted input, else undefined. */
export function cleanCaptchaToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  return token && token.length <= MAX_TOKEN_LENGTH ? token : undefined;
}

/** True when Supabase refused the attempt because the CAPTCHA token was missing, expired, reused or wrong. */
export function isCaptchaError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code === "captcha_failed") return true;
  return typeof message === "string" && /captcha/i.test(message);
}
