/**
 * Job photos in the offline outbox (lib/offline, migration 040): the picture is stored once, in the same atomic step as its
 * entry; it is "waiting" only once both are durable; replay is reserve -> upload the exact object -> finalise, and every step
 * repeats safely (the same photo id means the same photo, never a second one); an applied photo's bytes go, a refused photo
 * keeps them for export or retry; discard removes both.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportFileName } from "@/lib/job-photos";
import { attachmentKeys, discardPending, dismissHeld, enqueue, pendingEntries, photoBlobKey, readAttachment, rejectedEntries, replayOutbox, retryHeld, type PhotoOp } from "@/lib/offline/outbox";
import { executePhotoOp } from "@/lib/offline/sync";
import { memoryBackend, scopeKey, setOfflineBackend, setSupportSession, wipeScope } from "@/lib/offline/store";

const alice = { userId: "user-a", orgId: "org-1" };
const bob = { userId: "user-b", orgId: "org-1" };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0, 2, 0xff, 0xd9]);
const blob = () => new Blob([JPEG], { type: "image/jpeg" });
const photo = (photoId = "11111111-1111-4111-8111-111111111111", scope = alice): PhotoOp => ({ kind: "photo", photoId, jobId: "job-1", jobNo: "J-0001", note: "Bore", capturedAt: "2026-10-13T08:00:00Z", byteSize: JPEG.length, blobKey: photoBlobKey(scope, photoId) });

let data: Map<string, unknown>;
beforeEach(() => { data = new Map(); setOfflineBackend(memoryBackend(data)); setSupportSession(false); });
afterEach(() => { setOfflineBackend(null); setSupportSession(false); });

describe("the queued photo", () => {
  it("is stored once, with its bytes, in one step; the entry carries what the server needs", async () => {
    const op = photo();
    const entry = await enqueue(alice, op, new Date("2026-10-13T09:00:00Z"), { [op.blobKey]: blob() });
    expect(entry.op).toEqual({ kind: "photo", photoId: op.photoId, jobId: "job-1", jobNo: "J-0001", note: "Bore", capturedAt: "2026-10-13T08:00:00Z", byteSize: 8, blobKey: `${scopeKey(alice)}|blob:${op.photoId}` });
    expect(await pendingEntries(alice)).toEqual([entry]);
    const stored = await readAttachment<Blob>(op.blobKey);
    expect(stored?.size).toBe(8);
    expect(attachmentKeys(op)).toEqual([op.blobKey]);
    // One key for the bytes, under the scope prefix.
    expect([...data.keys()].filter((k) => k.includes("|blob:"))).toEqual([op.blobKey]);
    expect(op.blobKey.startsWith(`${scopeKey(alice)}|`)).toBe(true);
  });

  it("refuses bytes that don't belong to the change, and the same photo queued twice stays one entry", async () => {
    const op = photo();
    await expect(enqueue(alice, op, new Date(), { "somewhere-else": blob() })).rejects.toThrow("must belong to the change");
    expect(await pendingEntries(alice)).toEqual([]);
    await enqueue(alice, op, new Date(), { [op.blobKey]: blob() });
    await enqueue(alice, op, new Date(), { [op.blobKey]: blob() });
    expect(await pendingEntries(alice)).toHaveLength(1);
  });

  it("is not kept in a support session, and nothing is written", async () => {
    setSupportSession(true);
    const op = photo();
    await expect(enqueue(alice, op, new Date(), { [op.blobKey]: blob() })).rejects.toThrow(/Support access/);
    expect(data.size).toBe(0);
  });

  it("goes with its scope when the scope is wiped, and is left alone by a wipe of another person's scope", async () => {
    const mine = photo();
    const theirs = photo("22222222-2222-4222-8222-222222222222", bob);
    await enqueue(alice, mine, new Date(), { [mine.blobKey]: blob() });
    await enqueue(bob, theirs, new Date(), { [theirs.blobKey]: blob() });
    expect(await wipeScope(bob)).toBe(1);
    expect(await readAttachment(theirs.blobKey)).toBeNull();
    expect(await readAttachment<Blob>(mine.blobKey)).not.toBeNull();
    expect(await pendingEntries(alice)).toHaveLength(1);
  });
});

describe("replay outcomes and the bytes", () => {
  it("applied: the entry and its bytes are removed together", async () => {
    const op = photo();
    await enqueue(alice, op, new Date(), { [op.blobKey]: blob() });
    const result = await replayOutbox(alice, async () => ({ status: "applied" }));
    expect(result).toMatchObject({ applied: 1, remaining: 0 });
    expect(await pendingEntries(alice)).toEqual([]);
    expect(await readAttachment(op.blobKey)).toBeNull();
    expect([...data.keys()].filter((k) => k.includes("|blob:"))).toEqual([]);
  });

  it("network: the entry stays queued with its bytes; rejected: held with the reason, bytes kept; retry puts it back; dismiss removes both", async () => {
    const op = photo();
    await enqueue(alice, op, new Date(), { [op.blobKey]: blob() });
    await replayOutbox(alice, async () => ({ status: "network" }));
    expect(await pendingEntries(alice)).toHaveLength(1);
    expect(await readAttachment<Blob>(op.blobKey)).not.toBeNull();

    await replayOutbox(alice, async () => ({ status: "rejected", reason: "This photo was removed, so it can't be uploaded." }));
    expect(await pendingEntries(alice)).toEqual([]);
    const [held] = await rejectedEntries(alice);
    expect(held).toMatchObject({ reason: "This photo was removed, so it can't be uploaded.", op: { kind: "photo", photoId: op.photoId } });
    expect(await readAttachment<Blob>(op.blobKey)).not.toBeNull();

    expect(await retryHeld(alice, held.id)).toBe(true);
    expect(await retryHeld(alice, held.id)).toBe(false);
    expect(await rejectedEntries(alice)).toEqual([]);
    expect((await pendingEntries(alice)).map((e) => e.id)).toEqual([held.id]);

    await replayOutbox(alice, async () => ({ status: "rejected", reason: "still refused" }));
    await dismissHeld(alice, "rejected", held.id);
    expect(await rejectedEntries(alice)).toEqual([]);
    expect(await readAttachment(op.blobKey)).toBeNull();
  });

  it("discarding a waiting photo removes the entry and its bytes; other entries are untouched", async () => {
    const first = photo();
    const second = photo("33333333-3333-4333-8333-333333333333");
    await enqueue(alice, first, new Date(), { [first.blobKey]: blob() });
    await enqueue(alice, second, new Date(), { [second.blobKey]: blob() });
    const [a] = await pendingEntries(alice);
    await discardPending(alice, a.id);
    expect((await pendingEntries(alice)).map((e) => (e.op as PhotoOp).photoId)).toEqual([second.photoId]);
    expect(await readAttachment(first.blobKey)).toBeNull();
    expect(await readAttachment<Blob>(second.blobKey)).not.toBeNull();
  });

  it("names the exported file after the job and the photo", () => {
    expect(exportFileName({ jobNo: "J-0001", photoId: "11111111-1111-4111-8111-111111111111" })).toBe("photo-J-0001-11111111.jpg");
    expect(exportFileName({ jobNo: "J/1 x", photoId: "abcdef12-0000-4000-8000-000000000000" })).toBe("photo-J_1_x-abcdef12.jpg");
  });
});

/** A fake server: one row per photo id, one object per path, every call recorded. */
function fakeServer(options: { removed?: boolean; uploadFails?: "network" | "duplicate" | null; finaliseBeforeObject?: boolean } = {}) {
  const calls: string[] = [];
  const rows = new Map<string, { state: "reserved" | "uploaded"; path: string; removed: boolean }>();
  const objects = new Map<string, number>();
  let uploads = 0;
  const client = {
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push(fn);
      const id = String(args.p_id);
      if (fn === "reserve_job_photo") {
        if (options.removed) return { data: null, error: { message: "This photo was removed, so it can't be uploaded.", code: "42501", hint: "photo_removed" } };
        const row = rows.get(id) ?? { state: "reserved" as const, path: `org/job/photos/${id}.jpg`, removed: false };
        rows.set(id, row);
        return { data: { photo_id: id, state: row.state, storage_path: row.path, byte_size: args.p_byte_size }, error: null };
      }
      if (fn === "finalise_job_photo") {
        const row = rows.get(id);
        if (!row) return { data: null, error: { message: "Photo not found", code: "P0002" } };
        if (row.state === "uploaded") return { data: { photo_id: id, state: "uploaded" }, error: null };
        if (!objects.has(row.path)) return { data: null, error: { message: "The photo hasn't been uploaded yet.", code: "22023", hint: "photo_not_uploaded" } };
        row.state = "uploaded";
        return { data: { photo_id: id, state: "uploaded" }, error: null };
      }
      return { data: null, error: { message: `unknown ${fn}` } };
    },
  };
  const store = {
    async upload(path: string, body: Blob) {
      calls.push(`upload ${path}`);
      uploads += 1;
      if (options.uploadFails === "network") return { error: { message: "Failed to fetch" } };
      if (options.uploadFails === "duplicate" || objects.has(path)) return { error: { message: "The resource already exists", statusCode: "409" } };
      objects.set(path, body.size);
      return { error: null };
    },
  };
  return { client, store, calls, rows, objects, uploads: () => uploads };
}

