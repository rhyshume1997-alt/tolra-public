/**
 * How long a sign-in lasts without use (security readiness: agreed session timeout and shared-tablet lock). Constants, one
 * place; the middleware, the browser monitor and the tests all read these.
 *
 *  - Office and admin sessions end after 12 hours without use.
 *  - A workshop or viewer session (the shared workshop tablet) locks after 30 minutes without use: the person is signed out
 *    on that device and has to enter their password again. Offline changes still waiting to sync are KEPT on the device and
 *    are sent after they sign in again; nothing is deleted by a lock or by an expiry.
 *
 * "Use" is a tap, click, key press or scroll in the app, or moving to another page. Supabase's own session limits (one-hour
 * access token, refresh token that keeps rotating) are separate and unchanged; a hard server-side inactivity limit needs
 * the hosted Pro plan (docs/security-readiness.md).
 */
export const OFFICE_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const TABLET_LOCK_IDLE_MS = 30 * 60 * 1000;

/** Browser storage key (localStorage) holding the time of the last use, shared by every tab. */
export const LAST_ACTIVE_KEY = "tolra-last-active";
/** Set when this device locked or expired a sign-in, read by the sign-in page. */
export const LOCK_NOTICE_KEY = "tolra-lock-notice";
/** Cookie the middleware refreshes on every page request; a sign-in older than the limit is ended there as well. */
export const LAST_ACTIVE_COOKIE = "tolra_last_active";
/**
 * Short-lived cookie (readable by the sign-in page, which clears it once it has shown the message) the middleware sets when it
 * ends a sign-in for idleness. The page that was open when this happened can send the browser to a plain /login at the same
 * moment (its access recheck or the dashboard shell notices the session is gone); that request carries this cookie, so the
 * middleware still lands the person on /login?expired=1 instead of losing the reason.
 */
export const EXPIRED_NOTICE_COOKIE = "tolra_expired";
export const EXPIRED_NOTICE_MAX_AGE_S = 5 * 60;

const TABLET_ROLES = ["workshop", "viewer"];

/** The idle limit for the role the person is currently acting as. */
export function idleLimitMs(activeRole: string | null | undefined): number {
  return activeRole && TABLET_ROLES.includes(activeRole) ? TABLET_LOCK_IDLE_MS : OFFICE_IDLE_TIMEOUT_MS;
}

/** Why a sign-in ended: shown on the sign-in page. */
export type IdleReason = "locked" | "expired" | "ended";
export const reasonFor = (activeRole: string | null | undefined): IdleReason => (TABLET_ROLES.includes(activeRole ?? "") ? "locked" : "expired");

/** True when the last use was longer ago than the limit. A missing or unreadable time is not idle (first visit). */
export function idleExceeded(lastActive: number | string | null | undefined, now: number, limitMs: number): boolean {
  const at = typeof lastActive === "string" ? Number(lastActive) : lastActive;
  if (at === null || at === undefined || !Number.isFinite(at) || at <= 0) return false;
  // A time in the future (clock moved) is treated as now rather than as a way to stay signed in for ever.
  return now - Math.min(at, now) > limitMs;
}

/**
 * A request for the plain sign-in page (no ?expired=1) that should be taken to the expired message: the middleware just ended
 * this sign-in for idleness (notice cookie present), or it is about to (the auth cookies are still here and the last-use
 * cookie is past the limit, because the response that ends it has not reached the browser yet). A normal sign-out clears the
 * auth cookies, so an old last-use cookie on its own never produces the message.
 */
export function expiredSignInRedirect(input: { hasAuthCookie: boolean; lastActive: string | undefined; notice: string | undefined; now: number }): boolean {
  if (input.notice === "1") return true;
  return input.hasAuthCookie && idleExceeded(input.lastActive, input.now, OFFICE_IDLE_TIMEOUT_MS);
}

/**
 * Access ended (disabled, removed or moved; lib/use-user.ts endAccess): what the sign-in page adds about the offline changes that were
 * NOT sent and stay on this device behind the access lock (B23). Empty when none were waiting.
 */
export function accessEndedKeptMessage(kept: number): string {
  if (kept <= 0) return "";
  const one = kept === 1;
  return ` ${one ? "1 change" : `${kept} changes`} you made offline ${one ? "was" : "were"} not sent and ${one ? "is" : "are"} still saved on this device. ${one ? "It" : "They"} will be sent if your access is restored and you sign in again.`;
}

/** What the sign-in page says. `pending` is the number of offline changes kept on the device. */
export function idleMessage(reason: IdleReason, pending: number): string {
  const lead = reason === "locked"
    ? "This device was locked after 30 minutes without use. Enter your password to carry on."
    : reason === "ended"
      ? "Your session ended. Sign in again to carry on."
      : "You were signed out after 12 hours without use. Sign in again to carry on.";
  const kept = pending > 0 ? ` ${pending} change${pending === 1 ? "" : "s"} you made offline ${pending === 1 ? "is" : "are"} still saved on this device and will be sent when you sign in.` : "";
  return lead + kept;
}

/**
 * What the dashboard does the moment it mounts (a reload, a reopened tab, a tablet picked up again). The STORED time of the last
 * use is read first: if it is already past the limit the device locks at once and the stored time is NOT overwritten with
 * "now" (it used to be, which let any reload restart the clock). Only a stored time still inside the limit, or none at all
 * (first visit), lets the page carry on and start recording activity.
 */
export function mountDecision(stored: number | string | null | undefined, now: number, limitMs: number): "lock" | "continue" {
  return idleExceeded(stored, now, limitMs) ? "lock" : "continue";
}

/**
 * What a tap, key press or scroll does. The expiry is checked BEFORE the time of use is recorded: past the limit the device
 * locks and nothing is written, so a touch after the deadline can't bring an expired sign-in back. Inside the limit the
 * activity is recorded as usual.
 */
export function activityDecision(lastActive: number | string | null | undefined, now: number, limitMs: number): "lock" | "record" {
  return idleExceeded(lastActive, now, limitMs) ? "lock" : "record";
}

/**
 * Forgets the stored time of last use. Called when a sign-in ends and when the sign-in page opens, so the NEXT sign-in starts its
 * own clock: a time left from the previous one would lock the new session at once (the page reads it before anything else).
 */
export function forgetLastActive() {
  try {
    window.localStorage.removeItem(LAST_ACTIVE_KEY);
  } catch {
    // Storage unavailable: nothing was stored either.
  }
}
