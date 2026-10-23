"use client";

import { useEffect } from "react";

import { sessionEnding } from "@/lib/access-recheck";
import { pendingEntries } from "@/lib/offline/outbox";
import { offlineScope } from "@/lib/offline/scope";
import { LAST_ACTIVE_KEY, LOCK_NOTICE_KEY, activityDecision, forgetLastActive, idleExceeded, idleLimitMs, mountDecision, reasonFor } from "@/lib/session-policy";
import { supabase } from "@/lib/supabase";

const CHECK_EVERY_MS = 30_000;
const WRITE_EVERY_MS = 15_000;

function readLastActive(): string | null {
  try {
    return window.localStorage.getItem(LAST_ACTIVE_KEY);
  } catch {
    return null;
  }
}

function writeLastActive(now: number) {
  try {
    window.localStorage.setItem(LAST_ACTIVE_KEY, String(now));
  } catch {
    // Storage unavailable: the in-memory time below still ends an idle page.
  }
}

/** Removes this browser's Supabase session cookies (sb-<project>-auth-token and its .0/.1 chunks). */
function clearAuthCookies() {
  for (const part of document.cookie.split(";")) {
    const name = part.split("=")[0].trim();
    if (/^sb-.+-auth-token(\.\d+)?$/.test(name)) document.cookie = `${name}=; Max-Age=0; path=/`;
  }
}

/**
 * Ends this device's sign-in after the idle limit for the role being worked as (lib/session-policy.ts): 30 minutes for the
 * workshop tablet (locked), 12 hours for office and admin (expired). The person is signed out here and must enter their
 * password on the sign-in page. Offline changes still waiting to sync are NOT removed: they stay filed under this person and
 * company, and the sign-in page says so. Runs from the dashboard shell only.
 */
export function useIdleSignOut(activeRole: string | null | undefined, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const limit = idleLimitMs(activeRole);
    const reason = reasonFor(activeRole);
    let lastWrite = 0;
    let lastSeen = Date.now();
    let ending = false;

    // Reloading the page or opening a new tab does not restart the clock: the stored time of the last use is read FIRST, and
    // if it is already past the limit the device locks now, before anything is written (lib/session-policy mountDecision).
    const stored = readLastActive();
    const expiredOnMount = mountDecision(stored, Date.now(), limit) === "lock";
    if (!expiredOnMount && stored && Number.isFinite(Number(stored))) lastSeen = Math.min(Number(stored), Date.now());

    async function endSignIn() {
      if (ending) return;
      ending = true;
      sessionEnding.value = true;
      let pending = 0;
      try {
        const scope = offlineScope();
        if (scope) pending = (await pendingEntries(scope)).length;
      } catch {
        // The count is only for the message.
      }
      try {
        window.localStorage.setItem(LOCK_NOTICE_KEY, JSON.stringify({ reason, pending }));
      } catch {
        // The sign-in page then just shows the plain form.
      }
      try {
        if (supabase) await supabase.auth.signOut();
      } catch (err) {
        console.error(err);
      }
      // Offline the server can't be told and supabase-js keeps the session: end it on this device regardless. The offline copy and
      // the queue of unsynced changes are deliberately left alone.
      clearAuthCookies();
      forgetLastActive();
      window.location.assign(`/login?${reason}=1`);
    }

    /** The time of the last use. The stored time is the one source of truth (every tab writes it); this page's own time is only
     * the fallback when storage can't be read. */
    function latestActive() {
      const shared = readLastActive();
      return shared !== null && Number.isFinite(Number(shared)) ? Number(shared) : lastSeen;
    }

    function check() {
      if (idleExceeded(latestActive(), Date.now(), limit)) void endSignIn();
    }

    function onActivity() {
      if (ending) return;
      const now = Date.now();
      // Expiry first: a tap or key press after the limit has passed locks the device. It must never record a new time, which
      // would rescue a sign-in that has already expired (the next check would then find it in use).
      if (activityDecision(latestActive(), now, limit) === "lock") {
        void endSignIn();
        return;
      }
      lastSeen = now;
      if (now - lastWrite > WRITE_EVERY_MS) {
        lastWrite = now;
        writeLastActive(now);
      }
    }

    if (expiredOnMount) {
      void endSignIn();
      return () => undefined;
    }
    // A first visit starts the clock; a stored time inside the limit is kept as it is (only real activity moves it).
    if (!stored) writeLastActive(lastSeen);
    const events: Array<keyof WindowEventMap> = ["pointerdown", "keydown", "touchstart", "scroll", "wheel"];
    for (const name of events) window.addEventListener(name, onActivity, { passive: true });
    const onVisible = () => { if (document.visibilityState === "visible") check(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    const timer = setInterval(check, CHECK_EVERY_MS);
    check();
    return () => {
      for (const name of events) window.removeEventListener(name, onActivity);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
      clearInterval(timer);
    };
  }, [activeRole, enabled]);
}
