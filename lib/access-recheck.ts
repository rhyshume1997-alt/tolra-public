import { OFFLINE_IDENTITY_MAX_AGE_MS } from "@/lib/offline/identity-age";
import { authSessionGone, sessionEndedError } from "@/lib/session-end";
import type { UserProfile, UserRole } from "@/types";

/**
 * An open app does not trust what it loaded at sign-in for ever (audit of PR H: the cached profile was refreshed only after
 * Auth, and the offline expiry was checked only while loading). The person's account and membership are asked again
 * on focus, every ACCESS_RECHECK_EVERY_MS and after each sync, also when the app was opened offline (the request itself tells
 * whether the connection is back, not the browser's "online" event); and the offline expiry is a timer.
 */
export const ACCESS_RECHECK_EVERY_MS = 10 * 60 * 1000;

/** What the server says now about the signed-in person and the company they are working in. */
export type AccessFacts = {
  /** The login still has a session. */
  signedIn: boolean;
  /** The current user_profiles row, or null when it is gone. */
  profile: Pick<UserProfile, "active" | "organization_id"> | null;
  /** The person's organization_members row for the company they are in, or null when there is none. */
  membership: { active: boolean; role: UserRole; secondary_role: UserRole | null } | null;
};

export type AccessDecision =
  | { kind: "keep" }
  | { kind: "update"; role: UserRole; secondary_role: UserRole | null }
  | { kind: "end"; reason: "signed-out" | "disabled" | "removed" | "moved" };

/** Compares the server's answer with what this page is running on. */
export function decideAccess(current: Pick<UserProfile, "role" | "secondary_role" | "organization_id">, facts: AccessFacts): AccessDecision {
  if (!facts.signedIn) return { kind: "end", reason: "signed-out" };
  if (!facts.profile || facts.profile.active === false) return { kind: "end", reason: "disabled" };
  if (facts.profile.organization_id !== current.organization_id) return { kind: "end", reason: "moved" };
  if (!facts.membership || !facts.membership.active) return { kind: "end", reason: "removed" };
  const secondary = facts.membership.secondary_role ?? null;
  if (facts.membership.role !== current.role || secondary !== (current.secondary_role ?? null)) {
    return { kind: "update", role: facts.membership.role, secondary_role: secondary };
  }
  return { kind: "keep" };
}

/**
 * How recent a full server confirmation (the sign-in load, or a recheck pass that read the profile and my_session) must be for a
 * quiet sync pass not to ask the same questions again (page-load lag, step 2). The sync that runs as the app opens ended in a
 * recheck repeating, a second or so later, the three reads the load had just made (getUser, user_profiles, my_session).
 */
export const SYNC_RECHECK_SKIP_MS = 10_000;

/**
 * Does this sync pass's end ask the server again (lib/use-user.ts)? Always when the pass found the session gone, when a queued change
 * got an answer (a refusal may mean access changed), or when there is no full confirmation from the last SYNC_RECHECK_SKIP_MS
 * (none yet, opened offline, or a clock moved back). Only a quiet pass right after a full confirmation is answered by it. Focus,
 * visibility, "online", other-tab signals and the 10-minute timer are not affected.
 *
 * An idle pass (a background pass with nothing queued, which asked the server nothing; lib/offline/sync.ts) asks again only when
 * there is no full confirmation from the last ACCESS_RECHECK_EVERY_MS: while the 10-minute recheck is answering, the minute loop adds
 * no requests (phone lag); while it is not (opened offline, or the connection is down) the minute loop still asks, so access ends at
 * the first answer from the server once the connection is back.
 */
export function syncPassNeedsRecheck(event: { sessionGone: boolean; quiet: boolean; idle?: boolean }, fullyConfirmedAt: number | null, now: number = Date.now(), skipMs: number = event.idle ? ACCESS_RECHECK_EVERY_MS : SYNC_RECHECK_SKIP_MS): boolean {
  if (event.sessionGone || !event.quiet || fullyConfirmedAt === null) return true;
  const elapsed = now - fullyConfirmedAt;
  return !(elapsed >= 0 && elapsed < skipMs);
}

