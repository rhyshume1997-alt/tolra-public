"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { type JobInfo } from "@/lib/time-data";
import { localDateOf, localInstant, localTimeOf } from "@/lib/time-sheet";

/** A local date and time typed by the person, as an instant. On the night the clocks go back 01:00 to 01:59 needs BST or GMT. */
export function useLocalTime(initialDate: string, initialTime = "") {
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState(initialTime);
  const [zone, setZone] = useState<"BST" | "GMT" | "">("");
  const r = localInstant(date, time, zone || undefined);
  const error = !time ? "Enter a time." : r.kind === "missing" ? "That time doesn't exist that night (the clocks went forward)." : r.kind === "invalid" ? "Enter a date and a time (HH:MM)." : null;
  return { date, setDate, time, setTime, zone, setZone, ambiguous: r.kind === "ambiguous", at: r.kind === "ok" ? r.at : null, error: r.kind === "ambiguous" && !zone ? "That time happens twice tonight: choose BST or GMT." : error };
}
type LocalTime = ReturnType<typeof useLocalTime>;

export function TimeField({ label, value, testId }: { label: string; value: LocalTime; testId?: string }) {
  return (
    <div className="grid gap-1">
      <span className="text-sm font-medium">{label}</span>
      <div className="flex flex-wrap gap-2">
        <Input type="date" value={value.date} onChange={(e) => value.setDate(e.target.value)} className="w-40" aria-label={`${label} date`} />
        <Input type="time" value={value.time} onChange={(e) => value.setTime(e.target.value)} className="w-32" aria-label={`${label} time`} data-testid={testId} />
        {value.ambiguous ? (
          <select className="rounded-md border px-2 text-sm" value={value.zone} onChange={(e) => value.setZone(e.target.value as "BST" | "GMT" | "")} aria-label={`${label} BST or GMT`}>
            <option value="">BST or GMT?</option>
            <option value="BST">BST (first time)</option>
            <option value="GMT">GMT (second time)</option>
          </select>
        ) : null}
      </div>
    </div>
  );
}

const ACTIONS = [
  { value: "in", label: "Clock in" },
  { value: "out", label: "Clock out" },
  { value: "break_start", label: "Break start" },
  { value: "break_end", label: "Break end" },
] as const;

export type ClockCorrection = { action: "in" | "out" | "break_start" | "break_end" | "void"; at: Date | null; reason: string; supersedes: string | null };

/** Add a missing clock action, change one, or remove one (a reason each time; the original stays on record). */
export function ClockCorrectionDialog({ open, onOpenChange, date, existing, onSave }: {
  open: boolean; onOpenChange: (open: boolean) => void; date: string;
  existing: { id: string; action: "in" | "out" | "break_start" | "break_end"; at: string } | null;
  onSave: (c: ClockCorrection) => Promise<void>;
}) {
  const [action, setAction] = useState<ClockCorrection["action"]>(existing?.action ?? "out");
  const when = useLocalTime(existing ? localDateOf(existing.at) : date, existing ? localTimeOf(existing.at) : "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const removing = action === "void";
  const reasonOk = reason.trim().length >= 3;
  async function save() {
    setBusy(true);
    try {
      await onSave({ action, at: removing ? null : when.at, reason: reason.trim(), supersedes: existing?.id ?? null });
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? "Correct a clock record" : "Add a missing clock record"}</DialogTitle>
          <DialogDescription>The original stays on record. Once the week is approved only an admin can change it.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1 text-sm font-medium">
            What
            <select className="rounded-md border px-2 py-2" value={action} onChange={(e) => setAction(e.target.value as ClockCorrection["action"])}>
              {ACTIONS.filter((a) => !existing || a.value === existing.action).map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
              {existing ? <option value="void">Remove this record</option> : null}
            </select>
          </label>
          {removing ? null : <TimeField label="Time" value={when} testId="clock-correction-time" />}
          <label className="grid gap-1 text-sm font-medium">
            Reason
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="For example: forgot to clock out" />
          </label>
          {!removing && when.error ? <p className="text-sm text-amber-700">{when.error}</p> : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !reasonOk || (!removing && !when.at)}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export type LabourEdit = { jobId: string; from: Date; to: Date | null; reason: string };

/** Add job time by hand, or change the times of one stretch (a reason each time; the first times stay on record). */
export function LabourDialog({ open, onOpenChange, date, jobs, existing, onSave }: {
  open: boolean; onOpenChange: (open: boolean) => void; date: string; jobs: JobInfo[];
  existing: { jobId: string; started_at: string; ended_at: string | null } | null;
  onSave: (e: LabourEdit) => Promise<void>;
}) {
  const [jobId, setJobId] = useState(existing?.jobId ?? "");
  const from = useLocalTime(existing ? localDateOf(existing.started_at) : date, existing ? localTimeOf(existing.started_at) : "");
  const to = useLocalTime(existing?.ended_at ? localDateOf(existing.ended_at) : date, existing?.ended_at ? localTimeOf(existing.ended_at) : "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const toNeeded = !existing || existing.ended_at !== null || to.time !== "";
  const ok = Boolean(jobId) && Boolean(from.at) && (!toNeeded || Boolean(to.at)) && reason.trim().length >= 3 && (!to.at || !from.at || to.at >= from.at);
  async function save() {
    if (!from.at) return;
    setBusy(true);
    try {
      await onSave({ jobId, from: from.at, to: toNeeded ? to.at : null, reason: reason.trim() });
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{existing ? "Correct job time" : "Add job time"}</DialogTitle>
          <DialogDescription>For time you forgot to Start or Stop. Once the week is approved only an admin can change it.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <label className="grid gap-1 text-sm font-medium">
            Job
            <select className="rounded-md border px-2 py-2" value={jobId} onChange={(e) => setJobId(e.target.value)} disabled={Boolean(existing)}>
              <option value="">Choose a job</option>
              {jobs.map((j) => <option key={j.id} value={j.id}>{j.job_no}{j.customer ? ` · ${j.customer}` : ""}</option>)}
            </select>
          </label>
          <TimeField label="From" value={from} />
          <TimeField label="To" value={to} />
          <label className="grid gap-1 text-sm font-medium">
            Reason
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="For example: deburring, forgot to press Start" />
          </label>
          {from.error || (toNeeded && to.error) ? <p className="text-sm text-amber-700">{from.error ?? to.error}</p> : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void save()} disabled={busy || !ok}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
