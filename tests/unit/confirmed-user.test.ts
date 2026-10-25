/**
 * Page-load lag, step 1: one auth-server confirmation shared by the reads of one page load (lib/confirmed-user.ts). A fresh ask always
 * sends its own request; a reuse ask may take a confirmation seconds old, or join one in flight, only while the device's stored
 * session names that same user; errors are never kept; sign-out and company switch (invalidate) drop everything shared.
 * Step 2: a quiet sync pass straight after a full confirmation does not repeat the recheck (lib/access-recheck.ts).
 */
import { describe, expect, it, vi } from "vitest";
import type { UserResponse } from "@supabase/supabase-js";

vi.mock("@/lib/supabase", () => ({ supabase: null }));

import { CONFIRMED_USER_REUSE_MS, createConfirmedUser } from "@/lib/confirmed-user";
import { SYNC_RECHECK_SKIP_MS, syncPassNeedsRecheck } from "@/lib/access-recheck";

const ok = (id: string) => ({ data: { user: { id } }, error: null }) as unknown as UserResponse;
const gone = () => ({ data: { user: null }, error: { name: "AuthSessionMissingError", status: 400 } }) as unknown as UserResponse;
const unreachable = () => ({ data: { user: null }, error: { name: "AuthRetryableFetchError", status: 0 } }) as unknown as UserResponse;
const deferred = <T,>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };

function setup() {
  let clock = 1_000_000;
  const state = { stored: "user-1" as string | null, answer: ok("user-1") as UserResponse, gate: null as Promise<void> | null };
  const getUser = vi.fn(async () => { const gate = state.gate; if (gate) await gate; return state.answer; });
  const sessionUserId = vi.fn(async () => state.stored);
  const shared = createConfirmedUser({ getUser, sessionUserId }, () => clock);
  return { ...shared, getUser, sessionUserId, state, tick: (ms: number) => { clock += ms; } };
}
const REUSE = { maxAgeMs: CONFIRMED_USER_REUSE_MS };

