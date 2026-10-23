/**
 * How long this device may keep working offline as the person who last signed in (audit: the saved identity used to have
 * no maximum age, so a stolen or lent tablet could be used offline for ever). One constant; change it here only.
 *
 * The clock starts at the last time the server confirmed the person (a successful load of their account, repeated every
 * few minutes while online). After that long without confirmation, offline mode stops opening the app: the person has to
 * be online again. What they entered offline stays on the device, filed under their own user and company, and is sent
 * once they are back (nothing is dropped; lib/offline/scope.ts only wipes on sign-out, a disabled account or a session
 * the server ended).
 */
export const OFFLINE_IDENTITY_MAX_AGE_HOURS = 12;
export const OFFLINE_IDENTITY_MAX_AGE_MS = OFFLINE_IDENTITY_MAX_AGE_HOURS * 60 * 60 * 1000;

/** How often an open, online app re-confirms the person with the server (keeps the clock from running while online). */
export const IDENTITY_CONFIRM_EVERY_MS = 10 * 60 * 1000;

/** A saved time further ahead than this means the device clock was moved back: not trusted. */
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;

/** True when the saved identity is too old to use offline. A missing, unreadable or future-dated time counts as expired. */
export function offlineIdentityExpired(confirmedAt: string | null | undefined, now: number = Date.now(), maxAgeMs: number = OFFLINE_IDENTITY_MAX_AGE_MS): boolean {
  const at = confirmedAt ? Date.parse(confirmedAt) : NaN;
  if (!Number.isFinite(at)) return true;
  if (at > now + CLOCK_TOLERANCE_MS) return true;
  return now - at > maxAgeMs;
}

/** Raised instead of opening the app offline when the saved identity is too old; carries what is still waiting to sync. */
export class OfflineIdentityExpiredError extends Error {
  readonly pending: number;
  constructor(pending: number) {
    super(`Offline sign-in expired after ${OFFLINE_IDENTITY_MAX_AGE_HOURS} hours`);
    this.name = "OfflineIdentityExpiredError";
    this.pending = pending;
  }
}
