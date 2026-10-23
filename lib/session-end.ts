/**
 * What a server refusal says about the sign-in. Migration 017's request check (check_request_session) raises SQLSTATE 28000
 * "Your session has ended. Sign in again." ONLY when the token's session no longer exists or has passed its not_after (a
 * sign-out elsewhere, a password change, a revocation, a timeout). It is never raised for a disabled or removed person: those
 * are found by the access recheck (lib/access-recheck.ts), which reads the profile and membership while the session is valid.
 *
 *  - "session-ended": the session ended. The device is treated as offline: the queue and copies STAY, filed under the same person
 *    and company (lib/offline/scope), and are sent once that person signs in again. Anything with 28000 that cannot be told
 *    apart from this lands here too, because keeping is safe: the queue syncs only after a successful sign-in by the same
 *    person, and a person found disabled or removed then goes through endAccess, which blocks cached access while retaining the records.
 *  - "access-ended": the refusal itself says the account is disabled or removed. Cached access is blocked; pending records and bytes are retained.
 *  - "none": not about the session.
 */
export type AuthRefusal = "none" | "session-ended" | "access-ended";

const ACCESS_WORDS = /\b(disabled|deactivated|inactive|removed|suspended)\b/i;

export function classifyAuthRefusal(status: number, body: string): AuthRefusal {
  if (status < 400 || status >= 500) return "none";
  const sessionMessage = /your session has ended/i.test(body);
  if (!sessionMessage && !body.includes("28000")) return "none";
  if (!sessionMessage && ACCESS_WORDS.test(body)) return "access-ended";
  return "session-ended";
}

/**
 * The user a refused request was sent as: the `sub` of its bearer token (supabase-js sends the session's access token as
 * `Authorization: Bearer <jwt>`). Read only to lock that person's cached access on THIS device (fail closed), never as proof of who
 * anyone is. Null for the anon key, a non-JWT key or no header.
 */
export function requestSubject(input: RequestInfo | URL, init?: RequestInit): string | null {
  try {
    const headers = new Headers(init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined));
    const token = /^Bearer\s+(.+)$/i.exec(headers.get("Authorization") ?? "")?.[1];
    const payload = token?.split(".")[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payload.length / 4) * 4, "="));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === "string" && sub ? sub : null;
  } catch {
    return null;
  }
}

/** auth.getUser's answer that the session is gone (none on the device, or the server no longer knows it). Network errors are not. */
export function authSessionGone(error: { name?: string; status?: number } | null | undefined): boolean {
  return Boolean(error && (error.name === "AuthSessionMissingError" || error.status === 401 || error.status === 403));
}

/** A REST/RPC refusal saying this session has ended (017's request check, SQLSTATE 28000). */
export function sessionEndedError(error: { code?: string; message?: string } | null | undefined): boolean {
  return Boolean(error && (error.code === "28000" || /your session has ended/i.test(error.message ?? "")));
}
