"use client";

import { useEffect, useState } from "react";
import { CloudOff, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { friendlyError } from "@/lib/friendly-error";
import { exportFileName } from "@/lib/job-photos";
import { type JobWorksheet, saveWorksheet } from "@/lib/job-worksheet";
import { readAttachment, type OutboxEntry, type PhotoOp } from "@/lib/offline/outbox";
import { discardOfflinePending, dismissOfflineIssue, retryOfflineIssue, useOfflineStatus } from "@/lib/offline/scope";
import { discardedMessage, lastSyncedLabel, takeDiscardedNotice } from "@/lib/offline/store";
import { clockLabel, syncNow, useOfflineSync } from "@/lib/offline/sync";

/**
 * "Offline - last synced HH:MM", changes waiting to sync, and offline changes that need a person: conflicts (both
 * versions kept) and changes the server refused (locked or no longer available). Runs the sync loop. Photos waiting on the
 * device (migration 040) can be exported (the picture downloaded) or discarded after a confirmation; a refused photo can
 * also be retried.
 */
export function OfflineBanner() {
  useOfflineSync();
  const status = useOfflineStatus();
  const [open, setOpen] = useState(false);
  const [photosOpen, setPhotosOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const issues = status.conflicts.length + status.rejected.length;
  const waitingPhotos = status.pendingPhotos;
  // Unsynced changes a forced wipe removed (the server ended the session), on the next page load: said once, never
  // silent. A wipe on this page (sign-out) is said on the sign-in page instead.
  useEffect(() => {
    const discarded = takeDiscardedNotice();
    if (discarded) toast.error(discardedMessage(discarded, " when your session ended"), { duration: Infinity });
  }, []);
  if (!status.offline && !status.pending && !issues) return null;

  async function retry() {
    setBusy(true);
    try {
      const result = await syncNow();
      if (result && !result.remaining) toast.success("Offline changes synced.");
    } finally {
      setBusy(false);
    }
  }

  /** The person chose their offline worksheet over the server's: saved on top of the current server version. */
  async function applyMine(id: string, op: { jobId: string; worksheet: Record<string, unknown> }, server: unknown) {
    const version = Number((server as { worksheet_version?: unknown } | null)?.worksheet_version ?? NaN);
    if (!Number.isFinite(version)) return toast.error("Open the worksheet and save again.");
    try {
      await saveWorksheet(op.jobId, op.worksheet as unknown as JobWorksheet, version, { queueWhenOffline: false });
      await dismissOfflineIssue("conflicts", id);
      toast.success("Your offline version was saved.");
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't save your version. Open the worksheet and try again."));
    }
  }

  /** Downloads the pending picture from this device (the bytes stay queued). */
  async function exportPhoto(op: PhotoOp) {
    const blob = await readAttachment<Blob>(op.blobKey);
    if (!blob) return toast.error("The photo's bytes are no longer on this device.");
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = exportFileName(op);
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  async function discardPhoto(entry: OutboxEntry, held: boolean) {
    const op = entry.op as PhotoOp;
    if (!window.confirm(`Discard this photo of ${op.jobNo || "the job"}? It hasn't been uploaded and will be removed from this device for good. Export it first if you want to keep it.`)) return;
    if (held) await dismissOfflineIssue("rejected", entry.id);
    else await discardOfflinePending(entry.id);
    toast.success("Photo discarded.");
  }

  async function retryPhoto(entry: OutboxEntry) {
    try {
      if (await retryOfflineIssue(entry.id)) await retry();
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't queue the photo again."));
    }
  }

  const label = (op: OutboxEntry["op"]) => (op.kind === "worksheet" ? "worksheet" : op.kind === "photo" ? "photo" : op.kind === "signoff" ? "signature" : op.kind === "inspect" ? "inspection" : op.kind === "run_start" ? "Start" : op.kind === "run_pause" ? "Pause" : op.kind === "clock" ? clockLabel(op.action) : op.kind === "labour" ? (op.action === "start" ? "job time Start" : "job time Stop") : op.kind);

  /** A refused signature goes back in the queue (same key, same revision: the server checks every rule again). */
  async function retrySignature(entry: OutboxEntry) {
    try {
      if (await retryOfflineIssue(entry.id)) await retry();
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't queue the signature again."));
    }
  }

  return (
    <div id="offline-notice" role="status" className="mb-4 scroll-mt-20 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 print:hidden">
      <div className="flex flex-wrap items-center gap-2">
        {status.offline ? <><CloudOff className="size-4" /><strong>{lastSyncedLabel(status.syncedAt)}</strong></> : null}
        {status.pending ? <span>{status.pending} change{status.pending === 1 ? "" : "s"} waiting to sync.</span> : null}
        {waitingPhotos.length ? <button type="button" className="underline" onClick={() => setPhotosOpen((v) => !v)}>{waitingPhotos.length} photo{waitingPhotos.length === 1 ? "" : "s"} waiting to upload</button> : null}
        {issues ? <button type="button" className="underline" onClick={() => setOpen((v) => !v)}>{issues} offline change{issues === 1 ? "" : "s"} need{issues === 1 ? "s" : ""} attention</button> : null}
        {status.pending ? <Button size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={() => void retry()}><RefreshCw className="size-4" /> Sync now</Button> : null}
      </div>
      {photosOpen && waitingPhotos.length ? (
        <ul className="mt-2 space-y-2" aria-label="Photos waiting to upload">
          {waitingPhotos.map((item) => {
            const op = item.op as PhotoOp;
            return (
              <li key={item.id} className="rounded-none border border-amber-300 bg-white p-2">
                <p><strong>{op.jobNo || "Job"}</strong>: photo{op.note ? ` "${op.note}"` : ""} waiting to upload ({Math.round(op.byteSize / 1024)} KB).</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => void exportPhoto(op)}>Export</Button>
                  <Button size="sm" variant="ghost" onClick={() => void discardPhoto(item, false)}>Discard</Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {open && issues ? (
        <ul className="mt-2 space-y-2">
          {status.conflicts.map((item) => (
            <li key={item.id} className="rounded-none border border-amber-300 bg-white p-2">
              <p data-offline-conflict={item.op.kind}><strong>{item.op.jobNo || "Job"}</strong>{item.op.kind === "signoff" ? " (signature)" : ""}: {item.reason}</p>
              <div className="mt-1 flex flex-wrap gap-2">
                {item.op.kind === "worksheet" ? <Button size="sm" variant="outline" onClick={() => void applyMine(item.id, item.op as { jobId: string; worksheet: Record<string, unknown> }, item.server)}>Apply my version</Button> : null}
                <Button size="sm" variant="ghost" onClick={() => void dismissOfflineIssue("conflicts", item.id)}>{item.op.kind === "signoff" ? "Dismiss" : "Keep theirs"}</Button>
              </div>
            </li>
          ))}
          {status.rejected.map((item) => (
            <li key={item.id} className="rounded-none border border-red-300 bg-white p-2">
              <p><strong>{item.op.jobNo || "Job"}</strong> ({label(item.op)}): not saved. {item.reason}</p>
              {item.op.kind === "photo" ? (
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void retryPhoto(item)}>Retry</Button>
                  <Button size="sm" variant="outline" onClick={() => void exportPhoto(item.op as PhotoOp)}>Export</Button>
                  <Button size="sm" variant="ghost" onClick={() => void discardPhoto(item, true)}>Discard</Button>
                </div>
              ) : item.op.kind === "signoff" ? (
                <div className="mt-1 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={busy} onClick={() => void retrySignature(item)}>Retry</Button>
                  <Button size="sm" variant="ghost" onClick={() => void dismissOfflineIssue("rejected", item.id)}>Dismiss</Button>
                </div>
              ) : <Button size="sm" variant="ghost" onClick={() => void dismissOfflineIssue("rejected", item.id)}>Dismiss</Button>}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
