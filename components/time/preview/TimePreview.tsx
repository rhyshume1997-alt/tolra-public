"use client";

/**
 * BOUNDARY (Jobs / Schedule / Time / Workshop, Module 2, PREVIEW ONLY: nothing here is wired to anything).
 * Inputs: none from the server. Everything shown is fictional sample data (one made-up company, four fictional people, clock records and job time for the weeks of 16/11/2026 and 23/11/2026,
 * a preview clock that starts at Mon 23/11/2026 10:30) held in this file, plus the person's clicks. Outputs: a Weekly hours look-and-feel prototype (Today: clock in and out, breaks, the
 * day's totals, day ticks, clock records, job time; This week: the week per person with approval, exports, notices) whose only state is LOCAL UI state. Clocking in or out, starting or
 * stopping a job and ticking a day box are drawn on screen from LOCAL records (the figures are worked out by the REAL pure functions in lib/time-sheet and lib/time-day-flags) and reset with
 * "Reset preview" or a reload; every one of them also answers with the neutral "Preview only ... Nothing was saved." toast. Corrections, added time, removals, approvals, exports and the
 * payroll export send nothing and change nothing. The "Who is looking" control only changes which controls are drawn; it grants nothing. NO Supabase, auth, offline outbox, route or storage call.
 * Run-time imports from lib/ are pure functions and constants only (time-sheet, time-day-flags, time-week types, time-payroll-export weeks, working-hours text, dates, org-settings list) and types.
 * The rules inline in components/time/day-sheet.tsx, week-review.tsx and time-dialogs.tsx are mirrored here and pinned to that source by tests/unit/timePreview.test.ts.
 * v2 (owner-approved structure, STRUCTURAL-CHANGES-BRIEF items 4, 7, 10, 11): one PreviewBar strip; the generic sentence under the title is a tooltip and a screen-reader description of the title; each row has ONE primary action
 * (Approve on a week row, with "Save suggested ticks" in its More menu when both apply; Correct on a job-time line, with Remove in its More menu) in a fixed-width actions column; the v4 type scale. No control was removed.
 * MUST NOT CHANGE: wording, roles, columns, buttons and who may use which control mirror today's pages (Admin, Office and Workshop may open Weekly hours, a Viewer may not; Workshop sees and clocks
 * only their own day and week; Admin and Office open anyone's; only Admin approves by default and only Admin corrects someone else's time). Hours only: no rates or pay. Do not wire this to
 * real data, a session or an action, do not add a control the real page lacks, keep every control on a 48 px hit area. The printable A4 sheets are NOT part of this preview (Print answers with a
 * toast). Delete the four preview files (this component and its .module.css, app/(dashboard)/time/preview/page.tsx, tests/unit/timePreview.test.ts) to remove it completely.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Button, Checkbox, EmptyState, FailedState, Field, Input, LoadingState, Menu, PageHeader, Popover, PreviewBar, ScrollTable, SegmentedControl, Select, Sheet, StatTile, StatusBadge, Switch, Textarea,
  ToastProvider, cx, premiumTokens, srOnly, tabularNumbers, typeScale, useToast,
} from "@/components/ui/premium";
import type { StatusTone } from "@/components/ui/premium";
import { fmtDateText, fmtDateTime } from "@/lib/dates";
import { COLUMN_TABLES } from "@/lib/org-settings";
import { DESK_QUERY } from "@/lib/shell-status";
import { UNKNOWN } from "@/lib/people";
import { ACTION_TEXT, CODE_TEXT } from "@/lib/time-sync-rejections";
import { UNVERIFIED_REASON_TEXT } from "@/lib/clock-in-lock";
import { unrecognisedBannerText } from "@/lib/site-network";
import { TIME_NEEDS_DATABASE_UPDATE } from "@/lib/time-features";
import { DAY_FLAGS_FUTURE, DAY_FLAG_KEYS, DAY_FLAG_LABEL, effectiveDayFlags, flagsShort, pickFlags, shortDay, weekDayFlags, dayFlagsEditable } from "@/lib/time-day-flags";
import type { DayFlags, SavedDayFlags, WeekDayFlags } from "@/lib/time-day-flags";
import { PAYROLL_MAX_WEEKS, payrollWeeks } from "@/lib/time-payroll-export";
import {
  DEFAULT_TIME_SETTINGS, FLAG_TEXT, ROUNDING_NOTE, addDays, approvalSnapshot, clockStateOf, dayTotals, hm, hmSigned, localDateOf, localDayBounds, localInstant, localTimeOf, weekStartOf, weekTotals, zoneLabel,
} from "@/lib/time-sheet";
import type { AttendanceEvent, ClockAction, DayTotals, LabourSession, TimeSettings, WeekTotals } from "@/lib/time-sheet";
import { WEEK_STATE_TEXT } from "@/lib/time-week";
import type { WeekState } from "@/lib/time-week";
import { paidHoursExplanation } from "@/lib/working-hours";
import s from "./TimePreview.module.css";

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
   Rules mirrored from the real components (pinned to their source by tests/unit/timePreview.test.ts)
   ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

export type Role = "admin" | "office" | "workshop" | "viewer";
export const ROLES: Role[] = ["admin", "office", "workshop", "viewer"];
/** middleware.ts: ["/time", ["admin", "office", "workshop"]]. A viewer is refused (sent back to the dashboard). */
export const canOpenTime = (r: Role) => r === "admin" || r === "office" || r === "workshop";
/** DaySheet: seesEveryone = hasAnyRole(["admin", "office"]). */
export const seesEveryone = (r: Role) => r === "admin" || r === "office";
/** DaySheet: canEdit = own || isAdmin (corrections to someone else's time are admin only). */
export const canEditDay = (r: Role, own: boolean) => own || r === "admin";
/** WeekReview: canApprove = hasAnyRole(settings.approverRoles); the default is admin only. */
export const canApprove = (r: Role, settings: TimeSettings = DEFAULT_TIME_SETTINGS) => settings.approverRoles.includes(r);
export const ACTION_LABEL: Record<string, string> = { in: "Clock in", out: "Clock out", break_start: "Break start", break_end: "Break end", void: "Removed" };
/** The page sentence under the title: generic, so it is the title's tooltip and screen-reader description, not a visible line. */
export const TIME_INTRO = "Clock in and out, and see the hours worked each day and week.";
export const REASON_MIN = 3;
export const REASON_MAX = 500;
export const reasonOk = (reason: string) => reason.trim().length >= REASON_MIN;
export const VALID_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const SYNC_WARNING = "Anything still waiting to sync on a phone or tablet is not in these figures. Before approving, check each device used this week shows no ‘waiting to sync’ (open Weekly hours on it with signal).";

