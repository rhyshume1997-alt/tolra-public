/**
 * Pending photos are never lost without the person choosing (040 review, must-fix 1). Sign-out and company switch count every
 * unsynced change on what they would remove, queued AND held (refused or in conflict), photos named apart ("2 photos waiting to
 * upload, 1 photo that failed"); they offer an export first; Cancel keeps everything. A forced wipe (access revoked, session
 * ended) still removes the company's data, then says once what went: counts and job numbers, never a picture. The idle lock
 * keeps everything. A photo held because the server's copy didn't match is retried under a NEW photo id.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HEIC_MESSAGE, isHeic } from "@/lib/job-photos";
import { enqueue, pendingEntries, photoBlobKey, readAttachment, rejectedEntries, replayOutbox, retryHeld, type PhotoOp } from "@/lib/offline/outbox";
import { confirmUnsyncedDiscard, setOfflineScope, wipeOfflineData } from "@/lib/offline/scope";
import { executePhotoOp, PHOTO_MISMATCH_REASON } from "@/lib/offline/sync";
import { discardedMessage, memoryBackend, setOfflineBackend, setSupportSession, takeDiscardedNotice, unsyncedIdsForUser, wipeAllOffline, wipeScope } from "@/lib/offline/store";

const alice = { userId: "user-a", orgId: "org-1" };
const aliceElsewhere = { userId: "user-a", orgId: "org-2" };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 2, 0xff, 0xd9]);
let n = 0;
const photo = (scope = alice, jobNo = "J-1"): PhotoOp => {
  n += 1;
  const photoId = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return { kind: "photo", photoId, jobId: `job-${jobNo}`, jobNo, note: "Bore", capturedAt: null, byteSize: JPEG.length, blobKey: photoBlobKey(scope, photoId) };
};
const queue = async (scope: typeof alice, op: PhotoOp) => { await enqueue(scope, op, new Date(), { [op.blobKey]: new Blob([JPEG], { type: "image/jpeg" }) }); return op; };
/** Files every queued entry of the scope as refused (a photo that failed), with an optional code. */
const fail = (scope: typeof alice, code?: string) => replayOutbox(scope, async () => ({ status: "rejected", reason: "Refused", ...(code ? { code } : {}) }));

let data: Map<string, unknown>;
let session: Map<string, string>;
beforeEach(() => {
  data = new Map();
  setOfflineBackend(memoryBackend(data));
  setSupportSession(false);
  session = new Map();
  vi.stubGlobal("sessionStorage", { getItem: (k: string) => session.get(k) ?? null, setItem: (k: string, v: string) => void session.set(k, v), removeItem: (k: string) => void session.delete(k) });
});
afterEach(() => { setOfflineBackend(null); setOfflineScope(null); vi.unstubAllGlobals(); });

/** One photo that failed (held) and two waiting, on J-1 and J-2, in alice's company; one waiting in her other company. */
async function world() {
  const held = await queue(alice, photo(alice, "J-1"));
  await fail(alice);
  const waiting = [await queue(alice, photo(alice, "J-1")), await queue(alice, photo(alice, "J-2"))];
  const other = await queue(aliceElsewhere, photo(aliceElsewhere, "K-9"));
  setOfflineScope(alice);
  return { held, waiting, other, all: [held, ...waiting, other] };
}
const blobsLeft = async (ops: PhotoOp[]) => (await Promise.all(ops.map((op) => readAttachment(op.blobKey)))).filter(Boolean).length;
const offline = async () => { throw new Error("Failed to fetch"); };

