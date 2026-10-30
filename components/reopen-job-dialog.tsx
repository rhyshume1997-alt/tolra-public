"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/friendly-error";
import { REASON_MIN } from "@/lib/job-flow";
import {
  REASON_MAX, REOPEN_COUNT_EVENT, REOPEN_FALLBACK_NOTICE, type ReopenMode, type ReopenPreview,
  checkReopenForm, confirmationSentence, loadReopenPreview, sendLegacyReopen, sendReopen, submitLabel,
} from "@/lib/reopen-sign-off";
import { supabase } from "@/lib/supabase";

type Job = { id: string; job_no: string };

export type ReopenFormBodyProps = {
  jobNo: string;
  loading: boolean;
  fallback: boolean;
  preview: ReopenPreview | null;
  isAdmin: boolean;
  reason: string;
  confirmed: boolean;
  mode: ReopenMode | null;
  error: string | null;
  busy: boolean;
  onReason: (value: string) => void;
  onConfirmed: (value: boolean) => void;
  onMode: (value: ReopenMode | null) => void;
  onCancel: () => void;
  onSubmit: () => void;
};

/**
 * The dialog's content (no state of its own, so it renders the same on the server in tests): reason, the confirmation sentence, then
 * who signs it off. Before 113 only the reason is asked and the notice says why.
 */
export function ReopenFormBody(props: ReopenFormBodyProps) {
  const { jobNo, loading, fallback, preview, isAdmin, reason, confirmed, mode, error, busy } = props;
  const blocked = Boolean(preview && !preview.allowed);
  const sentence = preview ? confirmationSentence(preview) : null;
  const label = submitLabel({ isAdmin, fallback, mode });
  return (
    <div className="grid gap-3" data-testid="reopen-form">
      {fallback ? <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{REOPEN_FALLBACK_NOTICE}</p> : null}
      <label className="grid gap-1 text-xs text-slate-500">Reason (required, at least {REASON_MIN} characters)
        <Textarea name="reopen_reason" rows={3} maxLength={REASON_MAX} value={reason} disabled={busy} onChange={(event) => props.onReason(event.target.value)} placeholder="For example: finished by mistake, still machining" />
      </label>
      {loading ? <p className="text-sm text-slate-500">Checking the job…</p> : null}
      {!fallback && preview ? (
        <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3 text-sm text-slate-900">
          <input type="checkbox" name="reopen_confirm" className="mt-0.5 size-4" checked={confirmed} disabled={busy || blocked} onChange={(event) => props.onConfirmed(event.target.checked)} />
          <span>{sentence}</span>
        </label>
      ) : null}
      {blocked ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{preview?.refusal ?? `${jobNo} can't be reopened.`}</p> : null}
      {!fallback && preview && !blocked ? (isAdmin ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700" data-testid="reopen-admin-here">You are an admin: your approval is recorded with the reopen.</p>
      ) : (
        <fieldset className="grid gap-2 text-sm" data-testid="reopen-signoff">
          <legend className="mb-1 text-xs text-slate-500">Who signs it off</legend>
          <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3">
            <input type="radio" name="reopen_mode" value="admin_present" className="mt-0.5 size-4" checked={mode === "admin_present"} disabled={busy} onChange={() => props.onMode("admin_present")} />
            <span>
              <span className="font-medium text-slate-900">An admin is here: admin approval</span>
              <span className="block text-slate-500">Nothing changes yet. The admin approves it in the Approval Queue with their own login, and {jobNo} is reopened then.</span>
            </span>
          </label>
          <label className="flex items-start gap-2 rounded-lg border border-slate-200 p-3">
            <input type="checkbox" name="reopen_no_admin" className="mt-0.5 size-4" checked={mode === "tick_box_notify"} disabled={busy} onChange={(event) => props.onMode(event.target.checked ? "tick_box_notify" : null)} />
            <span>
              <span className="font-medium text-slate-900">No admin available: reopen now and notify the admin</span>
              <span className="block text-slate-500">It is reopened at once and recorded as signed off this way. The admin approves or rejects it later; a rejection is recorded but does not undo the reopen.</span>
            </span>
          </label>
        </fieldset>
      )) : null}
      {error ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button variant="outline" disabled={busy} onClick={props.onCancel}>Cancel</Button>
        <Button className="bg-brand text-brand-ink hover:bg-brand-hover" disabled={busy || loading || blocked} onClick={props.onSubmit}>{busy ? "Saving…" : label}</Button>
      </div>
    </div>
  );
}

