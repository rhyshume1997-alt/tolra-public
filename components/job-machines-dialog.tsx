"use client";

/**
 * The machines a job runs on and their hours, editable on the Job Board (migration 043): carried from the sales order, or added here.
 * Each machine can be booked on the schedule from a start (by default the machine's next free slot, as on the schedule and in "New job");
 * a booking already made moves when its start is changed. A machine just picked and not ticked goes on the schedule by itself at its next
 * free slot (after every booking on that machine, in its working hours; migration 061, Rhys 15 Oct) and the toast says when; on a
 * database before 061 it stays a plan row and the dialog says so. A clash is shown before saving: an admin may book anyway (recorded), everyone
 * else picks a free time. Admin, office and workshop edit; the viewer only reads the board.
 *
 * The rows load the job's bookings too (lib/job-machine-plan): a booking made on the Machine Schedule for this job is not linked to the
 * job's plan row, so it is shown ("adopted") with its hours and start, and saving never books that machine a second time. Opening the
 * dialog and Cancel only read; Save with nothing changed sends nothing.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { friendlyError } from "@/lib/friendly-error";
import { type SavedJobMachine, autoBookedLines, databaseAutoBooks, notBookedYet } from "@/lib/auto-booking";
import { type JobMachineEntry, keepsBooking, loadJobMachinesForDialog, machinesSaveReady, planMachinesSave } from "@/lib/job-machine-plan";
import {
  type Booking, type Machine, type ScheduledBooking, defaultJobStart, deleteBooking, formatDateTimeShort, planJobBookings, saveBooking, scheduleAll, toLocalInputValue,
} from "@/lib/machine-schedule";
import { MAX_MACHINES, MAX_MACHINE_HOURS } from "@/lib/so-machines";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

export type JobMachinesJob = { id: string; job_no: string };
type Row = {
  key: number;
  machineId: string;
  hours: string;
  book: boolean;
  start: string;
  touched: boolean;
  /** The person changed the start of the row's existing booking. */
  startEdited: boolean;
  /** The booking the row was loaded with (linked by the plan, or adopted from the schedule), or null. */
  booking: Booking | null;
  linked: boolean;
};

const STATUS_WORD: Record<Booking["status"], string> = { booked: "", running: " (running)", complete: " (complete)" };

