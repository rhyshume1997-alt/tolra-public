"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, ChevronLeft, ChevronRight, Printer } from "lucide-react";
import { toast } from "sonner";

import { dayHeading } from "@/components/time/day-sheet";
import { HoursTabs } from "@/components/time/hours-tabs";
import { ColumnToggle } from "@/components/column-toggle";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { pendingForPersonWeek, type JobInfo } from "@/lib/time-data";
import { exportSpreadsheet } from "@/lib/export-records";
import { WEEK_COLUMNS, weekExportRows } from "@/lib/time-week-export";
import { useOfflineStatus } from "@/lib/offline/scope";
import { loadCompanyPeople } from "@/lib/company-people";
import { friendlyError } from "@/lib/friendly-error";
import { type PeopleMap, UNKNOWN } from "@/lib/people";
import { NeedsDatabaseUpdate } from "@/components/time/needs-update";
import { SyncRejectionsNotice } from "@/components/time/sync-rejections-notice";
import { useColumnVisibility } from "@/lib/org-settings";
import { supabase } from "@/lib/supabase";
import { newClientOpId } from "@/lib/machine-runs";
import { DAY_FLAG_KEYS, DAY_FLAG_LABEL, type WeekDayFlags, flagTotalsSnapshot, flagsShort, saveDayFlags, shortDay } from "@/lib/time-day-flags";
import { databaseHasTime, missingDbObject } from "@/lib/time-features";
import { type TimeSettings, FLAG_TEXT, ROUNDING_NOTE, addDays, approvalSnapshot, hm, hmSigned, localDateOf, weekStartOf } from "@/lib/time-sheet";
import { type PersonWeek, WEEK_STATE_TEXT, loadWeek } from "@/lib/time-week";
import { useUser } from "@/lib/use-user";

