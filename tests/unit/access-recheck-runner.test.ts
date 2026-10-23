/**
 * B23 follow-up (PR #97 run 39116346628, access-recheck.spec.ts:143 timed out at 90 s inside waitForURL, so the test waited about
 * a minute, one sync period, before its first my_session answer arrived). lib/use-user.ts ran one access recheck at a time with a
 * plain `running` flag: while a pass was in flight every later ask (focus, the sync pass, another tab's signal, the 10-minute
 * timer) only set `askedAgain`, honoured when that pass ENDED. A pass that never settles (fetch has no timeout; the auth lock;
 * IndexedDB) therefore silenced every recheck for the life of the page, and a removed or disabled person stayed on it. These
 * tests drive the runner that replaced the flag (lib/access-recheck.ts createRecheckRunner).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RECHECK_STALL_MS, createRecheckRunner } from "@/lib/access-recheck";

/** A pass whose request the test answers (or never answers). */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const flush = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("createRecheckRunner", () => {
  it("a pass that never settles does not swallow the next ask: it reaches the server within the stall bound", async () => {
    // The server: membership present, then removed. Each pass reads it when it asks.
    let member = true;
    const reads: boolean[] = [];
    let ended = false;
    const runner = createRecheckRunner(async () => {
      const answer = member;
      reads.push(answer);
      if (reads.length === 1) await new Promise<void>(() => undefined); // the first pass's request never comes back
      if (!answer) ended = true;
    });

    void runner.ask(); // focus: pass 1 reads (still a member) and then hangs
    await flush();
    member = false; // removed from the company
    void runner.ask(); // focus again while pass 1 is stuck
    await flush();
    expect(reads).toEqual([true]);
    expect(ended).toBe(false);

    await vi.advanceTimersByTimeAsync(RECHECK_STALL_MS);
    expect(reads).toEqual([true, false]);
    expect(ended).toBe(true);
  });

  it("an ask arriving after the stall bound starts a fresh pass at once (sync, other-tab signal, 10-minute timer)", async () => {
    const passes: number[] = [];
    const runner = createRecheckRunner(async () => {
      passes.push(Date.now());
      if (passes.length === 1) await new Promise<void>(() => undefined);
    });
    void runner.ask();
    await flush();
    vi.setSystemTime(Date.now() + RECHECK_STALL_MS + 1); // no ask meanwhile, so no timer is armed
    void runner.ask();
    await flush();
    expect(passes).toHaveLength(2);
  });

  it("asked again while a pass is in flight: one more pass when it ends, never lost, never more than one", async () => {
    const answers = [deferred(), deferred()];
    let calls = 0;
    const runner = createRecheckRunner(async () => { await answers[calls++].promise; });
    void runner.ask();
    await flush();
    void runner.ask();
    void runner.ask();
    void runner.ask();
    await flush();
    expect(calls).toBe(1);
    answers[0].resolve(); // its answer predates the asks: it can't stand for them
    await flush();
    expect(calls).toBe(2);
    answers[1].resolve();
    await flush();
    await vi.advanceTimersByTimeAsync(RECHECK_STALL_MS * 2);
    expect(calls).toBe(2); // the stall timer was disarmed when the pass ended
  });

  it("a superseded pass may not apply its (older) answer; the newer pass is the current one", async () => {
    const seen: Array<{ pass: number; current: boolean }> = [];
    const first = deferred();
    let calls = 0;
    const runner = createRecheckRunner(async (isCurrent) => {
      const pass = ++calls;
      if (pass === 1) await first.promise;
      seen.push({ pass, current: isCurrent() });
    });
    void runner.ask();
    await flush();
    void runner.ask();
    await vi.advanceTimersByTimeAsync(RECHECK_STALL_MS); // pass 2 takes over from the stuck pass 1
    first.resolve(); // pass 1's old answer finally arrives
    await flush();
    expect(seen).toEqual([{ pass: 2, current: true }, { pass: 1, current: false }]);
    // The late pass 1 does not reset the runner: a new ask starts a pass immediately (nothing in flight).
    void runner.ask();
    await flush();
    expect(calls).toBe(3);
  });

  it("a pass that throws still frees the runner and honours an ask made meanwhile", async () => {
    const fail = deferred();
    let calls = 0;
    const runner = createRecheckRunner(async () => {
      calls += 1;
      if (calls === 1) { await fail.promise; throw new Error("network"); }
    });
    void runner.ask();
    await flush();
    void runner.ask();
    fail.resolve();
    await flush();
    expect(calls).toBe(2);
  });

  it("stopped (page leaving or recheck replaced): no armed timer fires and no pass is current", async () => {
    let calls = 0;
    let current: (() => boolean) | null = null;
    const runner = createRecheckRunner(async (isCurrent) => {
      calls += 1;
      current = isCurrent;
      await new Promise<void>(() => undefined);
    });
    void runner.ask();
    await flush();
    void runner.ask(); // arms the stall timer
    runner.stop();
    await vi.advanceTimersByTimeAsync(RECHECK_STALL_MS * 2);
    void runner.ask();
    await flush();
    expect(calls).toBe(1);
    expect(current!()).toBe(false);
  });

  it("the page is not alive: the stall timer does not start a pass", async () => {
    let alive = true;
    let calls = 0;
    const runner = createRecheckRunner(async () => { calls += 1; await new Promise<void>(() => undefined); }, { alive: () => alive });
    void runner.ask();
    await flush();
    void runner.ask();
    alive = false;
    await vi.advanceTimersByTimeAsync(RECHECK_STALL_MS);
    expect(calls).toBe(1);
  });

  it("is bounded well inside the e2e wait and the sync period", () => {
    expect(RECHECK_STALL_MS).toBeGreaterThan(0);
    expect(RECHECK_STALL_MS).toBeLessThanOrEqual(15_000);
  });
});

describe("lib/use-user.ts uses the runner (no single-flight flag of its own)", () => {
  const source = readFileSync(path.resolve(__dirname, "../../lib/use-user.ts"), "utf8");
  it("every ask goes through createRecheckRunner, and a superseded pass applies no keep or role update", () => {
    expect(source).toMatch(/createRecheckRunner\(async \(isCurrent\)/);
    expect(source).toMatch(/recheck = runner\.ask;/);
    expect(source).not.toMatch(/let running = false/);
    expect(source).toMatch(/if \(!isCurrent\(\)\) return;\s*\n\s*const hidden/);
    expect(source).toMatch(/recheckRunner\?\.stop\(\);\s*\n\s*if \(recheckTimer\) clearInterval/);
  });
});