describe("confirmedUser", () => {
  it("a fresh ask always sends its own request, even right after a confirmation", async () => {
    const s = setup();
    await s.confirmedUser();
    await s.confirmedUser();
    expect(s.getUser).toHaveBeenCalledTimes(2);
  });

  it("a fresh ask never joins a request already in flight", async () => {
    const s = setup();
    const gate = deferred<void>();
    s.state.gate = gate.promise;
    const first = s.confirmedUser();
    const second = s.confirmedUser();
    gate.resolve();
    await Promise.all([first, second]);
    expect(s.getUser).toHaveBeenCalledTimes(2);
  });

  it("a reuse ask is answered by a confirmation seconds old, and asks again once it is older than the window", async () => {
    const s = setup();
    await s.confirmedUser();
    s.tick(CONFIRMED_USER_REUSE_MS - 1);
    expect((await s.confirmedUser(REUSE)).data.user?.id).toBe("user-1");
    expect(s.getUser).toHaveBeenCalledTimes(1);
    s.tick(1);
    await s.confirmedUser(REUSE);
    expect(s.getUser).toHaveBeenCalledTimes(2);
  });

  it("the window runs from when the request was sent, not when it was answered", async () => {
    const s = setup();
    const gate = deferred<void>();
    s.state.gate = gate.promise;
    const first = s.confirmedUser();
    s.tick(CONFIRMED_USER_REUSE_MS); // a slow answer
    gate.resolve();
    await first;
    s.state.gate = null;
    await s.confirmedUser(REUSE);
    expect(s.getUser).toHaveBeenCalledTimes(2);
  });

  it("concurrent reuse callers share one request; all get the same answer", async () => {
    const s = setup();
    const gate = deferred<void>();
    s.state.gate = gate.promise;
    const calls = [s.confirmedUser(REUSE), s.confirmedUser(REUSE), s.confirmedUser(REUSE)];
    await Promise.resolve();
    gate.resolve();
    const answers = await Promise.all(calls);
    expect(s.getUser).toHaveBeenCalledTimes(1);
    expect(answers.map((answer) => answer.data.user?.id)).toEqual(["user-1", "user-1", "user-1"]);
  });

  it("a reuse caller joins a fresh request in flight (the sign-in load), then later ones reuse its answer", async () => {
    const s = setup();
    const gate = deferred<void>();
    s.state.gate = gate.promise;
    const load = s.confirmedUser();
    const settings = s.confirmedUser(REUSE);
    gate.resolve();
    await Promise.all([load, settings]);
    await s.confirmedUser(REUSE);
    expect(s.getUser).toHaveBeenCalledTimes(1);
  });

  it("errors, no user and a thrown request are never kept: the next reuse ask goes to the auth server", async () => {
    const s = setup();
    s.state.answer = gone();
    expect((await s.confirmedUser()).error).toBeTruthy();
    await s.confirmedUser(REUSE);
    s.state.answer = unreachable();
    await s.confirmedUser(REUSE);
    await s.confirmedUser(REUSE);
    expect(s.getUser).toHaveBeenCalledTimes(4);
    s.getUser.mockImplementationOnce(async () => { throw new Error("boom"); });
    await expect(Promise.all([s.confirmedUser(REUSE), s.confirmedUser(REUSE)])).rejects.toThrow("boom");
    expect(s.getUser).toHaveBeenCalledTimes(5); // the two concurrent callers shared the one failed request
    s.state.answer = ok("user-1");
    await s.confirmedUser(REUSE);
    expect(s.getUser).toHaveBeenCalledTimes(6);
  });

  it("is not reused when the device's stored session names someone else, or no one (signed out here or in another tab)", async () => {
    const s = setup();
    await s.confirmedUser();
    s.state.stored = "user-2";
    await s.confirmedUser(REUSE);
    expect(s.getUser).toHaveBeenCalledTimes(2);
    await s.confirmedUser();
    s.state.stored = null;
    s.state.answer = gone();
    expect((await s.confirmedUser(REUSE)).error).toBeTruthy();
    expect(s.getUser).toHaveBeenCalledTimes(4);
  });

  it("a failed read of the stored session is not a match", async () => {
    const s = setup();
    await s.confirmedUser();
    s.sessionUserId.mockRejectedValueOnce(new Error("lock"));
    await s.confirmedUser(REUSE);
    expect(s.getUser).toHaveBeenCalledTimes(2);
  });

  it("sign-out mid-check: the answer in flight is not kept, and no caller after the sign-out joins or reuses it", async () => {
    const s = setup();
    const gate = deferred<void>();
    s.state.gate = gate.promise;
    const before = s.confirmedUser(REUSE);
    await Promise.resolve();
    s.invalidate(); // signOut / endAccess
    s.state.answer = gone();
    s.state.gate = null;
    const after = s.confirmedUser(REUSE);
    expect((await after).error).toBeTruthy(); // its own request, answered after the sign-out
    expect(s.getUser).toHaveBeenCalledTimes(2);
    s.state.answer = ok("user-1");
    gate.resolve();
    // The caller that asked before the sign-out gets the answer to the request it was waiting on (as it did unshared)...
    await before;
    // ...but that answer is never handed to anyone later.
    s.state.answer = gone();
    expect((await s.confirmedUser(REUSE)).error).toBeTruthy();
    expect(s.getUser).toHaveBeenCalledTimes(3);
  });

  it("sign-out while the stored session is being compared: not reused", async () => {
    const s = setup();
    await s.confirmedUser();
    const read = deferred<string | null>();
    s.sessionUserId.mockImplementationOnce(() => read.promise);
    const asking = s.confirmedUser(REUSE);
    await Promise.resolve();
    s.invalidate();
    read.resolve("user-1");
    await asking;
    expect(s.getUser).toHaveBeenCalledTimes(2);
  });

  it("company switch: nothing confirmed before it is reused after it", async () => {
    const s = setup();
    await s.confirmedUser();
    await s.confirmedUser(REUSE);
    expect(s.getUser).toHaveBeenCalledTimes(1);
    s.invalidate(); // switchOrganization
    await s.confirmedUser(REUSE);
    expect(s.getUser).toHaveBeenCalledTimes(2);
    // The new confirmation is shared again from here (the reload confirms afresh anyway).
    await s.confirmedUser(REUSE);
    expect(s.getUser).toHaveBeenCalledTimes(2);
  });

  it("a fresh ask's answer replaces the kept one (a later reuse sees the newest confirmation)", async () => {
    const s = setup();
    await s.confirmedUser();
    s.tick(CONFIRMED_USER_REUSE_MS - 10);
    await s.confirmedUser(); // the access recheck
    s.tick(20);
    await s.confirmedUser(REUSE);
    expect(s.getUser).toHaveBeenCalledTimes(2);
  });
});

describe("syncPassNeedsRecheck (step 2)", () => {
  const at = 5_000_000;
  it("a quiet pass right after a full confirmation does not repeat the recheck", () => {
    expect(syncPassNeedsRecheck({ sessionGone: false, quiet: true }, at, at + 1)).toBe(false);
    expect(syncPassNeedsRecheck({ sessionGone: false, quiet: true }, at, at + SYNC_RECHECK_SKIP_MS - 1)).toBe(false);
  });
  it("rechecks once the confirmation is older than the window, or there is none (opened offline), or the clock moved back", () => {
    expect(syncPassNeedsRecheck({ sessionGone: false, quiet: true }, at, at + SYNC_RECHECK_SKIP_MS)).toBe(true);
    expect(syncPassNeedsRecheck({ sessionGone: false, quiet: true }, null, at)).toBe(true);
    expect(syncPassNeedsRecheck({ sessionGone: false, quiet: true }, at, at - 1)).toBe(true);
  });
  it("always rechecks when the pass found the session gone, or a queued change got an answer", () => {
    expect(syncPassNeedsRecheck({ sessionGone: true, quiet: true }, at, at + 1)).toBe(true);
    expect(syncPassNeedsRecheck({ sessionGone: false, quiet: false }, at, at + 1)).toBe(true);
  });
});
