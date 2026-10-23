"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/friendly-error";
import { REASON_MIN } from "@/lib/job-flow";
import { supabase } from "@/lib/supabase";

/**
 * Reopen a finished job (migration 081, reopen_job): back to In progress with who, when and why recorded. The person who finished it
 * can undo their own Finish while it awaits inspection; the office or an admin can reopen anyone's, a Complete job too (its pass is
 * voided, the record kept). Machine time and signatures are kept. Refused once a delivery note has gone out or it has been invoiced.
 */
export function ReopenJobDialog({ job, onClose, onReopened }: { job: { id: string; job_no: string } | null; onClose: () => void; onReopened: (job: { id: string; job_no: string }) => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setReason(""); setError(null); }, [job]);

  async function save() {
    if (!job || busy) return;
    if (reason.trim().length < REASON_MIN) return setError(`Say why it is reopened (at least ${REASON_MIN} characters).`);
    if (!supabase) return setError("Supabase is not configured.");
    setBusy(true);
    setError(null);
    try {
      const { error: refused } = await supabase.rpc("reopen_job", { p_job: job.id, p_reason: reason.trim() });
      if (refused) throw refused;
      onReopened(job);
    } catch (err) {
      setError(friendlyError(err, "Couldn't reopen the job. Nothing was changed."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={Boolean(job)} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reopen {job?.job_no}</DialogTitle>
          <DialogDescription>The job goes back to Running. Its machine time and signatures are kept; a passed inspection is voided and kept on record. Who, when and why are recorded.</DialogDescription>
        </DialogHeader>
        <label className="grid gap-1 text-xs text-slate-500">Reason (required, at least {REASON_MIN} characters)
          <Textarea name="reopen_reason" rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="For example: finished by mistake, still machining" />
        </label>
        {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Reopen job"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