/** A local date and time as an instant, with the same messages as useLocalTime in time-dialogs.tsx. */
export function localTimeProblem(date: string, time: string, zone: "BST" | "GMT" | "") {
  const r = localInstant(date, time, zone || undefined);
  const error = !time ? "Enter a time." : r.kind === "missing" ? "That time doesn't exist that night (the clocks went forward)." : r.kind === "invalid" ? "Enter a date and a time (HH:MM)." : r.kind === "ambiguous" && !zone ? "That time happens twice tonight: choose BST or GMT." : null;
  return { at: r.kind === "ok" ? r.at : null, ambiguous: r.kind === "ambiguous", error };
}
/** A clock record can only be saved with a time (unless it is being removed) and a reason of at least 3 characters. */
export const clockCorrectionOk = (a: { removing: boolean; at: Date | null; reason: string }) => reasonOk(a.reason) && (a.removing || Boolean(a.at));
/** Add or correct job time: a job, a start, an end when needed, a reason, and an end not before the start. */
export function labourEditOk(a: { jobId: string; from: Date | null; to: Date | null; toNeeded: boolean; reason: string }) {
  return Boolean(a.jobId) && Boolean(a.from) && (!a.toNeeded || Boolean(a.to)) && reasonOk(a.reason) && (!a.to || !a.from || a.to >= a.from);
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
   Sample data (fictional). Europe/London is GMT on these dates, so the instants are written in UTC.
   ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

export const COMPANY_NAME = "Fernhill Engineering Ltd";
export const TODAY = "2026-11-23";
export const SIM_START = Date.UTC(2026, 10, 23, 10, 30);
export const ME = "u-callum";
export const PEOPLE_NAMES: Record<string, string> = { "u-callum": "Callum Reeve", "u-tomas": "Tomas Whitcombe", "u-ngozi": "Ngozi Adeyemi", "u-harvey": "Harvey Lindqvist" };
export const JOB_INFO: Record<string, { job_no: string; customer: string; description: string }> = {
  "j-431": { job_no: "J-0431", customer: "Brightwell Pumps", description: "Pump housing, 12 off" },
  "j-430": { job_no: "J-0430", customer: "Northgate Valves", description: "Roller, 6 off" },
  "j-433": { job_no: "J-0433", customer: "Marlow Hydraulics", description: "Bracket, 40 off" },
  "j-436": { job_no: "J-0436", customer: "Kestrel Marine", description: "Manifold plate" },
  "j-438": { job_no: "J-0438", customer: "Northgate Valves", description: "Drive shaft, 8 off" },
  "j-435": { job_no: "J-0435", customer: "Marlow Hydraulics", description: "Bar cut-off, 200 pieces" },
};
const utc = (date: string, time: string) => new Date(`${date}T${time}:00Z`).toISOString();
let seq = 0;
const ev = (user: string, date: string, time: string, action: ClockAction): AttendanceEvent => ({ id: `e-${++seq}`, user_id: user, action, at: utc(date, time), source: "clock" });
const lab = (user: string, date: string, job: string, from: string, to: string | null): LabourSession => ({ id: `l-${++seq}`, user_id: user, job_id: job, started_at: utc(date, from), ended_at: to ? utc(date, to) : null });
const WEEK1 = "2026-11-16";
const day = (n: number) => addDays(WEEK1, n);

function build() {
  const events: AttendanceEvent[] = [];
  const labour: LabourSession[] = [];
  // Callum: a 40:00 week. Mon..Wed 07:30 start with a clocked 30 min lunch (allowance 45 applies), Thu 07:45 to 15:45, Fri a short day, Sat overtime.
  const callum: [number, string, string][] = [[0, "07:30", "16:00"], [1, "07:30", "16:30"], [2, "07:30", "16:00"], [3, "07:45", "15:45"], [4, "07:30", "12:30"], [5, "08:00", "12:00"]];
  for (const [d, i, o] of callum) {
    events.push(ev(ME, day(d), i, "in"));
    if (d <= 3) { events.push(ev(ME, day(d), "12:00", "break_start"), ev(ME, day(d), "12:30", "break_end")); }
    events.push(ev(ME, day(d), o, "out"));
  }
  labour.push(lab(ME, day(0), "j-431", "07:40", "11:50"), lab(ME, day(0), "j-430", "12:35", "15:50"), lab(ME, day(1), "j-431", "07:40", "16:20"), lab(ME, day(2), "j-433", "07:40", "15:50"), lab(ME, day(3), "j-436", "07:50", "15:30"), lab(ME, day(4), "j-433", "07:40", "12:20"), lab(ME, day(5), "j-431", "08:10", "11:50"));
  // Tomas: lunch clocked at 60 minutes (longer than the 45 allowance, so 60 is taken off); Wednesday's clock-out was never recorded.
  for (let d = 0; d < 5; d++) {
    events.push(ev("u-tomas", day(d), "08:00", "in"), ev("u-tomas", day(d), "12:00", "break_start"), ev("u-tomas", day(d), "13:00", "break_end"));
    if (d !== 2) events.push(ev("u-tomas", day(d), "16:30", "out"));
    labour.push(lab("u-tomas", day(d), "j-438", "08:10", d === 2 ? "16:00" : "16:20"));
  }
  // Ngozi: early starts, plus a Saturday morning with no ticks saved yet (so the week shows Sat as a starred suggestion).
  for (let d = 0; d < 5; d++) { events.push(ev("u-ngozi", day(d), "06:00", "in"), ev("u-ngozi", day(d), "14:30", "out")); labour.push(lab("u-ngozi", day(d), "j-435", "06:10", "14:20")); }
  events.push(ev("u-ngozi", day(5), "08:00", "in"), ev("u-ngozi", day(5), "11:00", "out")); labour.push(lab("u-ngozi", day(5), "j-435", "08:05", "10:55"));
  // Harvey: four long days.
  for (let d = 0; d < 4; d++) { events.push(ev("u-harvey", day(d), "07:00", "in"), ev("u-harvey", day(d), "17:00", "out")); labour.push(lab("u-harvey", day(d), "j-430", "07:10", "16:50")); }
  // Today (Mon 23/11/2026): everyone is in; Callum's two job stretches, the second one still open.
  events.push(ev(ME, TODAY, "07:31", "in"), ev("u-tomas", TODAY, "08:02", "in"), ev("u-ngozi", TODAY, "06:04", "in"), ev("u-harvey", TODAY, "07:12", "in"));
  labour.push(lab(ME, TODAY, "j-431", "07:40", "09:45"), lab(ME, TODAY, "j-433", "09:45", null), lab("u-tomas", TODAY, "j-438", "08:10", null), lab("u-ngozi", TODAY, "j-435", "06:10", null), lab("u-harvey", TODAY, "j-430", "07:20", null));
  return { events, labour };
}
export const SEED = build();
const flagRow = (user: string, d: number, f: Partial<DayFlags>): SavedDayFlags => ({ user_id: user, day: day(d), overtime: false, saturday: false, sunday: false, bank_holiday: false, ...f, updated_by: "u-sam", updated_at: utc(day(d), "18:00") });
export const SAVED_FLAGS: SavedDayFlags[] = [flagRow(ME, 5, { saturday: true, overtime: true }), flagRow("u-harvey", 3, { overtime: true })];
export const BANK_HOLIDAYS = new Map<string, string>();
export const SETTINGS: TimeSettings = { ...DEFAULT_TIME_SETTINGS };
export const WEEK_STATUS: Record<string, { state: WeekState; approved_at: string | null; approved_by: string | null }> = {
  "u-callum": { state: "approved", approved_at: utc("2026-11-23", "09:05"), approved_by: "u-sam" },
  "u-tomas": { state: "changed_since_approval", approved_at: utc("2026-11-22", "17:20"), approved_by: "u-sam" },
  "u-ngozi": { state: "not_approved", approved_at: null, approved_by: null },
  "u-harvey": { state: "not_approved", approved_at: null, approved_by: null },
};
export const NAMES_WITH_ADMIN: Record<string, string> = { ...PEOPLE_NAMES, "u-sam": "Sam Okoro" };
export type PersonWeekRow = { userId: string; week: WeekTotals; dayFlags: WeekDayFlags; state: WeekState; approvedAt: string | null; approvedBy: string | null };

/** The week of everyone from the given records, worked out by the real functions. */
export function weeksFor(weekStart: string, events: AttendanceEvent[], labour: LabourSession[], nowMs: number): PersonWeekRow[] {
  return Object.keys(PEOPLE_NAMES).map((id) => {
    const week = weekTotals({ weekStart, events: events.filter((e) => e.user_id === id), labour: labour.filter((l) => l.user_id === id), settings: SETTINGS, bankHolidays: BANK_HOLIDAYS, now: nowMs });
    const st = weekStart === WEEK1 ? WEEK_STATUS[id] : { state: "not_approved" as WeekState, approved_at: null, approved_by: null };
    return { userId: id, week, dayFlags: weekDayFlags(week, SAVED_FLAGS.filter((f) => f.user_id === id), BANK_HOLIDAYS), state: st.state, approvedAt: st.approved_at, approvedBy: st.approved_by };
  }).filter((p) => p.week.daysWorked > 0 || p.week.labour > 0).sort((a, b) => PEOPLE_NAMES[a.userId].localeCompare(PEOPLE_NAMES[b.userId]));
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
   Formatting (mirrors day-sheet.tsx)
   ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

export const dayHeading = (date: string) => fmtDateText(date, { weekday: "short", year: true });
export function isClockChangeDay(date: string) { const b = localDayBounds(date); return b.end.getTime() - b.start.getTime() !== 86_400_000; }
export function clockTime(at: string | number | null | undefined, date?: string) {
  if (at === null || at === undefined) return "—";
  const d = new Date(at);
  return `${localTimeOf(d)}${date && isClockChangeDay(date) ? ` ${zoneLabel(d)}` : ""}`;
}
export const breakSub = (rule: string, clocked: number) => (rule === "clocked" ? `clocked (${hm(clocked)})` : rule === "allowance" ? "lunch + break, unpaid" : rule === "paid" ? "breaks paid" : "none deducted");
const HOURS_COLUMNS = COLUMN_TABLES.find((t) => t.key === "hours")!;
export const HOURS_COLUMN_KEYS = HOURS_COLUMNS.columns.map((c) => c.key);
export const columnScopeText = (own: boolean) => (own ? "Your own view on this device only. Everyone else, and the company setting, are not changed." : "Changes apply to everyone in this company.");
export const resetLabel = (own: boolean) => (own ? "Reset to the company view" : "Reset to default (show all columns)");
const STATE_TONE: Record<WeekState, StatusTone> = { approved: "ok", changed_since_approval: "warn", not_approved: "neutral" };

function useMedia(query: string, fallback: boolean): boolean {
  return useSyncExternalStore((cb) => { const m = window.matchMedia(query); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); }, () => window.matchMedia(query).matches, () => fallback);
}

export type Screen = "ready" | "loading" | "error" | "needs-update" | "no-records";
export const SCREENS: { v: Screen; label: string }[] = [
  { v: "ready", label: "Normal" }, { v: "loading", label: "Loading" }, { v: "error", label: "Failed to load" }, { v: "needs-update", label: "Database update needed" }, { v: "no-records", label: "No records this week" },
];
export const HOURS_ERROR = "Couldn't load your hours.";
export const WEEK_ERROR = "Couldn't load the week.";
const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: r.charAt(0).toUpperCase() + r.slice(1) }));
const TAB_OPTIONS = [{ value: "today", label: "Today", controls: "panel-today" }, { value: "week", label: "This week", controls: "panel-week" }];

