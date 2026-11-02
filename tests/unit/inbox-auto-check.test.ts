/**
 * C1 option D: the browser check's schedule (lib/inbox-auto-check.ts) with a fake clock and a fake tab. About every 3 minutes (150 to
 * 210 s) while the tab is visible; paused while hidden; on showing or focusing again it carries on no sooner than 3 minutes after the
 * last check; one check at a time; 401/403 stop it; not connected or needs reconnect backs off to 15 minutes; new e-mails are announced.
 * Only admin and office start it.
 */
import { describe, expect, it } from "vitest";

import { CHECK_EVERY_MS, CHECK_JITTER_MS, FIRST_CHECK_MS, type InboxCheckReply, NOT_CONNECTED_EVERY_MS, runsInboxCheck, startInboxAutoCheck } from "@/lib/inbox-auto-check";

const reply = (over: Partial<InboxCheckReply> = {}): InboxCheckReply => ({ checked_at: "2026-11-01T10:00:00Z", new: 0, status: "checked", reason: "Inbox checked: nothing new.", ...over });

/** A fake tab: a clock with timers, visibility, and a server answering from a queue. */
function tab(opts: { random?: number; answers?: Array<{ httpStatus: number; reply: InboxCheckReply | null } | "throw">; hold?: boolean } = {}) {
  let now = 0;
  let visible = true;
  let listener: (() => void) | null = null;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  const checks: number[] = [];
  const announced: InboxCheckReply[] = [];
  let release: (() => void) | null = null;
  const answers = [...(opts.answers ?? [])];
  const t = {
    get now() { return now; },
    checks, announced, timers,
    stop: () => undefined as void,
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      }
      now = end;
    },
    async show(v: boolean) {
      visible = v;
      listener?.();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    },
    async finish() {
      release?.();
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    },
  };
  t.stop = startInboxAutoCheck({
    visible: () => visible,
    onVisibility: (cb) => { listener = cb; return () => { listener = null; }; },
    setTimer: (fn, ms) => { id += 1; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer: (h) => { timers.delete(h as number); },
    now: () => now,
    random: () => opts.random ?? 0.5,
    check: async () => {
      checks.push(now);
      if (opts.hold) await new Promise<void>((r) => { release = r; });
      const a = answers.shift() ?? { httpStatus: 200, reply: reply() };
      if (a === "throw") throw new TypeError("Failed to fetch");
      return a;
    },
    onNew: (r) => announced.push(r),
  });
  return t;
}

