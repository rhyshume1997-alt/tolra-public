"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/friendly-error";
import { REASON_MIN, sendEarlyRelease } from "@/lib/job-flow";
import { supabase } from "@/lib/supabase";

/**
 * An admin's early release (migration 081, release_job_early): a finished job that hasn't passed inspection may go out, with a reason.
 * Who, when and why are recorded by the server (a job flow event); it is voided by a reopen, a failed inspection or a worksheet change.
 * Only an admin is offered it; the server refuses anyone else.
 */
export function ReleaseEarlyDialog({ job, onClose, onReleased }: { job: { id: string; job_no: string } | null; onClose: () => void; onReleased: (message: string) => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setReason(""); setError(null); }, [job]);

  async function save() {
    if (!job || busy) return;
    if (!supabase) return setError("Supabase is not configured.");
    setBusy(true);
    setError(null);
    try {
      const sent = await sendEarlyRelease(supabase, job, reason);
      if (sent.ok) onReleased(sent.message);
      else setError(sent.local ?? friendlyError(sent.error, "Couldn't release the job. Nothing was changed."));
    } catch (err) {
      setError(friendlyError(err, "Couldn't release the job. Nothing was changed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(job)} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Release {job?.job_no} early</DialogTitle>
          <DialogDescription>It may go out before it passes inspection. Who, when and why are recorded. A reopen, a failed inspection or a worksheet change cancels it.</DialogDescription>
        </DialogHeader>
        <label className="grid gap-1 text-xs text-slate-500">Reason (required, at least {REASON_MIN} characters)
          <Textarea name="early_release_reason" rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="For example: customer needs the good parts now, rest to follow" />
        </label>
        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Release early"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