/**
 * Coming back to the app fires "visibilitychange" (visible) and "focus" together, and each asked for a recheck: two passes of the same
 * three reads for one return (phone lag). Within RETURN_PAIR_MS of a recheck asked by one of them, the OTHER one does not ask again;
 * the same event twice (two focus events) always asks, and the pair is used up once matched, so every return still asks once.
 */
export const RETURN_PAIR_MS = 30_000;
export type ReturnEvent = "focus" | "visible";

/** Returns `ask(kind, now)`: true when that focus / visible event should ask for a recheck (see RETURN_PAIR_MS). */
export function createReturnAsk(pairMs: number = RETURN_PAIR_MS) {
  let last: { kind: ReturnEvent; at: number } | null = null;
  return (kind: ReturnEvent, now: number = Date.now()): boolean => {
    const elapsed = last ? now - last.at : -1;
    if (last && last.kind !== kind && elapsed >= 0 && elapsed < pairMs) {
      last = null;
      return false;
    }
    last = { kind, at: now };
    return true;
  };
}

/** Milliseconds until a saved identity confirmed at `confirmedAt` stops opening the app offline (0 = already expired). */
export function msUntilOfflineExpiry(confirmedAt: string | null | undefined, now: number = Date.now(), maxAgeMs: number = OFFLINE_IDENTITY_MAX_AGE_MS): number {
  const at = confirmedAt ? Date.parse(confirmedAt) : NaN;
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, at + maxAgeMs - now + 1);
}

/**
 * Set while this device is ending the sign-in itself (idle lock, sign-out). A recheck that finds the session gone at that moment
 * must not send the person to a different page than the one the lock chose (the sign-in page with its "locked" notice).
 */
export const sessionEnding = { value: false };

/**
 * The longest an organisation switch holds back the access checks. The switch reloads the page at /dashboard (which resets this
 * module); the bound is only for a reload that never happens (a "leave this page?" prompt the person cancels), so the checks
 * cannot stay silenced for the life of the page.
 */
export const ORGANIZATION_SWITCH_HOLD_MS = 60_000;
let organizationSwitchStartedAt: number | null = null;

/**
 * This page is changing the session's company on purpose (lib/use-user.ts switchOrganization), set just before the
 * switch_organization request. Any my_session answer read after that request may already name the NEW company; an access
 * recheck or sync pass must not read that as "moved / removed" and lock the person out (PR #108 e2e: /login?disabled=1 instead
 * of /dashboard, and the device copy marked blocked). While set, those passes give no answer: they neither lock, nor update the
 * role, nor send queued work. Nothing is granted: the reload at /dashboard loads the person and company from the server again,
 * and every server check (middleware, RLS, loadUser) still applies.
 */
export function beginOrganizationSwitch(now: number = Date.now(), leaving: string | null = null) {
  organizationSwitchStartedAt = now;
  // Every open tab shares this session, so the switch changes their company too: they hold their sync (organizationSwitchAffects).
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(ORGANIZATION_SWITCH_KEY, JSON.stringify({ at: now, leaving })); } catch { /* this tab still holds */ }
}

/** The switch failed or was refused: the access checks answer again at once. */
export function endOrganizationSwitch() {
  const startedAt = organizationSwitchStartedAt;
  organizationSwitchStartedAt = null;
  if (startedAt === null || typeof window === "undefined") return;
  // Only this tab's own announcement is withdrawn, never a newer one from another tab.
  try {
    if (readSwitchAnnouncement()?.at === startedAt) window.localStorage.removeItem(ORGANIZATION_SWITCH_KEY);
  } catch { /* it ends by itself after ORGANIZATION_SWITCH_HOLD_MS */ }
}