const VALID = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Weekly hours (migration 052): per person, the week's paid hours worked out from their daily job sheets (clock in to out minus unpaid
 * breaks; no computed overtime, the JNR controller Sun 18 Oct 2026), with the approval. The JNR controller (admin, or the company's approver roles) approves each person's week; a correction after approval shows "Changed since
 * approval" until it is approved again. Workshop staff see their own week only. Printable per person (paid hours and the ticked days).
 * Day ticks (074): each day's Overtime / Saturday / Sunday / Bank holiday ticks and, per type, the days and the paid hours on them
 * (no rates, no multipliers; Overtime is whatever a person ticked); hidden until the database has 074. Only SAVED ticks are counted (and stored with an approval), the same
 * ticks the week's revision covers; a worked day's unsaved suggestions are shown starred, and office/admin can save them in one press.
 * Refused late time actions (075): office/admin see, per person, the clock and job time a phone synced too late (week approved / over
 * 14 days), to add as a correction; hidden until the database has 075.
 */
export function WeekReview() {
  const params = useSearchParams();
  const router = useRouter();
  const { user, hasAnyRole } = useUser();
  const me = user?.id ?? null;
  const seesEveryone = hasAnyRole(["admin", "office"]);
  const week = weekStartOf(VALID.test(params.get("week") ?? "") ? (params.get("week") as string) : localDateOf(new Date()));
  const only = seesEveryone ? params.get("user") : null;
  /** Display only (Columns picker, key "hours"): which columns show. Person, Paid and the actions cell are always shown; no figure is computed from this. */
  const { isVisible } = useColumnVisibility("hours");
  const [people, setPeople] = useState<PersonWeek[] | null>(null);
  const [settings, setSettings] = useState<TimeSettings | null>(null);
  const [jobs, setJobs] = useState<Record<string, JobInfo>>({});
  const [names, setNames] = useState<PeopleMap>({});
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<PersonWeek | null>(null);
  const [needsUpdate, setNeedsUpdate] = useState(false);

  const go = (nextWeek: string) => router.replace(`/time/week?week=${nextWeek}${only ? `&user=${only}` : ""}`);

  const load = useCallback(async () => {
    if (!supabase) return;
    setError(null);
    if ((await databaseHasTime()) === false) {
      setNeedsUpdate(true);
      return;
    }
    try {
      const [loaded, who] = await Promise.all([loadWeek(supabase, week, seesEveryone ? only : me), loadCompanyPeople(supabase)]);
      setPeople(loaded.people);
      setSettings(loaded.data.settings);
      setJobs(loaded.data.jobs);
      if (who) setNames(who);
    } catch (err) {
      if (missingDbObject(err as { code?: string; message?: string })) setNeedsUpdate(true);
      else setError(friendlyError(err, "Couldn't load the week."));
    }
  }, [week, only, seesEveryone, me]);
  useEffect(() => { void load(); }, [load]);

  const canApprove = Boolean(settings && hasAnyRole(settings.approverRoles as ("admin" | "office")[]));
  const sorted = useMemo(() => (people ?? []).slice().sort((a, b) => (names[a.userId] ?? "").localeCompare(names[b.userId] ?? "")), [people, names]);
  const isFuture = week > localDateOf(new Date());
  const showFlags = Boolean(people?.some((p) => p.dayFlags));
  /** Person + Paid + the actions cell are always there; the rest follow the picker. */
  const shownColumns = 3 + ["days", "clocked", "breaks", "jobs", "check", "approval"].filter(isVisible).length + (showFlags && isVisible("ticks") ? 1 : 0);
  const anySuggested = Boolean(people?.some((p) => p.dayFlags?.anySuggested));

  /** The week as shown (what is on screen, no new queries), CSV or Excel: one row per person per day. */
  const exportWeek = (format: "csv" | "xlsx") => void exportSpreadsheet(format, `Weekly Hours ${week}`, WEEK_COLUMNS, weekExportRows(sorted, names, jobs, UNKNOWN));

  /** Saves a person's starred (suggested, unsaved) days as shown, one keyed save per day; then reloads. */
  async function saveSuggested(p: PersonWeek) {
    if (!supabase || !p.dayFlags) return;
    const days = p.dayFlags.days.filter((d) => d.source === "suggested");
    try {
      for (const d of days) await saveDayFlags(supabase, { clientOpId: newClientOpId(), userId: p.userId, day: d.date, flags: d.flags });
      toast.success(`Suggested ticks saved for ${names[p.userId] ?? "them"}.`);
    } catch (err) {
      toast.error(friendlyError(err, "Couldn't save the suggested ticks."));
    }
    await load();
  }

  async function approve(p: PersonWeek, note: string) {
    if (!supabase || !p.status || !settings) return;
    const { error: e } = await supabase.rpc("approve_time_week", { p_user: p.userId, p_week: week, p_revision: p.status.revision, p_totals: approvalSnapshot(p.week, p.dayFlags ? flagTotalsSnapshot(p.dayFlags.totals) : null), p_note: note || null });
    if (e) {
      toast.error(friendlyError(e, "Couldn't approve the week."));
      if (e.hint === "stale_revision") await load();
      return;
    }
    toast.success(`${names[p.userId] ?? "Their"} week approved.`);
    setApproving(null);
    await load();
  }

  if (needsUpdate) return <NeedsDatabaseUpdate />;
  return (
    <div className="space-y-4" data-testid="week-review">
      <h1 className="page-title">Weekly hours</h1>
      <p className="text-sm text-slate-500">Clock in and out, and see the hours worked each day and week.</p>
      <HoursTabs active="week" weekHref={`/time/week?week=${week}${only ? `&user=${only}` : ""}`} />
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => go(addDays(week, -7))} aria-label="Previous week"><ChevronLeft className="size-4" /></Button>
        <span className="text-sm font-medium">Week of {dayHeading(week)}</span>
        <Button variant="outline" size="sm" onClick={() => go(addDays(week, 7))} aria-label="Next week"><ChevronRight className="size-4" /></Button>
        <div className="ml-auto flex flex-wrap gap-2">
          <ColumnToggle tableKey="hours" />
          <Button variant="outline" size="sm" disabled={!sorted.length} onClick={() => exportWeek("csv")}>Export CSV</Button>
          <Button variant="outline" size="sm" disabled={!sorted.length} onClick={() => exportWeek("xlsx")}>Export Excel</Button>
          <Button asChild variant="outline" size="sm"><Link href={`/time/week/print?week=${week}${only ? `&user=${only}` : !seesEveryone && me ? `&user=${me}` : ""}`}><Printer className="size-4" /> Print</Link></Button>
        </div>
      </div>
      <SyncRejectionsNotice enabled={seesEveryone} nameOf={(id) => names[id] ?? UNKNOWN} />
      {error ? <div className="flex items-center justify-between rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800"><span>{error}</span><Button variant="outline" size="sm" onClick={() => void load()}>Retry</Button></div> : null}
      {people === null && !error ? <p className="text-sm text-slate-500">Loading…</p> : null}
      {people ? (
        <div className="overflow-x-auto rounded-lg border bg-white">
          {/* Below 1024px each person is a stacked card (data-tablet-cards in app/globals.css, labels from data-label) so the week
              never scrolls sideways on a phone or tablet. The header row stays in the markup, hidden on a phone. */}
          <table role="table" className="w-full text-sm" data-testid="week-table" data-tablet-cards>
            <thead role="rowgroup" className="hidden md:table-header-group">
              <tr role="row" className="border-b bg-slate-50 text-left text-xs uppercase text-slate-500">
                <th role="columnheader" className="px-3 py-2">Person</th>
                {isVisible("days") ? <th role="columnheader" className="px-2 text-right">Days</th> : null}
                {isVisible("clocked") ? <th role="columnheader" className="px-2 text-right">Clocked</th> : null}
                {isVisible("breaks") ? <th role="columnheader" className="px-2 text-right">Breaks</th> : null}
                <th role="columnheader" className="px-2 text-right">Paid</th>
                {isVisible("jobs") ? <th role="columnheader" className="px-2 text-right">On jobs</th> : null}
                {showFlags && isVisible("ticks") ? <th role="columnheader" className="px-2">Day ticks</th> : null}
                {isVisible("check") ? <th role="columnheader" className="px-2">Check</th> : null}
                {isVisible("approval") ? <th role="columnheader" className="px-2">Approval</th> : null}
                <th role="columnheader" />
              </tr>
            </thead>
            <tbody role="rowgroup" role="rowgroup">
              {sorted.length ? sorted.map((p) => {
                const state = p.status?.state ?? "not_approved";
                return (
                  <tr role="row" key={p.userId} className="block border-b align-top md:table-row" data-testid={`week-row-${p.userId}`}>
                    <td role="cell" className="block px-3 py-2 md:table-cell"><Link className="font-medium hover:underline" href={`/time?date=${week}${p.userId !== me ? `&user=${p.userId}` : ""}`}>{names[p.userId] ?? UNKNOWN}</Link></td>
                    {isVisible("days") ? <td role="cell" data-label="Days" className="block px-3 py-2 text-left md:table-cell md:px-2 desk:text-right">{p.week.daysWorked}</td> : null}
                    {isVisible("clocked") ? <td role="cell" data-label="Clocked" className="block px-3 py-2 text-left font-mono md:table-cell md:px-2 desk:text-right">{hm(p.week.attendance)}</td> : null}
                    {isVisible("breaks") ? <td role="cell" data-label="Breaks" className="block px-3 py-2 text-left font-mono md:table-cell md:px-2 desk:text-right">{hmSigned(-p.week.breakDeduction)}</td> : null}
                    <td role="cell" data-label="Paid" className="block px-3 py-2 text-left font-mono md:table-cell md:px-2 desk:text-right" data-testid="week-paid">{hm(p.week.paid)}</td>
                    {isVisible("jobs") ? <td role="cell" data-label="On jobs" className="block px-3 py-2 text-left font-mono md:table-cell md:px-2 desk:text-right">{hm(p.week.labour)}</td> : null}
                    {showFlags && isVisible("ticks") ? <td role="cell" data-label="Day ticks" className="block px-3 py-2 text-xs empty:max-md:hidden md:table-cell md:px-2" data-testid="week-day-flags">{p.dayFlags ? <DayFlagsCell flags={p.dayFlags} /> : null}
                    </td> : null}
                    {isVisible("check") ? <td role="cell" data-label="Check" className="block px-3 py-2 text-xs text-amber-800 empty:max-md:hidden md:table-cell md:px-2">{p.week.flags.map((f) => FLAG_TEXT[f] ?? f).join("; ")}</td> : null}
                    {isVisible("approval") ? <td role="cell" data-label="Approval" className="block px-3 py-2 text-xs md:table-cell md:px-2" data-testid="week-state">
                      <span className={state === "approved" ? "text-emerald-700" : state === "changed_since_approval" ? "text-amber-700" : "text-slate-500"}>{WEEK_STATE_TEXT[state]}</span>
                      {p.status?.approved_at ? <div className="text-slate-500">{names[p.status.approved_by ?? ""] ?? UNKNOWN}, {new Date(p.status.approved_at).toLocaleString("en-GB", { timeZone: "Europe/London", dateStyle: "short", timeStyle: "short" })}</div> : null}
                    </td> : null}
                    <td role="cell" data-actions className="block px-3 py-2 text-left empty:max-md:hidden md:table-cell md:px-2 desk:text-right">
                      {showFlags && p.dayFlags?.anySuggested && seesEveryone ? <Button size="sm" variant="outline" className="mr-1" onClick={() => void saveSuggested(p)} data-testid="save-suggested-ticks">Save suggested ticks</Button> : null}
                      {canApprove && p.status && state !== "approved" && !isFuture ? <Button size="sm" onClick={() => setApproving(p)} data-testid="approve-week"><CheckCircle2 className="size-4" /> Approve</Button> : null}
                    </td>
                  </tr>
                );
              }) : <tr role="row" role="row"><td role="cell" colSpan={shownColumns} className="px-3 py-4 text-slate-500">Nobody has recorded time this week.</td></tr>}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="text-xs text-slate-500" data-testid="rounding-note">{ROUNDING_NOTE}</p>
      <p className="text-xs text-slate-500">
        Hours only: no rates or pay. Paid = clock in to clock out minus unpaid breaks. Overtime is not worked out: it is the days someone ticked Overtime.
        {canApprove ? " After a correction an approved week shows “Changed since approval” until you approve it again." : ""}
        {showFlags ? " Day ticks: the days with a saved tick and the paid hours on those days, per type (flags only, no rates)." : ""}
        {anySuggested ? " * suggested from the date, not saved yet, so not counted (save them on the sheet, or with Save suggested ticks)." : ""}
      </p>
      {approving && settings ? <ApproveDialog person={approving} name={names[approving.userId] ?? UNKNOWN} week={week} onCancel={() => setApproving(null)} onApprove={(note) => approve(approving, note)} /> : null}
    </div>
  );
}

function ApproveDialog({ person, name, week, onCancel, onApprove }: { person: PersonWeek; name: string; week: string; onCancel: () => void; onApprove: (note: string) => Promise<void> }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmedPending, setConfirmedPending] = useState(false);
  const { user } = useUser();
  const offline = useOfflineStatus();
  const waiting = pendingForPersonWeek(offline.pendingItems, user?.id ?? null, person.userId, week).length;
  const w = person.week;
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Approve {name}&apos;s week</DialogTitle>
          <DialogDescription>Week of {dayHeading(week)}. You are approving these figures as they are now; if anything changes before you press Approve, you will be asked to look again.</DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          <dt>Days worked</dt><dd className="font-mono">{w.daysWorked}</dd>
          <dt>Paid</dt><dd className="font-mono">{hm(w.paid)}</dd>
          <dt>Breaks deducted</dt><dd className="font-mono">{hm(w.breakDeduction)}</dd>
        </dl>
        {person.dayFlags?.days.some((d) => DAY_FLAG_KEYS.some((k) => d.flags[k])) ? (
          <div className="text-sm" data-testid="approve-day-flags"><div className="font-medium">Day ticks</div><DayFlagsCell flags={person.dayFlags} /></div>
        ) : null}
        {w.flags.length ? <p className="rounded-none border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900">Check first: {w.flags.map((f) => FLAG_TEXT[f] ?? f).join("; ")}.</p> : null}
        <p className="rounded-none border border-slate-300 bg-slate-50 p-2 text-sm text-slate-700" data-testid="approve-sync-warning">
          Anything still waiting to sync on a phone or tablet is not in these figures. Before approving, check each device used this week shows no &lsquo;waiting to sync&rsquo; (open Weekly hours on it with signal).
        </p>
        {waiting > 0 ? (
          <div className="space-y-2 rounded-none border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900" data-testid="approve-pending-here">
            <p>This device has {waiting} clock or job time item{waiting === 1 ? "" : "s"} for {name} this week still waiting to sync, so not in these figures. Sync them first (open Weekly hours with signal), or confirm below.</p>
            <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={confirmedPending} onChange={(e) => setConfirmedPending(e.target.checked)} /> <span>Approve without them</span></label>
          </div>
        ) : null}
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note (optional)" />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button disabled={busy || (waiting > 0 && !confirmedPending)} onClick={() => { setBusy(true); void onApprove(note).finally(() => setBusy(false)); }}><CheckCircle2 className="size-4" /> Approve</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** A person's day ticks for the week: the days ticked (unsaved suggestions starred) and, per type, the saved days and the paid hours on them. */
function DayFlagsCell({ flags }: { flags: WeekDayFlags }) {
  const ticked = flags.days.filter((d) => DAY_FLAG_KEYS.some((k) => d.flags[k]));
  if (!ticked.length) return <span className="text-slate-400">None</span>;
  const counted = DAY_FLAG_KEYS.filter((k) => flags.totals[k].days);
  return (
    <div className="space-y-1">
      <div>{ticked.map((d) => <span key={d.date} className="mr-2 whitespace-nowrap">{shortDay(d.date)}: {flagsShort(d.flags)}{d.source === "suggested" ? "*" : ""}</span>)}</div>
      <div className="text-slate-600">
        {!counted.length ? <span>Nothing saved yet</span> : null}
        {counted.map((k) => (
          <span key={k} className="mr-2 whitespace-nowrap" data-testid={`flag-total-${k}`}>{DAY_FLAG_LABEL[k]}: {flags.totals[k].days} day{flags.totals[k].days === 1 ? "" : "s"}, {hm(flags.totals[k].paidMinutes)} h</span>
        ))}
      </div>
    </div>
  );
}