type Dlg =
  | { kind: "clock"; existing: AttendanceEvent | null } | { kind: "labour"; existing: LabourSession | null } | { kind: "remove"; session: LabourSession }
  | { kind: "approve"; userId: string } | { kind: "payroll" };

export default function TimePreview() { return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>; }

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("ready");
  const [tab, setTab] = useState<"today" | "week">("today");
  const [date, setDate] = useState(TODAY);
  const [week, setWeek] = useState(weekStartOf(TODAY));
  const [person, setPerson] = useState(ME);
  const [simNow, setSimNow] = useState(SIM_START);
  const [events, setEvents] = useState<AttendanceEvent[]>(SEED.events);
  const [labour, setLabour] = useState<LabourSession[]>(SEED.labour);
  const [dayTicks, setDayTicks] = useState<Record<string, DayFlags>>({});
  const [startJob, setStartJob] = useState("");
  const [hidden, setHidden] = useState<string[]>([]);
  const [dlg, setDlgState] = useState<Dlg | null>(null);
  const [timer, setTimer] = useState<number | null>(null);
  const [bannerOff, setBannerOff] = useState(false);
  const [resolved, setResolved] = useState<string[]>([]);
  const wide = useMedia(DESK_QUERY, true);
  const setDlg = useCallback((d: Dlg | null) => { setDlgState(d); if (d) toast.clear(); }, [toast]);
  useEffect(() => () => { if (timer) window.clearTimeout(timer); }, [timer]);

  const allowed = canOpenTime(role);
  // Workshop sees and clocks only their own day; admin and office open anyone's (day-sheet.tsx: personId = (seesEveryone && params.user) || me).
  const pid = seesEveryone(role) ? person : ME;
  const own = pid === ME;
  const isToday = date === TODAY;
  const isAdmin = role === "admin";
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const isVisible = (k: string) => (HOURS_COLUMNS.columns.find((c) => c.key === k)?.locked ? true : !hidden.includes(k));
  const ownView = !seesEveryone(role);
  const nowMs = simNow;

  const mine = useMemo(() => ({ events: events.filter((e) => e.user_id === pid), labour: labour.filter((l) => l.user_id === pid) }), [events, labour, pid]);
  const day_ = useMemo(() => dayTotals({ date, events: mine.events, labour: mine.labour, settings: SETTINGS, bankHolidays: BANK_HOLIDAYS, now: nowMs }), [date, mine, nowMs]);
  const { clockedIn, onBreak, since } = clockStateOf(day_.sessions);
  const openJobs = day_.jobs.filter((j) => j.open);
  const people = useMemo(() => (screen === "no-records" ? [] : weeksFor(week, events, labour, nowMs).filter((p) => seesEveryone(role) || p.userId === ME)), [week, events, labour, nowMs, role, screen]);

  const push = (action: ClockAction) => {
    setEvents((e) => [...e, { id: `p-${e.length}-${simNow}`, user_id: ME, action, at: new Date(simNow).toISOString(), source: "clock" }]);
    preview(`${ACTION_LABEL[action]} at ${localTimeOf(new Date(simNow))} is shown here only.`);
  };
  const startLabour = () => {
    const j = JOB_INFO[startJob];
    if (!j) return;
    setLabour((l) => [...l, { id: `pl-${l.length}-${simNow}`, user_id: ME, job_id: startJob, started_at: new Date(simNow).toISOString(), ended_at: null }]);
    setStartJob("");
    preview(`${j.job_no} started at ${localTimeOf(new Date(simNow))} is shown here only.`);
  };
  const stopLabour = (jobId: string) => {
    setLabour((l) => l.map((x) => (x.user_id === ME && x.job_id === jobId && !x.ended_at ? { ...x, ended_at: new Date(simNow).toISOString() } : x)));
    preview(`${JOB_INFO[jobId]?.job_no ?? "The job"} stopped at ${localTimeOf(new Date(simNow))} is shown here only.`);
  };
  const retry = () => { setScreen("loading"); setTimer(window.setTimeout(() => { setScreen("ready"); toast.show({ title: "Preview only", detail: "Sample hours shown again. No server was contacted." }); }, 700)); };
  const resetAll = () => { setScreen("ready"); setRole("admin"); setTab("today"); setDate(TODAY); setWeek(weekStartOf(TODAY)); setPerson(ME); setSimNow(SIM_START); setEvents(SEED.events); setLabour(SEED.labour); setDayTicks({}); setStartJob(""); setHidden([]); setDlgState(null); setBannerOff(false); setResolved([]); toast.clear(); };
  const pickScreen = (v: Screen) => { toast.clear(); setDlgState(null); setScreen(v); };
  const advance = (mins: number) => { setSimNow((n) => n + mins * 60_000); toast.show({ title: "Preview clock", detail: `The preview clock now reads ${localTimeOf(new Date(simNow + mins * 60_000))}.` }); };
  const setColumn = (k: string, on: boolean) => { setHidden((h) => (on ? h.filter((x) => x !== k) : [...new Set([...h, k])])); if (!ownView) preview("This would change what everyone in the company sees on this screen."); };

  const name = PEOPLE_NAMES[pid] ?? UNKNOWN;
  const approving = dlg?.kind === "approve" ? people.find((p) => p.userId === dlg.userId) : null;

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="time-preview" data-role={role}>
      <PreviewBar data-testid="preview-bar" controls={
        <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
          <div className={s.dock}>
            <p className={s.dockNote}>Not part of Tolra. Sample data; the preview clock starts at Mon 23/11/2026 10:30. Clock actions are drawn from local records only, nothing is granted and no request is made.</p>
            <p className={s.dockLabel}>Who is looking (changes the drawing only)</p>
            <SegmentedControl label="Role" value={role} options={ROLE_OPTIONS} size="sm" onChange={(v) => { setRole(v); setDlgState(null); toast.clear(); if (!seesEveryone(v)) setPerson(ME); }} />
            <p className={s.dockLabel}>Screen state</p>
            <div className={s.dockStates} role="group" aria-label="Screen state">
              {SCREENS.map((x) => <button key={x.v} type="button" aria-pressed={screen === x.v} className={s.dockBtn} onClick={() => pickScreen(x.v)}>{x.label}</button>)}
            </div>
            <p className={s.dockLabel}>Preview clock ({localTimeOf(new Date(simNow))})</p>
            <div style={{ display: "flex", gap: 8 }}>
              <Button size="sm" onClick={() => advance(15)} data-testid="adv-15">+15 min</Button>
              <Button size="sm" onClick={() => advance(60)} data-testid="adv-60">+1 h</Button>
            </div>
            <Button size="sm" variant="secondary" onClick={resetAll}>Reset preview</Button>
          </div>
        </Popover>
      } />
      <PageHeader
        title={<span title={allowed ? TIME_INTRO : undefined} data-testid="time-title">{allowed ? "Weekly hours" : "Access Denied"}</span>}
        description={allowed ? <span className={srOnly}>{TIME_INTRO}</span> : "Redirecting you back to the dashboard."}
      />

      {!allowed ? (
        <section className={s.panel}><div className={s.denied} data-testid="access-denied"><h2 className={s.panelTitle}>Access Denied</h2><p className={s.deniedNote}>Preview only: no redirect happens here. Weekly hours is for Admin, Office and Workshop; a Viewer is refused by the route check and sent to the dashboard.</p></div></section>
      ) : screen === "needs-update" ? (
        <div className={cx(s.callout, s.calloutWarn)} role="status" data-testid="time-needs-update"><p className={s.calloutText}>{TIME_NEEDS_DATABASE_UPDATE}</p></div>
      ) : (
        <>
          <SegmentedControl label="Weekly hours" kind="tabs" value={tab} options={TAB_OPTIONS} onChange={(v) => { setTab(v as "today" | "week"); toast.clear(); }} data-testid="hours-tabs" />
          {role === "admin" && !bannerOff && tab !== undefined ? (
            <p role="alert" className={cx(s.callout, s.calloutWarn)} data-testid="unrecognised-network-banner">
              <span className={s.calloutText}>{unrecognisedBannerText(2)} <button type="button" className={s.personName} style={{ textDecoration: "underline", fontWeight: 650 }} onClick={() => preview("This would open Settings > Workshop network.")} data-testid="unrecognised-network-link">Open Settings &gt; Workshop network</button></span>
              <Button size="sm" aria-label="Dismiss this warning" className={s.calloutAct} onClick={() => setBannerOff(true)} data-testid="unrecognised-network-dismiss">Dismiss</Button>
            </p>
          ) : null}
          {tab === "today" ? (
            <div id="panel-today" role="tabpanel" aria-label="Today" className={s.root} style={{ gap: 16 }}>
              <div className={s.toolbar}>
                <Button aria-label="Previous day" onClick={() => setDate(addDays(date, -1))}>Previous day</Button>
                <div className={s.dateField}><Input type="date" aria-label="Day" value={date} onChange={(e) => VALID_DATE.test(e.target.value) && setDate(e.target.value)} data-testid="day-input" /></div>
                <Button aria-label="Next day" onClick={() => setDate(addDays(date, 1))}>Next day</Button>
                {!isToday ? <Button variant="quiet" onClick={() => setDate(TODAY)}>Today</Button> : null}
                {seesEveryone(role) ? (
                  <div className={s.personField}><Select aria-label="Person" value={person} onChange={(e) => setPerson(e.target.value)} data-testid="person">
                    {Object.entries(PEOPLE_NAMES).sort((a, b) => a[1].localeCompare(b[1])).map(([id, n]) => <option key={id} value={id}>{n}{id === ME ? " (you)" : ""}</option>)}
                  </Select></div>
                ) : null}
                <div className={s.toolbarEnd}>
                  <ColumnsPopover own={ownView} isVisible={isVisible} setColumn={setColumn} hidden={hidden} reset={() => { setHidden([]); if (!ownView) preview("This would show every item again for everyone in the company."); }} />
                  <Button onClick={() => toast.show({ title: "Preview only", detail: "The printable A4 sheet is not part of this preview. Nothing was printed or saved." })} data-testid="print">Print</Button>
                </div>
              </div>
              <h2 className={s.dayLine}>{name} · {dayHeading(date)}{day_.bankHolidayName ? ` · ${day_.bankHolidayName}` : ""}</h2>
              {screen === "loading" ? <LoadingState label="Loading your hours" rows={5} /> : screen === "error" ? (
                <FailedState headingLevel={3} title={HOURS_ERROR} detail="No hours are shown until they load, so a blank day is never mistaken for a day with no time." onRetry={retry} />
              ) : (
                <TodayBody
                  day={day_} date={date} pid={pid} own={own} isToday={isToday} role={role} clockedIn={clockedIn} onBreak={onBreak} since={since} empty={screen === "no-records"} openJobs={openJobs.map((o) => o.jobId)}
                  events={screen === "no-records" ? [] : mine.events} startJob={startJob} setStartJob={setStartJob} isVisible={isVisible} dayTicks={dayTicks} canEdit={canEditDay(role, own)}
                  onClock={push} onStart={startLabour} onStop={stopLabour} setDlg={setDlg}
                  confirmTicks={(f) => { setDayTicks((t) => ({ ...t, [`${pid}|${date}`]: f })); preview(`Day ticks for ${dayHeading(date)} would be saved.`); }}
                />
              )}
            </div>
          ) : (
            <div id="panel-week" role="tabpanel" aria-label="This week" className={s.root} style={{ gap: 16 }}>
              <div className={s.toolbar}>
                <Button aria-label="Previous week" onClick={() => setWeek(addDays(week, -7))}>Previous week</Button>
                <span style={{ fontWeight: 650, fontSize: 14 }}>Week of <span className={tabularNumbers}>{dayHeading(week)}</span></span>
                <Button aria-label="Next week" onClick={() => setWeek(addDays(week, 7))}>Next week</Button>
                <div className={s.toolbarEnd}>
                  <ColumnsPopover own={ownView} isVisible={isVisible} setColumn={setColumn} hidden={hidden} reset={() => { setHidden([]); if (!ownView) preview("This would show every item again for everyone in the company."); }} />
                  <Button disabled={!people.length} onClick={() => preview("A CSV file would be downloaded.")} data-testid="export-csv">Export CSV</Button>
                  <Button disabled={!people.length} onClick={() => preview("An Excel file would be downloaded.")} data-testid="export-xlsx">Export Excel</Button>
                  {seesEveryone(role) ? <Button onClick={() => setDlg({ kind: "payroll" })} data-testid="payroll-export-open">Payroll export</Button> : null}
                  <Button onClick={() => toast.show({ title: "Preview only", detail: "The printable A4 sheet is not part of this preview. Nothing was printed or saved." })} data-testid="print-week">Print</Button>
                </div>
              </div>
              {seesEveryone(role) && screen === "ready" ? <WeekNotices resolved={resolved} resolve={(id) => { setResolved((r) => [...r, id]); preview("The refused action would be marked resolved."); }} preview={preview} /> : null}
              {screen === "loading" ? <LoadingState label="Loading the week" rows={5} /> : screen === "error" ? (
                <FailedState headingLevel={3} title={WEEK_ERROR} detail="No week is shown until it loads, so a blank week is never mistaken for a week nobody worked." onRetry={retry} />
              ) : (
                <WeekBody people={people} week={week} role={role} wide={wide} isVisible={isVisible} onOpenDay={(id, d) => { if (seesEveryone(role)) setPerson(id); setDate(d); setTab("today"); }} onApprove={(id) => setDlg({ kind: "approve", userId: id })} onSaveSuggested={(id) => preview(`Suggested ticks for ${PEOPLE_NAMES[id]} would be saved.`)} />
              )}
            </div>
          )}
        </>
      )}

      {dlg?.kind === "clock" ? <ClockSheet date={date} existing={dlg.existing} onClose={() => setDlgState(null)} onSave={(what) => { setDlgState(null); preview(what); }} /> : null}
      {dlg?.kind === "labour" ? <LabourSheet date={date} existing={dlg.existing} onClose={() => setDlgState(null)} onSave={(what) => { setDlgState(null); preview(what); }} /> : null}
      {dlg?.kind === "remove" ? <RemoveSheet session={dlg.session} onClose={() => setDlgState(null)} onRemove={() => { setDlgState(null); preview("The job time would be removed (kept on record)."); }} /> : null}
      {approving ? <ApproveSheet person={approving} name={PEOPLE_NAMES[approving.userId]} week={week} onClose={() => setDlgState(null)} onApprove={() => { setDlgState(null); preview(`${PEOPLE_NAMES[approving.userId]}'s week would be approved.`); }} /> : null}
      {dlg?.kind === "payroll" ? <PayrollSheet week={week} onClose={() => setDlgState(null)} onExport={(f) => { setDlgState(null); preview(`The payroll ${f} would be downloaded.`); }} /> : null}
    </div>
  );
}

