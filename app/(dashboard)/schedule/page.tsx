"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CalendarClock, Flag, Pencil, Plus } from "lucide-react";

import { DayPlanField, planStartIso, todayString, useDayPlanForm } from "@/components/day-plan-editor";
import { MachineGantt } from "@/components/machine-gantt";
import { MachineStatusCards } from "@/components/machine-status-cards";
import { type InUseRow, type PausedRow, indexInUse, inUseRows, newClientOpId, pausedRows, pausedWarningText, runRefusal } from "@/lib/machine-runs";
import { peopleMap, type PeopleMap } from "@/lib/people";
import { RUN_COLUMNS, runRows, runWindowFilter, runningForText, sinceText, unbookedFinishText, unbookedLeftText, unbookedRunning, type RunBar, type RunRow } from "@/lib/schedule-live";
import { type RunPlan, loadRunPlan, runPlanKey, unbookedRunView } from "@/lib/run-plan";
import { RoleGate } from "@/components/role-gate";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { auditEvent } from "@/lib/audit";
import { useCompanyProfile, workStartOn, workingHoursOf } from "@/lib/company";
import { supabase } from "@/lib/supabase";
import {
  type BookingSaveOptions, DEFAULT_WORKING_DAYS, bookedNotStarted, WEEKDAY_OPTIONS, addDaysToDate, bookingSaveMessage, completeFinishedJobBookings, computeFinish, daysBetweenDates, deleteBooking, demoBookings, demoJobs, demoMachines, fetchSchedule,
  findOverlaps, formatDateTimeShort, formatDayPlan, isoWeekday, timeOf, formatHours, localDateString, machineStatus, normaliseStart, planSegments, saveBooking, saveMachine, scheduleAll,
  formatHoursClock, liveLeftText, runClock, toLocalInputValue, type Booking, type BookingStatus, type Machine, type ScheduledBooking, type ScheduleJob,
} from "@/lib/machine-schedule";
import { DEMO_MACHINES } from "@/lib/job-worksheet";
import { fmtDate } from "@/lib/dates";
import { DEMO_MODE } from "@/lib/demo";
import { loadOfflineSnapshot, reportOffline, saveOfflineSnapshot } from "@/lib/offline/scope";
import { isNetworkError } from "@/lib/offline/store";
import { friendlyError } from "@/lib/friendly-error";
import { useSaving } from "@/lib/use-saving";
import { useUser } from "@/lib/use-user";

const selectClass = "h-10 w-full rounded-lg border border-input bg-white px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand/40";
const navy = "bg-brand text-brand-ink hover:bg-brand-hover";
const STATUS_LABEL: Record<BookingStatus, string> = { booked: "Booked", running: "Running", complete: "Complete" };
/** The status words on screen: a booking past its start with no run started reads "Booked, not started" (still booked and blocking). */
const bookingStatusLabel = (b: ScheduledBooking, now: Date) => (bookedNotStarted(b, now) ? "Booked, not started" : STATUS_LABEL[b.status]);

const emptyMachine: Omit<Machine, "id"> & { id?: string } = { name: "", type: "", hoursPerDay: 8, workingDays: DEFAULT_WORKING_DAYS, active: true };

