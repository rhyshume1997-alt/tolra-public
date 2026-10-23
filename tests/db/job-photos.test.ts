/**
 * Job photos (migration 040): reserve -> upload the exact object -> finalise, against the real database and Storage of the
 * local stack. Who may add, see and remove; viewers denied in the table and in Storage; the other company sees and gets
 * nothing; finalise and reserve are idempotent (the photo id is the key); a removed photo can't be brought back by a late
 * retry; the server records who and when; the /photos/ prefix is locked in Storage (only the reserved object, no read, move,
 * copy, overwrite or delete); read-only support is refused; the release verify script holds.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generatePassword } from "@/lib/password";

import { JPEG_4x2, JPEG_64x32 } from "../support/exif";
import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { enrolTotp, passSecondStep } from "../support/totp";

const BUCKET = "job-photos";
const DRAWINGS = "job-drawings";
const JPEG = JPEG_4x2;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
const org = () => world.tenants.alpha.id;
const service = () => adminClient();
const jobs: string[] = [];

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
});

afterAll(async () => {
  if (!world) return;
  // The browser roles can't delete under /photos/ (that is the point); the service role cleans the disposable stack.
  for (const job of jobs) {
    for (const tenant of [world.tenants.alpha.id, world.tenants.beta.id]) {
      const listed = await service().storage.from(BUCKET).list(`${tenant}/${job}/photos`, { limit: 200 });
      const names = (listed.data ?? []).map((o) => `${tenant}/${job}/photos/${o.name}`);
      if (names.length) await service().storage.from(BUCKET).remove(names);
    }
  }
  await destroySyntheticWorld(world.runId);
});

let n = 0;
async function newJob(tenant = org()) {
  n += 1;
  const { data, error } = await service().from("jobs").insert({ organization_id: tenant, job_no: `J-PH-${world.runId}-${n}`, customer: "Photo Co", description: "Bracket" }).select("id").single();
  if (error) throw new Error(error.message);
  jobs.push(data.id as string);
  return data.id as string;
}
const reserve = (client: SupabaseClient, id: string, job: string, extra: Record<string, unknown> = {}) =>
  client.rpc("reserve_job_photo", { p_id: id, p_job: job, p_note: "Bore after finishing", p_captured_at: "2026-10-13T08:00:00Z", p_byte_size: JPEG.length, ...extra });
const upload = (client: SupabaseClient, storagePath: string, body: Buffer = JPEG, contentType = "image/jpeg", upsert = false) =>
  client.storage.from(BUCKET).upload(storagePath, body, { contentType, upsert });
const finalise = (client: SupabaseClient, id: string) => client.rpc("finalise_job_photo", { p_id: id });
const remove = (client: SupabaseClient, id: string) => client.rpc("remove_job_photo", { p_id: id });
const pathOf = (job: string, id: string, tenant = org()) => `${tenant}/${job}/photos/${id}.jpg`;
const row = async (id: string) => (await service().from("job_files").select("*").eq("id", id).maybeSingle()).data as Record<string, unknown> | null;
const outcome = (r: { error: { code?: string; message: string; hint?: string | null } | null; data?: unknown }) => (r.error ? { code: r.error.code, message: r.error.message, hint: r.error.hint ?? undefined } : "ok");
const events = (id: string, action: string) => withDb(async (db) => (await db.query("select actor_user_id, metadata from security_audit.audit_log where action = $1 and metadata ->> 'photo_id' = $2 order by created_at", [action, id])).rows);

/** A full add as `client`: reserve, upload, finalise. Returns the photo id. */
async function addPhoto(client: SupabaseClient, job: string) {
  const id = randomUUID();
  const reserved = await reserve(client, id, job);
  expect(outcome(reserved)).toBe("ok");
  expect(reserved.data).toMatchObject({ photo_id: id, state: "reserved", storage_path: pathOf(job, id), byte_size: JPEG.length });
  expect(outcome(await upload(client, pathOf(job, id)))).toBe("ok");
  const done = await finalise(client, id);
  expect(outcome(done)).toBe("ok");
  expect(done.data).toMatchObject({ photo_id: id, state: "uploaded" });
  return id;
}

