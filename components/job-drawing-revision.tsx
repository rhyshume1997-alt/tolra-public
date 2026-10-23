"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { missingDbObject } from "@/lib/db-features";
import { type DrawingRevisionState, drawingRevisionChange, drawingRevisionNotice } from "@/lib/drawing-revision";
import { friendlyError } from "@/lib/friendly-error";
import { supabase } from "@/lib/supabase";

/**
 * Drawing revision on the job (ISO 9001 8.2 / 8.5.1, migration 083), only where the job needs it. Admin and office switch "Drawing
 * revision required" on for the job; then it can't be Complete until a revision is entered (the database refuses it). Admin, office
 * and workshop enter the revision. Replacing one, or switching the requirement off, asks why. Hidden until the database has 083.
 */
export function JobDrawingRevision({ jobId, role }: { jobId: string; role: string | null | undefined }) {
  const [state, setState] = useState<DrawingRevisionState | null>(null);
  const [required, setRequired] = useState(false);
  const [revision, setRevision] = useState("");
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!supabase) return;
    const { data, error } = await supabase.from("jobs").select("drawing_revision_required, drawing_revision, inspected_at").eq("id", jobId).maybeSingle();
    if (error) { if (!missingDbObject(error)) setProblem(friendlyError(error, "Couldn't load the drawing revision.")); return; }
    if (!data) return;
    const next = { required: Boolean(data.drawing_revision_required), revision: (data.drawing_revision as string | null) ?? null, complete: data.inspected_at !== null };
    setState(next);
    setRequired(next.required);
    setRevision(next.revision ?? "");
    setReason("");
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);

  if (!state) return problem ? <p role="alert" className="text-sm text-red-700">{problem}</p> : null;
  const canRequire = role === "admin" || role === "office";
  const canEnter = canRequire || role === "workshop";
  const change = drawingRevisionChange(state, { required, revision });
  const notice = drawingRevisionNotice(state);

  async function save() {
    if (!supabase || !change.changed) return;
    if (change.problem) { setProblem(change.problem); return; }
    if (change.needsReason && reason.trim().length < 10) { setProblem("Say why (at least 10 characters)."); return; }
    setSaving(true);
    setProblem(null);
    try {
      const { error } = await supabase.rpc("set_job_drawing_revision", { p_job: jobId, p_required: required, p_revision: revision.trim() || null, p_reason: reason.trim() || null });
      if (error) throw error;
      toast.success("Drawing revision saved");
      await load();
    } catch (err) {
      setProblem(friendlyError(err, "The drawing revision wasn't saved. Try again."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section data-testid="drawing-revision" className="grid gap-2 rounded-lg border border-slate-200 p-3">
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <input type="checkbox" aria-label="Drawing revision required" className="size-4 accent-brand" checked={required}
            disabled={!canRequire || state.complete || saving} onChange={(event) => setRequired(event.target.checked)} />
          Drawing revision required
        </label>
        <label className="flex items-center gap-2 text-sm font-medium text-slate-700">Drawing revision
          <Input aria-label="Drawing revision" value={revision} maxLength={20} className="h-9 w-28" placeholder="e.g. C"
            disabled={!canEnter || state.complete || saving} onChange={(event) => setRevision(event.target.value)} />
        </label>
        {change.changed && canEnter ? <Button size="sm" disabled={saving} onClick={() => void save()}>{saving ? "Saving..." : "Save"}</Button> : null}
      </div>
      {change.changed && change.needsReason ? (
        <Input aria-label="Reason for the drawing revision change" value={reason} maxLength={500} className="h-9" placeholder="Why (e.g. customer issued revision D on 14 Oct)"
          onChange={(event) => setReason(event.target.value)} />
      ) : null}
      {notice ? <p data-testid="drawing-revision-needed" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950">{notice}</p> : null}
      {problem ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-700">{problem}</p> : null}
    </section>
  );
}