export default function SchedulePage() {
  const { activeRole } = useUser();
  const canManageMachines = activeRole === "admin" || activeRole === "office";
  const canBook = canManageMachines || activeRole === "workshop";

  const [machines, setMachines] = useState<Machine[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [jobs, setJobs] = useState<ScheduleJob[]>([]);
  const [demo, setDemo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { saving, run } = useSaving();
  const [seeded, setSeeded] = useState(false);
  // Example machine list: offered as a template, nothing chosen until the person ticks it (audit D20).
  const [templateOpen, setTemplateOpen] = useState(false);
  const [templatePicks, setTemplatePicks] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => new Date());
  const [editingMachine, setEditingMachine] = useState<(Omit<Machine, "id"> & { id?: string }) | null>(null);
  // "Show finished" is remembered in this browser, like the Job Board's time unit.
  const [showFinished, setShowFinished] = useState(false);
  useEffect(() => { try { if (window.localStorage.getItem("schedule-show-finished") === "1") setShowFinished(true); } catch { /* not remembered */ } }, []);
  const chooseShowFinished = (on: boolean) => { setShowFinished(on); try { window.localStorage.setItem("schedule-show-finished", on ? "1" : "0"); } catch { /* not remembered */ } };
  const [booking, setBooking] = useState<{ jobId?: string; machineId?: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Live use (migration 044): open runs (machines_in_use), the timeline window's runs (machine_runs) and the people's names.
  const [inUse, setInUse] = useState<InUseRow[]>([]);
  // Machines whose last run was paused on an unfinished job (migration 049): Book job warns before booking over them.
  const [paused, setPaused] = useState<PausedRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [people, setPeople] = useState<PeopleMap>({});
  const [liveError, setLiveError] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<{ bar: RunBar; label: string } | null>(null);
  const rangeRef = useRef<{ start: Date; end: Date } | null>(null);
  const busyRef = useRef(false);
  const pendingRef = useRef<"live" | "all" | null>(null);

  const loadDemo = useCallback(() => {
    setMachines(demoMachines());
    setBookings(demoBookings());
    setJobs(demoJobs());
    setDemo(true);
  }, []);

  /**
   * Re-reads live use (and with "all" the bookings too) without the loading skeleton. One read at a time: a call made while one is
   * running is folded into one more read straight after, so reads never overlap or answer out of order. Errors are shown, never dropped.
   */
  const refresh = useCallback(async (what: "live" | "all") => {
    const client = supabase;
    if (!client) return; // demo data: nothing live to read
    if (busyRef.current) {
      pendingRef.current = pendingRef.current === "all" || what === "all" ? "all" : "live";
      return;
    }
    busyRef.current = true;
    let next: "live" | "all" | null = what;
    try {
      while (next) {
        const full = next === "all";
        pendingRef.current = null;
        const problems: string[] = [];
        if (full) {
          try {
            const data = await fetchSchedule();
            setMachines(data.machines);
            setBookings(data.bookings);
            setJobs(data.jobs);
            void saveOfflineSnapshot("schedule", data);
            reportOffline(false);
          } catch (err) {
            problems.push(friendlyError(err, "The bookings couldn't be refreshed."));
          }
        }
        const range = rangeRef.current;
        try {
          const filter = range ? runWindowFilter(range.start, range.end) : null;
          const [liveRes, runsRes, whoRes, pausedRes] = await Promise.all([
            client.rpc("machines_in_use"),
            // Machine runs only: a bench run (machine_id null, migration 046) has no machine row to draw on.
            filter ? client.from("machine_runs").select(RUN_COLUMNS).not("machine_id", "is", null).lt("started_at", filter.before).or(filter.or).order("started_at") : Promise.resolve(null),
            client.rpc("company_people"),
            client.rpc("paused_machines"),
          ]);
          // Best effort (a server without 049 has no paused_machines): the booking just isn't warned about.
          if (!pausedRes.error) setPaused(pausedRows(pausedRes.data));
          if (liveRes.error) problems.push(friendlyError(liveRes.error, "Who is on which machine couldn't be loaded."));
          else setInUse(inUseRows(liveRes.data));
          if (runsRes?.error) problems.push(friendlyError(runsRes.error, "The timeline's actual machine use couldn't be loaded."));
          else if (runsRes) setRuns(runRows(runsRes.data));
          if (whoRes.error) problems.push(friendlyError(whoRes.error, "Operator names couldn't be loaded."));
          else setPeople(peopleMap(whoRes.data));
        } catch (err) {
          problems.push(friendlyError(err, "Live machine use couldn't be loaded."));
        }
        setLiveError(problems.length ? [...new Set(problems)].join(" ") : null);
        setNow(new Date());
        next = pendingRef.current;
      }
    } finally {
      busyRef.current = false;
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (!supabase) {
        if (!DEMO_MODE) throw new Error("Supabase is not configured.");
        loadDemo();
        return;
      }
      const data = await fetchSchedule();
      setMachines(data.machines);
      setBookings(data.bookings);
      setJobs(data.jobs);
      setDemo(false);
      // Live use for the timeline window already shown (a Retry); the first time, the timeline asks once it knows its window.
      if (rangeRef.current) void refresh("live");
      // This device's offline copy of the schedule (lib/offline), refreshed on every successful load.
      void saveOfflineSnapshot("schedule", data);
      reportOffline(false);
    } catch (err) {
      const copy = isNetworkError(err) ? await loadOfflineSnapshot<Awaited<ReturnType<typeof fetchSchedule>>>("schedule") : null;
      if (copy) {
        setMachines(copy.data.machines);
        setBookings(copy.data.bookings);
        setJobs(copy.data.jobs);
        setDemo(false);
        reportOffline(true, copy.syncedAt);
        return;
      }
      setError(friendlyError(err, "Couldn't load the machine schedule."));
    } finally {
      setLoading(false);
    }
  }, [loadDemo, refresh]);

  useEffect(() => { void load(); }, [load]);
  // Every 60 s the clock moves and, while the page is visible, the bookings and live use are re-read; and again whenever the
  // person comes back to the tab or window (a Start or Pause pressed on another device shows without a reload).
  useEffect(() => {
    const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
    const timer = window.setInterval(() => {
      setNow(new Date());
      if (visible()) void refresh("all");
    }, 60000);
    const onFocus = () => { if (visible()) void refresh("all"); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);
  // The timeline's window (span or week changed): that window's runs.
  const onRangeChange = useCallback((start: Date, end: Date) => {
    const prev = rangeRef.current;
    if (prev && prev.start.getTime() === start.getTime() && prev.end.getTime() === end.getTime()) return;
    rangeRef.current = { start, end };
    void refresh("live");
  }, [refresh]);

  const liveByMachine = useMemo(() => indexInUse(inUse).byMachine, [inUse]);
  // Hours left for a running booking is live (the Job Board's timer, same calculation): the estimate minus hours done minus this run's
  // time so far, ticking with the page's own minute clock (`now`); "0:20 over" past the estimate. Null for a booking with no open run or
  // no estimate (hoursLeft shows).
  const liveLeftOf = (booking: ScheduledBooking): string | null => {
    const run = booking.status === "complete" ? null : inUse.find((row) => row.booking_id === booking.id);
    const clock = run ? runClock(run.started_at, booking, now) : null;
    return clock && clock.leftMinutes !== null ? liveLeftText(clock.leftMinutes) : null;
  };
  const activeMachines = useMemo(() => machines.filter((m) => m.active), [machines]);
  // Finished work (a complete booking, or any booking of a finished job) comes off the chart and the table unless "Show finished" is on
  // (Rhys, 15 Oct). Machine status, "next free" and the clash checks only ever look at the open bookings.
  const everything = useMemo(() => scheduleAll(completeFinishedJobBookings(bookings, jobs), machines, now), [bookings, jobs, machines, now]);
  const scheduled = useMemo(() => everything.filter((b) => b.status !== "complete"), [everything]);
  const shown = showFinished ? everything : scheduled;
  const finishedCount = everything.length - scheduled.length;
  const statuses = useMemo(() => activeMachines.map((m) => machineStatus(m, scheduled, now)), [activeMachines, scheduled, now]);
  const tableRows = useMemo(() => [...shown].sort((a, b) => a.start.getTime() - b.start.getTime()), [shown]);
  const selected = everything.find((b) => b.id === selectedId) || null;
  const runningRows = useMemo(() => unbookedRunning(inUse, bookings), [inUse, bookings]);
  // An open run with no booking has no hours of its own: its job's plan row for that machine (minus the hours already run) stands in, as a
  // labelled "(plan)" estimate. Kept with the runs it was read for, so a new run never shows the old run's figures; a failed read shows elapsed only.
  // Only a run with no booking at all takes plan figures: a run whose booking merely lies outside the loaded window keeps its booking's figures (here "-").
  const planRuns = useMemo(() => runningRows.filter((r) => !r.booking_id), [runningRows]);
  const unbookedSig = useMemo(() => planRuns.map((r) => r.run_id).join(","), [planRuns]);
  const [runPlanRead, setRunPlanRead] = useState<{ sig: string; map: Map<string, RunPlan> }>({ sig: "", map: new Map() });
  const runPlan = runPlanRead.sig === unbookedSig ? runPlanRead.map : null;
  useEffect(() => {
    let active = true;
    void loadRunPlan(planRuns.map((r) => r.job_id)).then((map) => { if (active && map) setRunPlanRead({ sig: unbookedSig, map }); }, () => undefined);
    return () => { active = false; };
  }, [planRuns, unbookedSig]);
  const unbookedViews = useMemo(() => new Map(planRuns.map((r) => [r.machine_id, unbookedRunView(r.started_at, runPlan?.get(runPlanKey(r.job_id, r.machine_id)), machines.find((m) => m.id === r.machine_id), now)])), [planRuns, runPlan, machines, now]);

  function requiredDate(b: ScheduledBooking) {
    const job = jobs.find((j) => (b.jobId && j.id === b.jobId) || j.jobNo === b.jobNo);
    return job?.dateRequired || "";
  }

  async function submitMachine(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingMachine) return;
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") || "").trim();
    const hoursPerDay = Number(form.get("hours_per_day"));
    const workingDays = form.getAll("wd").map(Number);
    if (!name) { toast.error("Enter a machine name."); return; }
    if (!(hoursPerDay > 0 && hoursPerDay <= 16)) { toast.error("Hours per working day must be between 0 and 16."); return; }
    if (!workingDays.length) { toast.error("Pick at least one working day."); return; }
    const next = { id: editingMachine.id, name, type: String(form.get("type") || "").trim(), hoursPerDay, workingDays, active: form.get("active") === "on" };
    await run(async () => {
      try {
        if (demo) {
          const local: Machine = { ...next, id: next.id || `demo-m${Date.now()}` };
          setMachines((prev) => (next.id ? prev.map((m) => (m.id === local.id ? local : m)) : [...prev, local]));
          toast.success("Machine saved (demo data, not stored)");
        } else {
          const saved = await saveMachine(next);
          void auditEvent({ action: next.id ? "UPDATE" : "CREATE", entityTable: "machines", entityId: saved.id, oldData: next.id ? editingMachine : undefined, newData: saved });
          setMachines((prev) => (next.id ? prev.map((m) => (m.id === saved.id ? saved : m)) : [...prev, saved]));
          toast.success(next.id ? "Machine updated" : "Machine added");
        }
        setEditingMachine(null);
      } catch (err) {
        toast.error(friendlyError(err, "Could not save machine"));
      }
    });
  }

  async function seedMachines(names: string[]) {
    if (seeded || !names.length) return;
    setSeeded(true); // disabled after the first click so the machines can't be added twice
    setTemplateOpen(false);
    await run(async () => {
      const saved: Machine[] = [];
      try {
        for (const name of names) saved.push(await saveMachine({ name, type: "", hoursPerDay: 8, workingDays: DEFAULT_WORKING_DAYS, active: true }));
        toast.success(names.length === 1 ? "Machine added" : `${names.length} machines added`);
      } catch (err) {
        toast.error(friendlyError(err, "Could not add all the machines. Refresh to see which were added."));
      } finally {
        if (saved.length) setMachines((prev) => [...prev, ...saved]);
      }
    });
  }

  async function persistBooking(next: Omit<Booking, "id"> & { id?: string }, options: BookingSaveOptions = {}) {
    if (demo) {
      const local: Booking = { ...next, id: next.id || `demo-b${Date.now()}` };
      setBookings((prev) => (next.id ? prev.map((b) => (b.id === local.id ? local : b)) : [...prev, local]));
      toast.success("Saved (demo data, not stored)");
      return local;
    }
    // Taking a split off a booking that had one stores NULL again (the default rule); every other save leaves day_plan alone.
    const clearDayPlan = Boolean(next.id && bookings.find((b) => b.id === next.id)?.dayPlan?.length && !next.dayPlan?.length);
    const saved = await saveBooking(next, { clearDayPlan, ...options });
    void auditEvent({ action: next.id ? "UPDATE" : "CREATE", entityTable: "machine_bookings", entityId: saved.id, oldData: next.id ? bookings.find((b) => b.id === next.id) : undefined, newData: saved });
    setBookings((prev) => (next.id ? prev.map((b) => (b.id === saved.id ? saved : b)) : [...prev, saved]));
    toast.success(next.id ? "Booking updated" : "Job booked onto machine");
    return saved;
  }

  async function removeBooking(id: string) {
    try {
      if (!demo) {
        await deleteBooking(id);
        void auditEvent({ action: "DELETE", entityTable: "machine_bookings", entityId: id, oldData: bookings.find((b) => b.id === id) });
      }
      setBookings((prev) => prev.filter((b) => b.id !== id));
      setSelectedId(null);
      toast.success("Booking removed");
    } catch (err) {
      toast.error(err instanceof Error && err.message.startsWith("This booking couldn't") ? err.message : friendlyError(err, "Could not remove booking"));
    } finally {
      // Re-read the schedule so the chart shows exactly what the database holds.
      if (!demo) void load();
    }
  }

  return (
    <RoleGate allowed={["admin", "office", "workshop", "viewer"]}>
      <div className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h1 className="page-title">Machine Schedule</h1>
            <p className="mt-2 text-sm text-slate-500">Book jobs onto machines and see when each machine is free.</p>
          </div>
          {canBook ? <Button className={`min-h-11 ${navy}`} onClick={() => setBooking({})} disabled={!activeMachines.length}><CalendarClock className="size-4" /> New booking</Button> : null}
        </div>
        {error ? <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error} <button onClick={() => void load()} className="font-semibold underline">Retry</button></div> : null}
        {liveError && !error ? <div role="alert" data-testid="schedule-live-error" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Live machine use may be out of date. {liveError} <button onClick={() => void refresh("all")} className="font-semibold underline">Retry</button></div> : null}

        {loading ? <Skeleton className="h-96" /> : (
          <>
            <MachineStatusCards statuses={statuses} inUse={liveByMachine} now={now} unbooked={unbookedViews} />
            <label className="flex w-fit items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
              <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={showFinished} onChange={(e) => chooseShowFinished(e.target.checked)} />
              Show finished{finishedCount ? ` (${finishedCount})` : ""}
            </label>
            <MachineGantt
              machines={activeMachines} bookings={shown} now={now} liveLeftOf={liveLeftOf} onSelect={(b) => setSelectedId(b.id)}
              runs={runs} people={people} onRangeChange={onRangeChange} onSelectRun={(bar, label) => setRunDetail({ bar, label })}
            />

            <Card>
              <CardHeader><CardTitle className="text-lg">Jobs on machines</CardTitle></CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader className="hidden md:table-header-group"><TableRow><TableHead>Job</TableHead><TableHead>Machine</TableHead><TableHead>Start</TableHead><TableHead>Est. finish</TableHead><TableHead>Hours left</TableHead><TableHead>Status</TableHead><TableHead>Required</TableHead><TableHead /></TableRow></TableHeader>
                  <TableBody>
                    {runningRows.map((r) => {
                      const req = jobs.find((j) => j.id === r.job_id)?.dateRequired || "";
                      const view = r.booking_id ? undefined : unbookedViews.get(r.machine_id);
                      return (
                        <TableRow key={`run-${r.run_id}`} data-testid="running-unbooked" data-job-id={r.job_id} className="block bg-red-50/60 md:table-row">
                          <TableCell className="block font-semibold md:table-cell">{r.job_no || "—"}</TableCell>
                          <TableCell className="block md:table-cell">{r.machine_name}</TableCell>
                          <TableCell className="block md:table-cell">{formatDateTimeShort(new Date(r.started_at))}</TableCell>
                          <TableCell data-testid="unbooked-finish" className="block md:table-cell">{view ? unbookedFinishText(view) : "-"}</TableCell>
                          <TableCell data-testid="unbooked-left" className="block md:table-cell">{view ? unbookedLeftText(view) : "-"}</TableCell>
                          <TableCell className="block font-semibold text-red-700 md:table-cell">Running now (not booked)<span className="block text-xs font-normal text-slate-600">by {r.operator_name ?? "—"} since {sinceText(r.started_at, now)}{view?.clock ? `, ${runningForText(view.clock.elapsedMinutes)}` : ""}</span></TableCell>
                          <TableCell className="block md:table-cell">{req ? fmtDate(req) : "-"}</TableCell>
                          <TableCell className="block md:table-cell">{canBook ? <Button variant="outline" size="sm" onClick={() => setBooking({ jobId: r.job_id, machineId: r.machine_id })}>Book it</Button> : null}</TableCell>
                        </TableRow>
                      );
                    })}
                    {tableRows.map((b) => {
                      const req = requiredDate(b);
                      const late = Boolean(req) && b.status !== "complete" && b.finish > new Date(`${req}T23:59:59`);
                      return (
                        <TableRow key={b.id} className={`block md:table-row${b.status === "complete" ? " opacity-60" : ""}`}>
                          <TableCell className="block font-semibold md:table-cell">{b.jobNo || "-"}<span className="block text-xs font-normal text-slate-500">{b.description}</span></TableCell>
                          <TableCell className="block md:table-cell">{b.machine.name}</TableCell>
                          <TableCell className="block md:table-cell">{formatDateTimeShort(b.start)}</TableCell>
                          <TableCell className={`block md:table-cell ${late ? "font-semibold text-red-700" : ""}`}>
                            {formatDateTimeShort(b.finish)}
                            {late ? <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700"><Flag className="size-3" /> After required date</span> : null}
                          </TableCell>
                          <TableCell className="block md:table-cell">{liveLeftOf(b) ? <span data-testid="live-hours-left">{liveLeftOf(b)} ({formatHoursClock(b.estimatedHours)} booked)</span> : <>{formatHours(b.hoursLeft)} of {formatHours(b.estimatedHours)}</>}</TableCell>
                          <TableCell className="block md:table-cell">{bookingStatusLabel(b, now)}</TableCell>
                          <TableCell className="block md:table-cell">{req ? fmtDate(req) : "-"}</TableCell>
                          <TableCell className="block md:table-cell"><Button variant="outline" size="sm" onClick={() => setSelectedId(b.id)}>{canBook ? "Update" : "View"}</Button></TableCell>
                        </TableRow>
                      );
                    })}
                    {!tableRows.length && !runningRows.length ? <TableRow><TableCell colSpan={8} className="py-8 text-center text-slate-500">No jobs booked onto machines yet.</TableCell></TableRow> : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-3">
                <CardTitle className="text-lg">Machines</CardTitle>
                {canManageMachines ? <Button variant="outline" onClick={() => setEditingMachine(emptyMachine)}><Plus className="size-4" /> Add machine</Button> : null}
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader className="hidden md:table-header-group"><TableRow><TableHead>Name</TableHead><TableHead>Type</TableHead><TableHead>Hours per day</TableHead><TableHead>Working days</TableHead><TableHead>Active</TableHead><TableHead /></TableRow></TableHeader>
                  <TableBody>
                    {machines.map((m) => (
                      <TableRow key={m.id} className="block md:table-row">
                        <TableCell className="block font-semibold md:table-cell">{m.name}</TableCell>
                        <TableCell className="block md:table-cell">{m.type || "-"}</TableCell>
                        <TableCell className="block md:table-cell">{m.hoursPerDay}</TableCell>
                        <TableCell className="block md:table-cell">{WEEKDAY_OPTIONS.filter((d) => m.workingDays.includes(d.dow)).map((d) => d.label).join(", ")}</TableCell>
                        <TableCell className="block md:table-cell">{m.active ? "Yes" : "No"}</TableCell>
                        <TableCell className="block md:table-cell">{canManageMachines ? <Button variant="outline" size="sm" onClick={() => setEditingMachine(m)}><Pencil className="size-3.5" /> Edit</Button> : null}</TableCell>
                      </TableRow>
                    ))}
                    {!machines.length ? (
                      <TableRow><TableCell colSpan={6} className="py-8 text-center text-slate-500">
                        No machines yet.{canManageMachines ? <> Add your own, or <button disabled={seeded || saving} onClick={() => { setTemplatePicks([]); setTemplateOpen(true); }} className="-my-3 py-3 font-semibold text-brand underline disabled:opacity-50">choose from an example list</button>.</> : null}
                      </TableCell></TableRow>
                    ) : null}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </>
        )}

        <Dialog open={Boolean(editingMachine)} onOpenChange={(open) => !open && setEditingMachine(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>{editingMachine?.id ? "Edit machine" : "Add machine"}</DialogTitle><DialogDescription>Working hours start at 08:00 on each working day.</DialogDescription></DialogHeader>
            {editingMachine ? (
              <form key={editingMachine.id || "new"} onSubmit={submitMachine} className="grid gap-3">
                <Input name="name" placeholder="Machine name" defaultValue={editingMachine.name} required />
                <Input name="type" placeholder="Type (e.g. CNC lathe)" defaultValue={editingMachine.type} />
                <label className="grid gap-1 text-sm font-medium text-slate-700">Hours per working day
                  <Input name="hours_per_day" type="number" inputMode="decimal" step="0.5" min="0.5" max="16" defaultValue={editingMachine.hoursPerDay} required />
                </label>
                <fieldset className="flex flex-wrap gap-3 text-sm">
                  <legend className="mb-1 font-medium text-slate-700">Working days</legend>
                  {WEEKDAY_OPTIONS.map((d) => (
                    <label key={d.dow} className="flex min-h-9 items-center gap-1.5"><input type="checkbox" name="wd" value={d.dow} defaultChecked={editingMachine.workingDays.includes(d.dow)} /> {d.label}</label>
                  ))}
                </fieldset>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="active" defaultChecked={editingMachine.active} /> Active (shown on the schedule)</label>
                <Button type="submit" disabled={saving} className={navy}>{saving ? "Saving..." : "Save machine"}</Button>
              </form>
            ) : null}
          </DialogContent>
        </Dialog>

        {booking ? (
          <BookJobDialog
            paused={paused}
            machines={activeMachines}
            jobs={jobs}
            scheduled={scheduled}
            now={now}
            initialJobId={booking.jobId}
            initialMachineId={booking.machineId}
            onClose={() => setBooking(null)}
            isAdmin={activeRole === "admin"}
            onSave={async (next, options) => { try { await persistBooking(next, options); setBooking(null); } catch (err) { toast.error(bookingSaveMessage(err) ?? friendlyError(err, "Could not book job")); } }}
          />
        ) : null}

        <Dialog open={Boolean(runDetail)} onOpenChange={(open) => !open && setRunDetail(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Actual machine use</DialogTitle>
              <DialogDescription>What happened on the machine (from Start, Pause and Finish). The booking, if any, stays the plan.</DialogDescription>
            </DialogHeader>
            {runDetail ? (
              <div className="grid gap-1 text-sm" data-testid="run-detail">
                <p>{runDetail.label}</p>
                <p className="text-slate-600">Started {formatDateTimeShort(new Date(runDetail.bar.run.started_at))}{runDetail.bar.run.ended_at ? `, ended ${formatDateTimeShort(new Date(runDetail.bar.run.ended_at))}` : ", still running"}.</p>
                {!runDetail.bar.run.booking_id ? <p className="text-slate-600">Not booked on the schedule.</p> : null}
              </div>
            ) : null}
          </DialogContent>
        </Dialog>

        <Dialog open={templateOpen} onOpenChange={setTemplateOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Example machine list</DialogTitle>
              <DialogDescription>A starting template, not your shop&apos;s machines. Tick only the ones you have; you can rename them later.</DialogDescription>
            </DialogHeader>
            <div className="grid gap-2">
              {DEMO_MACHINES.map((name) => (
                <label key={name} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4" checked={templatePicks.includes(name)} onChange={(event) => setTemplatePicks((picks) => event.target.checked ? [...picks, name] : picks.filter((p) => p !== name))} />
                  {name}
                </label>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setTemplateOpen(false)}>Cancel</Button>
              <Button className="bg-brand text-brand-ink" disabled={!templatePicks.length || saving} onClick={() => void seedMachines(DEMO_MACHINES.filter((name) => templatePicks.includes(name)))}>
                Add {templatePicks.length || ""} selected
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {selected ? (
          <BookingDetailDialog
            key={selected.id}
            booking={selected}
            now={now}
            liveLeft={liveLeftOf(selected)}
            canEdit={canBook}
            canDelete={canManageMachines}
            requiredDate={requiredDate(selected)}
            onClose={() => setSelectedId(null)}
            isAdmin={activeRole === "admin"}
            onSave={async (next, options) => { try { await persistBooking(next, options); setSelectedId(null); } catch (err) { toast.error(bookingSaveMessage(err) ?? friendlyError(err, "Could not update booking")); } }}
            onDelete={() => void removeBooking(selected.id)}
          />
        ) : null}
      </div>
    </RoleGate>
  );
}

/**
 * "I've checked" before booking over a paused machine (migration 049, plan R3.2): each press sends a NEW key. Matched: the booking is
 * saved. The machine re-paused meanwhile (not matched): the current pause is shown and asked again (a fresh key with the new run). The
 * check is recorded (BOOK_OVER_PAUSED_JOB); the warning stays soft: "I've checked" is always available.
 */
async function acknowledgePaused(row: PausedRow, jobId: string): Promise<{ ok: true } | { ok: false; current: PausedRow | null; message?: string }> {
  if (!supabase) return { ok: true };
  const { data, error } = await supabase.rpc("acknowledge_paused_machine", { p_machine: row.machine_id, p_paused_run: row.paused_run_id, p_job: jobId, p_client_op_id: newClientOpId() });
  if (error) return { ok: false, current: null, message: runRefusal(error)?.message ?? friendlyError(error, "The check couldn't be recorded.") };
  const answer = data as { matched?: boolean; current?: Record<string, unknown> | null } | null;
  if (answer?.matched || !answer?.current) return { ok: true };
  return { ok: false, current: pausedRows([answer.current])[0] ?? null };
}

function BookJobDialog({ machines, jobs, scheduled, now, isAdmin, initialJobId, initialMachineId, onClose, onSave, paused = [] }: {
  /** Machines paused on another unfinished job (049): booking one asks to check first. */
  paused?: PausedRow[];
  machines: Machine[];
  /** "Book it" on a job running without a booking: that job and machine, preselected. */
  initialJobId?: string;
  initialMachineId?: string;
  jobs: ScheduleJob[];
  scheduled: ScheduledBooking[];
  now: Date;
  isAdmin: boolean;
  onClose: () => void;
  onSave: (booking: Omit<Booking, "id">, options?: BookingSaveOptions) => Promise<void>;
}) {
  const [jobId, setJobId] = useState(() => (initialJobId && jobs.some((j) => j.id === initialJobId) ? initialJobId : ""));
  const [manualJobNo, setManualJobNo] = useState("");
  const [machineId, setMachineId] = useState(() => (initialMachineId && machines.some((m) => m.id === initialMachineId) ? initialMachineId : machines[0]?.id || ""));
  const [startTouched, setStartTouched] = useState(false);
  const [startOverride, setStartOverride] = useState("");
  const [hours, setHours] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  // Booking over another job: an admin's recorded decision with a reason (the database refuses everyone else).
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState("");
  const split = useDayPlanForm(null);
  const workingHours = workingHoursOf(useCompanyProfile().profile);
  // The paused-machine check: the pause shown (the server's current one after a mismatch) and the run the person confirmed.
  const [shownPause, setShownPause] = useState<PausedRow | null>(null);
  const [checkedRun, setCheckedRun] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const machine = machines.find((m) => m.id === machineId);
  const job = jobs.find((j) => j.id === jobId);
  const pausedHere = machine ? (paused.find((row) => row.machine_id === machine.id && row.job_id !== jobId) ?? null) : null;
  const pause = shownPause && shownPause.machine_id === machineId ? shownPause : pausedHere;
  const needsCheck = Boolean(pause && checkedRun !== pause.paused_run_id);
  const defaultStart = useMemo(() => (machine ? toLocalInputValue(machineStatus(machine, scheduled, now).nextFree) : ""), [machine, scheduled, now]);
  const start = startTouched ? startOverride : defaultStart;
  const hoursNum = Number(hours);
  const startDate = start ? new Date(start) : null;
  const validStart = Boolean(startDate) && !Number.isNaN(startDate!.getTime());
  // Split by day: the days and times are exactly what the person entered, so the machine's working days play no part.
  const check = split.check(hoursNum);
  const planned = split.on && check.ok ? planSegments(check.plan) : null;
  const finish = planned?.length ? planned[planned.length - 1].end
    : !split.on && machine && validStart && hoursNum >= 0 && hours !== "" ? computeFinish(startDate!, hoursNum, machine) : null;
  const overlaps = machine && finish && (planned?.length || validStart) ? findOverlaps(machine, scheduled, planned?.[0]?.start ?? startDate!, finish, undefined, planned) : [];

  function pickJob(id: string) {
    setJobId(id);
    const next = jobs.find((j) => j.id === id);
    if (next?.estimatedHours != null) setHours(String(next.estimatedHours));
  }

  function startAfterCurrent() {
    if (!machine) return;
    const latest = Math.max(...overlaps.map((b) => b.finish.getTime()));
    const after = normaliseStart(new Date(latest), machine);
    if (split.on) {
      // Move the whole split (same gaps between its dates, same times) so it begins the day after the clash ends, or that day when
      // the clash ends by the first day's start time.
      const firstRow = split.rows.filter((r) => r.date).sort((a, b) => a.date.localeCompare(b.date))[0];
      const first = firstRow?.date;
      const clashEnd = new Date(latest);
      const target = localDateString(timeOf(clashEnd) > (firstRow?.start || workStartOn(workingHours, first ? isoWeekday(first) : null)) ? new Date(clashEnd.getFullYear(), clashEnd.getMonth(), clashEnd.getDate() + 1) : clashEnd);
      const shift = first ? daysBetweenDates(first, target) : 0;
      if (shift > 0) split.setRows(split.rows.map((r) => (r.date ? { ...r, date: addDaysToDate(r.date, shift) } : r)));
      return;
    }
    setStartTouched(true);
    setStartOverride(toLocalInputValue(after));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const jobNo = job?.jobNo || manualJobNo.trim();
    if (!jobNo) { toast.error("Pick a job or enter a job number."); return; }
    if (!machine) { toast.error("Pick a machine."); return; }
    if (!(hoursNum > 0)) { toast.error("Enter the estimated hours."); return; }
    if (split.on && !check.ok) { toast.error(check.message); return; }
    if (!split.on && !validStart) { toast.error("Enter a start date and time."); return; }
    if (needsCheck) { toast.info(`Check with ${pause?.operator_name ?? "the operator"} first, then press "I've checked".`); return; }
    setSaving(true);
    await onSave({
      machineId: machine.id, jobId: job && !job.id.startsWith("demo-") ? job.id : null, jobNo, description: job?.description || "",
      startAt: split.on && check.ok ? planStartIso(check.plan) : startDate!.toISOString(), estimatedHours: split.on && check.ok ? check.estimatedHours : hoursNum, hoursDone: 0, status: "booked", notes,
      dayPlan: split.on && check.ok ? check.plan : null,
    }, overlaps.length ? { clashOverride: isAdmin && override, overrideReason: reason } : undefined);
    setSaving(false);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Book job onto machine</DialogTitle><DialogDescription>The finish time only counts the machine&apos;s working hours.</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <label className="grid gap-1 text-sm font-medium text-slate-700">Job
            <select className={selectClass} value={jobId} onChange={(e) => pickJob(e.target.value)}>
              <option value="">Other (type job number)</option>
              {jobs.map((j) => <option key={j.id} value={j.id}>{j.jobNo}{j.description ? ` - ${j.description}` : ""}</option>)}
            </select>
          </label>
          {!jobId ? <Input placeholder="Job number" value={manualJobNo} onChange={(e) => setManualJobNo(e.target.value)} /> : null}
          <label className="grid gap-1 text-sm font-medium text-slate-700">Machine
            <select className={selectClass} value={machineId} onChange={(e) => setMachineId(e.target.value)}>
              {machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            {split.on ? (
              <div className="grid content-end gap-1 text-sm text-slate-600"><span className="font-medium text-slate-700">Start</span><span className="flex min-h-10 items-center">The first day&apos;s start time below</span></div>
            ) : (
              <label className="grid gap-1 text-sm font-medium text-slate-700">Start (next free slot by default)
                <Input type="datetime-local" value={start} onChange={(e) => { setStartTouched(true); setStartOverride(e.target.value); }} />
              </label>
            )}
            <label className="grid gap-1 text-sm font-medium text-slate-700">Estimated hours{job?.estimatedHours != null ? " (setup + run from worksheet)" : ""}
              <Input type="number" inputMode="decimal" min="0" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} />
            </label>
          </div>
          {job?.estimatedHours == null && job ? <p className="text-xs text-slate-500">No setup, run or quoted time on this job&apos;s worksheet, so enter the hours.</p> : null}
          <DayPlanField on={split.on} onToggle={(on) => split.toggle(on, hoursNum, validStart ? localDateString(startDate!) : todayString(), validStart ? timeOf(startDate!) : workStartOn(workingHours, isoWeekday(todayString())))} rows={split.rows} setRows={split.setRows} estimatedHours={hoursNum} check={check} workingHours={workingHours} />
          <Textarea placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          {finish ? <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-700">Estimated finish: <span className="font-semibold">{formatDateTimeShort(finish)}</span></p> : null}
          {pause && machine ? (
            <div data-testid="book-paused-warning" data-run-id={pause.paused_run_id} className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <p className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{pausedWarningText(pause, machine.name, now)}</p>
              {needsCheck ? (
                <Button type="button" variant="outline" size="sm" className="mt-2 min-h-11" disabled={checking} onClick={async () => {
                  if (!job || job.id.startsWith("demo-")) { setCheckedRun(pause.paused_run_id); return; }
                  setChecking(true);
                  const result = await acknowledgePaused(pause, job.id);
                  setChecking(false);
                  if (result.ok) { setCheckedRun(pause.paused_run_id); return; }
                  if (result.message) { toast.error(result.message); return; }
                  if (result.current) { setShownPause(result.current); toast.info(`${machine.name} was paused again meanwhile (${result.current.job_no}). Check again.`); }
                }}>{checking ? "Recording..." : `I've checked, use the ${machine.name}`}</Button>
              ) : <p data-testid="book-paused-checked" className="mt-1 font-medium">Checked (recorded).</p>}
            </div>
          ) : null}
          {overlaps.length ? (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <p className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" /> This overlaps {overlaps.map((b) => b.jobNo).join(", ")} on {machine?.name}.</p>
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={startAfterCurrent}>Start after current booking</Button>
              {isAdmin ? (
                <div className="mt-2 space-y-2">
                  <label className="flex min-h-11 items-center gap-3">
                    <input type="checkbox" className="size-5" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                    Book anyway (admin; recorded with your reason)
                  </label>
                  {override ? <Textarea data-testid="override-reason" placeholder="Why this booking goes over the other job (required, 3 to 500 characters)" value={reason} onChange={(e) => setReason(e.target.value)} /> : null}
                </div>
              ) : <p className="mt-2">Only an admin can book over another job: pick a free time.</p>}
            </div>
          ) : null}
          <Button type="submit" disabled={saving || needsCheck || (split.on && !check.ok) || (overlaps.length > 0 && (!isAdmin || !override || reason.trim().length < 3))} className={`min-h-11 ${navy}`}>{saving ? "Saving..." : overlaps.length ? "Book anyway" : "Book job"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BookingDetailDialog({ booking, now, liveLeft, canEdit, canDelete, isAdmin, requiredDate, onClose, onSave, onDelete }: {
  booking: ScheduledBooking;
  now: Date;
  /** The running booking's live hours left ("2:35 left" / "0:20 over"); null shows the stored figure. */
  liveLeft: string | null;
  canEdit: boolean;
  canDelete: boolean;
  isAdmin: boolean;
  requiredDate: string;
  onClose: () => void;
  onSave: (booking: Booking, options?: BookingSaveOptions) => Promise<void>;
  onDelete: () => void;
}) {
  const [clashOverride, setClashOverride] = useState(false);
  const [reason, setReason] = useState("");
  const [hoursDone, setHoursDone] = useState(String(booking.hoursDone));
  const [estimated, setEstimated] = useState(String(booking.estimatedHours));
  const [status, setStatus] = useState<BookingStatus>(booking.status);
  const [notes, setNotes] = useState(booking.notes);
  const split = useDayPlanForm(booking.dayPlan);
  const workingHours = workingHoursOf(useCompanyProfile().profile);
  const check = split.check(Number(estimated));
  // A split that doesn't add up to the estimate can't be saved (the database refuses it too). Mark running and Mark complete stay
  // available: while the edit doesn't add up they change only the status (and hours done) and keep the plan as it is stored.
  const blocked = split.on && !check.ok;
  const planEnded = Boolean(booking.segments?.length) && booking.status !== "complete" && booking.hoursLeft > 0 && booking.finish.getTime() < now.getTime();

  const { machine, start, finish, hoursLeft: _left, segments: _segments, ...base } = booking;
  void _left; void start; void finish; void machine; void _segments;

  function save(override?: Partial<Booking>) {
    const est = Number(estimated);
    const done = Number(hoursDone);
    if (!(est >= 0) || !(done >= 0)) { toast.error("Hours must be zero or more."); return; }
    if (split.on && !check.ok) { toast.error(check.message); return; }
    const plan = split.on && check.ok ? { dayPlan: check.plan, startAt: planStartIso(check.plan) } : { dayPlan: null };
    void onSave({ ...base, estimatedHours: split.on && check.ok ? check.estimatedHours : est, hoursDone: done, status, notes, ...plan, ...override }, { clashOverride: isAdmin && clashOverride, overrideReason: reason });
  }

  /** Mark running / complete. With a split edit that doesn't add up, only the status changes; the stored booking and plan stay as they are. */
  function mark(next: "running" | "complete") {
    if (!blocked) {
      save(next === "running" ? { status: "running" } : { status: "complete", hoursDone: Number(estimated) || booking.estimatedHours });
      return;
    }
    toast.info("The split by day edit doesn't add up, so it wasn't saved. Only the status changed.");
    void onSave({ ...base, ...(next === "running" ? { status: "running" } : { status: "complete", hoursDone: booking.estimatedHours }) });
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{booking.jobNo} on {booking.machine.name}</DialogTitle><DialogDescription>{booking.description || "Machine booking"}</DialogDescription></DialogHeader>
        <dl className="grid grid-cols-2 gap-2 text-sm">
          <dt className="field-label">Start</dt><dd className="font-medium">{formatDateTimeShort(booking.start)}</dd>
          <dt className="field-label">Estimated finish</dt><dd className="font-medium">{formatDateTimeShort(booking.finish)}</dd>
          <dt className="field-label">Hours left</dt><dd className="font-medium" data-testid="booking-hours-left">{liveLeft ?? formatHours(booking.hoursLeft)}</dd>
          {booking.dayPlan?.length ? <><dt className="field-label">Split by day</dt><dd className="font-medium" data-testid="booking-day-plan">{formatDayPlan(booking.dayPlan)}</dd></> : null}
          {requiredDate ? <><dt className="field-label">Required</dt><dd className="font-medium">{fmtDate(requiredDate)}</dd></> : null}
        </dl>
        {planEnded ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">The planned days have passed and {formatHours(booking.hoursLeft)} are still left. A split doesn&apos;t move on by itself: add days to it, or turn Split by day off.</p> : null}
        {canEdit ? (
          <div className="grid gap-3">
            <div className="grid gap-3 md:grid-cols-2">
              <label className="grid gap-1 text-sm font-medium text-slate-700">Hours done<Input type="number" inputMode="decimal" min="0" step="0.5" value={hoursDone} onChange={(e) => setHoursDone(e.target.value)} /></label>
              <label className="grid gap-1 text-sm font-medium text-slate-700">Estimated hours<Input type="number" inputMode="decimal" min="0" step="0.5" value={estimated} onChange={(e) => setEstimated(e.target.value)} /></label>
            </div>
            <label className="grid gap-1 text-sm font-medium text-slate-700">Status
              <select className={selectClass} value={status} onChange={(e) => setStatus(e.target.value as BookingStatus)}>
                {(Object.keys(STATUS_LABEL) as BookingStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </label>
            <DayPlanField on={split.on} onToggle={(on) => split.toggle(on, Number(estimated), localDateString(booking.start), timeOf(booking.start))} rows={split.rows} setRows={split.setRows} estimatedHours={Number(estimated)} check={check} workingHours={workingHours} />
            <Textarea placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <Button className={`min-h-11 ${navy}`} disabled={blocked} onClick={() => save()}>Save</Button>
              {isAdmin && canEdit ? (
                <div className="basis-full space-y-2 text-sm">
                  <label className="flex min-h-11 items-center gap-3">
                    <input type="checkbox" className="size-5" checked={clashOverride} onChange={(e) => setClashOverride(e.target.checked)} />
                    If this change overlaps another job, book anyway (admin; recorded with your reason)
                  </label>
                  {clashOverride ? <Textarea data-testid="override-reason" placeholder="Why this booking goes over the other job (required, 3 to 500 characters)" value={reason} onChange={(e) => setReason(e.target.value)} /> : null}
                </div>
              ) : null}
              {booking.status === "booked" ? <Button variant="outline" className="min-h-11" onClick={() => mark("running")}>Mark running</Button> : null}
              {booking.status !== "complete" ? <Button variant="outline" className="min-h-11" onClick={() => mark("complete")}>Mark complete</Button> : null}
              {canDelete ? <Button variant="outline" className="text-red-700" onClick={onDelete}>Remove booking</Button> : null}
            </div>
          </div>
        ) : <p className="text-sm text-slate-500">Status: {bookingStatusLabel(booking, now)}. {booking.notes}</p>}
      </DialogContent>
    </Dialog>
  );
}