describe("who adds, sees and removes", () => {
  it("admin, office and workshop add a photo; the server records who and when; all three see it; viewers see none and can't add", async () => {
    const job = await newJob();
    const before = Date.now();
    const ids: Record<string, string> = {};
    for (const role of ["admin", "office", "workshop"] as const) {
      ids[role] = await addPhoto(as[role], job);
      const stored = await row(ids[role]);
      expect(stored).toMatchObject({
        kind: "photo", organization_id: org(), job_id: job, storage_bucket: BUCKET, storage_path: pathOf(job, ids[role]), ref: "photo", file_name: `${ids[role]}.jpg`,
        note: "Bore after finishing", captured_at: "2026-10-13T08:00:00+00:00", mime_type: "image/jpeg", byte_size: JPEG.length, upload_state: "uploaded", deleted_at: null, deleted_by: null,
        created_by: world.tenants.alpha.users[role].id, revision: null,
      });
      expect(Math.abs(new Date(stored!.created_at as string).getTime() - before)).toBeLessThan(60_000);
      expect(new Date(stored!.uploaded_at as string).getTime()).toBeGreaterThanOrEqual(new Date(stored!.created_at as string).getTime());
      // The history says who added it, in the same transaction as the row.
      const added = await events(ids[role], "ADD_PHOTO");
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ actor_user_id: world.tenants.alpha.users[role].id, metadata: expect.objectContaining({ note: "Bore after finishing", byte_size: JPEG.length }) });
    }
    for (const role of ["admin", "office", "workshop"]) {
      const seen = await as[role].from("job_files").select("id").eq("job_id", job).eq("kind", "photo");
      expect(seen.error).toBeNull();
      expect(seen.data!.map((r) => r.id).sort()).toEqual(Object.values(ids).sort());
    }
    // Viewer: no rows, and no way to add one.
    expect((await as.viewer.from("job_files").select("id").eq("job_id", job)).data).toEqual([]);
    const viewerId = randomUUID();
    expect(outcome(await reserve(as.viewer, viewerId, job))).toMatchObject({ code: "42501" });
    expect(outcome(await upload(as.viewer, pathOf(job, viewerId)))).not.toBe("ok");
    expect(outcome(await finalise(as.viewer, viewerId))).toMatchObject({ code: "42501" });
    expect(await row(viewerId)).toBeNull();
    // A viewer still sees drawings and certs.
    expect((await service().from("job_files").insert({ organization_id: org(), job_id: job, kind: "cert", ref: "Heat 1", file_name: "c.png", storage_bucket: DRAWINGS, storage_path: `${org()}/${job}/certs/1-c.png` })).error).toBeNull();
    expect((await as.viewer.from("job_files").select("kind").eq("job_id", job)).data).toEqual([{ kind: "cert" }]);
  });

  it("office and admin remove a photo (marker, recorded, bytes kept); the workshop can't; removing again changes nothing", async () => {
    const job = await newJob();
    const id = await addPhoto(as.workshop, job);
    expect(outcome(await remove(as.workshop, id))).toMatchObject({ code: "42501", message: "Only admin and office staff remove photos." });
    expect(outcome(await remove(as.viewer, id))).toMatchObject({ code: "42501" });
    expect(await row(id)).toMatchObject({ deleted_at: null });
    const removed = await remove(as.office, id);
    expect(outcome(removed)).toBe("ok");
    expect(removed.data).toMatchObject({ photo_id: id, state: "removed" });
    const after = await row(id);
    expect(after).toMatchObject({ upload_state: "uploaded", deleted_by: world.tenants.alpha.users.office.id });
    expect(after!.deleted_at).toBeTruthy();
    // The row stays (soft delete), the bytes stay, the history has the removal.
    const listed = await service().storage.from(BUCKET).list(`${org()}/${job}/photos`);
    expect((listed.data ?? []).map((o) => o.name)).toEqual([`${id}.jpg`]);
    const log = await events(id, "REMOVE_PHOTO");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor_user_id: world.tenants.alpha.users.office.id, metadata: expect.objectContaining({ was_uploaded: true, added_by: world.tenants.alpha.users.workshop.id }) });
    // Again: the first marker is kept, no second event.
    const again = await remove(as.admin, id);
    expect(again.data).toMatchObject({ state: "removed", deleted_at: after!.deleted_at });
    expect(await row(id)).toMatchObject({ deleted_by: world.tenants.alpha.users.office.id, deleted_at: after!.deleted_at });
    expect(await events(id, "REMOVE_PHOTO")).toHaveLength(1);
    // Admin removes one of their own too.
    const mine = await addPhoto(as.admin, job);
    expect(outcome(await remove(as.admin, mine))).toBe("ok");
  });
});