export function JobMachinesDialog({ job, role, onClose, onSaved }: { job: JobMachinesJob | null; role: string | null | undefined; onClose: () => void; onSaved: () => void }) {
  const isAdmin = role === "admin";
  const touch = role === "workshop" ? "min-h-11 pointer-coarse:min-h-12" : "min-h-11";
  const jobId = job?.id ?? null;
  const [rows, setRows] = useState<Row[]>([]);
  const [loaded, setLoaded] = useState<JobMachineEntry<Booking>[]>([]);
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledBooking[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  /**
   * The job whose machines and bookings were loaded successfully. Save stays disabled until it is this job: an empty list saved after a
   * failed (or not yet finished) load would take every machine off the job and remove its bookings (set_job_machines, migration 043).
   */
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Keyed on the job's id, not the object: the board passes a new object on every render, which used to reload the dialog (and drop
  // the edits) whenever the board refreshed.
  const now = useMemo(() => new Date(), [jobId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!jobId || !supabase) return;
    let active = true;
    setRows([]); setLoaded([]); setOverride(false); setReason(""); setLoadError(null); setLoadedFor(null); setLoading(true);
    // Reads only (lib/job-machine-plan loadJobMachinesForDialog): opening the dialog never writes.
    loadJobMachinesForDialog(jobId).then(({ machines: all, bookings, entries }) => {
      if (!active) return;
      const live = all.filter((m) => m.active);
      setMachines(live);
      // Clashes are against OTHER jobs' bookings: this job's own bookings move with the edit.
      setScheduled(scheduleAll(bookings.filter((b) => b.jobId !== jobId), live, now));
      setLoaded(entries);
      setRows(entries.map((entry, i) => ({
        key: i + 1, machineId: entry.machineId, hours: String(entry.hours), book: Boolean(entry.booking),
        start: entry.booking ? toLocalInputValue(new Date(entry.booking.startAt)) : "", touched: Boolean(entry.booking), startEdited: false,
        booking: entry.booking, linked: entry.linked,
      })));
      setLoadedFor(jobId);
    }).catch((error) => { if (active) setLoadError(friendlyError(error, "Couldn't load the job's machines.")); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [jobId, now, attempt]);

  const byId = useMemo(() => new Map(machines.map((m) => [m.id, m])), [machines]);
  const startOf = (row: Row) => {
    if (row.touched) return row.start;
    const machine = byId.get(row.machineId);
    return machine ? toLocalInputValue(defaultJobStart(machine, scheduled, now)) : "";
  };
  /** The start the row's booking moves to, when the person changed it to another time. */
  const startChanged = (row: Row) => Boolean(row.booking && row.startEdited && row.start !== toLocalInputValue(new Date(row.booking.startAt)));
  /** A row that writes machine time on save: a new booking, or a booking still only booked that moves or changes hours. */
  const writesTime = (row: Row) => {
    if (!row.machineId) return false;
    if (keepsBooking(row)) return row.booking!.status === "booked" && (startChanged(row) || Number(row.hours) !== row.booking!.estimatedHours);
    return row.book;
  };
  // Only rows that write are checked for clashes (as the database does): an unchanged booking never blocks saving another row.
  const writing = rows.filter(writesTime);
  const plan = planJobBookings(writing.map((row) => ({ machineId: row.machineId, hours: Number(row.hours), start: startOf(row) ? new Date(startOf(row)) : null })), machines, scheduled, now);
  const clashes = plan.clashes;
  const badRow = rows.some((row) => !row.machineId || row.hours === "" || !(Number(row.hours) >= 0 && Number(row.hours) <= MAX_MACHINE_HOURS) || (row.book && Number.isNaN(new Date(startOf(row)).getTime())));
  const usedMachines = new Set(rows.map((row) => row.machineId));
  const ready = machinesSaveReady({ jobId, loadedFor, loading, loadError });
  const blocked = !ready || saving || badRow || (clashes.length > 0 && !(isAdmin && override && reason.trim().length >= 3));

  const setRow = (key: number, patch: Partial<Row>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const addRow = () => {
    const free = machines.find((m) => !usedMachines.has(m.id));
    setRows((current) => [...current, { key: Date.now() + current.length, machineId: free?.id ?? "", hours: "", book: false, start: "", touched: false, startEdited: false, booking: null, linked: false }]);
  };
  const changeMachine = (row: Row, machineId: string) => {
    // Back on the machine of its booking: the booking's start again. Another machine: a new start (the old booking is removed on save).
    if (row.booking && row.booking.machineId === machineId) setRow(row.key, { machineId, start: toLocalInputValue(new Date(row.booking.startAt)), touched: true, startEdited: false, book: true });
    else setRow(row.key, { machineId, touched: false, startEdited: false });
  };

  async function save() {
    if (!job || !supabase || blocked || !machinesSaveReady({ jobId: job.id, loadedFor, loading, loadError })) return;
    const saveRows = rows.map((row) => {
      const start = row.book || keepsBooking(row) ? startOf(row) : "";
      return { machineId: row.machineId, hours: Number(row.hours), book: row.book, start: start ? new Date(start).toISOString() : null, startChanged: startChanged(row), booking: row.booking, linked: row.linked };
    });
    const todo = planMachinesSave(loaded, saveRows);
    if (!todo.changed) {
      // Nothing to save: no request at all (an accidental Save, or Enter in a field, writes nothing).
      toast.info(`No changes to ${job.job_no}'s machines.`);
      onClose();
      return;
    }
    const overriding = isAdmin && override;
    setSaving(true);
    try {
      // 1. A booking made on the schedule (not linked to the plan) moves or changes hours through the schedule's own function, as the
      // schedule writes it (clash check under the company lock; a day plan is cleared, as set_job_machines clears it).
      for (const update of todo.bookingUpdates) {
        await saveBooking({ ...update.booking, machineId: update.machineId, jobId: job.id, jobNo: job.job_no, startAt: update.startAt, estimatedHours: update.hours, status: "booked", dayPlan: null },
          { clearDayPlan: true, clashOverride: overriding, overrideReason: overriding ? reason.trim() : undefined });
      }
      // 2. The plan. Rows with an adopted booking carry no start, so no second booking is made for them.
      const { data, error } = await supabase.rpc("set_job_machines", { p_job: job.id, p_machines: todo.payload, p_clash_override: overriding, p_clashes: clashes, p_override_reason: overriding ? reason.trim() : null });
      if (error) throw error;
      const saved = ((data as { machines?: SavedJobMachine[] } | null)?.machines ?? []) as SavedJobMachine[];
      // 3. A schedule booking whose machine was taken off the job, still only booked: off the schedule too (set_job_machines does the same
      // for the bookings it knows).
      for (const booking of todo.removeBookings) await deleteBooking(booking.id);
      // What the database booked by itself (061), with its start and finish; on an older database, the machines left unbooked.
      const booked = autoBookedLines(saved, (id) => byId.get(id)?.name);
      toast.success(`Machines saved on ${job.job_no}`, booked.length ? { description: booked.join(". "), duration: 10000 } : undefined);
      const picked = new Set(rows.filter((row) => !row.booking && !row.book && !loaded.some((entry) => entry.machineId === row.machineId)).map((row) => row.machineId));
      const waiting = databaseAutoBooks(saved) ? [] : notBookedYet(saved, picked);
      if (waiting.length) toast.info(`${waiting.map((m) => byId.get(m.machine_id)?.name ?? "A machine").join(", ")} ${waiting.length === 1 ? "is" : "are"} on the job but not on the schedule yet: open Machines and tick Book on schedule.`);
      onSaved();
      onClose();
    } catch (error) {
      if ((error as { hint?: string })?.hint === "machine_clash") toast.error("A machine is already booked at that time. Pick a free time (only an admin can book over another job).");
      else if ((error as { hint?: string })?.hint === "override_reason") toast.error("Give a reason for booking over another job (3 to 500 characters).");
      else toast.error(friendlyError(error, "Couldn't save the machines."));
      onSaved(); // a step may have been written before the failure: the board shows what is stored
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={Boolean(job)} onOpenChange={(next) => !next && !saving && onClose()}>
      {/* Width only: the shared DialogContent keeps the dvh height bound and scrolling, so the controls stay reachable with the phone keyboard open. */}
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Machines - {job?.job_no}</DialogTitle>
          <DialogDescription>The machines this job runs on and the hours each needs. A machine you add goes on the schedule at its next free time when you save; tick &quot;Book on schedule&quot; to choose the start. A booking already made moves with its start.</DialogDescription>
        </DialogHeader>
        {loadError ? (
          <div role="alert" data-testid="job-machines-load-error" className="flex flex-wrap items-center gap-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/40 dark:text-red-200">
            <p className="flex-1">{loadError} Nothing can be saved until the job&apos;s machines load.</p>
            <Button type="button" variant="outline" className={touch} onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
          </div>
        ) : null}
        {loading ? <p className="text-sm text-slate-500" role="status">Loading...</p> : null}
        <form onSubmit={(e) => { e.preventDefault(); void save(); }} className="space-y-4" aria-label="Job machines">
          <fieldset className="space-y-2">
            <legend className="sr-only">Machines and time estimate</legend>
            {!loading && rows.length === 0 ? <p className="text-sm text-slate-500">No machine on this job yet.</p> : null}
            {rows.map((row, index) => {
              const kept = keepsBooking(row);
              const movable = !kept || row.booking!.status === "booked";
              const planned = writesTime(row) ? plan.bookings.find((b) => b.machine.id === row.machineId) : undefined;
              const leaving = row.booking && !kept && row.booking.status === "booked" ? byId.get(row.booking.machineId)?.name ?? "the old machine" : null;
              return (
                <div key={row.key} data-testid="job-machine" className="grid gap-2 rounded-md border p-2 sm:grid-cols-[1fr_6rem_auto] sm:items-end">
                  <label className="space-y-1 text-xs">Machine {index + 1}
                    <select aria-label={`Machine ${index + 1}`} className={cn("w-full rounded-md border bg-background px-3 text-sm", touch)} value={row.machineId} onChange={(e) => changeMachine(row, e.target.value)}>
                      <option value="">Choose a machine</option>
                      {machines.filter((m) => m.id === row.machineId || !usedMachines.has(m.id)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs">Hours
                    <Input aria-label={`Hours on machine ${index + 1}`} type="number" min={0} max={MAX_MACHINE_HOURS} step="0.25" className={touch} value={row.hours} onChange={(e) => setRow(row.key, { hours: e.target.value })} />
                  </label>
                  <Button type="button" variant="outline" className={touch} aria-label={`Remove machine ${index + 1}`} onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}><Trash2 className="size-4" /></Button>
                  <div className="flex flex-wrap items-end gap-3 sm:col-span-3">
                    <label className={cn("flex items-center gap-2 text-xs", touch)}>
                      <input type="checkbox" className="size-5" aria-label={`Book machine ${index + 1} on schedule`} checked={kept || row.book} disabled={kept} onChange={(e) => setRow(row.key, { book: e.target.checked })} />
                      {kept ? `Booked on the schedule${STATUS_WORD[row.booking!.status]}` : "Book on schedule"}
                    </label>
                    {kept || row.book ? (
                      <label className="space-y-1 text-xs">Start
                        <Input aria-label={`Start on machine ${index + 1}`} type="datetime-local" className={touch} disabled={!movable} value={startOf(row)} onChange={(e) => setRow(row.key, { start: e.target.value, touched: true, startEdited: true })} />
                      </label>
                    ) : null}
                    {planned && planned.hours > 0 ? <p className="text-xs text-slate-500">Finishes about {formatDateTimeShort(planned.finish)}{planned.clashes.length ? <span className="font-semibold text-amber-700 dark:text-amber-400">{` - clashes with ${[...new Set(planned.clashes.map((c) => c.jobNo))].join(", ")}`}</span> : null}</p> : null}
                    {!kept && !row.book && !row.booking && row.machineId && Number(row.hours) > 0 && !loaded.some((entry) => entry.machineId === row.machineId)
                      ? <p className="text-xs text-slate-500" data-testid="auto-book-hint">Goes on the schedule at {byId.get(row.machineId)?.name ?? "the machine"}&apos;s next free time when you save.</p> : null}
                    {leaving ? <p className="text-xs text-amber-700 dark:text-amber-400">Its booking on {leaving} is removed from the schedule when you save.</p> : null}
                  </div>
                </div>
              );
            })}
            <Button type="button" variant="outline" className={touch} disabled={!ready || rows.length >= MAX_MACHINES || rows.length >= machines.length} onClick={addRow}><Plus className="size-4" /> Add machine</Button>
          </fieldset>

          {clashes.length ? (
            <div role="alert" data-testid="job-machines-clash" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <p className="font-semibold">Already booked: {[...new Set(clashes.map((c) => c.job_no))].join(", ")}.</p>
              {isAdmin ? (
                <label className={cn("flex items-center gap-3", touch)}>
                  <input type="checkbox" className="size-5" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                  Book anyway (admin; recorded in the activity log with your reason)
                </label>
              ) : <p>Pick a free time for that machine. Only an admin can book over another job.</p>}
              {isAdmin && override ? <textarea data-testid="override-reason" aria-label="Reason for booking over another job" className="min-h-20 w-full rounded-md border bg-background p-2 text-sm" placeholder="Why this job goes over the other booking (required, 3 to 500 characters)" value={reason} onChange={(e) => setReason(e.target.value)} /> : null}
              {isAdmin && override ? <p className="text-xs">The reason, the bookings found and who booked are kept in the activity log.</p> : null}
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            {/* Cancel only closes: nothing is written. */}
            <Button type="button" variant="outline" className={touch} disabled={saving} onClick={onClose}>Cancel</Button>
            <Button type="submit" className={cn("bg-brand text-brand-ink", touch)} disabled={blocked}>{saving ? "Saving..." : "Save machines"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