/** Tells the company's admins by e-mail where a mailer is set up (best effort: the Approval Queue badge is the notice that counts). */
function notifyAdmins(requestId: string) {
  window.dispatchEvent(new CustomEvent(REOPEN_COUNT_EVENT));
  void fetch("/api/reopen-requests/notify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId }) }).catch(() => undefined);
}

/**
 * Reopen a finished job, signed off (migration 113, lib/reopen-sign-off): a reason, a confirmation that names the job and its invoice,
 * then an admin's approval (an admin here, or the admin's own login in the Approval Queue) or the "No admin available" tick box that
 * reopens now and notifies the admin. Every rule of who may reopen what stays 081's reopen_job: the person who finished it while it
 * awaits inspection, the office or an admin for anyone's; refused once a delivery note has gone out. An invoiced job may be reopened
 * through this sign-off (113); the issued invoice never changes and the confirmation names it. Before 113 an invoiced job stays refused. Machine time and signatures are kept; a passed inspection is voided and kept on record. Before 113 is
 * applied it is today's Reopen (reopen_job with a reason) with a notice.
 * onReopened: the job is reopened (the board updates); onWaiting: an admin has to approve first (nothing changed yet).
 */
export function ReopenJobDialog({ job, onClose, onReopened, onWaiting }: { job: Job | null; onClose: () => void; onReopened: (job: Job, message?: string) => void; onWaiting?: (job: Job, message: string) => void }) {
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [mode, setMode] = useState<ReopenMode | null>(null);
  const [preview, setPreview] = useState<ReopenPreview | null>(null);
  const [fallback, setFallback] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setReason(""); setConfirmed(false); setMode(null); setPreview(null); setFallback(false); setError(null);
    if (!job || !supabase) return;
    let active = true;
    setLoading(true);
    void loadReopenPreview(supabase, job).then((loaded) => {
      if (!active) return;
      if (loaded.kind === "ready") setPreview(loaded.preview);
      else if (loaded.kind === "fallback") setFallback(true);
      else setError(friendlyError(loaded.error, "Couldn't check the job. Close and try again."));
    }, (err) => { if (active) setError(friendlyError(err, "Couldn't check the job. Close and try again.")); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [job]);

  const isAdmin = Boolean(preview?.is_admin);

  async function save() {
    if (!job || busy || loading) return;
    const check = checkReopenForm({ reason, confirmed, mode }, { isAdmin, fallback, preview });
    if (!check.ok) return setError(check.error);
    if (!supabase) return setError("Supabase is not configured.");
    setBusy(true);
    setError(null);
    try {
      if (fallback || !check.mode) {
        const done = await sendLegacyReopen(supabase, job, reason);
        if (!done.ok) throw done.error;
        onReopened(job);
        return;
      }
      const sent = await sendReopen(supabase, job, reason, check.mode);
      if (!sent.ok) {
        if (sent.fallback) { setFallback(true); setPreview(null); return setError("The database changed while this was open: check the reason and press Reopen again."); }
        throw sent.error;
      }
      if (sent.status === "pending" && sent.requestId) notifyAdmins(sent.requestId);
      if (sent.reopened) onReopened(job, sent.message);
      else if (onWaiting) onWaiting(job, sent.message);
      else onClose();
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
          <DialogDescription>The job goes back to Running. Its machine time and signatures are kept; a passed inspection is voided and kept on record. Who, when and why are recorded, with the admin&apos;s sign-off.</DialogDescription>
        </DialogHeader>
        <ReopenFormBody jobNo={job?.job_no ?? ""} loading={loading} fallback={fallback} preview={preview} isAdmin={isAdmin} reason={reason} confirmed={confirmed} mode={mode}
          error={error} busy={busy} onReason={setReason} onConfirmed={setConfirmed} onMode={setMode} onCancel={onClose} onSubmit={() => void save()} />
      </DialogContent>
    </Dialog>
  );
}
