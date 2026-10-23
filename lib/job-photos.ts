/**
 * Job photos (migration 040): photos taken on the shop floor and attached to the worksheet.
 *
 * Adding one: the picture is prepared on the device (lib/photo-image.ts: upright, 2048 px, JPEG of at most 2 MiB, no metadata),
 * given its id here, and written to the device store together with its outbox entry in ONE atomic step. Only then is it
 * "waiting to upload"; the sync loop sends it (reserve, upload the exact object, finalise: lib/offline/sync.ts), and a lost
 * connection at any point means the same photo is sent again, never a second one. A support session keeps nothing on the
 * device, so it sends straight away or not at all.
 */
import { executePhotoOp, PHOTOS_BUCKET, syncNow } from "@/lib/offline/sync";
import { exportFileName, newPhotoId, pendingEntries, photoBlobKey, readAttachment, rejectedEntries, type OutboxEntry, type PhotoOp } from "@/lib/offline/outbox";
import { offlineScope, queueOfflineWith } from "@/lib/offline/scope";
import { isSupportSession } from "@/lib/offline/store";
import { type PhotoPorts, preparePhoto } from "@/lib/photo-image";
import { supabase } from "@/lib/supabase";

export type JobPhoto = { id: string; note: string | null; captured_at: string | null; created_by: string | null; created_at: string; uploaded_at: string | null; byte_size: number | null };
export const PHOTO_COLUMNS = "id, note, captured_at, created_by, created_at, uploaded_at, byte_size";

/** The job's uploaded, not removed photos, oldest first. Throws on a failed load (the caller decides what to show). */
export async function listJobPhotos(jobId: string): Promise<JobPhoto[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from("job_files").select(PHOTO_COLUMNS).eq("job_id", jobId).eq("kind", "photo").eq("upload_state", "uploaded").is("deleted_at", null).order("created_at").order("id");
  if (error) throw error;
  return (data ?? []) as JobPhoto[];
}

/** Where the picture is served from: the app server, after the person's own row read (app/api/job-photos/[id]). */
export function photoUrl(photo: Pick<JobPhoto, "id" | "uploaded_at">, attempt = 0) {
  return `/api/job-photos/${photo.id}?v=${encodeURIComponent(photo.uploaded_at ?? "")}${attempt > 0 ? `&r=${attempt}` : ""}`;
}

/**
 * A thumbnail that fails to load is tried again (a fresh request: a new URL, so the browser doesn't reuse the failed answer) after
 * these waits; after the last one it shows "Couldn't load this photo" with a Retry button instead of a broken image.
 */
export const PHOTO_RETRY_DELAYS_MS = [800, 2500] as const;
export function nextPhotoRetry(failures: number): number | null {
  return failures >= 1 && failures <= PHOTO_RETRY_DELAYS_MS.length ? PHOTO_RETRY_DELAYS_MS[failures - 1] : null;
}

export type PendingPhoto = { entry: OutboxEntry; op: PhotoOp; blob: Blob | null; status: "waiting" | "rejected"; reason?: string };

/** This device's photos of the job that haven't been uploaded: waiting in the outbox, or refused and held with the reason. */
export async function pendingPhotosFor(jobId: string): Promise<PendingPhoto[]> {
  const scope = offlineScope();
  if (!scope) return [];
  const [waiting, rejected] = await Promise.all([pendingEntries(scope), rejectedEntries(scope)]);
  const out: PendingPhoto[] = [];
  for (const entry of waiting) {
    if (entry.op.kind === "photo" && entry.op.jobId === jobId) out.push({ entry, op: entry.op, blob: await readAttachment<Blob>(entry.op.blobKey), status: "waiting" });
  }
  for (const entry of rejected) {
    if (entry.op.kind === "photo" && entry.op.jobId === jobId) out.push({ entry, op: entry.op, blob: await readAttachment<Blob>(entry.op.blobKey), status: "rejected", reason: entry.reason });
  }
  return out;
}


export type AddPhotoResult = { photoId: string; bytes: number; width: number; height: number; queued: boolean };

/**
 * Prepares the picture and keeps it on the device as a queued upload, then starts a sync. Resolves once the photo is safely
 * saved on the device (or, in a support session, once the server has it). Throws when the picture can't be prepared or the
 * device can't hold it.
 */
/** iPhones save HEIC by default; v1 takes JPEG (and pictures the browser can turn into one), never HEIC. */
export const HEIC_MESSAGE = "iPhone HEIC photos can't be added yet: set Camera > Formats > Most Compatible, or pick a JPEG.";
export const isHeic = (file: Blob & { name?: string }) => /^image\/hei[cf](-sequence)?$/i.test(file.type) || /\.hei[cf]$/i.test(file.name ?? "");

export async function addJobPhoto({ jobId, jobNo, file, note, capturedAt }: { jobId: string; jobNo: string; file: Blob; note: string; capturedAt: string | null }, ports?: PhotoPorts): Promise<AddPhotoResult> {
  if (isHeic(file)) throw new Error(HEIC_MESSAGE);
  const prepared = await preparePhoto(file, ports);
  const photoId = newPhotoId();
  const scope = offlineScope();
  const trimmed = note.trim().slice(0, 500) || null;
  const base = { kind: "photo" as const, photoId, jobId, jobNo, note: trimmed, capturedAt, byteSize: prepared.bytes };
  if (isSupportSession() || !scope) {
    // Nothing is kept on the device: send now, or say why it didn't go.
    if (!supabase) throw new Error("Supabase is not configured.");
    const outcome = await executePhotoOp({ ...base, blobKey: "" }, supabase, supabase.storage.from(PHOTOS_BUCKET), prepared.blob);
    if (outcome.status === "network") throw new Error("Can't reach the server, and support access keeps nothing on this device. Reconnect and take the photo again.");
    if (outcome.status !== "applied") throw new Error(outcome.status === "rejected" || outcome.status === "conflict" ? outcome.reason : "The photo wasn't saved.");
    return { photoId, bytes: prepared.bytes, width: prepared.width, height: prepared.height, queued: false };
  }
  const op: PhotoOp = { ...base, blobKey: photoBlobKey(scope, photoId) };
  await queueOfflineWith(op, { [op.blobKey]: prepared.blob });
  void syncNow();
  return { photoId, bytes: prepared.bytes, width: prepared.width, height: prepared.height, queued: true };
}

/** Marks a photo removed (admin and office; the server records who and when, the bytes stay). */
export async function removeJobPhoto(id: string): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { error } = await supabase.rpc("remove_job_photo", { p_id: id });
  if (error) throw error;
}

/** A file name for a pending photo exported from the device. */
export { exportFileName };