describe("the browser check's schedule", () => {
  it("first check 10 to 20 s after opening, then about every 3 minutes (150 to 210 s, jittered)", async () => {
    for (const [random, gap] of [[0, CHECK_EVERY_MS - CHECK_JITTER_MS], [0.5, CHECK_EVERY_MS], [1, CHECK_EVERY_MS + CHECK_JITTER_MS]] as const) {
      const t = tab({ random });
      await t.advance(30 * 60_000);
      expect(t.checks[0]).toBe(FIRST_CHECK_MS + random * FIRST_CHECK_MS);
      expect(t.checks.slice(1).map((at, i) => at - t.checks[i])).toEqual(Array(t.checks.length - 1).fill(gap));
      expect(gap).toBeGreaterThanOrEqual(150_000);
      expect(gap).toBeLessThanOrEqual(210_000);
      t.stop();
    }
  });

  it("hidden: no check at all, however long; shown again: carries on 3 minutes after the last check (or at once if that has passed)", async () => {
    const t = tab();
    await t.advance(20_000);
    expect(t.checks).toEqual([15_000]);
    await t.show(false);
    await t.advance(60 * 60_000);
    expect(t.checks).toEqual([15_000]);
    expect(t.timers.size).toBe(0);
    await t.show(true);
    // The last check was over an hour ago: it runs now.
    await t.advance(0);
    expect(t.checks).toEqual([15_000, t.now]);
    // Hidden and shown again 30 s later: no extra check; the next one is still 3 minutes after the last.
    const last = t.now;
    await t.advance(30_000);
    await t.show(false);
    await t.show(true);
    await t.advance(60_000);
    expect(t.checks.at(-1)).toBe(last);
    await t.advance(CHECK_EVERY_MS);
    expect(t.checks.at(-1)).toBe(last + CHECK_EVERY_MS);
    t.stop();
  });

  it("focus while visible (a focus event on top of visibilitychange) never adds a check", async () => {
    const t = tab();
    await t.advance(20_000);
    for (let i = 0; i < 5; i += 1) await t.show(true);
    await t.advance(15_000 + CHECK_EVERY_MS - 1 - t.now);
    expect(t.checks).toEqual([15_000]);
    await t.advance(1);
    expect(t.checks).toEqual([15_000, 15_000 + CHECK_EVERY_MS]);
    t.stop();
  });

  it("never two checks at once from one tab: a slow answer holds the next until it is back", async () => {
    const t = tab({ hold: true });
    await t.advance(20_000);
    await t.show(false);
    await t.show(true);
    await t.advance(10 * 60_000);
    expect(t.checks).toHaveLength(1);
    await t.finish();
    await t.advance(CHECK_EVERY_MS);
    expect(t.checks).toHaveLength(2);
    t.stop();
  });

  it("401 or 403 (signed out, workshop, viewer, the second step needed): stops for good", async () => {
    for (const httpStatus of [401, 403]) {
      const t = tab({ answers: [{ httpStatus, reply: null }] });
      await t.advance(60 * 60_000);
      await t.show(false);
      await t.show(true);
      await t.advance(60 * 60_000);
      expect(t.checks).toHaveLength(1);
      t.stop();
    }
  });

  it("not connected or needs reconnect: asked again only every 15 minutes (a reconnect is picked up without a reload); then back to 3 minutes; offline: the next turn", async () => {
    const t = tab({ answers: [{ httpStatus: 200, reply: reply({ status: "not_connected", checked_at: null }) }, { httpStatus: 200, reply: reply({ status: "needs_reconnect" }) },
                              { httpStatus: 200, reply: reply() }, "throw"] });
    await t.advance(15_000 + 2 * NOT_CONNECTED_EVERY_MS + 2 * CHECK_EVERY_MS);
    const n = NOT_CONNECTED_EVERY_MS;
    expect(t.checks).toEqual([15_000, 15_000 + n, 15_000 + 2 * n, 15_000 + 2 * n + CHECK_EVERY_MS, 15_000 + 2 * n + 2 * CHECK_EVERY_MS]);
    t.stop();
  });

  it("new e-mails are announced (the RFQ list reloads); nothing new is not", async () => {
    const t = tab({ answers: [{ httpStatus: 200, reply: reply() }, { httpStatus: 200, reply: reply({ new: 2, reason: "Inbox checked: 2 new e-mails." }) }] });
    await t.advance(20_000 + CHECK_EVERY_MS);
    expect(t.announced.map((r) => r.new)).toEqual([2]);
    t.stop();
  });

  it("stop: no timer left and no further check", async () => {
    const t = tab();
    await t.advance(20_000);
    t.stop();
    expect(t.timers.size).toBe(0);
    await t.show(true);
    await t.advance(60 * 60_000);
    expect(t.checks).toHaveLength(1);
  });
});

describe("who starts the browser check", () => {
  it("admin or office (as role or second role) only; workshop, viewer and nobody never", () => {
    expect(runsInboxCheck({ role: "admin" })).toBe(true);
    expect(runsInboxCheck({ role: "office" })).toBe(true);
    expect(runsInboxCheck({ role: "workshop", secondary_role: "office" })).toBe(true);
    expect(runsInboxCheck({ role: "workshop" })).toBe(false);
    expect(runsInboxCheck({ role: "viewer", secondary_role: null })).toBe(false);
    expect(runsInboxCheck(null)).toBe(false);
  });
});