/**
 * Where a tab announces its company switch to the other open tabs (`{ at, leaving }`: when it began, and the company it leaves, or
 * null when not known). Two tabs share one Supabase session, and switch_organization changes the session's company (036), so a sync
 * pass in another tab that already confirmed the old company would otherwise keep sending that company's queue under the new one.
 */
export const ORGANIZATION_SWITCH_KEY = "tolra-organization-switch";

function readSwitchAnnouncement(): { at: number; leaving: string | null } | null {
  const value: unknown = JSON.parse(window.localStorage.getItem(ORGANIZATION_SWITCH_KEY) ?? "null");
  if (!value || typeof value !== "object") return null;
  const { at, leaving } = value as { at?: unknown; leaving?: unknown };
  if (typeof at !== "number") return null;
  return { at, leaving: typeof leaving === "string" ? leaving : null };
}

/**
 * True while this tab is switching company (organizationSwitchInProgress), or another open tab announced, less than
 * ORGANIZATION_SWITCH_HOLD_MS ago, a switch away from `orgId` (or from a company it did not name). A sync pass holds then: nothing of
 * `orgId` is sent under a session that may already be in another company. A tab that has just arrived in another company is not held.
 */
export function organizationSwitchAffects(orgId: string, now: number = Date.now()): boolean {
  if (organizationSwitchInProgress(now)) return true;
  if (typeof window === "undefined") return false;
  let announced: { at: number; leaving: string | null } | null;
  try {
    announced = readSwitchAnnouncement();
  } catch {
    return false; // unreadable storage: the server checks of the pass still apply
  }
  if (!announced || (announced.leaving !== null && announced.leaving !== orgId)) return false;
  const elapsed = now - announced.at;
  return elapsed >= 0 && elapsed < ORGANIZATION_SWITCH_HOLD_MS;
}

/** True only from beginOrganizationSwitch until it ends or ORGANIZATION_SWITCH_HOLD_MS passes (a clock moved back ends it too). */
export function organizationSwitchInProgress(now: number = Date.now()): boolean {
  if (organizationSwitchStartedAt === null) return false;
  const elapsed = now - organizationSwitchStartedAt;
  return elapsed >= 0 && elapsed < ORGANIZATION_SWITCH_HOLD_MS;
}

/**
 * How long one access recheck may stay unanswered before a new request to check is no longer held back by it. A recheck awaits
 * the auth lock, two requests (fetch has no timeout) and an IndexedDB write; if any of them never settles, the old single-flight
 * flag stayed set for the life of the page and every later focus, sync, other-tab signal and 10-minute check was swallowed.
 */
export const RECHECK_STALL_MS = 15_000;

/** One recheck pass. `isCurrent()` turns false once a newer pass has started: a superseded pass may still END access (never
 * unsafe), but must not apply a role update or restart the offline clock from an answer older than the newer pass's. */
export type RecheckPass = (isCurrent: () => boolean) => Promise<void>;

/**
 * Runs access rechecks one at a time. Asked while a pass is in flight, it runs once more when that pass ends (the pass may have
 * read the server before whatever prompted the new ask, e.g. a removal). Asked while a pass has been in flight for `stallMs` or
 * more, or still waiting `stallMs` after an ask, it starts a fresh pass instead of waiting for one that may never end. A fresh
 * pass still goes through the same auth lock, so a wedged lock delays it too; what this removes is one stuck request silencing
 * every later ask for the life of the page. Stuck passes are not cancelled (fetch has no abort here): at most one more starts per
 * ask made `stallMs` or more after the last start.
 */
