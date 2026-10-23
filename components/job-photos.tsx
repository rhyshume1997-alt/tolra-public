"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Images, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { ConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtDateTime } from "@/lib/dates";
import { friendlyError } from "@/lib/friendly-error";
import { addJobPhoto, HEIC_MESSAGE, isHeic, listJobPhotos, nextPhotoRetry, pendingPhotosFor, photoUrl, removeJobPhoto, type JobPhoto, type PendingPhoto } from "@/lib/job-photos";
import { onSyncComplete } from "@/lib/offline/sync";
import { isNetworkError } from "@/lib/offline/store";
import { type PeopleMap, personName } from "@/lib/people";
import { canReadUsernames, loadCompanyPeople } from "@/lib/company-people";
import { useMaybeUser } from "@/lib/use-user";
import { supabase } from "@/lib/supabase";
import { useUser } from "@/lib/use-user";

/** Shop-floor touch targets: 48 px high. */
const TARGET = "min-h-12 px-4";
const ACCEPT = "image/jpeg,image/png,image/webp";

/**
 * Photos on the worksheet (migration 040). Take one with the camera or pick one from the gallery (one at a time), with an
 * optional note; it is prepared on the device and uploaded, and is "waiting to upload" while the device holds it. Admin and
 * office can remove a photo (confirmed, recorded). Viewers see nothing here.
 */
export function JobPhotos({ jobId, jobNo }: { jobId: string; jobNo: string }) {
  const { activeRole } = useUser();
  const canRemove = activeRole === "admin" || activeRole === "office";
  const canSee = activeRole === "admin" || activeRole === "office" || activeRole === "workshop";
  const [photos, setPhotos] = useState<JobPhoto[]>([]);
  const [pending, setPending] = useState<PendingPhoto[]>([]);
  const [people, setPeople] = useState<PeopleMap>({});
  const viewer = useMaybeUser();
  const [offline, setOffline] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<JobPhoto | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!canSee) return;
    try {
      const [rows, who] = await Promise.all([listJobPhotos(jobId), loadCompanyPeople(supabase, { usernames: canReadUsernames(viewer?.profile) }).catch(() => null)]);
      setPhotos(rows);
      if (who) setPeople(who);
      setOffline(false);
    } catch (err) {
      // Uploaded photos need the connection; the device's own are still listed below.
      if (isNetworkError(err)) setOffline(true);
      else toast.error(friendlyError(err, "Couldn't load the photos."));
    }
    setPending(await pendingPhotosFor(jobId));
  }, [canSee, jobId]);

  useEffect(() => {
    void load();
    return onSyncComplete(() => { void load(); });
  }, [load]);

  async function onPick(input: HTMLInputElement) {
    const file = input.files?.[0];
    input.value = "";
    if (!file || busy) return;
    if (isHeic(file)) {
      toast.error(HEIC_MESSAGE);
      return;
    }
    setBusy(true);
    try {
      const taken = file.lastModified ? new Date(file.lastModified).toISOString() : null;
      const result = await addJobPhoto({ jobId, jobNo, file, note, capturedAt: taken });
      setNote("");
      toast.success(result.queued ? "Photo saved on this device. Uploading..." : "Photo added.");
      await load();
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't add the photo."));
    } finally {
      setBusy(false);
    }
  }

  async function confirmRemove() {
    const target = removing;
    if (!target) return;
    setBusy(true);
    try {
      await removeJobPhoto(target.id);
      setRemoving(null);
      toast.success("Photo removed.");
      await load();
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't remove the photo."));
    } finally {
      setBusy(false);
    }
  }

  if (!canSee) return null;

  return (
    <section aria-label="Photos" data-testid="job-photos" className="space-y-3 rounded-lg border border-slate-300 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] font-bold uppercase">Photos</p>
        {offline ? <span className="text-xs text-amber-800">Offline: photos already uploaded show when you&apos;re back online.</span> : null}
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
          <span>Note for the next photo (optional)</span>
          <Input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="e.g. Bore after finishing pass" className="min-h-12" aria-label="Photo note" />
        </label>
        <input ref={cameraRef} type="file" accept={ACCEPT} capture="environment" className="hidden" aria-label="Camera" onChange={(event) => void onPick(event.target)} />
        <input ref={galleryRef} type="file" accept={ACCEPT} className="hidden" aria-label="Gallery file" onChange={(event) => void onPick(event.target)} />
        <Button type="button" variant="outline" className={TARGET} disabled={busy} onClick={() => cameraRef.current?.click()}><Camera className="size-5" /> Take photo</Button>
        <Button type="button" variant="outline" className={TARGET} disabled={busy} onClick={() => galleryRef.current?.click()}><Images className="size-5" /> Gallery</Button>
      </div>
      {busy ? <p className="text-xs text-slate-600" role="status">Preparing the photo...</p> : null}
      {pending.length ? (
        <ul aria-label="Photos on this device" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {pending.map((item) => <PendingTile key={item.entry.id} item={item} />)}
        </ul>
      ) : null}
      {photos.length ? (
        <ul aria-label="Uploaded photos" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {photos.map((photo) => (
            <li key={photo.id} data-testid="job-photo" className="space-y-1 rounded border border-slate-200 p-2">
              <PhotoThumb photo={photo} />
              {photo.note ? <p className="text-xs">{photo.note}</p> : null}
              <p className="text-xs text-slate-600">Added by {personName(people, photo.created_by)} · {fmtDateTime(photo.created_at)}</p>
              {canRemove ? <Button type="button" variant="ghost" className={`${TARGET} text-red-700`} disabled={busy} onClick={() => setRemoving(photo)}><Trash2 className="size-4" /> Remove</Button> : null}
            </li>
          ))}
        </ul>
      ) : !pending.length && !offline ? <p className="text-xs text-slate-500">No photos yet.</p> : null}
      <ConfirmDialog
        open={Boolean(removing)}
        title="Remove this photo?"
        description={removing ? <p>The photo{removing.note ? ` "${removing.note}"` : ""} added by {personName(people, removing.created_by)} on {fmtDateTime(removing.created_at)} will no longer show on {jobNo}. The removal is recorded with your name.</p> : ""}
        confirmLabel="Remove photo"
        destructive
        busy={busy}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void confirmRemove()}
      />
    </section>
  );
}