describe("idempotency: the photo id is the key", () => {
  it("finalise twice gives one uploaded photo and one ADD_PHOTO; reserve again returns the row as it is, never a second one", async () => {
    const job = await newJob();
    const id = randomUUID();
    expect(outcome(await reserve(as.workshop, id, job))).toBe("ok");
    const again = await reserve(as.workshop, id, job, { p_note: "a different note on the retry" });
    expect(again.data).toMatchObject({ photo_id: id, state: "reserved", storage_path: pathOf(job, id) });
    expect(await row(id)).toMatchObject({ note: "Bore after finishing" }); // the first reservation's values stay
    expect(outcome(await upload(as.workshop, pathOf(job, id)))).toBe("ok");
    const first = await finalise(as.workshop, id);
    const second = await finalise(as.workshop, id);
    expect(outcome(first)).toBe("ok");
    expect(outcome(second)).toBe("ok");
    expect(second.data).toMatchObject({ photo_id: id, state: "uploaded", uploaded_at: (first.data as { uploaded_at: string }).uploaded_at });
    expect((await reserve(as.workshop, id, job)).data).toMatchObject({ state: "uploaded" });
    expect((await service().from("job_files").select("id").eq("job_id", job).eq("kind", "photo")).data).toHaveLength(1);
    expect(await events(id, "ADD_PHOTO")).toHaveLength(1);
    // A reserve with that id for another job, or by another person, is refused (the row is not touched).
    expect(outcome(await reserve(as.workshop, id, await newJob()))).toMatchObject({ code: "22023", message: "That photo id is already in use." });
    expect(outcome(await reserve(as.office, id, job))).toMatchObject({ code: "22023" });
    expect(outcome(await finalise(as.office, id))).toMatchObject({ code: "42501", message: "Only the person who took this photo finishes uploading it." });
    expect(await row(id)).toMatchObject({ job_id: job, created_by: world.tenants.alpha.users.workshop.id, upload_state: "uploaded" });
  });

  it("a removed photo can't be brought back by a late retry: finalise and reserve on its id are refused, and so is an upload to its path", async () => {
    const job = await newJob();
    // Uploaded, then removed while a stale device still holds the op.
    const id = await addPhoto(as.workshop, job);
    expect(outcome(await remove(as.office, id))).toBe("ok");
    expect(outcome(await finalise(as.workshop, id))).toMatchObject({ code: "42501", message: "This photo was removed, so it can't be uploaded.", hint: "photo_removed" });
    expect(outcome(await reserve(as.workshop, id, job))).toMatchObject({ code: "42501", hint: "photo_removed" });
    expect(await row(id)).toMatchObject({ upload_state: "uploaded", deleted_by: world.tenants.alpha.users.office.id });
    expect(await events(id, "ADD_PHOTO")).toHaveLength(1);
    // Reserved but never uploaded, then removed: the object can't even be put there, and finalise is refused.
    const pending = randomUUID();
    expect(outcome(await reserve(as.workshop, pending, job))).toBe("ok");
    expect(outcome(await remove(as.admin, pending))).toBe("ok");
    expect(outcome(await upload(as.workshop, pathOf(job, pending)))).not.toBe("ok");
    expect(outcome(await finalise(as.workshop, pending))).toMatchObject({ code: "42501", hint: "photo_removed" });
    expect(await row(pending)).toMatchObject({ upload_state: "reserved" });
    expect(await events(pending, "ADD_PHOTO")).toHaveLength(0);
    expect((await service().storage.from(BUCKET).list(`${org()}/${job}/photos`)).data!.map((o) => o.name)).toEqual([`${id}.jpg`]);
  });

  it("finalise before the object landed says so (hint photo_not_uploaded) and leaves the reservation; the wrong object is refused", async () => {
    const job = await newJob();
    const id = randomUUID();
    expect(outcome(await reserve(as.office, id, job))).toBe("ok");
    expect(outcome(await finalise(as.office, id))).toMatchObject({ code: "22023", hint: "photo_not_uploaded" });
    expect(await row(id)).toMatchObject({ upload_state: "reserved" });
    // A PNG at the reserved path: Storage refuses it at upload (the bucket takes image/jpeg only), so nothing is stored.
    expect(outcome(await upload(as.office, pathOf(job, id), PNG, "image/png"))).not.toBe("ok");
    expect(outcome(await finalise(as.office, id))).toMatchObject({ code: "22023", hint: "photo_not_uploaded" });
    // The interrupted upload completes later: same id, one photo, one ADD_PHOTO.
    expect(outcome(await upload(as.office, pathOf(job, id)))).toBe("ok");
    expect((await finalise(as.office, id)).data).toMatchObject({ photo_id: id, state: "uploaded" });
    expect(await events(id, "ADD_PHOTO")).toHaveLength(1);
    // A JPEG of the wrong size at a reserved path (a 409 on the device's retry would point at it): finalise refuses it, marks the
    // row abandoned (kept: not rolled back), writes no ADD_PHOTO, and the id can't be finalised or reserved again.
    const other = randomUUID();
    expect(outcome(await reserve(as.office, other, job))).toBe("ok");
    expect(outcome(await upload(as.office, pathOf(job, other), JPEG_64x32))).toBe("ok");
    expect((await finalise(as.office, other)).data).toMatchObject({ photo_id: other, state: "abandoned", error: "photo_mismatch", message: expect.stringMatching(new RegExp(`JPEG of ${JPEG.length} bytes`)) });
    expect(await row(other)).toMatchObject({ upload_state: "abandoned", mime_type: null, uploaded_at: null });
    expect(outcome(await finalise(as.office, other))).toMatchObject({ code: "22023", hint: "photo_abandoned" });
    expect(outcome(await reserve(as.office, other, job))).toMatchObject({ code: "22023", hint: "photo_abandoned" });
    expect(await events(other, "ADD_PHOTO")).toHaveLength(0);
    // The refusal is in the history, once, with what was reserved and what was found (the marker and this row commit together).
    expect(await events(other, "PHOTO_MISMATCH")).toEqual([{ actor_user_id: world.tenants.alpha.users.office.id,
      metadata: expect.objectContaining({ photo_id: other, reserved_byte_size: JPEG.length, stored_size: JPEG_64x32.length, stored_mime: "image/jpeg" }) }]);
    for (const role of ["admin", "office", "workshop", "viewer"]) {
      expect((await as[role].storage.from(BUCKET).download(pathOf(job, other))).error, role).not.toBeNull();
      expect((await as[role].storage.from(BUCKET).createSignedUrl(pathOf(job, other), 60)).error, role).not.toBeNull();
    }
    // It can't be replaced with the right one either, so the device sends the photo under a NEW id (same note and bytes).
    expect(outcome(await upload(as.office, pathOf(job, other), JPEG, "image/jpeg", true))).not.toBe("ok");
    const renewed = await addPhoto(as.office, job);
    expect(await row(renewed)).toMatchObject({ note: "Bore after finishing", upload_state: "uploaded" });
  });

  it("two concurrent finalises of the same photo give one uploaded photo and exactly one ADD_PHOTO", async () => {
    const job = await newJob();
    const id = randomUUID();
    expect(outcome(await reserve(as.workshop, id, job))).toBe("ok");
    expect(outcome(await upload(as.workshop, pathOf(job, id)))).toBe("ok");
    const second = await signedInClient(world.tenants.alpha.users.workshop);
    const results = await Promise.all([finalise(as.workshop, id), finalise(second, id), finalise(as.workshop, id)]);
    expect(results.map(outcome)).toEqual(["ok", "ok", "ok"]);
    const uploadedAt = new Set(results.map((r) => (r.data as { uploaded_at: string }).uploaded_at));
    expect(uploadedAt.size).toBe(1);
    expect((await service().from("job_files").select("id").eq("job_id", job).eq("kind", "photo")).data).toHaveLength(1);
    expect(await events(id, "ADD_PHOTO")).toHaveLength(1);
  });

  it("reserve checks the size and the job; the device's taken-at time is kept unless it is in the future", async () => {
    const job = await newJob();
    expect(outcome(await reserve(as.workshop, randomUUID(), job, { p_byte_size: 0 }))).toMatchObject({ code: "22023", message: "A photo is a JPEG of up to 2 MB." });
    expect(outcome(await reserve(as.workshop, randomUUID(), job, { p_byte_size: 2097153 }))).toMatchObject({ code: "22023" });
    expect(outcome(await reserve(as.workshop, randomUUID(), job, { p_byte_size: null }))).toMatchObject({ code: "22023" });
    expect(outcome(await reserve(as.workshop, randomUUID(), randomUUID()))).toMatchObject({ code: "P0002", message: "Job not found" });
    expect(outcome(await reserve(as.workshop, null as unknown as string, job))).toMatchObject({ code: "22023" });
    const future = randomUUID();
    expect(outcome(await reserve(as.workshop, future, job, { p_captured_at: "2099-01-01T00:00:00Z", p_note: "   " }))).toBe("ok");
    expect(await row(future)).toMatchObject({ captured_at: null, note: null, byte_size: JPEG.length });
    const long = randomUUID();
    expect(outcome(await reserve(as.workshop, long, job, { p_note: "x".repeat(600) }))).toBe("ok");
    expect((await row(long))!.note).toHaveLength(500);
  });
});

