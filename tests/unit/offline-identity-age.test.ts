/**
 * The saved offline identity has a maximum age (default 12 hours since the server last confirmed the person), and its expiry
 * never touches the changes queued on the device.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IDENTITY_CONFIRM_EVERY_MS, OFFLINE_IDENTITY_MAX_AGE_HOURS, OFFLINE_IDENTITY_MAX_AGE_MS, OfflineIdentityExpiredError, offlineIdentityExpired } from "@/lib/offline/identity-age";
import { enqueue, pendingEntries } from "@/lib/offline/outbox";
import { loadOfflineIdentity, saveOfflineIdentity, setOfflineScope } from "@/lib/offline/scope";
import { memoryBackend, saveSnapshot, setOfflineBackend } from "@/lib/offline/store";

const HOUR = 60 * 60 * 1000;
const now = Date.parse("2026-10-12T09:00:00Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

describe("offlineIdentityExpired", () => {
  it("the default is 12 hours, one constant", () => {
    expect(OFFLINE_IDENTITY_MAX_AGE_HOURS).toBe(12);
    expect(OFFLINE_IDENTITY_MAX_AGE_MS).toBe(12 * HOUR);
    // The online app re-confirms far more often than it expires.
    expect(IDENTITY_CONFIRM_EVERY_MS).toBeLessThan(OFFLINE_IDENTITY_MAX_AGE_MS / 10);
  });

  it("fresh and exactly at the limit are fine; one millisecond past it is expired", () => {
    expect(offlineIdentityExpired(ago(0), now)).toBe(false);
    expect(offlineIdentityExpired(ago(11 * HOUR + 59 * 60 * 1000), now)).toBe(false);
    expect(offlineIdentityExpired(ago(12 * HOUR), now)).toBe(false);
    expect(offlineIdentityExpired(ago(12 * HOUR + 1), now)).toBe(true);
    expect(offlineIdentityExpired(ago(7 * 24 * HOUR), now)).toBe(true);
  });

  it("a missing, unreadable or future-dated time is not trusted (clock moved back)", () => {
    expect(offlineIdentityExpired(null, now)).toBe(true);
    expect(offlineIdentityExpired(undefined, now)).toBe(true);
    expect(offlineIdentityExpired("", now)).toBe(true);
    expect(offlineIdentityExpired("not a date", now)).toBe(true);
    expect(offlineIdentityExpired(ago(-2 * 60 * 1000), now)).toBe(false); // a couple of minutes of clock drift
    expect(offlineIdentityExpired(ago(-HOUR), now)).toBe(true);
  });

  it("a different limit can be passed (for tests only)", () => {
    expect(offlineIdentityExpired(ago(2 * HOUR), now, HOUR)).toBe(true);
    expect(offlineIdentityExpired(ago(30 * 60 * 1000), now, HOUR)).toBe(false);
  });
});

describe("the identity saved on this device", () => {
  beforeEach(() => setOfflineBackend(memoryBackend()));
  afterEach(() => { setOfflineBackend(null); setOfflineScope(null); });

  it("each save restarts the clock, and an old save is expired while the queued changes stay", async () => {
    const alice = { userId: "user-a", orgId: "org-1" };
    await enqueue(alice, { kind: "start", jobId: "id-1", jobNo: "J-1", at: "2026-10-11T08:00:00Z" });
    await enqueue(alice, { kind: "start", jobId: "id-2", jobNo: "J-2", at: "2026-10-11T08:05:00Z" });

    // Saved 13 hours ago (what a long-offline tablet holds): the snapshot's own time is what counts.
    await saveSnapshot({ userId: alice.userId, orgId: "identity" }, "identity", { profile: { organization_id: alice.orgId }, organizations: [], hiddenSections: [] }, new Date(now - 13 * HOUR));
    const old = await loadOfflineIdentity(alice.userId);
    expect(offlineIdentityExpired(old?.syncedAt, now)).toBe(true);
    expect((await pendingEntries(alice)).map((e) => e.op.jobNo)).toEqual(["J-1", "J-2"]);

    // The server confirms the person again: the identity is saved again and is fresh.
    await saveOfflineIdentity(alice.userId, { profile: { organization_id: alice.orgId }, organizations: [], hiddenSections: [] });
    const fresh = await loadOfflineIdentity(alice.userId);
    expect(offlineIdentityExpired(fresh?.syncedAt)).toBe(false);
    expect((await pendingEntries(alice)).length).toBe(2);
  });

  it("the expiry error carries the number of waiting changes for the screen", () => {
    const error = new OfflineIdentityExpiredError(3);
    expect(error).toBeInstanceOf(Error);
    expect(error.pending).toBe(3);
    expect(error.name).toBe("OfflineIdentityExpiredError");
  });
});
