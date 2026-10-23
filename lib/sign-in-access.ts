/**
 * Admin > Users: offboarding a leaver whose only company is this one (migration 066 keeps every login's last company, so Deactivate
 * can't switch them off). "Disable sign-in" stops them signing in to Tolra (the app's own marked sign-in ban); their records and
 * membership stay as they are, and "Enable sign-in" undoes it. Shown only for a login that belongs to this company alone; everyone
 * else keeps the normal Deactivate. The server (app/api/admin/users/sign-in) decides; this file only reads its answer and words it.
 */
import { PRODUCT } from "@/lib/product";

/** on: can sign in; off: disabled by this company (our marked ban); off_platform: disabled by Tolra support; unknown: unreadable. */
export type SignInState = "on" | "off" | "off_platform" | "unknown";
const STATES: SignInState[] = ["on", "off", "off_platform", "unknown"];

/** The GET answer as user id -> state. Only the logins listed can be disabled here; anything malformed is dropped. */
export function parseSignInList(data: unknown): Map<string, SignInState> {
  const list = data && typeof data === "object" ? (data as { users?: unknown }).users : undefined;
  const map = new Map<string, SignInState>();
  if (!Array.isArray(list)) return map;
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const { user_id, sign_in } = raw as { user_id?: unknown; sign_in?: unknown };
    if (typeof user_id === "string" && STATES.includes(sign_in as SignInState)) map.set(user_id, sign_in as SignInState);
  }
  return map;
}

/**
 * 093: a member whose identity no company admin may touch: a platform owner's login, or one with any support membership ("protected"),
 * or one the server couldn't check ("check_unavailable": fail closed). The GET lists them under `protected`.
 */
export type ProtectedState = "protected" | "check_unavailable";

/** The GET answer's `protected` list as user id -> state; anything malformed is dropped. */
export function parseProtectedList(data: unknown): Map<string, ProtectedState> {
  const list = data && typeof data === "object" ? (data as { protected?: unknown }).protected : undefined;
  const map = new Map<string, ProtectedState>();
  if (!Array.isArray(list)) return map;
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const { user_id, state } = raw as { user_id?: unknown; state?: unknown };
    if (typeof user_id === "string" && (state === "protected" || state === "check_unavailable")) map.set(user_id, state);
  }
  return map;
}

/** Why a protected row's Edit, Set password, Reset two-step and sign-in controls are off. */
export const PROTECTED_ROW_REASON = "Platform owner / support login: managed by the platform owner.";
export const PROTECTED_CHECK_REASON = "Can't check whether this is a Tolra support login, so these are off: the database needs its 093 update.";

/** What the confirm box says before disabling: what happens, and when to use it. */
export function disableSignInConfirm(name: string, company: string): string {
  return `Disable sign-in for ${name}? Use this when someone leaves: it stops them signing in to ${PRODUCT.name}. `
    + `Their work and their place in ${company} stay as they are, and Enable sign-in undoes it.`;
}

/** The status badge for a login whose sign-in is off; null while it is on (or unknown). */
export function signInBadge(state: SignInState | undefined): string | null {
  if (state === "off") return "Sign-in disabled";
  if (state === "off_platform") return `Sign-in disabled by ${PRODUCT.name}`;
  return null;
}

/** The note under the table. */
export const SIGN_IN_HELP = `Leaver whose only company is this one: use Disable sign-in (it stops them signing in to ${PRODUCT.name}; Deactivate can't remove someone's only company). Someone who also works for another company: Deactivate removes this company only.`;

/** The small badge shown in the Status cell while the sign-in answer is still on its way, so nothing reads as "Active" on a guess. */
export const SIGN_IN_CHECKING_LABEL = "Checking sign-in\u2026";

/**
 * Whether a row's identity actions (Edit, Set password, Reset two-step, Disable / Enable sign-in) are offered (093). Oneself: always
 * (the server never refuses one's own edits). While the answer is on its way: off ("checking"). The answer couldn't be read at all
 * (`unavailable`), or says check_unavailable: off with the 093 reason. Protected: off with the platform-owner reason. Else on.
 * Deactivate / Reactivate and support rows' Revoke are not decided here.
 */
export function identityActions(row: { isSelf: boolean; checking: boolean; unavailable: boolean; state: ProtectedState | undefined }): { allowed: boolean; reason: string | null } {
  if (row.isSelf) return { allowed: true, reason: null };
  if (row.checking) return { allowed: false, reason: SIGN_IN_CHECKING_LABEL };
  if (row.unavailable || row.state === "check_unavailable") return { allowed: false, reason: PROTECTED_CHECK_REASON };
  if (row.state === "protected") return { allowed: false, reason: PROTECTED_ROW_REASON };
  return { allowed: true, reason: null };
}

/**
 * Which sign-in buttons a row offers. While the answer is still unknown (`checking`) an active person gets one disabled "checking"
 * control and neither Disable sign-in nor Deactivate: nothing is offered on a guess (Deactivate can't remove a login's only company,
 * and that is what the answer says). Once it is known: Enable / Disable sign-in for a login this company alone owns (not one
 * disabled by Tolra support), Deactivate only for everyone else. Reactivate (not active) is never held back.
 */
export function signInControls(row: { isSelf: boolean; isLastAdmin: boolean; active: boolean; checking: boolean; state: SignInState | undefined }): { signIn: "none" | "checking" | "enable" | "disable"; deactivate: boolean } {
  if (row.isSelf || row.isLastAdmin) return { signIn: "none", deactivate: false };
  if (!row.active) return { signIn: "none", deactivate: true };
  if (row.checking) return { signIn: "checking", deactivate: false };
  if (row.state === undefined) return { signIn: "none", deactivate: true };
  return { signIn: row.state === "off" ? "enable" : row.state === "off_platform" ? "none" : "disable", deactivate: false };
}
