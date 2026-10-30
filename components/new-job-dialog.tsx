"use client";

/**
 * "New job" on the Job Board (migration 042): a customer job with no sales order, or an Internal job (for the company itself: rework,
 * tooling, a fixture), optionally related to another job, with the machines it runs on and their hours. Each machine is booked from
 * its own start (by default its next free slot, as on the schedule), all in parallel. A clash is shown before saving: an admin may book
 * anyway (recorded), everyone else picks a free time. The J number is given by the server, so creating needs a connection.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Plus, Trash2 } from "lucide-react";

import { CustomerSelect } from "@/components/customer-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ukDateTime } from "@/lib/auto-booking";
import { friendlyError } from "@/lib/friendly-error";
import {
  type Machine, type ScheduledBooking, defaultJobStart, fetchSchedule, formatDateTimeShort, planJobBookings, scheduleAll, toLocalInputValue,
} from "@/lib/machine-schedule";
import { onReconnect, prereqOutcome } from "@/lib/offline/reconnect";
import { isNetworkError } from "@/lib/offline/store";
import { confirmPageCompany } from "@/lib/page-company";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

export type RelatedChoice = { id: string; job_no: string; description: string };
type Row = { key: number; machineId: string; hours: string; start: string; touched: boolean };

export const OFFLINE_MESSAGE = "Creating a job needs a connection: the job number comes from the server. Try again when you're back online.";
const MAX_MACHINES = 10;

export function NewJobDialog({ open, role, jobs, onClose, onCreated }: {
  open: boolean;
  role: string | null | undefined;
  jobs: RelatedChoice[];
  onClose: () => void;
  onCreated: (created: { job_id: string; job_no: string }) => void;
}) {
  const isAdmin = role === "admin";
  const touch = role === "workshop" ? "min-h-11 pointer-coarse:min-h-12" : "min-h-11";
  const [internal, setInternal] = useState(false);
  const [customer, setCustomer] = useState("");
  const [description, setDescription] = useState("");
  const [required, setRequired] = useState("");
  const [related, setRelated] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [offline, setOffline] = useState(false);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledBooking[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bumped by Retry and by the browser's `online` event: loads the machines and schedule again (and clears "offline" when it works). */
  const [attempt, setAttempt] = useState(0);
  const now = useMemo(() => new Date(), [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // A fresh form each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setInternal(false); setCustomer(""); setDescription(""); setRequired(""); setRelated(""); setRows([]); setOverride(false);
  }, [open]);

  // The prerequisites (machines and the schedule): loaded on open, on Retry and whenever the connection comes back. The form is kept.
  useEffect(() => {
    if (!open) return;
    const browserOnline = () => typeof navigator === "undefined" || navigator.onLine !== false;
    setLoadError(null);
    setOffline(!browserOnline());
    if (!supabase) return;
    let active = true;
    fetchSchedule()
      .then(({ machines: list, bookings }) => {
        if (!active) return;
        const live = list.filter((m) => m.active);
        setMachines(live);
        setScheduled(scheduleAll(bookings, live, now));
        const next = prereqOutcome(null, browserOnline(), String);
        setOffline(next.offline); setLoadError(next.loadError);
      })
      .catch((error) => {
        if (!active) return;
        const next = prereqOutcome(error, browserOnline(), (e) => friendlyError(e, "Couldn't load the machines."));
        setOffline(next.offline); setLoadError(next.loadError);
      });
    return () => { active = false; };
  }, [open, now, attempt]);

  useEffect(() => {
    if (!open) return;
    return onReconnect(typeof window === "undefined" ? undefined : window, () => setAttempt((n) => n + 1));
  }, [open]);

  const byId = useMemo(() => new Map(machines.map((m) => [m.id, m])), [machines]);
  const startOf = (row: Row) => {
    if (row.touched) return row.start;
    const machine = byId.get(row.machineId);
    return machine ? toLocalInputValue(defaultJobStart(machine, scheduled, now)) : "";
  };
  const plan = planJobBookings(
    rows.filter((row) => row.machineId).map((row) => ({ machineId: row.machineId, hours: Number(row.hours), start: startOf(row) ? new Date(startOf(row)) : null })),
    machines, scheduled, now,
  );
  const clashes = plan.clashes;
  const badRow = rows.some((row) => !row.machineId || row.hours === "" || !(Number(row.hours) >= 0 && Number(row.hours) <= 1000) || Number.isNaN(new Date(startOf(row)).getTime()));
  const usedMachines = new Set(rows.map((row) => row.machineId));
  const customerMissing = !internal && !customer.trim();
  const blocked = offline || saving || !description.trim() || customerMissing || badRow || (clashes.length > 0 && !(isAdmin && override && reason.trim().length >= 3));

  const setRow = (key: number, patch: Partial<Row>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const addRow = () => {
    const free = machines.find((m) => !usedMachines.has(m.id));
    setRows((current) => [...current, { key: Date.now() + current.length, machineId: free?.id ?? "", hours: "", start: "", touched: false }]);
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (blocked || !supabase) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) { setOffline(true); return; }
    setSaving(true);
    try {
      // create_job files the job in the session's company: refused if another tab switched it since this page opened (S5).
      await confirmPageCompany(supabase);
      const { data, error } = await supabase.rpc("create_job", {
        p_customer: customer.trim() || null,
        p_description: description.trim(),
        p_internal: internal,
        p_related: related || null,
        p_required: required || null,
        p_machines: plan.payload,
        p_clash_override: isAdmin && override,
        p_clashes: clashes,
        p_override_reason: isAdmin && override ? reason.trim() : null,
      });
      if (error) throw error;
      // The bookings create_job made, each from its start (the machine's next free time unless chosen), in UK time.
      const booked = plan.bookings.filter((b) => b.hours > 0).map((b) => `${b.machine.name}: Booked on the schedule from ${ukDateTime(b.start)} until ${ukDateTime(b.finish)}`);
      if (booked.length) toast.info(booked.join(". "), { duration: 10000 });
      onCreated(data as { job_id: string; job_no: string });
    } catch (error) {
      if (isNetworkError(error)) setOffline(true);
      else if ((error as { hint?: string })?.hint === "machine_clash") toast.error((error as { message?: string }).message || "A machine is already booked at that time. Pick a free time (only an admin can book over another job).");
      else if ((error as { hint?: string })?.hint === "override_reason") toast.error("Give a reason for booking over another job (3 to 500 characters).");
      else toast.error(friendlyError(error, "Couldn't create the job."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !saving && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New job</DialogTitle>
          <DialogDescription>A customer job without a sales order, or an internal job for the company itself. No purchase order either way; the J number is the next in the sequence.</DialogDescription>
        </DialogHeader>
        {offline ? (
          <div role="alert" data-testid="new-job-offline" className="flex flex-wrap items-center gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <p className="flex-1">{OFFLINE_MESSAGE}</p>
            <Button type="button" variant="outline" className={touch} onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
          </div>
        ) : null}
        <form onSubmit={submit} className="space-y-4" aria-label="New job">
          <label className={cn("flex items-center gap-3 text-sm font-medium", touch)}>
            <input type="checkbox" className="size-5" checked={internal} onChange={(e) => setInternal(e.target.checked)} />
            Internal job (for the company itself: rework, tooling, a fixture)
          </label>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="new-job-customer">Customer{internal ? " (optional)" : ""}</label>
            <CustomerSelect name="customer" value={customer} onValueChange={setCustomer} required={!internal} className={touch} />
            {customerMissing ? <p className="text-xs text-slate-500">A customer job needs a customer. Tick Internal for a job made for the company itself.</p> : null}
            {/* The customer list is read by admin and office only (existing access rule): the workshop makes internal jobs here. */}
            {role === "workshop" && !internal ? <p className="text-xs text-slate-500">The customer list is kept by the office. Tick Internal, or ask the office to create a customer job.</p> : null}
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium" htmlFor="new-job-description">Description</label>
            <Textarea id="new-job-description" required maxLength={500} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="new-job-required">Date required (optional)</label>
              <Input id="new-job-required" type="date" className={touch} value={required} onChange={(e) => setRequired(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium" htmlFor="new-job-related">Related job (optional)</label>
              <select id="new-job-related" className={cn("w-full rounded-md border bg-background px-3 text-sm", touch)} value={related} onChange={(e) => setRelated(e.target.value)}>
                <option value="">None</option>
                {jobs.map((job) => <option key={job.id} value={job.id}>{job.job_no}{job.description ? ` - ${job.description.slice(0, 60)}` : ""}</option>)}
              </select>
            </div>
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Machines and time estimate</legend>
            <p className="text-xs text-slate-500">Each machine is booked on the schedule from its start for its hours, in parallel. The start defaults to the machine&apos;s next free time.</p>
            {loadError ? (
              <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-red-700">
                <p className="flex-1">{loadError}</p>
                <Button type="button" variant="outline" className={touch} onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
              </div>
            ) : null}
            {rows.map((row, index) => {
              const booked = plan.bookings.find((b) => b.machine.id === row.machineId);
              return (
                <div key={row.key} data-testid="new-job-machine" className="grid gap-2 rounded-md border p-2 sm:grid-cols-[1fr_6rem_14rem_auto] sm:items-end">
                  <label className="space-y-1 text-xs">Machine {index + 1}
                    <select aria-label={`Machine ${index + 1}`} className={cn("w-full rounded-md border bg-background px-3 text-sm", touch)} value={row.machineId} onChange={(e) => setRow(row.key, { machineId: e.target.value, touched: false })}>
                      <option value="">Choose a machine</option>
                      {machines.filter((m) => m.id === row.machineId || !usedMachines.has(m.id)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </label>
                  <label className="space-y-1 text-xs">Hours
                    <Input aria-label={`Hours on machine ${index + 1}`} type="number" min={0} max={1000} step="0.25" className={touch} value={row.hours} onChange={(e) => setRow(row.key, { hours: e.target.value })} />
                  </label>
                  <label className="space-y-1 text-xs">Start
                    <Input aria-label={`Start on machine ${index + 1}`} type="datetime-local" className={touch} value={startOf(row)} onChange={(e) => setRow(row.key, { start: e.target.value, touched: true })} />
                  </label>
                  <Button type="button" variant="outline" className={touch} aria-label={`Remove machine ${index + 1}`} onClick={() => setRows((current) => current.filter((item) => item.key !== row.key))}><Trash2 className="size-4" /></Button>
                  {booked && booked.hours > 0 ? <p className="text-xs text-slate-500 sm:col-span-4">Finishes about {formatDateTimeShort(booked.finish)}{booked.clashes.length ? <span className="font-semibold text-amber-700 dark:text-amber-400">{` - clashes with ${[...new Set(booked.clashes.map((c) => c.jobNo))].join(", ")}`}</span> : null}</p> : null}
                </div>
              );
            })}
            <Button type="button" variant="outline" className={touch} disabled={rows.length >= MAX_MACHINES || rows.length >= machines.length} onClick={addRow}><Plus className="size-4" /> Add machine</Button>
          </fieldset>

          {clashes.length ? (
            <div role="alert" data-testid="new-job-clash" className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <p className="font-semibold">Already booked: {[...new Set(clashes.map((c) => c.job_no))].join(", ")}.</p>
              {isAdmin ? (
                <>
                  <label className={cn("flex items-center gap-3", touch)}>
                    <input type="checkbox" className="size-5" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                    Book anyway (admin; recorded in the activity log with your reason)
                  </label>
                  {override ? <textarea data-testid="override-reason" className="min-h-20 w-full rounded-md border bg-background p-2 text-sm" placeholder="Why this job goes over the other booking (required, 3 to 500 characters)" value={reason} onChange={(e) => setReason(e.target.value)} /> : null}
                </>
              ) : <p>Pick a free time for that machine. Only an admin can book over another job.</p>}
              {isAdmin && override ? <p className="text-xs">The reason, the bookings found and who booked are kept in the activity log.</p> : null}
            </div>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" className={touch} disabled={saving} onClick={onClose}>Cancel</Button>
            <Button type="submit" className={cn("bg-brand text-brand-ink", touch)} disabled={blocked}>{saving ? "Creating..." : "Create job"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