describe("the table is written only by the functions", () => {
  it("a photo row can't be inserted, changed or deleted through the API, by any role", async () => {
    const job = await newJob();
    const id = await addPhoto(as.admin, job);
    const direct = randomUUID();
    for (const role of ["admin", "office", "workshop"]) {
      const inserted = await as[role].from("job_files").insert({ id: direct, organization_id: org(), job_id: job, kind: "photo", ref: "photo", file_name: `${direct}.jpg`, storage_bucket: BUCKET, storage_path: pathOf(job, direct), byte_size: 10, upload_state: "uploaded", uploaded_at: new Date().toISOString(), mime_type: "image/jpeg" });
      expect({ role, code: inserted.error?.code }).toEqual({ role, code: "42501" });
      expect({ role, code: (await as[role].from("job_files").update({ deleted_at: null, note: "changed" }).eq("id", id)).error?.code }).toEqual({ role, code: "42501" });
      expect({ role, code: (await as[role].from("job_files").update({ upload_state: "uploaded" }).eq("id", id)).error?.code }).toEqual({ role, code: "42501" });
      expect({ role, code: (await as[role].from("job_files").update({ kind: "cert" }).eq("id", id)).error?.code }).toEqual({ role, code: "42501" });
      const deleted = await as[role].from("job_files").delete().eq("id", id).select("id");
      expect({ role, refused: deleted.error?.code === "42501" || (deleted.data ?? []).length === 0 }).toEqual({ role, refused: true });
    }
    expect(await row(direct)).toBeNull();
    expect(await row(id)).toMatchObject({ note: "Bore after finishing", kind: "photo", deleted_at: null });
    // A cert can't be turned into a photo either.
    const { data: cert } = await service().from("job_files").insert({ organization_id: org(), job_id: job, kind: "cert", ref: "Heat 2", file_name: "c.png", storage_bucket: DRAWINGS, storage_path: `${org()}/${job}/certs/2-c.png` }).select("id").single();
    expect((await as.admin.from("job_files").update({ kind: "photo" }).eq("id", cert!.id)).error?.code).toBe("42501");
  });
});

