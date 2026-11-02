import { useEffect } from "react";

// The browser check (C1, option D): while an office or admin user has Tolra open in a visible tab, the browser asks the SERVER to check
// the company's inbox about every 3 minutes (150 to 210 seconds, so tabs don't line up). Hidden tab: paused. Shown again or focused:
// carries on, never sooner than 3 minutes after the last check. The server does the reading (POST /api/mail/check: the session's own
// company, admin or office only, one real check per company per 90 seconds whatever the number of tabs or users); the browser only ever
// gets { checked_at, new, status, reason }. Workshop and viewer never start it; a 401 or 403 stops it; a company whose inbox isn't
// connected (or needs reconnecting) is asked again only every 15 minutes, so a reconnect is picked up without a reload.

export const INBOX_CHECK_URL = "/api/mail/check";
/** Fired on window when a check stored new e-mails (detail: the reply), so an open RFQ list can reload. */
export const INBOX_NEW_EVENT = "tolra:inbox-new";
export const CHECK_EVERY_MS = 180_000;
export const CHECK_JITTER_MS = 30_000;
export const FIRST_CHECK_MS = 10_000;
export const NOT_CONNECTED_EVERY_MS = 15 * 60_000;

export type InboxCheckReply = { checked_at: string | null; new: number; status: "checked" | "recent" | "needs_reconnect" | "failed" | "not_connected"; reason: string };

/** Who starts the browser check (the server checks again): a person holding admin or office in this company. */
export function runsInboxCheck(profile: { role?: string | null; secondary_role?: string | null } | null | undefined): boolean {
  return [profile?.role, profile?.secondary_role].some((role) => role === "admin" || role === "office");
}

export type AutoCheckEnv = {
  visible(): boolean;
  /** Subscribe to "the tab may have become visible or hidden" (visibilitychange, focus); returns the unsubscribe. */
  onVisibility(cb: () => void): () => void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  now(): number;
  random(): number;
  check(): Promise<{ httpStatus: number; reply: InboxCheckReply | null }>;
  onNew(reply: InboxCheckReply): void;
};

/** Starts the schedule; returns stop. Never two checks at once from one tab. */
export function startInboxAutoCheck(env: AutoCheckEnv): () => void {
  let stopped = false;
  let timer: unknown = null;
  let inFlight = false;
  let lastRun: number | null = null;
  let every = CHECK_EVERY_MS;

  const clear = () => {
    if (timer !== null) env.clearTimer(timer);
    timer = null;
  };
  const schedule = (ms: number) => {
    clear();
    if (!stopped) timer = env.setTimer(() => { timer = null; void run(); }, Math.max(0, Math.round(ms)));
  };
  const jittered = () => every + (every === CHECK_EVERY_MS ? (env.random() * 2 - 1) * CHECK_JITTER_MS : 0);

  async function run() {
    if (stopped || inFlight || !env.visible()) return;
    inFlight = true;
    lastRun = env.now();
    try {
      const { httpStatus, reply } = await env.check();
      if (httpStatus === 401 || httpStatus === 403) {
        stopped = true;
        return;
      }
      every = reply && (reply.status === "not_connected" || reply.status === "needs_reconnect") ? NOT_CONNECTED_EVERY_MS : CHECK_EVERY_MS;
      if (reply && reply.new > 0) env.onNew(reply);
    } catch {
      // Offline or no answer: try again at the next turn.
    } finally {
      inFlight = false;
      if (!stopped && env.visible()) schedule(jittered());
    }
  }

  const unsubscribe = env.onVisibility(() => {
    if (stopped) return;
    if (!env.visible()) {
      clear();
      return;
    }
    if (timer !== null || inFlight) return;
    schedule(lastRun === null ? FIRST_CHECK_MS : lastRun + every - env.now());
  });
  if (env.visible()) schedule(FIRST_CHECK_MS + env.random() * FIRST_CHECK_MS);

  return () => {
    stopped = true;
    clear();
    unsubscribe();
  };
}

/** The browser check for the signed-in shell; enabled only for admin or office (runsInboxCheck). */
export function useInboxAutoCheck(enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof document === "undefined") return;
    return startInboxAutoCheck({
      visible: () => document.visibilityState === "visible",
      onVisibility: (cb) => {
        document.addEventListener("visibilitychange", cb);
        window.addEventListener("focus", cb);
        return () => {
          document.removeEventListener("visibilitychange", cb);
          window.removeEventListener("focus", cb);
        };
      },
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      now: Date.now,
      random: Math.random,
      check: async () => {
        const res = await fetch(INBOX_CHECK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", cache: "no-store" });
        return { httpStatus: res.status, reply: (await res.json().catch(() => null)) as InboxCheckReply | null };
      },
      onNew: (reply) => window.dispatchEvent(new CustomEvent(INBOX_NEW_EVENT, { detail: reply })),
    });
  }, [enabled]);
}