/**
 * An uploaded photo's thumbnail. A load that fails (the server busy, the connection dropping) is tried again with a fresh request,
 * twice; after that it says so, with a Retry button, instead of leaving a broken image.
 */
function PhotoThumb({ photo }: { photo: JobPhoto }) {
  const [attempt, setAttempt] = useState(0);
  const [failures, setFailures] = useState(0);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const onError = () => {
    const count = failures + 1;
    setFailures(count);
    const wait = nextPhotoRetry(count);
    if (wait === null) {
      setFailed(true);
      return;
    }
    timer.current = setTimeout(() => setAttempt((n) => n + 1), wait);
  };
  const retry = () => {
    setFailed(false);
    setFailures(0);
    setAttempt((n) => n + 1);
  };
  const alt = photo.note ? `Photo: ${photo.note}` : "Job photo";
  if (failed) {
    return (
      <div data-testid="photo-unavailable" className="flex h-40 w-full flex-col items-center justify-center gap-2 rounded bg-slate-100 text-xs text-slate-700">
        <span>Couldn&apos;t load this photo.</span>
        <Button type="button" variant="outline" className={TARGET} onClick={retry}>Retry</Button>
      </div>
    );
  }
  return (
    <a href={photoUrl(photo)} target="_blank" rel="noopener" className="block">
      {/* eslint-disable-next-line @next/next/no-img-element -- served by our own route after the person's row read */}
      <img src={photoUrl(photo, attempt)} alt={alt} loading="lazy" className="h-40 w-full rounded object-cover" onError={onError} />
    </a>
  );
}

/** A photo still on this device: its picture from the stored bytes, and whether it is waiting or was refused. */
function PendingTile({ item }: { item: PendingPhoto }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!item.blob) return;
    const next = URL.createObjectURL(item.blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [item.blob]);
  return (
    <li data-testid="pending-photo" data-status={item.status} className="space-y-1 rounded border border-amber-300 bg-amber-50 p-2">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- the bytes are on this device, not a URL
        <img src={url} alt={item.op.note ? `Photo: ${item.op.note}` : "Job photo"} className="h-40 w-full rounded object-cover" />
      ) : <div className="flex h-40 items-center justify-center rounded bg-amber-100 text-xs text-amber-900">No preview</div>}
      {item.op.note ? <p className="text-xs">{item.op.note}</p> : null}
      <p className="text-xs text-amber-900">{item.status === "waiting" ? "Waiting to upload" : `Not uploaded: ${item.reason ?? "refused"}. See the offline notice above to retry, export or discard it.`}</p>
    </li>
  );
}