describe("the /photos/ prefix in Storage", () => {
  it("only the reserved object, by the person who reserved it; nothing under the prefix is read, listed, signed, moved, copied, overwritten or deleted", async () => {
    const job = await newJob();
    const id = await addPhoto(as.workshop, job);
    const stored = pathOf(job, id);
    // No reservation: refused, even in the person's own company folder. Someone else's reservation: refused.
    expect(outcome(await upload(as.workshop, pathOf(job, randomUUID())))).not.toBe("ok");
    const theirs = randomUUID();
    expect(outcome(await reserve(as.office, theirs, job))).toBe("ok");
    expect(outcome(await upload(as.workshop, pathOf(job, theirs)))).not.toBe("ok");
    expect(outcome(await upload(as.admin, pathOf(job, theirs)))).not.toBe("ok");
    expect((await service().storage.from(BUCKET).list(`${org()}/${job}/photos`)).data!.map((o) => o.name)).toEqual([`${id}.jpg`]);
    // A folder named photos one level deeper or shallower is not a photo path and follows 006's drawing rules; the prefix itself is locked.
    for (const role of ["admin", "office", "workshop", "viewer"]) {
      const store = as[role].storage.from(BUCKET);
      expect({ role, read: (await store.download(stored)).error === null }).toEqual({ role, read: false });
      expect({ role, signed: (await store.createSignedUrl(stored, 60)).error === null }).toEqual({ role, signed: false });
      expect({ role, listed: (await store.list(`${org()}/${job}/photos`)).data ?? [] }).toEqual({ role, listed: [] });
      expect({ role, overwritten: (await upload(as[role], stored, JPEG, "image/jpeg", true)).error === null }).toEqual({ role, overwritten: false });
      expect({ role, moved: (await store.move(stored, `${org()}/${job}/${role}-moved.jpg`)).error === null }).toEqual({ role, moved: false });
      expect({ role, movedIn: (await store.move(`${org()}/${job}/certs/none.png`, pathOf(job, randomUUID()))).error === null }).toEqual({ role, movedIn: false });
      expect({ role, copied: (await store.copy(stored, `${org()}/${job}/${role}-copy.jpg`)).error === null }).toEqual({ role, copied: false });
      expect({ role, deleted: ((await store.remove([stored])).data ?? []).length }).toEqual({ role, deleted: 0 });
    }
    // Nothing but a reserved photo path is taken in the bucket, by anyone, even in the company's own folder.
    for (const role of ["admin", "office", "workshop"]) expect({ role, other: outcome(await upload(as[role], `${org()}/${job}/${role}.jpg`)) === "ok" }).toEqual({ role, other: false });
    expect((await service().storage.from(BUCKET).list(`${org()}/${job}`)).data!.map((o) => o.name)).toEqual(["photos"]);
    const bytes = Buffer.from(await (await service().storage.from(BUCKET).download(stored)).data!.arrayBuffer());
    expect(bytes.equals(JPEG)).toBe(true);
  });

  it("a readable job-drawings file copied INTO the caller's own reserved photo path lands (Storage allows the copy) but is refused by finalise, never attached or served", async () => {
    const job = await newJob();
    const drawing = `${org()}/${job}/${Date.now()}-copy-source.png`;
    expect((await as.office.storage.from(DRAWINGS).upload(drawing, PNG, { contentType: "image/png" })).error).toBeNull();
    const id = randomUUID();
    expect(outcome(await reserve(as.office, id, job, { p_byte_size: PNG.length }))).toBe("ok");
    const copied = await as.office.storage.from(DRAWINGS).copy(drawing, pathOf(job, id), { destinationBucket: BUCKET });
    // storage-api 1.26.5 applies the bucket's size and type limits to uploads, not to a copy: the copy lands. finalise then refuses
    // it (a PNG, not the reserved JPEG): the row is abandoned, PHOTO_MISMATCH is recorded, and it is never attached or served.
    expect(copied.error).toBeNull();
    expect((await service().storage.from(BUCKET).list(`${org()}/${job}/photos`)).data!.map((o) => o.name)).toEqual([`${id}.jpg`]);
    expect((await finalise(as.office, id)).data).toMatchObject({ state: "abandoned", error: "photo_mismatch" });
    expect(await row(id)).toMatchObject({ upload_state: "abandoned", uploaded_at: null });
    expect(await events(id, "PHOTO_MISMATCH")).toEqual([{ actor_user_id: world.tenants.alpha.users.office.id, metadata: expect.objectContaining({ stored_mime: "image/png", stored_size: PNG.length }) }]);
    expect(outcome(await finalise(as.office, id))).toMatchObject({ hint: "photo_abandoned" });
    for (const role of ["admin", "office", "workshop", "viewer"]) expect({ role, read: (await as[role].storage.from(BUCKET).download(pathOf(job, id))).error === null }).toEqual({ role, read: false });
    expect(await events(id, "ADD_PHOTO")).toHaveLength(0);
    await service().storage.from(DRAWINGS).remove([drawing]);
  });

  it("drawings and certs outside the prefix work as before (034): uploaded, read and signed in the company folder", async () => {
    const job = await newJob();
    const drawing = `${org()}/${job}/${Date.now()}-bracket.png`;
    expect((await as.workshop.storage.from(DRAWINGS).upload(drawing, PNG, { contentType: "image/png" })).error).toBeNull();
    expect((await as.viewer.storage.from(DRAWINGS).createSignedUrl(drawing, 60)).error).toBeNull();
    expect((await as.workshop.from("job_files").insert({ organization_id: org(), job_id: job, kind: "drawing", ref: "bracket", file_name: "bracket.png", storage_bucket: DRAWINGS, storage_path: drawing })).error).toBeNull();
    expect((await as.viewer.from("job_files").select("kind").eq("job_id", job)).data).toEqual([{ kind: "drawing" }]);
    await service().storage.from(DRAWINGS).remove([drawing]);
  });
});