function ColumnsPopover({ own, isVisible, setColumn, hidden, reset }: { own: boolean; isVisible: (k: string) => boolean; setColumn: (k: string, on: boolean) => void; hidden: string[]; reset: () => void }) {
  return (
    <Popover label="Columns" title={`${HOURS_COLUMNS.label} columns`} variant="secondary" data-testid="columns-toggle">
      <p className={s.hint} data-testid="column-scope" style={{ maxWidth: 280, marginBottom: 4 }}>{columnScopeText(own)}</p>
      {HOURS_COLUMNS.columns.map((c) => c.locked
        ? <p key={c.key} className={s.hint} style={{ display: "flex", justifyContent: "space-between", minHeight: 32, alignItems: "center", margin: 0 }}><span>{c.label}</span><span>Always shown</span></p>
        : <Switch key={c.key} label={c.label} checked={isVisible(c.key)} onChange={(on) => setColumn(c.key, on)} data-testid={`col-${c.key}`} />)}
      <div style={{ paddingTop: 6 }}><Button size="sm" disabled={!hidden.length} onClick={reset}>{resetLabel(own)}</Button></div>
    </Popover>
  );
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
   Today
   ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function TodayBody({ day, date, pid, own, isToday, role, clockedIn, onBreak, since, empty, openJobs, events, startJob, setStartJob, isVisible, dayTicks, canEdit, onClock, onStart, onStop, setDlg, confirmTicks }: {
  day: DayTotals; date: string; pid: string; own: boolean; isToday: boolean; role: Role; clockedIn: boolean; onBreak: boolean; since: number | null; empty: boolean; openJobs: string[]; events: AttendanceEvent[];
  startJob: string; setStartJob: (v: string) => void; isVisible: (k: string) => boolean; dayTicks: Record<string, DayFlags>; canEdit: boolean; onClock: (a: ClockAction) => void; onStart: () => void; onStop: (jobId: string) => void;
  setDlg: (d: Dlg | null) => void; confirmTicks: (f: DayFlags) => void;
}) {
  const showClock = own && isToday && role !== "viewer";
  const jobIds = Object.keys(JOB_INFO).filter((id) => !openJobs.includes(id));
  const recs = events.filter((e) => localDateOf(e.at) === date).sort((a, b) => a.at.localeCompare(b.at));
  const savedKey = `${pid}|${date}`;
  const saved = dayTicks[savedKey] ?? null;
  const shown = effectiveDayFlags(day, saved, BANK_HOLIDAYS, true);
  const [draft, setDraft] = useState<DayFlags | null>(null);
  const ticks = draft ?? shown.flags;
  const editableDay = dayFlagsEditable(date, TODAY);
  useEffect(() => setDraft(null), [date, pid, saved]);
  return (
    <>
      {showClock ? (
        <section className={cx(s.panel, s.clockCard, clockedIn && s.clockOn)} aria-label="Clock" data-testid="clock-card">
          <div className={s.clockState}>
            <p className={s.clockLabel}>Clock</p>
            <p className={s.clockText} data-testid="clock-state">{clockedIn ? `Clocked in since ${clockTime(since, date)}${onBreak ? " · on a break" : ""}` : "Not clocked in"}</p>
          </div>
          <div className={s.clockBtns}>
            {clockedIn ? (
              <>
                {onBreak ? <Button size="lg" onClick={() => onClock("break_end")} data-testid="break-end">End break</Button> : <Button size="lg" onClick={() => onClock("break_start")} data-testid="break-start">Start break</Button>}
                <Button size="lg" variant="primary" onClick={() => onClock("out")} data-testid="clock-out">Clock out</Button>
              </>
            ) : <Button size="lg" variant="primary" onClick={() => onClock("in")} data-testid="clock-in">Clock in</Button>}
          </div>
        </section>
      ) : null}

      {empty ? <EmptyState headingLevel={3} title="No clock records on this day." detail="Start and Pause on the Job Board record job time too." /> : (
        <>
          <div className={s.tiles5} data-testid="day-totals">
            {isVisible("clocked") ? <StatTile label="Clocked" value={hm(day.attendance)} hint="clock in to out" /> : null}
            {isVisible("breaks") ? <StatTile label="Breaks" value={hmSigned(-day.breakDeduction)} hint={breakSub(day.breakRule, day.clockedBreaks)} /> : null}
            <StatTile label="Paid" value={hm(day.paid)} />
            {isVisible("jobs") ? <StatTile label="On jobs" value={hm(day.labour)} hint={day.labourOutsideAttendance > 0.5 ? `${hm(day.labourOutsideAttendance)} outside clock times` : undefined} /> : null}
            {isVisible("unallocated") ? <StatTile label="Not on a job" value={hm(day.unallocated)} hint="paid time with no job time" deltaTone={day.unallocated > 60 ? "warn" : "neutral"} delta={day.unallocated > 60 ? "More than an hour" : undefined} /> : null}
          </div>
          {day.flags.length ? (
            <div className={cx(s.callout, s.calloutWarn)} data-testid="day-flags"><ul className={s.flagList}>{day.flags.map((f) => <li key={f}>{FLAG_TEXT[f] ?? f}</li>)}</ul></div>
          ) : null}
          {own || seesEveryone(role) ? (
            <section className={s.panel} aria-labelledby="ticks-h" data-testid="day-flags-card">
              <div className={s.panelHead}>
                <h3 id="ticks-h" className={cx(typeScale.card, s.panelTitle)}>Day ticks</h3>
                {!saved ? <Button size="sm" disabled={!editableDay} onClick={() => confirmTicks(pickFlags(ticks))} data-testid="day-flags-confirm">Confirm</Button> : null}
              </div>
              <div className={s.panelBody}>
                <div className={s.ticks}>
                  {DAY_FLAG_KEYS.map((k) => (
                    <label key={k} className={s.tick}><Checkbox checked={ticks[k]} disabled={!editableDay} onChange={(e) => { const next = { ...pickFlags(ticks), [k]: e.target.checked }; setDraft(next); confirmTicks(next); }} data-testid={`day-flag-${k}`} />{DAY_FLAG_LABEL[k]}</label>
                  ))}
                </div>
                <p className={s.hint} data-testid="day-flags-state">{!editableDay ? `${DAY_FLAGS_FUTURE} ` : ""}{saved ? "Saved. Flags only: no rates or pay are worked out here." : "Suggested from the date (not saved yet, not counted on the weekly hours): untick what doesn't apply, or press Confirm."}</p>
              </div>
            </section>
          ) : null}

          <section className={s.panel} aria-labelledby="rec-h">
            <div className={s.panelHead}><h3 id="rec-h" className={cx(typeScale.card, s.panelTitle)}>Clock in and out</h3>{canEdit ? <Button size="sm" onClick={() => setDlg({ kind: "clock", existing: null })} data-testid="add-missing">Add missing</Button> : null}</div>
            <div className={s.panelBody}>
              {recs.length ? (
                <ul className={s.recList} data-testid="clock-records">
                  {recs.map((e) => {
                    const replaced = events.some((x) => x.supersedes === e.id);
                    const gone = replaced || e.action === "void";
                    return (
                      <li key={e.id} className={cx(s.rec, gone && s.recGone)}>
                        <span className={cx(s.recTime, tabularNumbers)}>{clockTime(e.at, date)}</span>
                        <span className={s.recAct}>{ACTION_LABEL[e.action]}</span>
                        {e.source === "correction" ? <span className={s.recNote}>corrected{e.reason ? `: ${e.reason}` : ""}</span> : null}
                        {canEdit && !replaced && e.action !== "void" ? <Button size="sm" variant="quiet" style={{ marginLeft: "auto" }} aria-label={`Correct the ${ACTION_LABEL[e.action]} at ${clockTime(e.at, date)}`} onClick={() => setDlg({ kind: "clock", existing: e })}>Correct</Button> : null}
                      </li>
                    );
                  })}
                </ul>
              ) : <p className={s.hint}>No clock records on this day.</p>}
            </div>
          </section>

          <section className={s.panel} aria-labelledby="jobs-h">
            <div className={s.panelHead}><h3 id="jobs-h" className={cx(typeScale.card, s.panelTitle)}>Jobs worked</h3>{canEdit ? <Button size="sm" onClick={() => setDlg({ kind: "labour", existing: null })} data-testid="add-time">Add time</Button> : null}</div>
            <div className={s.panelBody}>
              {showClock ? (
                <div className={s.startRow}>
                  <Field label="Job to start"><Select value={startJob} onChange={(e) => setStartJob(e.target.value)} data-testid="job-to-start"><option value="">Start time on a job…</option>{jobIds.map((id) => <option key={id} value={id}>{JOB_INFO[id].job_no} · {JOB_INFO[id].customer}</option>)}</Select></Field>
                  <Button disabled={!startJob} onClick={onStart} data-testid="labour-start">Start</Button>
                </div>
              ) : null}
              {day.jobs.length ? (
                <div style={{ overflowX: "auto", minWidth: 0 }} role="region" aria-label="Jobs worked, table" tabIndex={0}>
                  <table className={s.jobTable} data-testid="job-lines">
                    <thead><tr><th scope="col">Job</th><th scope="col">Times</th><th scope="col" className="num" style={{ textAlign: "right" }}>Time</th><th scope="col" style={{ textAlign: "right" }}>Share</th><th scope="col"><span className={s.srOnly}>Action</span></th></tr></thead>
                    <tbody>
                      {day.jobs.map((line) => {
                        const j = JOB_INFO[line.jobId];
                        return (
                          <tr key={line.jobId}>
                            <td><span className={s.jobName}>{j?.job_no ?? "Job"}</span><span className={s.jobSub}>{[j?.customer, j?.description].filter(Boolean).join(" · ")}</span></td>
                            <td>{line.sessions.map((x) => (
                              <div key={x.id} className={s.sess}>
                                <span className={tabularNumbers}>{clockTime(x.started_at, date)}–{x.ended_at ? clockTime(x.ended_at, date) : "now"}</span>
                                {canEdit ? (
                                  <span className={s.rowBtns}>
                                    <Button size="sm" variant="quiet" aria-label={`Correct job time for ${j?.job_no}`} onClick={() => setDlg({ kind: "labour", existing: x })}>Correct</Button>
                                    <Menu label="More" size="sm" variant="quiet" aria-label={`More actions for job time ${j?.job_no} ${clockTime(x.started_at, date)}`} items={[{ id: "remove", label: `Remove job time for ${j?.job_no}`, onSelect: () => setDlg({ kind: "remove", session: x }) }]} />
                                  </span>
                                ) : null}
                              </div>
                            ))}</td>
                            <td className={cx(tabularNumbers, "num")} style={{ textAlign: "right" }}>{hm(line.minutes)}</td>
                            <td className={tabularNumbers} style={{ textAlign: "right" }}>{hm(line.allocatedMinutes)}</td>
                            <td style={{ textAlign: "right" }}>{showClock && line.open ? <Button size="sm" onClick={() => onStop(line.jobId)} data-testid="labour-stop" aria-label={`Stop ${j?.job_no}`}>Stop</Button> : null}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : <p className={s.hint}>No job time on this day. Start and Pause on the Job Board record it too.</p>}
              <p className={s.hint}>Time: the clock time on each job. Share: when you were on more than one job at once, that time is split equally, so the shares add up to your time on jobs.</p>
            </div>
          </section>
          <p className={s.hint}>{paidHoursExplanation(SETTINGS)} Overtime is not worked out from the hours: it is the Overtime tick below. Bank holidays are holiday allowance; a day worked is an ordinary day unless ticked.</p>
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
   This week
   ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

const REJECTIONS = [{ id: "rj-1", userId: "u-tomas", line: `${ACTION_TEXT.out}, Wed 18 Nov 16:30 (${CODE_TEXT.week_approved}), Lathe 2 phone` }];
const UNVERIFIED = [{ id: "uv-1", userId: "u-harvey", action: "in", at: "Mon 23 Nov 07:12", reason: UNVERIFIED_REASON_TEXT.synced_later }];

function WeekNotices({ resolved, resolve, preview }: { resolved: string[]; resolve: (id: string) => void; preview: (d: string) => void }) {
  const rows = REJECTIONS.filter((r) => !resolved.includes(r.id));
  return (
    <>
      {rows.length ? rows.map((r) => (
        <div key={r.id} className={cx(s.callout, s.calloutWarn)} data-testid="sync-rejection-notice">
          <p className={s.calloutText}><b>1 time action from {PEOPLE_NAMES[r.userId]}&apos;s device was refused when it synced (week approved).</b> {r.line}. Add it as a correction.</p>
          <span className={s.calloutRow}>
            <Button size="sm" onClick={() => preview("This would open that person's day to add a correction.")}>Add on the sheet</Button>
            <Button size="sm" onClick={() => resolve(r.id)} data-testid="sync-rejection-resolve">Resolved</Button>
          </span>
        </div>
      )) : null}
      <div className={cx(s.callout, s.calloutWarn)} data-testid="network-unverified">
        <p className={s.calloutText}><b>1 clock action this week was kept without a network check (clock-in is locked to the workshop network).</b> {PEOPLE_NAMES[UNVERIFIED[0].userId]}: {ACTION_TEXT[UNVERIFIED[0].action]} {UNVERIFIED[0].at} ({UNVERIFIED[0].reason})</p>
      </div>
    </>
  );
}

function DayTicksCell({ flags }: { flags: WeekDayFlags }) {
  const ticked = flags.days.filter((d) => DAY_FLAG_KEYS.some((k) => d.flags[k]));
  if (!ticked.length) return <span className={s.muted}>None</span>;
  const counted = DAY_FLAG_KEYS.filter((k) => flags.totals[k].days);
  return (
    <div className={s.dayTicks}>
      <div>{ticked.map((d) => <span key={d.date} style={{ marginRight: 8, whiteSpace: "nowrap" }}>{shortDay(d.date)}: {flagsShort(d.flags)}{d.source === "suggested" ? "*" : ""}</span>)}</div>
      <div className={s.muted2}>
        {!counted.length ? <span>Nothing saved yet</span> : null}
        {counted.map((k) => <span key={k} style={{ marginRight: 8, whiteSpace: "nowrap" }} data-testid={`flag-total-${k}`}>{DAY_FLAG_LABEL[k]}: {flags.totals[k].days} day{flags.totals[k].days === 1 ? "" : "s"}, {hm(flags.totals[k].paidMinutes)} h</span>)}
      </div>
    </div>
  );
}

function WeekBody({ people, week, role, wide, isVisible, onOpenDay, onApprove, onSaveSuggested }: {
  people: PersonWeekRow[]; week: string; role: Role; wide: boolean; isVisible: (k: string) => boolean; onOpenDay: (id: string, date: string) => void; onApprove: (id: string) => void; onSaveSuggested: (id: string) => void;
}) {
  const isFuture = week > TODAY;
  const approver = canApprove(role);
  const every = seesEveryone(role);
  const ticksOn = isVisible("ticks");
  const anySuggested = people.some((p) => p.dayFlags.anySuggested);
  const approval = (p: PersonWeekRow) => (
    <span><span style={{ color: p.state === "approved" ? "#14532d" : p.state === "changed_since_approval" ? "#6b4300" : undefined }}><StatusBadge tone={STATE_TONE[p.state]}>{WEEK_STATE_TEXT[p.state]}</StatusBadge></span>
      {p.approvedAt ? <span className={s.hint} style={{ display: "block", marginTop: 2 }}>{NAMES_WITH_ADMIN[p.approvedBy ?? ""] ?? UNKNOWN}, {fmtDateTime(p.approvedAt)}</span> : null}</span>
  );
  /** ONE primary action per row: Approve when it applies (with "Save suggested ticks" in More when both apply); otherwise "Save suggested ticks" is the row's one action. */
  const actions = (p: PersonWeekRow) => {
    const who = PEOPLE_NAMES[p.userId];
    const canApproveRow = approver && p.state !== "approved" && !isFuture;
    const canSuggest = p.dayFlags.anySuggested && every;
    return (
      <span className={s.actions}>
        {canApproveRow ? (
          <>
            <Button size="sm" variant="primary" onClick={() => onApprove(p.userId)} data-testid="approve-week" aria-label={`Approve ${who}'s week`}>Approve</Button>
            {canSuggest ? <Menu label="More" size="sm" aria-label={`More actions for ${who}`} data-testid="week-more" items={[{ id: "suggested", label: "Save suggested ticks", onSelect: () => onSaveSuggested(p.userId) }]} /> : null}
          </>
        ) : canSuggest ? <Button size="sm" onClick={() => onSaveSuggested(p.userId)} data-testid="save-suggested-ticks" aria-label={`Save suggested ticks for ${who}`}>Save suggested ticks</Button> : null}
      </span>
    );
  };
  return (
    <>
      <section className={cx(s.panel, s.tblWrap, s.tbl)} aria-label="The week per person" data-testid="week-table">
        {!people.length ? <p className={s.emptyText}>Nobody has recorded time this week.</p> : wide ? (
          <ScrollTable label="Weekly hours, table">
            <thead><tr>
              <th scope="col">Person</th>
              {isVisible("days") ? <th scope="col" className="num">Days</th> : null}
              <th scope="col" className="num">Clocked</th>
              {isVisible("breaks") ? <th scope="col" className="num">Breaks</th> : null}
              <th scope="col" className="num">Paid</th>
              {isVisible("jobs") ? <th scope="col" className="num">On jobs</th> : null}
              {ticksOn ? <th scope="col">Day ticks</th> : null}
              <th scope="col">Check</th><th scope="col">Approval</th><th scope="col" className={s.actCol}><span className={s.srOnly}>Actions</span></th>
            </tr></thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.userId} data-testid={`week-row-${p.userId}`}>
                  <td className={s.nm}><button type="button" className={s.personName} onClick={() => onOpenDay(p.userId, week)}>{PEOPLE_NAMES[p.userId]}</button></td>
                  {isVisible("days") ? <td className={cx(s.right, tabularNumbers)}>{p.week.daysWorked}</td> : null}
                  <td className={cx(s.right, tabularNumbers)}>{hm(p.week.attendance)}</td>
                  {isVisible("breaks") ? <td className={cx(s.right, tabularNumbers)}>{hmSigned(-p.week.breakDeduction)}</td> : null}
                  <td className={cx(s.right, tabularNumbers)} data-testid="week-paid"><b style={{ fontWeight: 650 }}>{hm(p.week.paid)}</b></td>
                  {isVisible("jobs") ? <td className={cx(s.right, tabularNumbers)}>{hm(p.week.labour)}</td> : null}
                  {ticksOn ? <td className={s.tk} data-testid="week-day-flags"><DayTicksCell flags={p.dayFlags} /></td> : null}
                  <td className={s.ck}><span className={s.cellWarn}>{p.week.flags.map((f) => FLAG_TEXT[f] ?? f).join("; ")}</span></td>
                  <td className={s.ap} data-testid="week-state">{approval(p)}</td>
                  <td className={s.actCol}>{actions(p)}</td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        ) : (
          <ul className={s.cardList}>
            {people.map((p) => (
              <li key={p.userId} className={s.rowCard} data-testid={`week-row-${p.userId}`}>
                <div className={s.rowCardHead}><button type="button" className={s.personName} onClick={() => onOpenDay(p.userId, week)}>{PEOPLE_NAMES[p.userId]}</button>{approval(p)}</div>
                <dl className={s.rowCardGrid}>
                  {isVisible("days") ? <div><dt>Days</dt><dd className={tabularNumbers}>{p.week.daysWorked}</dd></div> : null}
                  <div><dt>Clocked</dt><dd className={tabularNumbers}>{hm(p.week.attendance)}</dd></div>
                  {isVisible("breaks") ? <div><dt>Breaks</dt><dd className={tabularNumbers}>{hmSigned(-p.week.breakDeduction)}</dd></div> : null}
                  <div><dt>Paid</dt><dd className={tabularNumbers} data-testid="week-paid"><b>{hm(p.week.paid)}</b></dd></div>
                  {isVisible("jobs") ? <div><dt>On jobs</dt><dd className={tabularNumbers}>{hm(p.week.labour)}</dd></div> : null}
                </dl>
                {ticksOn ? <div><DayTicksCell flags={p.dayFlags} /></div> : null}
                {p.week.flags.length ? <span className={s.cellWarn}>{p.week.flags.map((f) => FLAG_TEXT[f] ?? f).join("; ")}</span> : null}
                <div className={s.rowCardAct}>{actions(p)}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
      <p className={s.hint} data-testid="rounding-note">{ROUNDING_NOTE}</p>
      <p className={s.hint}>
        Hours only: no rates or pay. Paid = clock in to clock out minus unpaid breaks. Overtime is not worked out: it is the days someone ticked Overtime.
        {approver ? " After a correction an approved week shows “Changed since approval” until you approve it again." : ""}
        {" Day ticks: the days with a saved tick and the paid hours on those days, per type (flags only, no rates)."}
        {anySuggested ? " * suggested from the date, not saved yet, so not counted (save them on the sheet, or with Save suggested ticks)." : ""}
      </p>
    </>
  );
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
   Sheets
   ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function TimeField({ label, date, time, zone, setDate, setTime, setZone, ambiguous, error }: { label: string; date: string; time: string; zone: "BST" | "GMT" | ""; setDate: (v: string) => void; setTime: (v: string) => void; setZone: (v: "BST" | "GMT" | "") => void; ambiguous: boolean; error: string | null }) {
  return (
    <fieldset className={s.timeGroup}>
      <legend className={s.timeLegend}>{label}</legend>
      <div className={s.timeRow}>
        <Field label="Date"><Input type="date" aria-label={`${label} date`} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Time"><Input type="time" aria-label={`${label} time`} value={time} onChange={(e) => setTime(e.target.value)} data-testid={`${label.toLowerCase()}-time`} /></Field>
      </div>
      {ambiguous ? <Field label="BST or GMT"><Select aria-label={`${label} BST or GMT`} value={zone} onChange={(e) => setZone(e.target.value as "BST" | "GMT" | "")}><option value="">BST or GMT?</option><option value="BST">BST (first time)</option><option value="GMT">GMT (second time)</option></Select></Field> : null}
      {error ? <p className={s.fieldErr} role="status">{error}</p> : null}
    </fieldset>
  );
}

function useLocal(initialDate: string, initialTime = "") {
  const [date, setDate] = useState(initialDate);
  const [time, setTime] = useState(initialTime);
  const [zone, setZone] = useState<"BST" | "GMT" | "">("");
  const p = localTimeProblem(date, time, zone);
  return { date, time, zone, setDate, setTime, setZone, ...p };
}

const CLOCK_ACTIONS = [{ value: "in", label: "Clock in" }, { value: "out", label: "Clock out" }, { value: "break_start", label: "Break start" }, { value: "break_end", label: "Break end" }] as const;

function ClockSheet({ date, existing, onClose, onSave }: { date: string; existing: AttendanceEvent | null; onClose: () => void; onSave: (what: string) => void }) {
  const [action, setAction] = useState<string>(existing && existing.action !== "void" ? existing.action : "out");
  const when = useLocal(existing ? localDateOf(existing.at) : date, existing ? localTimeOf(existing.at) : "");
  const [reason, setReason] = useState("");
  const removing = action === "void";
  const ok = clockCorrectionOk({ removing, at: when.at, reason });
  return (
    <Sheet open size="sm" title={existing ? "Correct a clock record" : "Add a missing clock record"} description="The original stays on record. Once the week is approved only an admin can change it." onClose={onClose} closeButton={false} testId="clock-sheet"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ok} data-testid="clock-save" onClick={() => onSave(removing ? "The clock record would be removed (kept on record)." : `The ${ACTION_LABEL[action].toLowerCase()} record would be ${existing ? "corrected" : "added"}.`)}>Save</Button></>}>
      <Field label="What"><Select value={action} onChange={(e) => setAction(e.target.value)}>{CLOCK_ACTIONS.filter((a) => !existing || a.value === existing.action).map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}{existing ? <option value="void">Remove this record</option> : null}</Select></Field>
      {removing ? null : <TimeField label="Time" {...when} error={when.error} />}
      <Field label="Reason" hint={`${REASON_MIN} to ${REASON_MAX} characters`}><Textarea value={reason} maxLength={REASON_MAX} onChange={(e) => setReason(e.target.value)} placeholder="For example: forgot to clock out" data-testid="clock-reason" /></Field>
    </Sheet>
  );
}

function LabourSheet({ date, existing, onClose, onSave }: { date: string; existing: LabourSession | null; onClose: () => void; onSave: (what: string) => void }) {
  const [jobId, setJobId] = useState(existing?.job_id ?? "");
  const from = useLocal(existing ? localDateOf(existing.started_at) : date, existing ? localTimeOf(existing.started_at) : "");
  const to = useLocal(existing?.ended_at ? localDateOf(existing.ended_at) : date, existing?.ended_at ? localTimeOf(existing.ended_at) : "");
  const [reason, setReason] = useState("");
  const toNeeded = !existing || existing.ended_at !== null || to.time !== "";
  const ok = labourEditOk({ jobId, from: from.at, to: to.at, toNeeded, reason });
  return (
    <Sheet open size="sm" title={existing ? "Correct job time" : "Add job time"} description="For time you forgot to Start or Stop. Once the week is approved only an admin can change it." onClose={onClose} closeButton={false} testId="labour-sheet"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ok} data-testid="labour-save" onClick={() => onSave(`The job time would be ${existing ? "corrected" : "added"}.`)}>Save</Button></>}>
      <Field label="Job"><Select value={jobId} disabled={Boolean(existing)} onChange={(e) => setJobId(e.target.value)}><option value="">Choose a job</option>{Object.entries(JOB_INFO).map(([id, j]) => <option key={id} value={id}>{j.job_no} · {j.customer}</option>)}</Select></Field>
      <TimeField label="From" {...from} error={from.error} />
      <TimeField label="To" {...to} error={toNeeded ? to.error : null} />
      <Field label="Reason" hint={`${REASON_MIN} to ${REASON_MAX} characters`}><Textarea value={reason} maxLength={REASON_MAX} onChange={(e) => setReason(e.target.value)} placeholder="For example: deburring, forgot to press Start" data-testid="labour-reason" /></Field>
    </Sheet>
  );
}

function RemoveSheet({ session, onClose, onRemove }: { session: LabourSession; onClose: () => void; onRemove: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <Sheet open size="sm" title="Remove job time" description="Why remove this job time? (3 to 500 characters)" onClose={onClose} closeButton={false} testId="remove-sheet"
      footer={<><Button onClick={onClose}>Cancel</Button><Button className={s.dangerBtn} disabled={!reasonOk(reason)} data-testid="remove-confirm" onClick={onRemove}>Remove job time</Button></>}>
      <p className={s.hint}>{JOB_INFO[session.job_id]?.job_no}, {clockTime(session.started_at)}–{session.ended_at ? clockTime(session.ended_at) : "now"}. It is kept on record.</p>
      <Field label="Reason"><Textarea value={reason} maxLength={REASON_MAX} onChange={(e) => setReason(e.target.value)} data-testid="remove-reason" /></Field>
    </Sheet>
  );
}

function ApproveSheet({ person, name, week, onClose, onApprove }: { person: PersonWeekRow; name: string; week: string; onClose: () => void; onApprove: () => void }) {
  const [note, setNote] = useState("");
  const w = person.week;
  const snap = approvalSnapshot(w);
  return (
    <Sheet open size="sm" title={`Approve ${name}'s week`} description={`Week of ${dayHeading(week)}. You are approving these figures as they are now; if anything changes before you press Approve, you will be asked to look again.`} onClose={onClose} closeButton={false} testId="approve-sheet"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" data-testid="approve-confirm" onClick={onApprove}>Approve</Button></>}>
      <dl className={s.defs}>
        <dt>Days worked</dt><dd className={tabularNumbers}>{w.daysWorked}</dd>
        <dt>Paid</dt><dd className={tabularNumbers}>{hm(w.paid)}</dd>
        <dt>Breaks deducted</dt><dd className={tabularNumbers}>{hm(w.breakDeduction)}</dd>
        <dt>Stored with the approval</dt><dd className={tabularNumbers}>{snap.paid_minutes} paid minutes</dd>
      </dl>
      {person.dayFlags.days.some((d) => DAY_FLAG_KEYS.some((k) => d.flags[k])) ? <div data-testid="approve-day-flags"><p className={s.clockLabel}>Day ticks</p><DayTicksCell flags={person.dayFlags} /></div> : null}
      {w.flags.length ? <p className={cx(s.callout, s.calloutWarn)}>Check first: {w.flags.map((f) => FLAG_TEXT[f] ?? f).join("; ")}.</p> : null}
      <p className={cx(s.callout, s.calloutNeutral)} data-testid="approve-sync-warning">{SYNC_WARNING}</p>
      <Field label="Note" optional><Textarea value={note} maxLength={REASON_MAX} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" /></Field>
    </Sheet>
  );
}

function PayrollSheet({ week, onClose, onExport }: { week: string; onClose: () => void; onExport: (f: string) => void }) {
  const [from, setFrom] = useState(week);
  const [count, setCount] = useState(1);
  const period = VALID_DATE.test(from) ? payrollWeeks(from, count) : null;
  return (
    <Sheet open size="sm" title="Payroll export" description="Everyone's paid hours, one row per person per week (Monday to Sunday), with days worked, overtime ticks and approval. Hours only: no rates or pay." onClose={onClose} closeButton={false} testId="payroll-sheet"
      footer={<><Button onClick={onClose}>Cancel</Button><Button disabled={!period} onClick={() => onExport("CSV")} data-testid="payroll-csv">Export CSV</Button><Button variant="primary" disabled={!period} onClick={() => onExport("Excel file")} data-testid="payroll-xlsx">Export Excel</Button></>}>
      <div className={s.formGrid}>
        <Field label="First week (any day in it)"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} data-testid="payroll-from" /></Field>
        <Field label="Number of weeks"><Input type="number" min={1} max={PAYROLL_MAX_WEEKS} value={count} onChange={(e) => setCount(Number(e.target.value))} data-testid="payroll-weeks" /></Field>
      </div>
      <p className={s.hint} data-testid="payroll-range" style={{ fontSize: 13.5 }}>{period ? `${period.start} to ${period.end} (${period.weekStarts.length} week${period.weekStarts.length === 1 ? "" : "s"})` : "Choose a date."}</p>
    </Sheet>
  );
}