describe("executePhotoOp: reserve, upload the exact object, finalise", () => {
  it("a fresh photo goes through the three steps in order and is applied; the server has one row and one object", async () => {
    const server = fakeServer();
    const op = photo();
    expect(await executePhotoOp(op, server.client, server.store, blob())).toEqual({ status: "applied" });
    expect(server.calls).toEqual(["reserve_job_photo", `upload org/job/photos/${op.photoId}.jpg`, "finalise_job_photo"]);
    expect(server.rows.get(op.photoId)).toMatchObject({ state: "uploaded" });
    expect(server.objects.size).toBe(1);
  });

  it("the same photo replayed again (a lost answer, a second tab) adds nothing: reserve answers 'uploaded' and the upload is skipped", async () => {
    const server = fakeServer();
    const op = photo();
    await executePhotoOp(op, server.client, server.store, blob());
    expect(await executePhotoOp(op, server.client, server.store, blob())).toEqual({ status: "applied" });
    expect(server.calls.slice(3)).toEqual(["reserve_job_photo", "finalise_job_photo"]);
    expect(server.rows.size).toBe(1);
    expect(server.objects.size).toBe(1);
    expect(server.uploads()).toBe(1);
  });

  it("an upload that landed although its answer was lost (409 on the retry) is taken as done, and finalise checks it", async () => {
    const server = fakeServer({ uploadFails: "duplicate" });
    const op = photo();
    server.rows.set(op.photoId, { state: "reserved", path: `org/job/photos/${op.photoId}.jpg`, removed: false });
    server.objects.set(`org/job/photos/${op.photoId}.jpg`, JPEG.length);
    expect(await executePhotoOp(op, server.client, server.store, blob())).toEqual({ status: "applied" });
    expect(server.calls).toEqual(["reserve_job_photo", `upload org/job/photos/${op.photoId}.jpg`, "finalise_job_photo"]);
  });

  it("a connection lost during the upload keeps the entry queued (network), and so does finalise before the object landed", async () => {
    const op = photo();
    const lost = fakeServer({ uploadFails: "network" });
    expect(await executePhotoOp(op, lost.client, lost.store, blob())).toEqual({ status: "network" });
    expect(lost.rows.get(op.photoId)).toMatchObject({ state: "reserved" });
    expect(lost.calls).not.toContain("finalise_job_photo");
    // The server answers finalise with "not uploaded yet" (hint photo_not_uploaded): the upload has to be sent again, so the entry stays.
    const early = fakeServer();
    early.store.upload = async (path: string) => { early.calls.push(`upload ${path}`); return { error: null }; }; // pretends to succeed, stores nothing
    expect(await executePhotoOp(op, early.client, early.store, blob())).toEqual({ status: "network" });
  });

  it("a removed photo is refused for good, with the server's reason; missing bytes are refused too", async () => {
    const server = fakeServer({ removed: true });
    const op = photo();
    expect(await executePhotoOp(op, server.client, server.store, blob())).toEqual({ status: "rejected", reason: "This photo was removed, so it can't be uploaded." });
    expect(server.calls).toEqual(["reserve_job_photo"]);
    const fresh = fakeServer();
    expect(await executePhotoOp(op, fresh.client, fresh.store, null)).toMatchObject({ status: "rejected", reason: expect.stringMatching(/no longer on this device/) });
    expect(fresh.calls).toEqual([]);
  });
});
