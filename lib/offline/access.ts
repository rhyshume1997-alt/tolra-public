/** A revoked identity cannot reopen cached work. Records and attachment bytes stay in their original scopes. */
export const OFFLINE_ACCESS_EVENT = "tolra-offline-access-ended";
export const OFFLINE_ACCESS_PREFIX = "tolra-offline-access-ended:";
const blockedHere = new Set<string>();
const COOKIE_PREFIX = "tolra_offline_blocked_";
const cookieName = (userId: string) => `${COOKIE_PREFIX}${encodeURIComponent(userId)}`;
/**
 * The document.cookie text for this device's lock mark (or, with clear, its removal). Same attributes as the server-set copy
 * (accessEndedCookie): Path=/, SameSite=Strict, one year. Secure is added on https only: a Secure cookie cannot be set from
 * http://localhost in development, where the lock must keep working.
 */
export function offlineBlockCookieString(userId: string, protocol: string | undefined, clear = false): string {
  return `${cookieName(userId)}=${clear ? "" : "1"}; Path=/; Max-Age=${clear ? 0 : 31536000}; SameSite=Strict${protocol === "https:" ? "; Secure" : ""}`;
}
const pageProtocol = () => (typeof window === "undefined" ? undefined : window.location?.protocol);

/** Asks every open tab to run its access recheck now (a fresh value each time, so each signal fires a storage event). */
export const ACCESS_RECHECK_KEY = "tolra-access-recheck";

export function offlineAccessBlocked(userId: string): boolean {
  if (blockedHere.has(userId)) return true;
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(OFFLINE_ACCESS_PREFIX + userId) === "1"
      || typeof document !== "undefined" && document.cookie.split(";").some((part) => part.trim() === `${cookieName(userId)}=1`);
  } catch {
    // If the revocation record cannot be read, cached identity is not authority.
    return true;
  }
}

/** Synchronous: neither an IndexedDB failure nor an auth request can delay locking the app. */
export function blockOfflineAccess(userId: string) {
  blockedHere.add(userId);
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(OFFLINE_ACCESS_PREFIX + userId, "1"); } catch { /* cookie and memory also block */ }
  try { document.cookie = offlineBlockCookieString(userId, pageProtocol()); } catch { /* memory still blocks */ }
  window.dispatchEvent?.(new CustomEvent(OFFLINE_ACCESS_EVENT, { detail: userId }));
}

/** Only after fresh server confirmation of the account AND its current company membership. */
export function confirmOfflineAccess(userId: string) {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(OFFLINE_ACCESS_PREFIX + userId);
      document.cookie = offlineBlockCookieString(userId, pageProtocol(), true);
    } catch {
      return; // online work can continue; offline recovery waits until storage works
    }
  }
  blockedHere.delete(userId);
}

/**
 * The cookie the middleware sets when it refuses a disabled or profile-less account (middleware.ts). It is the same mark
 * blockOfflineAccess writes: it can only lock this device's cached access for that person, never grant anything, and only
 * confirmOfflineAccess (fresh server confirmation) clears it. The middleware also signs the login out everywhere and clears the
 * auth cookies, so without this mark an open tab would find "no session" and could not tell a disabled account from a timeout.
 */
export function accessEndedCookie(userId: string) {
  return { name: cookieName(userId), value: "1", options: { path: "/", maxAge: 31536000, sameSite: "strict" as const, httpOnly: false } };
}

/**
 * Copies access-ended marks the server set as cookies into this browser's storage mark, so every other open tab hears it (storage
 * event) and locks. Only ever suspends. Returns the people newly marked.
 */
export function adoptServerAccessEnded(): string[] {
  if (typeof document === "undefined") return [];
  const marked: string[] = [];
  let cookies: string[];
  try { cookies = document.cookie.split(";"); } catch { return marked; }
  for (const part of cookies) {
    const [name, value] = part.trim().split("=");
    if (!name?.startsWith(COOKIE_PREFIX) || value !== "1") continue;
    let userId: string;
    try { userId = decodeURIComponent(name.slice(COOKIE_PREFIX.length)); } catch { continue; }
    if (!userId) continue;
    try { if (window.localStorage.getItem(OFFLINE_ACCESS_PREFIX + userId) === "1") continue; } catch { /* mark it anyway */ }
    blockOfflineAccess(userId);
    marked.push(userId);
  }
  return marked;
}

/**
 * The access recheck found the session gone. "disabled" when this device holds an access-ended mark for the person (the middleware
 * refused a disabled account, or another tab locked it): the app then locks exactly as a recheck that saw the refusal. Otherwise a
 * plain "signed-out" (a timeout or a sign-out elsewhere), which keeps the queue for the same person signing in again.
 */
export function sessionGoneReason(userId: string | null): "disabled" | "signed-out" {
  return userId && offlineAccessBlocked(userId) ? "disabled" : "signed-out";
}

/** Tells the other open tabs to ask the server again now (a tab found its session gone). */
export function signalAccessRecheck() {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(ACCESS_RECHECK_KEY, `${Date.now()}-${Math.random().toString(36).slice(2)}`); } catch { /* they recheck on focus */ }
}

/** What a storage event from another tab asks of this one: lock now ("end"), ask the server again ("recheck"), or nothing. */
export function accessSignal(event: { key: string | null; newValue: string | null }, userId: string | null): "end" | "recheck" | null {
  if (!userId) return null;
  if (event.key === OFFLINE_ACCESS_PREFIX + userId && event.newValue === "1") return "end";
  if (event.key === ACCESS_RECHECK_KEY && event.newValue) return "recheck";
  return null;
}