export function createRecheckRunner(pass: RecheckPass, options: { stallMs?: number; now?: () => number; alive?: () => boolean } = {}) {
  const stallMs = options.stallMs ?? RECHECK_STALL_MS;
  const now = options.now ?? Date.now;
  const alive = options.alive ?? (() => true);
  let generation = 0;
  let startedAt: number | null = null; // the current pass's start; null when none is running
  let askedAgain = false;
  let stalled: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const clearStalled = () => {
    if (stalled) clearTimeout(stalled);
    stalled = null;
  };

  const start = (): Promise<void> => {
    clearStalled();
    const mine = ++generation;
    const isCurrent = () => !stopped && mine === generation;
    startedAt = now();
    askedAgain = false;
    return (async () => {
      try {
        await pass(isCurrent);
      } catch {
        // The pass reports nothing: a failed request is not an answer (the offline clock decides).
      } finally {
        if (mine === generation) {
          startedAt = null;
          clearStalled();
          if (askedAgain && !stopped && alive()) void start();
        }
      }
    })();
  };

  const ask = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (startedAt === null) return start();
    const waited = now() - startedAt;
    if (waited >= stallMs) return start();
    askedAgain = true;
    // If the pass in flight never settles, this ask still goes out once that pass counts as stuck.
    stalled ??= setTimeout(() => {
      stalled = null;
      if (!stopped && alive() && askedAgain && startedAt !== null) void start();
    }, stallMs - waited);
    return Promise.resolve();
  };

  /** The page is leaving or the recheck is being replaced: no pass applies anything any more and no timer stays armed. */
  const stop = () => {
    stopped = true;
    clearStalled();
  };

  return { ask, stop };
}

type AuthErrorLike = { name?: string; status?: number } | null | undefined;
type ReadErrorLike = { code?: string; message?: string } | null | undefined;
type ReadResult = { data: unknown; error: ReadErrorLike };

/** The server reads one recheck pass makes (lib/use-user.ts): the login, the profile row and my_session. */
export type AccessReads = {
  getUser: () => PromiseLike<{ data: { user: { id: string } | null }; error: AuthErrorLike }>;
  readProfile: () => PromiseLike<ReadResult>;
  readSession: () => PromiseLike<ReadResult>;
};

/**
 * What one recheck pass learned from the server, before it is compared with what the page runs on:
 *  - "session-gone": the session no longer exists (lib/offline/access.ts sessionGoneReason then says disabled or signed out);
 *  - "signed-out": a different login, or none, answered;
 *  - "no-answer": a failed request is not an answer (the offline clock decides);
 *  - "read": the profile and my_session answers.
 */
export type AccessRead =
  | { kind: "session-gone" }
  | { kind: "signed-out" }
  | { kind: "no-answer" }
  | { kind: "read"; profileResult: ReadResult; sessionResult: ReadResult };

export async function askAccess(reads: AccessReads, userId: string): Promise<AccessRead> {
  const { data, error: confirmError } = await reads.getUser();
  // No session: a timeout or sign-out elsewhere, or the middleware refused a disabled account and marked access ended on this
  // device (lib/offline/access.ts accessEndedCookie). The mark decides which; only a plain timeout keeps cached access.
  if (authSessionGone(confirmError)) return { kind: "session-gone" };
  if (confirmError) return { kind: "no-answer" };
  if (!data.user || data.user.id !== userId) return { kind: "signed-out" };
  // The company is the SESSION's (036): my_session answers which company, role and page access this sign-in has now, and no
  // company means the membership (or the support window) has gone.
  const [profileResult, sessionResult] = await Promise.all([reads.readProfile(), reads.readSession()]);
  // The session ended between getUser and these reads (the server refuses them with 28000): the same as no session.
  if (sessionEndedError(profileResult.error) || sessionEndedError(sessionResult.error)) return { kind: "session-gone" };
  if (profileResult.error || sessionResult.error) {
    // Not always a failed read: when a request from any tab reaches the middleware during this pass, a disabled account is signed
    // out everywhere and the auth cookies are cleared. getUser above still saw the session, but these reads then went out with
    // no session (supabase-js falls back to the anon key): my_session is refused with 42501, not 28000. Ask again whether a session
    // is there; only a session still present (or no connection) makes this a failed read. PR #118 access-recheck.spec.ts:61.
    const again = await reads.getUser();
    return authSessionGone(again.error) ? { kind: "session-gone" } : { kind: "no-answer" };
  }
  return { kind: "read", profileResult, sessionResult };
}
