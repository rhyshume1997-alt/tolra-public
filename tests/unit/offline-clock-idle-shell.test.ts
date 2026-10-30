/**
 * Review condition (phone lag, fix 2): the 12-hour offline clock (the saved identity's syncedAt, lib/offline/identity-age.ts) is
 * restarted by the access recheck's saveOfflineIdentity. Before fe0e588 the minute sync loop set off a recheck every minute; now an
 * idle loop asks nothing, and the restart comes from the 10-minute recheck timer (lib/use-user.ts installRecheck). This proves, with
 * the real UserProvider and the real sync loop mounted on fake timers against a stubbed Supabase client and the in-memory store:
 *  - online and idle, the saved identity is never older than ACCESS_RECHECK_EVERY_MS (10 minutes) over two hours, so an online
 *    device never drifts towards the 12-hour limit;
 *  - opened offline from an identity saved at T0, the app is still open just before T0 + 12 h and locks just after it.
 *  - access revoked (removed from the company, or the session ended) with an empty and with a populated outbox: the next pass that
 *    asks the server ends access, nothing is replayed and the queued change is kept as queued;
 *  - the offline lock is measured from the last successful verification and falls 12 hours after it, keeping queued work.
 * The idle sign-out (lib/use-idle-sign-out.ts, lib/session-policy.ts) is not touched by fe0e588; its own tests are session-policy.test.ts.
 */
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const server = vi.hoisted(() => ({ offline: false, revoked: null as null | "removed" | "session-gone", calls: [] as string[] }));
vi.mock("@/lib/supabase", () => {
  const profile = { id: "u-clock", email: "office@example.test", full_name: "Office Person", role: "office", secondary_role: null, organization_id: "org-clock", organization: "Example Ltd", workshop_email: null, active: true };
  const down = { message: "Failed to fetch", status: 0 };
  const chain = () => {
    const c = {
      select: () => c,
      eq: () => c,
      single: async () => { server.calls.push("user_profiles"); return server.offline ? { data: null, error: down } : { data: profile, error: null }; },
      maybeSingle: async () => { server.calls.push("user_profiles"); return server.offline ? { data: null, error: down } : { data: { active: true }, error: null }; },
    };
    return c;
  };
  const client = {
    auth: {
      getUser: async () => {
        server.calls.push("getUser");
        if (server.offline) return { data: { user: null }, error: { name: "AuthRetryableFetchError", message: "Failed to fetch", status: 0 } };
        if (server.revoked === "session-gone") return { data: { user: null }, error: { name: "AuthSessionMissingError", message: "Auth session missing!", status: 400 } };
        return { data: { user: { id: "u-clock" } }, error: null };
      },
      getSession: async () => ({ data: { session: { user: { id: "u-clock" } } }, error: null }),
      signOut: async () => ({ error: null }),
    },
    from: () => chain(),
    rpc: async (name: string) => {
      server.calls.push(name);
      if (server.offline) return { data: null, error: down };
      // A session the server ended: the database refuses every request for it (017 check_request_session).
      if (server.revoked === "session-gone") return { data: null, error: { code: "28000", message: "Your session has ended. Sign in again." } };
      if (name === "my_organizations") return { data: [], error: null };
      // Removed from the company: my_session answers with no role (the membership has gone).
      if (name === "my_session") return { data: { user_id: "u-clock", organization_id: "org-clock", organization_name: "Example Ltd", role: server.revoked === "removed" ? null : "office", secondary_role: null, hidden_sections: [] }, error: null };
      if (name === "pause_machine_run") return { data: { time_conflicts: [] }, error: null };
      return { data: null, error: null };
    },
  };
  return { supabase: client, isSupabaseConfigured: true };
});

import { ACCESS_RECHECK_EVERY_MS, sessionEnding } from "@/lib/access-recheck";
import { invalidateConfirmedUser } from "@/lib/confirmed-user";
import { confirmOfflineAccess, offlineAccessBlocked } from "@/lib/offline/access";
import { enqueue, pendingEntries, type RunPauseOp } from "@/lib/offline/outbox";
import { IDENTITY_CONFIRM_EVERY_MS, OFFLINE_IDENTITY_MAX_AGE_MS, OfflineIdentityExpiredError } from "@/lib/offline/identity-age";
import { loadOfflineIdentity, saveOfflineIdentity, setOfflineScope } from "@/lib/offline/scope";
import { memoryBackend, setOfflineBackend, setSupportSession } from "@/lib/offline/store";

const USER = "u-clock";
const T0 = Date.parse("2026-10-30T08:00:00Z");
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(T0);
  const store = new Map<string, string>();
  const win = Object.assign(new EventTarget(), {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } as unknown as Storage,
    location: { assign: vi.fn() },
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible", cookie: "" }));
  server.offline = false;
  server.revoked = null;
  server.calls.length = 0;
  invalidateConfirmedUser(); confirmOfflineAccess(USER); setSupportSession(false);
  sessionEnding.value = false; // module state: a previous test ended access
  setOfflineBackend(memoryBackend(new Map()));
});
afterEach(() => { setOfflineScope(null); setOfflineBackend(null); vi.unstubAllGlobals(); vi.useRealTimers(); });