describe("the bucket's own limits, the reservation rate and abandoned reservations", () => {
  it("Storage itself refuses an object over 2 MiB and a non-JPEG content type at upload, for the browser and the service role", async () => {
    const bucket = await withDb(async (db) => (await db.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'job-photos'")).rows[0]);
    expect(bucket).toEqual({ public: false, file_size_limit: "2097152", allowed_mime_types: ["image/jpeg"] });
    const job = await newJob();
    const big = randomUUID();
    expect(outcome(await reserve(as.workshop, big, job, { p_byte_size: 2097152 }))).toBe("ok");
    const oversized = Buffer.concat([JPEG, Buffer.alloc(2097153 - JPEG.length)]);
    const refusedBig = await upload(as.workshop, pathOf(job, big), oversized);
    expect(refusedBig.error).not.toBeNull();
    expect(String((refusedBig.error as { statusCode?: string }).statusCode ?? refusedBig.error!.message)).toMatch(/413|size|exceed/i);
    const refusedType = await upload(as.workshop, pathOf(job, big), JPEG, "image/png");
    expect(refusedType.error).not.toBeNull();
    expect(String((refusedType.error as { statusCode?: string }).statusCode ?? refusedType.error!.message)).toMatch(/415|mime|type/i);
    // The limits are the bucket's, not the row rules': the service role is refused too.
    expect((await service().storage.from(BUCKET).upload(pathOf(job, big), oversized, { contentType: "image/jpeg" })).error).not.toBeNull();
    expect((await service().storage.from(BUCKET).upload(pathOf(job, big), PNG, { contentType: "image/png" })).error).not.toBeNull();
    expect((await service().storage.from(BUCKET).list(`${org()}/${job}/photos`)).data).toEqual([]);
    expect(outcome(await finalise(as.workshop, big))).toMatchObject({ hint: "photo_not_uploaded" });
  });

  it("at most 60 new reservations per person per hour (hint photo_rate_limited); a retry of an existing id isn't counted", async () => {
    const job = await newJob(world.tenants.beta.id);
    const user = world.tenants.beta.users.admin.id;
    const first = randomUUID();
    expect(outcome(await reserve(as.betaAdmin, first, job))).toBe("ok");
    const hash = (await withDb((db) => db.query("select encode(sha256(convert_to($1::text, 'UTF8')), 'hex') as h", [user]))).rows[0].h as string;
    await withDb((db) => db.query("insert into public.auth_rate_limits (bucket, key_hash) select 'job_photo_reserve', $1 from generate_series(1, 59)", [hash]));
    try {
      expect(outcome(await reserve(as.betaAdmin, randomUUID(), job))).toMatchObject({ code: "P0001", hint: "photo_rate_limited", message: expect.stringMatching(/Too many photos/) });
      expect((await reserve(as.betaAdmin, first, job)).data).toMatchObject({ photo_id: first, state: "reserved" });
      // Another person isn't affected.
      expect(outcome(await reserve(as.workshop, randomUUID(), await newJob()))).toBe("ok");
    } finally {
      await withDb((db) => db.query("delete from public.auth_rate_limits where bucket = 'job_photo_reserve' and key_hash = $1", [hash]));
    }
  });

  it("reservations older than a day with no object are marked abandoned (admin, service role, and reserve for the caller's own); rows and bytes kept", async () => {
    const job = await newJob();
    const [empty, landed, mine] = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of [empty, landed]) expect(outcome(await reserve(as.office, id, job))).toBe("ok");
    expect(outcome(await upload(as.office, pathOf(job, landed)))).toBe("ok");
    expect(outcome(await reserve(as.workshop, mine, job))).toBe("ok");
    await withDb((db) => db.query("update public.job_files set created_at = now() - interval '25 hours' where id = any($1::uuid[])", [[empty, landed, mine]]));
    expect(outcome(await as.workshop.rpc("abandon_stale_job_photos", { p_hours: 24 }))).toMatchObject({ code: "42501" });
    expect(outcome(await as.admin.rpc("abandon_stale_job_photos", { p_hours: 1 }))).toMatchObject({ code: "22023" });
    expect(outcome(await as.betaAdmin.rpc("abandon_stale_job_photos", { p_hours: 24 }))).toBe("ok");
    expect(await row(empty)).toMatchObject({ upload_state: "reserved" }); // another company's admin touches nothing here
    // The workshop's next reservation tidies its own stale one only.
    expect(outcome(await reserve(as.workshop, randomUUID(), job))).toBe("ok");
    expect(await row(mine)).toMatchObject({ upload_state: "abandoned" });
    expect(await row(empty)).toMatchObject({ upload_state: "reserved" });
    const marked = await as.admin.rpc("abandon_stale_job_photos", { p_hours: 24 });
    expect(marked.data).toBeGreaterThanOrEqual(1);
    expect(await row(empty)).toMatchObject({ upload_state: "abandoned" });
    expect(await row(landed)).toMatchObject({ upload_state: "reserved" }); // its object landed: left for its device to finalise
    expect((await service().rpc("abandon_stale_job_photos", { p_hours: 24 })).error).toBeNull();
    // One ABANDON_STALE_PHOTOS row per company touched, with the count: the workshop's own tidy, then the admin's run. The service
    // role's run found nothing more here, so it wrote nothing for this company.
    const audit = await withDb(async (db) => (await db.query("select actor_user_id, metadata from security_audit.audit_log where action = 'ABANDON_STALE_PHOTOS' and organization_id = $1 order by created_at", [org()])).rows);
    expect(audit).toEqual([
      { actor_user_id: world.tenants.alpha.users.workshop.id, metadata: expect.objectContaining({ count: 1, older_than_hours: 24, scope: "own reservations" }) },
      { actor_user_id: world.tenants.alpha.users.admin.id, metadata: expect.objectContaining({ count: 1, older_than_hours: 24, scope: "company admin" }) },
    ]);
    // A device that comes back later with the photo carries on under the same id (nothing was stored, so it is the same photo).
    expect((await reserve(as.workshop, mine, job)).data).toMatchObject({ photo_id: mine, state: "reserved" });
    expect(outcome(await upload(as.workshop, pathOf(job, mine)))).toBe("ok");
    expect((await finalise(as.workshop, mine)).data).toMatchObject({ state: "uploaded" });
    expect((await finalise(as.office, landed)).data).toMatchObject({ state: "uploaded" });
    expect(await events(mine, "ADD_PHOTO")).toHaveLength(1);
  });
});

describe("other companies and read-only support", () => {
  it("the other company can't reserve on the job, list the rows, upload to the path, or sign and download the object", async () => {
    const job = await newJob();
    const id = await addPhoto(as.admin, job);
    expect(outcome(await reserve(as.betaAdmin, randomUUID(), job))).toMatchObject({ code: "P0002", message: "Job not found" });
    expect(outcome(await reserve(as.betaAdmin, id, job))).toMatchObject({ code: "P0002", message: "Photo not found" });
    expect(outcome(await finalise(as.betaAdmin, id))).toMatchObject({ code: "P0002" });
    expect(outcome(await remove(as.betaAdmin, id))).toMatchObject({ code: "P0002" });
    expect((await as.betaAdmin.from("job_files").select("id").eq("job_id", job)).data).toEqual([]);
    const store = as.betaAdmin.storage.from(BUCKET);
    expect((await store.download(pathOf(job, id))).error).not.toBeNull();
    expect((await store.createSignedUrl(pathOf(job, id), 60)).error).not.toBeNull();
    expect((await store.list(`${org()}/${job}/photos`)).data ?? []).toEqual([]);
    expect((await store.upload(pathOf(job, randomUUID()), JPEG, { contentType: "image/jpeg" })).error).not.toBeNull();
    // Beta's own job and reservation: beta's admin can't put alpha's photo id to use, and alpha can't touch beta's job.
    const betaJob = await newJob(world.tenants.beta.id);
    expect(outcome(await reserve(as.betaAdmin, id, betaJob))).toMatchObject({ code: "P0002", message: "Photo not found" });
    expect(outcome(await reserve(as.admin, randomUUID(), betaJob))).toMatchObject({ code: "P0002" });
    expect(await row(id)).toMatchObject({ organization_id: org(), job_id: job, deleted_at: null });
  });

  it("a read-only support session can list the photos but can't add or remove one", async () => {
    const job = await newJob();
    const id = await addPhoto(as.workshop, job);
    // A platform owner with no membership of alpha enters it for support: read-only until elevated (036).
    const email = `owner.ph.${world.runId}@example.test`;
    const password = generatePassword(16);
    const made = await service().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: "Owner Person" } });
    expect(made.error).toBeNull();
    expect((await service().rpc("add_member", { p_org: world.tenants.beta.id, p_email: email, p_role: "viewer" })).data).toBe("member");
    await withDb(async (db) => { await db.query("insert into security_audit.platform_admins (user_id, note) values ($1, 'synthetic platform owner')", [made.data.user!.id]); });
    const factor = await enrolTotp(await signedInClient({ email, password }));
    const support = await signedInClient({ email, password });
    await passSecondStep(support, factor.factorId, factor.secret);
    await support.auth.refreshSession();
    expect(outcome(await support.rpc("platform_enter_organization", { p_org: org(), p_reason: "Looking at a photo query" }))).toBe("ok");
    expect((await support.from("job_files").select("id").eq("id", id)).data).toHaveLength(1);
    const attempt = randomUUID();
    const refused = [await reserve(support, attempt, job), await remove(support, id)].map(outcome);
    expect(refused).toEqual(refused.map(() => ({ code: "42501", message: expect.stringMatching(/read-only/i), hint: "support_read_only" })));
    // Finalising someone else's reservation is refused before any write is attempted (the support trigger would stop the write too).
    expect(outcome(await finalise(support, id))).toMatchObject({ code: "42501", message: "Only the person who took this photo finishes uploading it." });
    expect((await support.storage.from(BUCKET).upload(pathOf(job, attempt), JPEG, { contentType: "image/jpeg" })).error).not.toBeNull();
    expect(await row(attempt)).toBeNull();
    expect(await row(id)).toMatchObject({ deleted_at: null, upload_state: "uploaded" });
  });
});

describe("the release verify script", () => {
  it("runs read-only and every fact it checks is true, with the photos made above counted", async () => {
    const dir = path.resolve(__dirname, "../../supabase/verify");
    const file = readdirSync(dir).find((f) => /^job_photos_\d{3}\.sql$/.test(f));
    expect(file).toBeTruthy();
    const text = readFileSync(path.join(dir, file!), "utf8");
    const rows = await withDb(async (db) => {
      await db.query("begin transaction read only");
      try {
        return (await db.query<{ n: number; check_name: string; value: string; expected: string }>(text)).rows;
      } finally {
        await db.query("rollback");
      }
    });
    expect(rows.filter((r) => r.n <= 8).map((r) => [r.n, r.value])).toEqual(Array.from({ length: 8 }, (_, i) => [i + 1, "true"]));
    expect(rows.filter((r) => r.n > 8)).toHaveLength(4);
    expect(Number(rows.find((r) => r.n === 9)!.value)).toBeGreaterThan(3);
    expect(Number(rows.find((r) => r.n === 11)!.value)).toBeGreaterThan(0);
    expect(Number(rows.find((r) => r.n === 12)!.value)).toBe(JPEG.length);
  });
});
