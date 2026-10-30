"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { HoursTabs } from "@/components/time/hours-tabs";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Clock, Coffee, LogIn, LogOut, Pencil, Play, Plus, Printer, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { DayFlagsCard } from "@/components/time/day-flags";
import { NeedsDatabaseUpdate } from "@/components/time/needs-update";
import { ClockCorrectionDialog, type ClockCorrection, LabourDialog, type LabourEdit } from "@/components/time/time-dialogs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ColumnToggle } from "@/components/column-toggle";
import { StatTile } from "@/components/stat-tile";
import { loadCompanyPeople } from "@/lib/company-people";
import { friendlyError } from "@/lib/friendly-error";
import { adminStopText } from "@/lib/job-actions";
import { useColumnVisibility } from "@/lib/org-settings";
import { newClientOpId } from "@/lib/machine-runs";
import { type ClockOp, type LabourOp } from "@/lib/offline/outbox";
import { currentOfflineStatus, offlineScope, queueOffline, useOfflineStatus } from "@/lib/offline/scope";
import { scopeKey } from "@/lib/offline/store";
import { executeClockOp, executeLabourOp, syncNow } from "@/lib/offline/sync";
import { type PeopleMap, UNKNOWN } from "@/lib/people";
import { supabase } from "@/lib/supabase";
import { type JobInfo, type SendNotice, type TimeData, deviceLabel, loadStartableJobs, loadTimeData, overlayPending, syncPassRan, timeSendNotice } from "@/lib/time-data";
import { type AttendanceEvent, type LabourSession, FLAG_TEXT, addDays, dayTotals, hm, hmSigned, localDateOf, localDayBounds, localTimeOf, weekStartOf, zoneLabel } from "@/lib/time-sheet";
import { fmtDateText } from "@/lib/dates";
import { TIME_NEEDS_DATABASE_UPDATE, databaseHasTime, missingDbObject, timeOpsAllowed } from "@/lib/time-features";
import { useUser } from "@/lib/use-user";

