"use client";

/**
 * Open drawing and Problem on a My jobs card (migration 117). Open drawing opens the job's current drawing the way the Job Board's
 * Worksheet dialog lists it (lib/open-drawing). Problem: pick a reason, add a note if useful, send; the job then shows a "Problem" flag here, on
 * the Job Board and in the office's Needs attention. Nothing here starts, pauses or finishes a job. Both buttons are at least 48 px tall, and
 * every state is words, not colour alone. Reporting needs a connection and says so.
 */
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, FileText } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { DRAWING_UNAVAILABLE, drawingLink, NO_DRAWING, planJobDrawings, type DrawingChoice } from "@/lib/open-drawing";
import {
  NEEDS_CONNECTION, PROBLEM_NOTE_MAX, PROBLEM_REASONS, problemControls, problemFlag, reasonLabel, reportFailure, reportJobProblem, reportSignature, requestKeyFor,
  type OpenProblem, type ProblemReason,
} from "@/lib/job-problems";
import { COLOUR_CLASSES } from "@/lib/status-colours";
import { supabase } from "@/lib/supabase";

const TAP = "h-auto min-h-12 whitespace-normal px-4 py-2 text-base font-semibold pointer-coarse:h-auto pointer-coarse:min-h-12";

export function MyJobExtras({ jobId, jobNo, role, available, problems, readOnly = false, onReported }: {
  jobId: string;
  jobNo: string;
  role: string | null | undefined;
  /** Whether the database has 117 (true), has not (false) or could not be asked (null). Only true shows the Problem button. */
  available: boolean | null;
  /** This job's open problems. */
  problems: OpenProblem[];
  readOnly?: boolean;
  onReported?: () => void;
}) {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  const controls = problemControls({ available, role, online, readOnly });
  const flag = problemFlag(problems);
  const [choices, setChoices] = useState<DrawingChoice[] | null>(null);
  const [opening, setOpening] = useState(false);
  const [drawingNote, setDrawingNote] = useState<string | null>(null);
  const [form, setForm] = useState(false);
  const [reason, setReason] = useState<ProblemReason>("material");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const key = useRef<{ key: string; signature: string } | null>(null);

  async function open(file: DrawingChoice["file"]) {
    try {
      const url = await drawingLink(file);
      window.open(url, "_blank", "noopener");
      setDrawingNote(null);
    } catch {
      setDrawingNote(DRAWING_UNAVAILABLE);
    }
  }

  async function openDrawing() {
    if (opening) return;
    setOpening(true);
    setDrawingNote(null);
    setChoices(null);
    try {
      const plan = await planJobDrawings(jobId);
      if (plan.kind === "none") setDrawingNote(NO_DRAWING);
      else if (plan.kind === "unavailable") setDrawingNote(DRAWING_UNAVAILABLE);
      else if (plan.kind === "one") await open(plan.choice.file);
      else setChoices(plan.choices);
    } finally {
      setOpening(false);
    }
  }

  async function send() {
    if (saving) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setFailure(NEEDS_CONNECTION);
      return;
    }
    if (!supabase) {
      setFailure(NEEDS_CONNECTION);
      return;
    }
    setSaving(true);
    setFailure(null);
    // The same report sent again (after a lost answer) keeps its key, so it is still one problem.
    key.current = requestKeyFor(key.current, reportSignature(jobId, reason, note), () => crypto.randomUUID());
    try {
      await reportJobProblem(supabase, jobId, reason, note, key.current.key);
      key.current = null;
      setForm(false);
      setNote("");
      toast.success("Problem reported. The office can see it.");
      onReported?.();
    } catch (err) {
      setFailure(reportFailure(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3" data-testid="my-job-extras">
      {flag ? (
        <div role="status" data-testid="my-job-problem-flag" className={`border-2 px-4 py-3 text-ink ${COLOUR_CLASSES.red.edge} ${COLOUR_CLASSES.red.tint}`}>
          <p data-testid="my-job-problem-headline" className="flex items-center gap-2 text-lg font-bold break-words"><AlertTriangle aria-hidden className="size-6 shrink-0" />{flag.headline}</p>
          <p className="mt-1 text-base break-words">{flag.detail}</p>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Button type="button" variant="outline" className={`${TAP} w-full sm:w-auto`} data-testid="my-job-drawing" aria-label={`Open drawing: ${jobNo}`} disabled={opening} onClick={() => void openDrawing()}>
          <FileText className="size-5" />{opening ? "Opening..." : "Open drawing"}
        </Button>
        {controls.showReport ? (
          <Button type="button" variant="outline" className={`${TAP} w-full sm:w-auto`} data-testid="my-job-problem" aria-label={`Report a problem: ${jobNo}`} aria-expanded={form} onClick={() => { setForm((v) => !v); setFailure(null); }}>
            <AlertTriangle className="size-5" />Problem
          </Button>
        ) : null}
      </div>
      {drawingNote ? <p role="status" data-testid="my-job-drawing-note" className="text-sm text-muted-foreground">{drawingNote}</p> : null}
      {choices ? (
        <ul className="space-y-2" data-testid="my-job-drawing-choices" aria-label={`Drawings for ${jobNo}`}>
          {choices.map((choice) => (
            <li key={choice.file.id ?? choice.file.path}>
              <Button type="button" variant="outline" className={`${TAP} w-full justify-start text-left`} data-testid="my-job-drawing-choice" onClick={() => void open(choice.file)}>
                <FileText className="size-5" />{choice.label}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {controls.showReport && controls.note && !form ? <p className="text-sm text-muted-foreground">{controls.note}</p> : null}
      {controls.showReport && form ? (
        <div className="space-y-3 border border-line bg-surface p-4" data-testid="my-job-problem-form">
          <label className="block text-sm font-semibold text-ink" htmlFor={`problem-reason-${jobId}`}>What is the problem?</label>
          <select
            id={`problem-reason-${jobId}`}
            data-testid="my-job-problem-reason"
            aria-label={`Problem reason for ${jobNo}`}
            className="min-h-12 w-full rounded-lg border border-input bg-surface px-3 text-base text-ink"
            value={reason}
            disabled={saving}
            onChange={(event) => setReason(event.target.value as ProblemReason)}
          >
            {PROBLEM_REASONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <label className="block text-sm font-semibold text-ink" htmlFor={`problem-note-${jobId}`}>Note (optional)</label>
          <Textarea
            id={`problem-note-${jobId}`}
            data-testid="my-job-problem-note"
            aria-label={`Problem note for ${jobNo}`}
            className="min-h-24"
            value={note}
            maxLength={PROBLEM_NOTE_MAX}
            disabled={saving}
            placeholder={`What did you find? (${reasonLabel(reason)})`}
            onChange={(event) => setNote(event.target.value)}
          />
          {failure ? <p role="alert" data-testid="my-job-problem-error" className="text-sm font-semibold text-destructive">{failure}</p> : null}
          {controls.note ? <p className="text-sm text-muted-foreground">{controls.note}</p> : null}
          <div className="flex flex-wrap gap-3">
            <Button type="button" className={`${TAP} w-full sm:w-auto`} data-testid="my-job-problem-send" disabled={saving} onClick={() => void send()}>{saving ? "Reporting..." : "Report problem"}</Button>
            <Button type="button" variant="outline" className={`${TAP} w-full sm:w-auto`} disabled={saving} onClick={() => { setForm(false); setFailure(null); }}>Cancel</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