describe("explicit sign-out (everything on the device)", () => {
  it("Cancel keeps every queued and held photo; the questions list them and offer an export first", async () => {
    const w = await world();
    const ask = vi.fn<(m: string) => boolean>(() => false);
    const exportPhotos = vi.fn(async () => 0);
    expect(await confirmUnsyncedDiscard("Signing out", offline, ask, { everything: true, exportPhotos })).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(ask.mock.calls[0][0]).toMatch(/4 changes made offline haven't synced yet\.\n\nNot uploaded: 3 photos waiting to upload, 1 photo that failed\. Jobs: J-1, J-2, K-9\.\n\nExport the 4 photos first\?/);
    expect(ask.mock.calls[1][0]).toMatch(/Signing out removes them from this device for good\.\n\nNot uploaded: 3 photos waiting to upload, 1 photo that failed/);
    expect(exportPhotos).not.toHaveBeenCalled();
    expect(await blobsLeft(w.all)).toBe(4);
    expect(await rejectedEntries(alice)).toHaveLength(1);
  });

  it("OK exports the photos, then OK removes them (and only then are they wiped)", async () => {
    const w = await world();
    const exportPhotos = vi.fn<(photos: { blobKey: string }[]) => Promise<number>>(async (photos) => photos.length);
    expect(await confirmUnsyncedDiscard("Signing out", offline, () => true, { everything: true, exportPhotos })).toBe(true);
    expect(exportPhotos.mock.calls[0][0].map((p) => p.blobKey).sort()).toEqual(w.all.map((op) => op.blobKey).sort());
    expect(await blobsLeft(w.all)).toBe(4); // asking removes nothing; the sign-out's wipe does
    expect(await wipeAllOffline()).toBe(4);
    expect(data.size).toBe(0);
  });

  it("a held photo alone (nothing waiting) is still asked about", async () => {
    await queue(alice, photo());
    await fail(alice);
    setOfflineScope(alice);
    const ask = vi.fn<(m: string) => boolean>(() => false);
    expect(await confirmUnsyncedDiscard("Signing out", offline, ask, { everything: true, exportPhotos: async () => 0 })).toBe(false);
    expect(ask.mock.calls[0][0]).toMatch(/Not uploaded: 1 photo that failed\./);
  });
});

describe("company switch (that company only)", () => {
  it("Cancel keeps; the other company's photo isn't counted or touched", async () => {
    const w = await world();
    const ask = vi.fn<(m: string) => boolean>(() => false);
    expect(await confirmUnsyncedDiscard("Switching company", offline, ask, { exportPhotos: async () => 0 })).toBe(false);
    expect(ask.mock.calls[1][0]).toMatch(/^3 changes made offline haven't synced yet\. Switching company removes them[\s\S]*Not uploaded: 2 photos waiting to upload, 1 photo that failed\. Jobs: J-1, J-2\./);
    expect(await blobsLeft(w.all)).toBe(4);
  });

  it("OK (after the export offer) removes only that company's photos", async () => {
    const w = await world();
    const exportPhotos = vi.fn<(photos: { blobKey: string }[]) => Promise<number>>(async () => 3);
    expect(await confirmUnsyncedDiscard("Switching company", offline, () => true, { exportPhotos })).toBe(true);
    expect(exportPhotos.mock.calls[0][0]).toHaveLength(3);
    expect(await wipeScope(alice)).toBe(3);
    expect(await blobsLeft(w.all)).toBe(1);
    expect(await pendingEntries(aliceElsewhere)).toHaveLength(1);
  });

  it("nothing waiting or held: no question", async () => {
    setOfflineScope(alice);
    const ask = vi.fn(() => false);
    expect(await confirmUnsyncedDiscard("Switching company", offline, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("forced wipe: access revoked or session ended", () => {
  it("removes everything without asking, then says once what went: counts and job numbers, never a picture", async () => {
    await world();
    await wipeOfflineData(); // what endAccess runs: the signed-in person's scope is known
    expect(await wipeAllOffline()).toBe(0);
    expect(data.size).toBe(0);
    const raw = [...session.values()].join("");
    expect(raw).not.toMatch(/blob|Bore|\\u00ff/i);
    const notice = takeDiscardedNotice();
    expect(notice).toEqual({ count: 4, photos: 4, jobNos: ["J-1", "J-2", "K-9"], others: 0 });
    expect(discardedMessage(notice!, " when your access changed")).toBe("4 offline changes that hadn't synced were removed from this device when your access changed. 4 of them were photos. Jobs: J-1, J-2, K-9. Please enter them again.");
    // The first sentence is unchanged from before 040, so the sign-in page and banner still say it word for word.
    expect(discardedMessage({ count: 1, photos: 0, jobNos: [], others: 0 }, "")).toBe("1 offline change that hadn't synced was removed from this device. Please enter it again.");
    expect(discardedMessage({ count: 1, photos: 1, jobNos: ["J-7"], others: 0 }, " when your session ended")).toBe("1 offline change that hadn't synced was removed from this device when your session ended. It was a photo. Job: J-7. Please enter it again.");
    expect(discardedMessage({ count: 3, photos: 1, jobNos: [], others: 0 }, "")).toBe("3 offline changes that hadn't synced were removed from this device. 1 of them was a photo. Please enter them again.");
    expect(takeDiscardedNotice()).toBeNull(); // said once
  });
});

describe("idle lock", () => {
  it("keeps everything: neither the idle sign-out nor the offline-age lock wipes the device", async () => {
    const w = await world();
    const idle = readFileSync(path.resolve(__dirname, "../../lib/use-idle-sign-out.ts"), "utf8");
    expect(idle).not.toMatch(/wipe/i);
    const user = readFileSync(path.resolve(__dirname, "../../lib/use-user.ts"), "utf8");
    const expiry = user.slice(user.indexOf("function armExpiry"), user.indexOf("async function endAccess"));
    expect(expiry).not.toMatch(/wipe/i);
    setOfflineScope(null); // the lock: the app is closed to the person, the store is left alone
    expect(await blobsLeft(w.all)).toBe(4);
    expect(await rejectedEntries(alice)).toHaveLength(1);
  });
});

describe("a photo the server's copy didn't match", () => {
  const rpc = (answers: Record<string, { data?: unknown; error?: { message: string; hint?: string } | null }>) => ({
    rpc: async (fn: string) => ({ data: answers[fn]?.data ?? null, error: answers[fn]?.error ?? null }),
  });
  const conflict = { upload: async () => ({ error: { message: "The resource already exists", statusCode: "409" } }) };
  const blob = new Blob([JPEG], { type: "image/jpeg" });

  it("409 + finalise marks it abandoned: held with code photo_mismatch and a clear reason, not queued again", async () => {
    const op = photo();
    const outcome = await executePhotoOp(op, rpc({ reserve_job_photo: { data: { state: "reserved", storage_path: "p" } }, finalise_job_photo: { data: { state: "abandoned", error: "photo_mismatch" } } }), conflict, blob);
    expect(outcome).toEqual({ status: "rejected", code: "photo_mismatch", reason: PHOTO_MISMATCH_REASON });
    const abandoned = await executePhotoOp(op, rpc({ reserve_job_photo: { error: { message: "x", hint: "photo_abandoned" } } }), conflict, blob);
    expect(abandoned).toMatchObject({ status: "rejected", code: "photo_abandoned" });
    const limited = await executePhotoOp(op, rpc({ reserve_job_photo: { error: { message: "x", hint: "photo_rate_limited" } } }), conflict, blob);
    // Too many photos this hour: deferred like a lost connection (stays queued, the sync loop tries again later), never held.
    expect(limited).toEqual({ status: "network" });
  });

  it("an upload interrupted before the object exists stays queued (finalise: not uploaded yet)", async () => {
    const outcome = await executePhotoOp(photo(), rpc({ reserve_job_photo: { data: { state: "reserved", storage_path: "p" } }, finalise_job_photo: { error: { message: "x", hint: "photo_not_uploaded" } } }), { upload: async () => ({ error: null }) }, blob);
    expect(outcome).toEqual({ status: "network" });
  });

  it("Retry sends it again under a NEW photo id with the same note and bytes; a plain refusal keeps its id", async () => {
    const op = await queue(alice, photo());
    await replayOutbox(alice, async () => ({ status: "rejected", code: "photo_mismatch", reason: PHOTO_MISMATCH_REASON }));
    const [held] = await rejectedEntries(alice);
    expect(held).toMatchObject({ code: "photo_mismatch", reason: PHOTO_MISMATCH_REASON });
    expect(await retryHeld(alice, held.id)).toBe(true);
    const [back] = await pendingEntries(alice);
    expect(back.op).toMatchObject({ kind: "photo", note: "Bore", blobKey: op.blobKey, jobId: op.jobId, byteSize: op.byteSize });
    expect((back.op as PhotoOp).photoId).not.toBe(op.photoId);
    expect(await readAttachment(op.blobKey)).not.toBeNull();
    const plain = await queue(aliceElsewhere, photo(aliceElsewhere));
    await fail(aliceElsewhere);
    await retryHeld(aliceElsewhere, (await rejectedEntries(aliceElsewhere))[0].id);
    expect(((await pendingEntries(aliceElsewhere))[0].op as PhotoOp).photoId).toBe(plain.photoId);
  });
});

describe("a shared tablet: another person's unsynced work", () => {
  const bob = { userId: "user-b", orgId: "org-9" };
  async function shared() {
    const mine = await queue(alice, photo(alice, "J-1"));
    const theirs = await queue(bob, photo(bob, "B-SECRET-1"));
    await fail(bob);
    await queue(bob, photo(bob, "B-SECRET-2"));
    setOfflineScope(alice);
    return { mine, theirs };
  }

  it("sign-out describes and exports only the signed-in person's work; other people's is not mentioned, counted or removed", async () => {
    const { mine, theirs } = await shared();
    const ask = vi.fn<(m: string) => boolean>(() => true);
    const exportPhotos = vi.fn<(photos: { blobKey: string }[]) => Promise<number>>(async (photos) => photos.length);
    expect(await confirmUnsyncedDiscard("Signing out", offline, ask, { everything: true, exportPhotos })).toBe(true);
    const said = ask.mock.calls.map((call) => call[0]).join("\n");
    expect(said).not.toMatch(/B-SECRET|that failed|other people/);
    expect(ask.mock.calls[0][0]).toMatch(/^1 change made offline hasn't synced yet\.\n\nNot uploaded: 1 photo waiting to upload\. Job: J-1\.\n\nExport the photo first\?/);
    expect(ask.mock.calls[1][0]).toMatch(/Signing out removes it from this device for good\.[\s\S]*\n\nPress Cancel/);
    expect(exportPhotos.mock.calls[0][0].map((p) => p.blobKey)).toEqual([mine.blobKey]);
    // The wipe removes the person's own work only; the other person's queue and bytes stay.
    await wipeOfflineData(await unsyncedIdsForUser(alice.userId));
    expect(await pendingEntries(alice)).toEqual([]);
    expect(await readAttachment(theirs.blobKey)).not.toBeNull();
    expect(await rejectedEntries({ userId: "user-b", orgId: "org-9" })).toHaveLength(1);
    const notice = takeDiscardedNotice()!;
    expect(notice).toEqual({ count: 1, photos: 1, jobNos: ["J-1"], others: 0 });
    expect(JSON.stringify(notice)).not.toMatch(/B-SECRET/);
  });

  it("only other people's work on the device: nothing to ask, nothing removed", async () => {
    await shared();
    await replayOutbox(alice, async () => ({ status: "applied" }));
    const ask = vi.fn<(m: string) => boolean>(() => false);
    expect(await confirmUnsyncedDiscard("Signing out", offline, ask, { everything: true, exportPhotos: async () => 0 })).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    const before = data.size;
    await wipeOfflineData(await unsyncedIdsForUser(alice.userId));
    expect([...data.keys()].filter((k) => k.startsWith("u:user-b|")).length).toBeGreaterThan(0);
    expect(data.size).toBeLessThanOrEqual(before);
  });

  it("a company switch never counts or names another person's work", async () => {
    await shared();
    const ask = vi.fn<(m: string) => boolean>(() => false);
    expect(await confirmUnsyncedDiscard("Switching company", offline, ask, { exportPhotos: async () => 0 })).toBe(false);
    expect(ask.mock.calls.map((call) => call[0]).join("\n")).not.toMatch(/B-SECRET|other people/);
  });
});

describe("HEIC", () => {
  it("is refused with the settings hint", () => {
    expect(isHeic(new File([JPEG], "IMG_1.HEIC", { type: "" }))).toBe(true);
    expect(isHeic(new Blob([JPEG], { type: "image/heif" }))).toBe(true);
    expect(isHeic(new File([JPEG], "IMG_1.jpg", { type: "image/jpeg" }))).toBe(false);
    expect(HEIC_MESSAGE).toBe("iPhone HEIC photos can't be added yet: set Camera > Formats > Most Compatible, or pick a JPEG.");
  });
});