const today = () => localDateOf(new Date());
const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "Mon, 19 Oct 2026" (the person's date format, with the weekday). */
export function dayHeading(date: string) {
  return fmtDateText(date, { weekday: "short", year: true });
}
/** "07:31", with BST/GMT on the two clock-change days (so a repeated hour is never ambiguous on screen). */
export function clockTime(at: string | number | null | undefined, date?: string) {
  if (at === null || at === undefined) return "—";
  const d = new Date(at);
  return `${localTimeOf(d)}${date && isClockChangeDay(date) ? ` ${zoneLabel(d)}` : ""}`;
}
/** A day that is 23 or 25 hours long (the clocks change that night). */
export function isClockChangeDay(date: string) {
  const b = localDayBounds(date);
  return b.end.getTime() - b.start.getTime() !== 86_400_000;
}
/** How long a clock action waits for the sync pass before saying it is still on this device (the pass carries on). */
const SEND_WAIT_MS = 8_000;
const showNotice = (n: SendNotice) => (n.tone === "error" ? toast.error(n.message) : n.tone === "info" ? toast.info(n.message) : toast.success(n.message));
const actionLabel: Record<string, string> = { in: "Clock in", out: "Clock out", break_start: "Break start", break_end: "Break end", void: "Removed" };

/**
 * The daily job sheet (migrations 050, 051): one person's day. Clock in and out (and breaks), the jobs they worked on with the time on
 * each, and the totals. Workshop staff see and fill in their own; admin and office can open anyone's in the company. Clock actions and
 * job Start/Stop go into the device's outbox first and sync when they can, so the sheet works offline. Online the outbox is sent at once
 * and the toast says "saved" once the server has it; "saved on this device" only while it is still waiting here (lib/time-data.ts).
 * The day line's tick boxes (Overtime, Saturday, Sunday, Bank holiday; 074) are for the person and for office/admin viewing their day;
 * they appear once the database has 074 and save online only (components/time/day-flags.tsx).
 */
export function DaySheet() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, profile, hasAnyRole } = useUser();
  const offline = useOfflineStatus();
  const me = user?.id ?? null;
  const seesEveryone = hasAnyRole(["admin", "office"]);
  const isAdmin = hasAnyRole(["admin"]);
  const date = VALID_DATE.test(params.get("date") ?? "") ? (params.get("date") as string) : today();
  const personId = (seesEveryone && params.get("user")) || me;
  const own = personId === me;
  const isToday = date === today();
  /** Display only (Columns picker, key "hours"): which totals show. Paid always shows; no figure is computed from this. */
  const { isVisible } = useColumnVisibility("hours");

  const [data, setData] = useState<TimeData | null>(null);
  const [people, setPeople] = useState<PeopleMap>({});
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** The database doesn't have 050 to 052 yet (the app can be deployed first): say so, record nothing. */
  const [needsUpdate, setNeedsUpdate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [startJob, setStartJob] = useState("");
  const [clockDialog, setClockDialog] = useState<{ existing: AttendanceEvent | null } | null>(null);
  const [labourDialog, setLabourDialog] = useState<{ existing: LabourSession | null } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const go = useCallback((next: { date?: string; user?: string | null }) => {
    const q = new URLSearchParams();
    q.set("date", next.date ?? date);
    const u = next.user === undefined ? personId : next.user;
    if (u && u !== me) q.set("user", u);
    router.replace(`/time?${q.toString()}`);
  }, [date, personId, me, router]);

  const load = useCallback(async () => {
    if (!supabase || !personId) return;
    setError(null);
    if ((await databaseHasTime()) === false) {
      setNeedsUpdate(true);
      return;
    }
    try {
      const bounds = localDayBounds(date);
      const [loaded, who, startable] = await Promise.all([
        loadTimeData(supabase, { userId: personId, from: bounds.start, to: bounds.end }),
        loadCompanyPeople(supabase),
        loadStartableJobs(supabase, personId),
      ]);
      setData(loaded);
      if (who) setPeople(who);
      setJobs(startable);
    } catch (err) {
      if (missingDbObject(err as { code?: string; message?: string })) setNeedsUpdate(true);
      else setError(friendlyError(err, "Couldn't load your hours."));
    }
  }, [date, personId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  // Reload after a sync pass sent something of ours.
  const pendingCount = offline.pending;
  useEffect(() => { if (pendingCount === 0) void load(); }, [pendingCount, load]);

  const merged = useMemo(() => {
    if (!data) return null;
    const mine = own && me ? offline.pendingItems.filter((e) => e.op.kind === "clock" || e.op.kind === "labour") : [];
    return { ...data, ...overlayPending(data, mine, personId ?? "") };
  }, [data, offline.pendingItems, own, me, personId]);

  const day = useMemo(() => (merged ? dayTotals({ date, events: merged.events, labour: merged.labour, settings: merged.settings, bankHolidays: merged.bankHolidays, now }) : null), [merged, date, now]);
  const jobById = useMemo(() => {
    const map: Record<string, JobInfo> = { ...(merged?.jobs ?? {}) };
    for (const j of jobs) map[j.id] = j;
    return map;
  }, [merged, jobs]);

  const lastSession = day?.sessions.filter((s) => s.start !== null).at(-1) ?? null;
  const clockedIn = Boolean(lastSession && lastSession.end === null && lastSession.flags.includes("open"));
  const onBreak = clockedIn && Boolean(lastSession?.events.at(-1)?.action === "break_start");
  const openJobs = day?.jobs.filter((j) => j.open) ?? [];

  async function send(op: ClockOp | LabourOp, label: string) {
    setBusy(true);
    try {
      // Never queue time for a server that can't take it (before 050 to 052 are applied).
      const allowed = await timeOpsAllowed();
      if (!allowed.ok) {
        toast.error(allowed.reason);
        if (allowed.reason === TIME_NEEDS_DATABASE_UPDATE) setNeedsUpdate(true);
        return;
      }
      const scopeBefore = offlineScope();
      if (await queueOffline(op)) {
        const wasOffline = offline.offline;
        if (wasOffline) showNotice(timeSendNotice(label, op.clientOpId, { offline: true, settled: false, pending: [], held: [] }));
        const sync = syncNow().then(syncPassRan, () => false);
        void sync.then(() => load());
        if (!wasOffline) {
          // Say "saved" once the server has it; "saved on this device" only while it is still waiting here.
          const settled = await Promise.race([sync, new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), SEND_WAIT_MS))]);
          const scopeAfter = offlineScope();
          const same = Boolean(scopeBefore && scopeAfter && scopeKey(scopeBefore) === scopeKey(scopeAfter));
          const s = currentOfflineStatus();
          // Held and blocked entries are only read from this same person and company's queue.
          showNotice(timeSendNotice(label, op.clientOpId, { offline: false, settled: settled && same, pending: same ? s.pendingItems : [], held: same ? [...s.rejected, ...s.conflicts] : [] }));
        }
      } else if (supabase) {
        // This device can't hold it (no offline store): send it now.
        const outcome = op.kind === "clock" ? await executeClockOp(op, supabase, profile?.organization_id ?? undefined) : await executeLabourOp(op, supabase);
        if (outcome.status === "applied") toast.success(`${label}: saved.`);
        else toast.error(outcome.status === "rejected" || outcome.status === "blocked" ? outcome.reason : "Couldn't reach the server. Try again.");
        await load();
      }
    } finally {
      setBusy(false);
    }
  }
  const clock = (action: ClockOp["action"]) =>
    send({ kind: "clock", v: 1, action, at: new Date().toISOString(), clientOpId: newClientOpId(), device: deviceLabel(), jobNo: "Daily job sheet" }, actionLabel[action]);
  const labour = (job: JobInfo, action: "start" | "stop") =>
    send({ kind: "labour", v: 1, action, jobRef: job.id, jobNo: job.job_no, at: new Date().toISOString(), clientOpId: newClientOpId() }, `${job.job_no} ${action === "start" ? "started" : "stopped"}`);

  async function rpc(fn: string, args: Record<string, unknown>) {
    if (!supabase) throw new Error("Not connected.");
    const { error: e } = await supabase.rpc(fn, args);
    if (e) throw e;
  }
  async function saveClockCorrection(c: ClockCorrection) {
    try {
      await rpc("correct_attendance_event", { p_client_op_id: newClientOpId(), p_user: personId, p_supersedes: c.supersedes, p_action: c.action, p_at: c.at?.toISOString() ?? null, p_reason: c.reason });
      toast.success("Clock record corrected.");
      await load();
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't save the correction. Corrections need a connection."));
      throw err;
    }
  }
  async function saveLabour(e: LabourEdit, existing: LabourSession | null) {
    try {
      if (existing) await rpc("correct_labour_session", { p_session: existing.id, p_started_at: e.from.toISOString(), p_ended_at: e.to?.toISOString() ?? null, p_reason: e.reason });
      else await rpc("add_labour_session", { p_client_op_id: newClientOpId(), p_user: personId, p_job: e.jobId, p_started_at: e.from.toISOString(), p_ended_at: e.to?.toISOString() ?? null, p_reason: e.reason });
      toast.success(existing ? "Job time corrected." : "Job time added.");
      await load();
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't save the job time. Changes by hand need a connection."));
      throw err;
    }
  }
  async function removeLabour(s: LabourSession) {
    const reason = window.prompt("Why remove this job time? (3 to 500 characters)");
    if (!reason || reason.trim().length < 3) return;
    try {
      await rpc("void_labour_session", { p_session: s.id, p_reason: reason.trim() });
      toast.success("Job time removed (kept on record).");
      await load();
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't remove the job time."));
    }
  }

  const name = personId ? people[personId] ?? (own ? profile?.full_name ?? "You" : UNKNOWN) : UNKNOWN;
  const canEdit = own || isAdmin;
  const printHref = `/time/print?date=${date}${personId && !own ? `&user=${personId}` : ""}`;
  const weekHref = `/time/week?week=${weekStartOf(date)}${personId && !own ? `&user=${personId}` : ""}`;

  return (
    needsUpdate ? <NeedsDatabaseUpdate /> :
    <div className="space-y-4" data-testid="day-sheet">
      <h1 className="page-title">Weekly hours</h1>
      <p className="text-sm text-slate-500">Clock in and out, and see the hours worked each day and week.</p>
      <HoursTabs active="today" weekHref={weekHref} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => go({ date: addDays(date, -1) })} aria-label="Previous day"><ChevronLeft className="size-4" /></Button>
        <input type="date" className="rounded-md border px-2 py-1 text-sm" value={date} onChange={(e) => VALID_DATE.test(e.target.value) && go({ date: e.target.value })} aria-label="Day" />
        <Button variant="outline" size="sm" onClick={() => go({ date: addDays(date, 1) })} aria-label="Next day"><ChevronRight className="size-4" /></Button>
        {!isToday ? <Button variant="ghost" size="sm" onClick={() => go({ date: today() })}>Today</Button> : null}
        {seesEveryone ? (
          <select className="rounded-md border px-2 py-1 text-sm" value={personId ?? ""} onChange={(e) => go({ user: e.target.value })} aria-label="Person">
            {Object.entries(people).sort((a, b) => (a[1] ?? "").localeCompare(b[1] ?? "")).map(([id, n]) => <option key={id} value={id}>{n ?? UNKNOWN}{id === me ? " (you)" : ""}</option>)}
          </select>
        ) : null}
        <div className="ml-auto flex gap-2">
          <ColumnToggle tableKey="hours" />
          <Button asChild variant="outline" size="sm"><Link href={printHref}><Printer className="size-4" /> Print</Link></Button>
        </div>
      </div>

      <h2 className="text-lg font-semibold">{name} · {dayHeading(date)}{day?.bankHolidayName ? ` · ${day.bankHolidayName}` : ""}</h2>
      {error ? <div className="flex items-center justify-between rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"><span>{error}</span><Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button></div> : null}

      {own && isToday ? (
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 pt-6">
            <Clock className="size-5 text-brand-accent" />
            <span className="font-medium" data-testid="clock-state">
              {clockedIn ? `Clocked in since ${clockTime(lastSession?.start ?? null, date)}${onBreak ? " · on a break" : ""}` : "Not clocked in"}
            </span>
            <div className="ml-auto flex flex-wrap gap-2">
              {clockedIn ? (
                <>
                  {onBreak
                    ? <Button variant="outline" disabled={busy} onClick={() => void clock("break_end")}><Coffee className="size-4" /> End break</Button>
                    : <Button variant="outline" disabled={busy} onClick={() => void clock("break_start")}><Coffee className="size-4" /> Start break</Button>}
                  <Button disabled={busy} onClick={() => void clock("out")} data-testid="clock-out"><LogOut className="size-4" /> Clock out</Button>
                </>
              ) : <Button disabled={busy} onClick={() => void clock("in")} data-testid="clock-in"><LogIn className="size-4" /> Clock in</Button>}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {day ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5" data-testid="day-totals">
            {isVisible("clocked") ? <StatTile label="Clocked" value={hm(day.attendance)} sub="clock in to out" /> : null}
            {isVisible("breaks") ? <StatTile label="Breaks" value={hmSigned(-day.breakDeduction)} sub={breakSub(day.breakRule, day.clockedBreaks)} /> : null}
            <StatTile label="Paid" value={hm(day.paid)} tone="info" />
            {isVisible("jobs") ? <StatTile label="On jobs" value={hm(day.labour)} sub={day.labourOutsideAttendance > 0.5 ? `${hm(day.labourOutsideAttendance)} outside clock times` : undefined} /> : null}
            {isVisible("unallocated") ? <StatTile label="Not on a job" value={hm(day.unallocated)} sub="paid time with no job time" tone={day.unallocated > 60 ? "warn" : "neutral"} /> : null}
          </div>
          {day.flags.length ? (
            <ul className="space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-testid="day-flags">
              {day.flags.map((f) => <li key={f}>{FLAG_TEXT[f] ?? f}</li>)}
            </ul>
          ) : null}
          {merged && personId && (own || seesEveryone) ? (
            <DayFlagsCard date={date} personId={personId} day={day} bankHolidays={merged.bankHolidays} offline={offline.offline} />
          ) : null}

          <Card>
            <CardHeader className="flex flex-row items-center justify-between"><CardTitle className="text-base">Clock in and out</CardTitle>
              {canEdit ? <Button size="sm" variant="outline" onClick={() => setClockDialog({ existing: null })}><Plus className="size-4" /> Add missing</Button> : null}
            </CardHeader>
            <CardContent>
              {merged && merged.events.filter((e) => localDateOf(e.at) === date).length ? (
                <ul className="divide-y text-sm" data-testid="clock-records">
                  {merged.events.filter((e) => localDateOf(e.at) === date).sort((a, b) => a.at.localeCompare(b.at)).map((e) => {
                    const replaced = merged.events.some((x) => x.supersedes === e.id);
                    return (
                      <li key={e.id} className={`flex flex-wrap items-center gap-2 py-2 ${replaced || e.action === "void" ? "text-slate-400 line-through" : ""}`}>
                        <span className="w-16 font-mono">{clockTime(e.at, date)}</span>
                        <span className="w-28">{actionLabel[e.action]}</span>
                        {e.source === "correction" ? <span className="text-xs text-slate-500">corrected{e.reason ? `: ${e.reason}` : ""}</span> : null}
                        {e.pending ? <span className="text-xs text-amber-700">saved on this device</span> : null}
                        {e.device_at && !e.pending && new Date(e.device_at).getTime() !== new Date(e.at).getTime() ? <span className="text-xs text-amber-700">device said {clockTime(e.device_at, date)}</span> : null}
                        {canEdit && !e.pending && !replaced && e.action !== "void" ? (
                          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setClockDialog({ existing: e })}><Pencil className="size-4" /> Correct</Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : <p className="text-sm text-slate-500">No clock records on this day.</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2"><CardTitle className="text-base">Jobs worked</CardTitle>
              {canEdit ? <Button size="sm" variant="outline" onClick={() => setLabourDialog({ existing: null })}><Plus className="size-4" /> Add time</Button> : null}
            </CardHeader>
            <CardContent className="space-y-3">
              {own && isToday ? (
                <div className="flex flex-wrap items-center gap-2">
                  <select className="min-w-60 rounded-md border px-2 py-2 text-sm" value={startJob} onChange={(e) => setStartJob(e.target.value)} aria-label="Job to start">
                    <option value="">Start time on a job…</option>
                    {jobs.filter((j) => !openJobs.some((o) => o.jobId === j.id)).map((j) => <option key={j.id} value={j.id}>{j.job_no}{j.customer ? ` · ${j.customer}` : ""}</option>)}
                  </select>
                  <Button disabled={!startJob || busy} onClick={() => { const j = jobById[startJob]; if (j) { void labour(j, "start"); setStartJob(""); } }} data-testid="labour-start"><Play className="size-4" /> Start</Button>
                </div>
              ) : null}
              {day.jobs.length ? (
                <table className="w-full text-sm" data-testid="job-lines">
                  <thead><tr className="border-b text-left text-xs uppercase text-slate-500"><th className="py-1">Job</th><th>Times</th><th className="text-right">Time</th><th className="text-right">Share</th><th /></tr></thead>
                  <tbody>
                    {day.jobs.map((line) => {
                      const job = jobById[line.jobId];
                      return (
                        <tr key={line.jobId} className="border-b align-top">
                          <td className="py-2"><span className="font-medium">{job?.job_no ?? "Job"}</span><div className="text-xs text-slate-500">{[job?.customer, job?.description].filter(Boolean).join(" · ")}</div></td>
                          <td className="py-2">
                            {line.sessions.map((s) => (
                              <div key={s.id} className="flex flex-wrap items-center gap-1">
                                <span className="font-mono">{clockTime(s.started_at, date)}–{s.ended_at ? clockTime(s.ended_at, date) : "now"}</span>
                                {s.pending ? <span className="text-xs text-amber-700">saved on this device</span> : null}
                                {s.original_started_at ? <span className="text-xs text-slate-500">corrected</span> : null}
                                {s.end_source === "admin_released" ? <span className="text-xs text-slate-500" data-testid="labour-admin-stop">{adminStopText(s.ended_by ? people[s.ended_by] : null, s.end_reason)}</span> : null}
                                {canEdit && !s.pending ? (
                                  <>
                                    <Button size="icon" variant="ghost" aria-label="Correct job time" onClick={() => setLabourDialog({ existing: s })}><Pencil className="size-3.5" /></Button>
                                    <Button size="icon" variant="ghost" aria-label="Remove job time" onClick={() => void removeLabour(s)}><Trash2 className="size-3.5" /></Button>
                                  </>
                                ) : null}
                              </div>
                            ))}
                          </td>
                          <td className="py-2 text-right font-mono">{hm(line.minutes)}</td>
                          <td className="py-2 text-right font-mono">{hm(line.allocatedMinutes)}</td>
                          <td className="py-2 text-right">{own && isToday && line.open && job ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void labour(job, "stop")} data-testid="labour-stop"><Square className="size-4" /> Stop</Button> : null}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ) : <p className="text-sm text-slate-500">No job time on this day. Start and Pause on the Job Board record it too.</p>}
              <p className="text-xs text-slate-500">Time: the clock time on each job. Share: when you were on more than one job at once, that time is split equally, so the shares add up to your time on jobs.</p>
            </CardContent>
          </Card>
          <p className="text-xs text-slate-500">
            Paid time is clock in to clock out minus breaks ({merged?.settings.breaksPaid ? "breaks are paid" : `unpaid: on a day of ${merged?.settings.breakMinDayHours ?? 6} hours or more, ${merged?.settings.lunchMinutes ?? 30} + ${merged?.settings.breakMinutes ?? 15} minutes, or the breaks you clocked if longer; on a shorter day, the breaks you clocked`}).
            Overtime is not worked out from the hours: it is the Overtime tick below. Bank holidays are holiday allowance; a day worked is an ordinary day unless ticked.
          </p>
        </>
      ) : !error ? <p className="text-sm text-slate-500">Loading…</p> : null}

      {clockDialog ? (
        <ClockCorrectionDialog open onOpenChange={(o) => !o && setClockDialog(null)} date={date}
          existing={clockDialog.existing && clockDialog.existing.action !== "void" ? { id: clockDialog.existing.id, action: clockDialog.existing.action, at: clockDialog.existing.at } : null}
          onSave={saveClockCorrection} />
      ) : null}
      {labourDialog ? (
        <LabourDialog open onOpenChange={(o) => !o && setLabourDialog(null)} date={date} jobs={labourDialog.existing ? Object.values(jobById) : jobs}
          existing={labourDialog.existing ? { jobId: labourDialog.existing.job_id, started_at: labourDialog.existing.started_at, ended_at: labourDialog.existing.ended_at } : null}
          onSave={(e) => saveLabour(e, labourDialog.existing)} />
      ) : null}
    </div>
  );
}

function breakSub(rule: string, clocked: number) {
  if (rule === "clocked") return `clocked (${hm(clocked)})`;
  if (rule === "allowance") return "lunch + break, unpaid";
  if (rule === "paid") return "breaks paid";
  return "none deducted";
}