/** Lets promises, React's scheduler (setImmediate, not faked) and due timers run, moving the fake clock by a few ms only. */
const settle = async () => {
  for (let i = 0; i < 30; i += 1) {
    await vi.advanceTimersByTimeAsync(1);
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/** Moves the clock forward in one-minute steps (the sync loop's interval), letting each step's work finish. */
async function advance(ms: number, eachMinute?: () => Promise<void>) {
  for (let left = ms; left > 0; left -= MINUTE) {
    await vi.advanceTimersByTimeAsync(Math.min(MINUTE, left));
    await settle();
    await eachMinute?.();
  }
}

async function mountShell() {
  type Reconciler = { createContainer: (root: object) => unknown; updateContainer: (element: unknown, root: unknown, parent: null, done: () => void) => void };
  const { createRenderer } = (await import("@react-pdf/renderer")) as unknown as { createRenderer: (options: object) => Reconciler };
  const { UserProvider, useUser } = await import("@/lib/use-user");
  const { useOfflineSync } = await import("@/lib/offline/sync");
  const shown: { profile: unknown; error: Error | null; loading: boolean }[] = [];
  function Shell() {
    const value = useUser();
    shown.push(value);
    useOfflineSync(); // the dashboard shell's minute loop, as in the app
    return null;
  }
  const renderer = createRenderer({});
  const root = renderer.createContainer({ type: "ROOT", document: null });
  renderer.updateContainer(createElement(UserProvider, null, createElement(Shell)), root, null, () => undefined);
  await settle();
  return { last: () => shown.at(-1)!, unmount: async () => { renderer.updateContainer(null, root, null, () => undefined); await settle(); } };
}

const identityAge = async () => {
  const saved = await loadOfflineIdentity(USER);
  expect(saved).not.toBeNull();
  return Date.now() - Date.parse(saved!.syncedAt);
};

describe("the 12-hour offline clock with an idle shell (no queued changes)", () => {
  it("the constants: the recheck every 10 minutes is the identity confirmation interval, the offline limit is 12 hours", () => {
    expect(ACCESS_RECHECK_EVERY_MS).toBe(10 * MINUTE);
    expect(IDENTITY_CONFIRM_EVERY_MS).toBe(ACCESS_RECHECK_EVERY_MS);
    expect(OFFLINE_IDENTITY_MAX_AGE_MS).toBe(12 * 60 * MINUTE);
  });

  it("online: the saved identity is restarted at least every 10 minutes for two hours (the access recheck, not a per-minute pass)", async () => {
    const shell = await mountShell();
    try {
      expect(shell.last()).toMatchObject({ loading: false, error: null });
      expect(await identityAge()).toBeLessThan(MINUTE);
      let oldest = 0;
      await advance(120 * MINUTE, async () => {
        oldest = Math.max(oldest, await identityAge());
      });
      const rechecks = server.calls.filter((name) => name === "my_session").length;
      // Never older than one recheck interval (plus the few ms settle() moves the clock).
      expect(oldest).toBeLessThanOrEqual(ACCESS_RECHECK_EVERY_MS + 1_000);
      // The page load's my_session plus the 10-minute timer's 12 in two hours. On this fake clock the load takes no time, so the
      // minute loop's tick lands exactly 10 minutes after the confirmation and may ask once more at each boundary; never the 120
      // (one per minute) of before fe0e588.
      expect(rechecks).toBeGreaterThanOrEqual(1 + 12);
      expect(rechecks).toBeLessThanOrEqual(1 + 24);
      expect(shell.last().profile).not.toBeNull();
      expect(shell.last().error).toBeNull();
    } finally { await shell.unmount(); }
  });

  it("offline: opened from an identity saved at T0, the app works until T0 + 12 h and locks just after it", async () => {
    await saveOfflineIdentity(USER, { profile: { id: USER, role: "office", organization_id: "org-clock", full_name: "Office Person" }, organizations: [], hiddenSections: [] });
    expect(await identityAge()).toBe(0);
    server.offline = true;
    const shell = await mountShell();
    try {
      expect(shell.last()).toMatchObject({ loading: false, error: null });
      expect(shell.last().profile).toMatchObject({ id: USER, organization_id: "org-clock" });
      // The 10-minute recheck and the minute loop keep asking (each fails offline): nothing restarts the clock.
      await advance(OFFLINE_IDENTITY_MAX_AGE_MS - 2 * MINUTE);
      expect(await identityAge()).toBeGreaterThan(OFFLINE_IDENTITY_MAX_AGE_MS - 3 * MINUTE);
      expect(shell.last().error).toBeNull();
      expect(shell.last().profile).not.toBeNull();
      await advance(3 * MINUTE);
      expect(shell.last().error).toBeInstanceOf(OfflineIdentityExpiredError);
      expect(shell.last().profile).toBeNull();
      expect(server.calls.filter((name) => name === "getUser").length).toBeGreaterThan(12 * 6); // it did keep asking
    } finally { await shell.unmount(); }
  });
});

const SCOPE = { userId: USER, orgId: "org-clock" };
const op: RunPauseOp = { kind: "run_pause", v: 2, jobRef: "job", jobNo: "J-9", at: "2026-10-30T07:30:00Z", clientOpId: "clock-client-key", machines: null, afterStart: null };
const assigned = () => (window as unknown as { location: { assign: ReturnType<typeof vi.fn> } }).location.assign;
const replays = () => server.calls.filter((name) => name === "pause_machine_run");

/** Moves the clock forward a minute at a time until `target` (each minute's loop pass and timers run); stops early when `done()`. */
async function advanceTo(target: number, done?: () => boolean) {
  while (Date.now() < target) {
    await vi.advanceTimersByTimeAsync(Math.min(MINUTE, target - Date.now()));
    await settle();
    if (done?.()) return;
  }
}

describe("access revoked with an empty and with a populated outbox (the next pass that asks the server ends access; queued work survives)", () => {
  for (const kind of ["removed", "session-gone"] as const) {
    for (const queue of ["empty", "populated"] as const) {
      it(`${kind === "removed" ? "removed from the company (my_session: no role)" : "session ended (getUser: no session)"}, ${queue} outbox`, async () => {
        const shell = await mountShell();
        try {
          expect(shell.last()).toMatchObject({ loading: false, error: null });
          // Work queued on the device (e.g. while the connection dropped), then access is revoked before the next pass.
          const queued = queue === "populated" ? await enqueue(SCOPE, op) : null;
          server.revoked = kind;
          // The page load's auth answer may be shared for CONFIRMED_USER_REUSE_MS (10 s, timed on the real clock in lib/confirmed-user.ts,
          // not this test's fake one): forget it, as a minute of real time would.
          invalidateConfirmedUser();
          const revokedAt = Date.now();
          await advanceTo(revokedAt + 11 * MINUTE, () => assigned().mock.calls.length > 0);
          const endedAfter = Date.now() - revokedAt;
          expect(assigned()).toHaveBeenCalledWith(kind === "removed" ? "/login?disabled=1" : "/login");
          if (queue === "populated") {
            // A queued change makes the minute loop's pass ask the server first (getUser, my_session): it ends access at once.
            expect(endedAfter).toBeLessThanOrEqual(MINUTE + 1_000);
          } else {
            // Nothing queued: the idle loop asks nothing; the access recheck (every 10 minutes, and on focus, return and
            // "online") ends access. The server refuses the revoked person's requests meanwhile (requireProfile, RLS).
            expect(endedAfter).toBeLessThanOrEqual(ACCESS_RECHECK_EVERY_MS + 1_000);
          }
          // Nothing was replayed, and the queued change is still on the device exactly as queued (not sent, not deleted).
          expect(replays()).toEqual([]);
          expect(await pendingEntries(SCOPE)).toEqual(queued ? [queued] : []);
          if (kind === "removed") expect(offlineAccessBlocked(USER)).toBe(true);
        } finally { await shell.unmount(); }
      });
    }
  }

  it("empty outbox: coming back to the app (focus) ends access at once, without waiting for the 10-minute recheck", async () => {
    const shell = await mountShell();
    try {
      server.revoked = "removed";
      await advanceTo(Date.now() + MINUTE);
      expect(assigned()).not.toHaveBeenCalled();
      window.dispatchEvent(new Event("focus"));
      await settle();
      expect(assigned()).toHaveBeenCalledWith("/login?disabled=1");
    } finally { await shell.unmount(); }
  });
});

describe("the offline lock is measured from the last SUCCESSFUL verification, never later than 12 hours after it, and keeps queued work", () => {
  it("online for two hours, then offline: open until last success + 12 h, locked just after; failed checks do not extend it", async () => {
    const shell = await mountShell();
    try {
      await advanceTo(T0 + 125 * MINUTE);
      const lastOk = Date.parse((await loadOfflineIdentity(USER))!.syncedAt);
      expect(lastOk).toBeGreaterThan(T0 + 110 * MINUTE); // restarted by the rechecks while online
      server.offline = true;
      const queued = await enqueue(SCOPE, op); // work done offline
      await advanceTo(lastOk + OFFLINE_IDENTITY_MAX_AGE_MS - MINUTE);
      // Every minute's pass and every 10-minute recheck failed meanwhile: none of them moved the clock.
      expect(Date.parse((await loadOfflineIdentity(USER))!.syncedAt)).toBe(lastOk);
      expect(shell.last().error).toBeNull();
      expect(shell.last().profile).not.toBeNull();
      await advanceTo(lastOk + OFFLINE_IDENTITY_MAX_AGE_MS + MINUTE);
      const error = shell.last().error;
      expect(error).toBeInstanceOf(OfflineIdentityExpiredError);
      expect((error as OfflineIdentityExpiredError).pending).toBe(1);
      expect(shell.last().profile).toBeNull();
      // Locked, not wiped: the change made offline is still queued for this person and company, and was never sent.
      expect(await pendingEntries(SCOPE)).toEqual([queued]);
      expect(replays()).toEqual([]);
    } finally { await shell.unmount(); }
  });
});
