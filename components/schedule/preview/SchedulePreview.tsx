"use client";

/**
 * BOUNDARY (Jobs / Schedule / Time / Workshop, Module 2, PREVIEW ONLY: nothing here is wired to anything).
 * Inputs: none from the server. Everything shown is fictional sample data (one made-up company, fictional people and customers, a fixed "now" of Mon 23/11/2026 10:30) held in this file, plus
 * the person's clicks. Outputs: a Machine Schedule look-and-feel prototype (status cards, the machine timeline with its lanes, bars, week navigation and legend, the Jobs on machines
 * table, the Machines table, the Book job, Booking, Machine, Example list and Actual use sheets) whose only state is LOCAL UI state. The "Who is looking" control in Preview controls
 * only changes which controls are drawn; it grants nothing. It contains NO Supabase, auth, fetch, route or storage call. No action reports success: every committing action (save a
 * machine, book a job, update a booking, Mark running, Mark complete, remove a booking, add example machines, "I've checked", change the company's Show / hide setting) answers with the
 * neutral "Preview only ... Nothing was saved." toast and nothing in the data changes. The real page has NO drag and drop: a booking is a button that opens its sheet (keyboard: Tab to it, Enter),
 * the week moves with Previous / Today / Next; this preview adds no drag and no keyboard shortcut the real page lacks.
 * Run-time imports from lib/ are the REAL pure functions (machine-schedule: finish, overlap, status, day plan, window maths; schedule-live: status card text, run bars; run-plan: unbooked run view;
 * machine-runs: live-use shapes and the paused warning; status-colours legend; org-settings: the real Show / hide list) and types. The rules that live inline in
 * app/(dashboard)/schedule/page.tsx are mirrored here and pinned to that source text by tests/unit/schedulePreview.test.ts.
 * v2 (owner-approved structure, STRUCTURAL-CHANGES-BRIEF items 4, 8, 10, 11): day columns are at least 90 px wide and the timeline scrolls sideways in its own named region; every booking and run bar always shows its
 * job number (cut short with an ellipsis, the full text is its title and accessible name); the machine card says "In use by ... since ..." once (the duplicated red in-use line is gone); one PreviewBar strip; the generic sentence
 * under the title is a tooltip and a screen-reader description of the title; the v4 type scale. Nothing was removed.
 * MUST NOT CHANGE: wording, roles, columns, buttons and who may use which control mirror today's page (Admin, Office, Workshop and Viewer may open it; Admin and Office manage machines and
 * remove bookings; Workshop also books and updates; Viewer only looks; only Admin may book over another job). Do not wire this to real data, a session or an action, do not add a control
 * the real page lacks, keep every control on a 48 px hit area. Delete the four preview files (this component and its .module.css, app/(dashboard)/schedule/preview/page.tsx,
 * tests/unit/schedulePreview.test.ts) to remove it completely.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, FormEvent } from "react";
import {
  Button, Checkbox, EmptyState, FailedState, Field, Input, LoadingState, PageHeader, Popover, PreviewBar, ScrollTable, SegmentedControl, Select, Sheet, StatusBadge, Switch, Textarea,
  ToastProvider, cx, premiumTokens, srOnly, tabularNumbers, typeScale, useToast,
} from "@/components/ui/premium";
import type { StatusTone } from "@/components/ui/premium";
import { fmtDate, fmtDateText, fmtDayDateTime } from "@/lib/dates";
import { DEFAULT_WORKING_HOURS, workStartOn } from "@/lib/company";
import { DEMO_MACHINES } from "@/lib/job-worksheet";
import {
  CLEAR_START_MAX_STEPS, DEFAULT_WORKING_DAYS, WEEKDAY_OPTIONS, addDaysToDate, bookedNotStarted, computeFinish, dayHoursSplit, estimateMinutes, findOverlaps, formatDayPlan, formatHours,
  formatHoursClock, formatMinutes, inputEnd, isWorkingDay, isoWeekday, liveLeftText, localDateString, machineStatus, mondayOf, nextClearStart, parseLocalDate, planSegments, rowMinutes,
  runClock, scheduleAll, splitClearShift, startAfterBooking, storedEnd, timeOf, toLocalInputValue, validateDayPlan, windowFor, worksOn,
} from "@/lib/machine-schedule";
import type { Booking, BookingSegment, BookingStatus, DayPlanCheck, DayPlanRow, Machine, ScheduleJob, ScheduledBooking } from "@/lib/machine-schedule";
import { indexInUse, pausedWarningText } from "@/lib/machine-runs";
import type { InUseRow, PausedRow } from "@/lib/machine-runs";
import { COLUMN_TABLES } from "@/lib/org-settings";
import { personName } from "@/lib/people";
import type { PeopleMap } from "@/lib/people";
import { unbookedRunView } from "@/lib/run-plan";
import type { RunPlan } from "@/lib/run-plan";
import {
  runBarLabel, runBarsFor, runningForText, runRows, sinceText, statusCardText, uncoveredParts, unbookedFinishText, unbookedLeftText, unbookedRunning,
} from "@/lib/schedule-live";
import type { RunBar, RunRow } from "@/lib/schedule-live";
import { DESK_QUERY } from "@/lib/shell-status";
import { SCHEDULE_ORDER, SCHEDULE_STATES, scheduleLegendText } from "@/lib/status-colours";
import { workingHoursLabel } from "@/lib/working-hours";
import s from "./SchedulePreview.module.css";

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
   Rules mirrored from app/(dashboard)/schedule/page.tsx (pinned to its source by tests/unit/schedulePreview.test.ts)
   ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

export type Role = "admin" | "office" | "workshop" | "viewer";
export const ROLES: Role[] = ["admin", "office", "workshop", "viewer"];
/** Admin and office add, edit and (with the booking sheet) remove machines and bookings. */
export const canManageMachines = (role: Role) => role === "admin" || role === "office";
/** Admin, office and workshop book jobs and update bookings. A viewer only looks. */
export const canBook = (role: Role) => canManageMachines(role) || role === "workshop";
/** Only an admin may book over another job (the database refuses everyone else); it is recorded with a reason of 3 to 500 characters. */
export const canOverride = (role: Role) => role === "admin";
export const OVERRIDE_REASON_MIN = 3;
export const OVERRIDE_REASON_MAX = 500;
/** The page lets all four roles in (RoleGate allowed={["admin", "office", "workshop", "viewer"]}). */
export const SCHEDULE_ROLES_ALLOWED: Role[] = ["admin", "office", "workshop", "viewer"];

export const STATUS_LABEL: Record<BookingStatus, string> = { booked: "Booked", running: "Running", complete: "Complete" };
/** The status words on screen: a booking past its start with no run started reads "Booked, not started" (still booked and blocking). */
export const bookingStatusLabel = (b: ScheduledBooking, now: Date) => (bookedNotStarted(b, now) ? "Booked, not started" : STATUS_LABEL[b.status]);
/** A booking whose estimated finish is after its job's required date (end of that day) and that is not complete. */
export const afterRequiredDate = (b: Pick<ScheduledBooking, "status" | "finish">, required: string) => Boolean(required) && b.status !== "complete" && b.finish > new Date(`${required}T23:59:59`);

export const MACHINE_NAME_NEEDED = "Enter a machine name.";
export const MACHINE_HOURS_RANGE = "Hours per working day must be between 0 and 16.";
export const MACHINE_DAYS_NEEDED = "Pick at least one working day.";
export type MachineForm = { name: string; type: string; hoursPerDay: string; workingDays: number[]; active: boolean };
export type MachineProblem = { field: "name" | "hours" | "days"; message: string };
/** The same three checks, in the same order, as submitMachine on the real page. */
export function validateMachine(f: MachineForm): MachineProblem | null {
  if (!f.name.trim()) return { field: "name", message: MACHINE_NAME_NEEDED };
  const h = Number(f.hoursPerDay);
  if (!(h > 0 && h <= 16)) return { field: "hours", message: MACHINE_HOURS_RANGE };
  if (!f.workingDays.length) return { field: "days", message: MACHINE_DAYS_NEEDED };
  return null;
}

export const BOOK_NEEDS_JOB = "Pick a job or enter a job number.";
export const BOOK_NEEDS_MACHINE = "Pick a machine.";
export const BOOK_NEEDS_HOURS = "Enter the estimated hours.";
export const BOOK_NEEDS_START = "Enter a start date and time.";
export const BOOKING_HOURS_NEGATIVE = "Hours must be zero or more.";
export const checkFirstText = (who: string | null | undefined) => `Check with ${who ?? "the operator"} first, then press "I've checked".`;
export const SPLIT_STATUS_ONLY = "The split by day edit doesn't add up, so it wasn't saved. Only the status changed.";
export const OVERRIDE_ONLY_ADMIN = "Only an admin can book over another job: pick a free time.";

export type BookInput = { jobId: string; manualJobNo: string; jobNo: string; hasMachine: boolean; hours: number; splitOn: boolean; splitOk: boolean; splitMessage: string; startValid: boolean; needsCheck: boolean; pauseOperator: string | null };
/** Submit checks of Book job, in the real order. Returns the first message, or null when the booking could be sent (it never is in this preview). */
export function validateBooking(i: BookInput): string | null {
  if (!i.jobNo) return BOOK_NEEDS_JOB;
  if (!i.hasMachine) return BOOK_NEEDS_MACHINE;
  if (!(i.hours > 0)) return BOOK_NEEDS_HOURS;
  if (i.splitOn && !i.splitOk) return i.splitMessage;
  if (!i.splitOn && !i.startValid) return BOOK_NEEDS_START;
  if (i.needsCheck) return checkFirstText(i.pauseOperator);
  return null;
}
/** The real Book button's disabled rule. */
export function bookDisabled(i: { saving: boolean; needsCheck: boolean; splitOn: boolean; splitOk: boolean; overlaps: number; isAdmin: boolean; override: boolean; reason: string }) {
  return i.saving || i.needsCheck || (i.splitOn && !i.splitOk) || (i.overlaps > 0 && (!i.isAdmin || !i.override || i.reason.trim().length < OVERRIDE_REASON_MIN));
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
   Sample data (fictional). "now" is fixed so the screen reads the same every time.
   ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

export const COMPANY_NAME = "Fernhill Engineering Ltd";
export const NOW = new Date(2026, 10, 23, 10, 30, 0);
/** A moment `off` days from Mon 23/11/2026 at h:m (local time), as the ISO string a booking stores. */
const at = (off: number, h = 8, m = 0) => new Date(2026, 10, 23 + off, h, m, 0).toISOString();
const dstr = (off: number) => localDateString(new Date(2026, 10, 23 + off));

export const MACHINES: Machine[] = [
  { id: "m-mill1", name: "Mill 1", type: "CNC vertical mill", hoursPerDay: 8, workingDays: DEFAULT_WORKING_DAYS, active: true },
  { id: "m-mill2", name: "Mill 2", type: "CNC vertical mill", hoursPerDay: 8, workingDays: DEFAULT_WORKING_DAYS, active: true },
  { id: "m-lathe1", name: "Lathe 1", type: "CNC lathe", hoursPerDay: 8, workingDays: DEFAULT_WORKING_DAYS, active: true },
  { id: "m-lathe2", name: "Lathe 2", type: "Manual lathe", hoursPerDay: 8, workingDays: DEFAULT_WORKING_DAYS, active: true },
  { id: "m-saw", name: "Saw", type: "Band saw", hoursPerDay: 6, workingDays: [1, 2, 3, 4], active: true },
  { id: "m-grind", name: "Surface grinder", type: "Retired in October", hoursPerDay: 8, workingDays: DEFAULT_WORKING_DAYS, active: false },
];

export const JOBS: ScheduleJob[] = [
  { id: "j-431", jobNo: "J-0431", description: "Pump housing, 12 off", customer: "Brightwell Pumps", dateRequired: dstr(4), estimatedHours: 14 },
  { id: "j-430", jobNo: "J-0430", description: "Roller, 6 off", customer: "Northgate Valves", dateRequired: dstr(2), estimatedHours: 6 },
  { id: "j-433", jobNo: "J-0433", description: "Bracket, 40 off", customer: "Marlow Hydraulics", dateRequired: dstr(7), estimatedHours: 12 },
  { id: "j-436", jobNo: "J-0436", description: "Manifold plate", customer: "Kestrel Marine", dateRequired: dstr(9), estimatedHours: 10 },
  { id: "j-434", jobNo: "J-0434", description: "Spindle sleeve", customer: "Brightwell Pumps", dateRequired: dstr(4), estimatedHours: 9 },
  { id: "j-438", jobNo: "J-0438", description: "Drive shaft, 8 off", customer: "Northgate Valves", dateRequired: dstr(2), estimatedHours: 20 },
  { id: "j-435", jobNo: "J-0435", description: "Bar cut-off, 200 pieces", customer: "Marlow Hydraulics", dateRequired: dstr(2), estimatedHours: 5 },
  { id: "j-437", jobNo: "J-0437", description: "Cover plate, 30 off", customer: "Kestrel Marine", dateRequired: dstr(3), estimatedHours: 7 },
  { id: "j-440", jobNo: "J-0440", description: "Valve body, 4 off", customer: "Northgate Valves", dateRequired: dstr(8), estimatedHours: 8 },
  { id: "j-439", jobNo: "J-0439", description: "Clamp ring, 20 off", customer: "Brightwell Pumps", dateRequired: dstr(11), estimatedHours: 8 },
  { id: "j-442", jobNo: "J-0442", description: "Spacer, 100 off", customer: "Marlow Hydraulics", dateRequired: dstr(10), estimatedHours: 4 },
  { id: "j-441", jobNo: "J-0441", description: "Hub, 2 off", customer: "Kestrel Marine", dateRequired: dstr(12), estimatedHours: null },
  { id: "j-429", jobNo: "J-0429", description: "Shaft, 25 off", customer: "Brightwell Pumps", dateRequired: dstr(-2), estimatedHours: 16, finishedAt: at(-3, 16, 0) },
  { id: "j-432", jobNo: "J-0432", description: "Flange, 6 off", customer: "Marlow Hydraulics", dateRequired: dstr(1), estimatedHours: 2 },
];

export const BOOKINGS: Booking[] = [
  { id: "b-1", machineId: "m-mill1", jobId: "j-431", jobNo: "J-0431", description: "Pump housing, 12 off", startAt: at(0, 8), estimatedHours: 14, hoursDone: 2.5, status: "running", notes: "Fixture 2 on the table. Second op after the 8 mm bore." },
  { id: "b-2", machineId: "m-mill1", jobId: "j-436", jobNo: "J-0436", description: "Manifold plate", startAt: at(2, 14), estimatedHours: 10, hoursDone: 0, status: "booked", notes: "" },
  { id: "b-3", machineId: "m-mill1", jobId: "j-439", jobNo: "J-0439", description: "Clamp ring, 20 off", startAt: at(8, 8), estimatedHours: 8, hoursDone: 0, status: "booked", notes: "" },
  { id: "b-4", machineId: "m-mill2", jobId: "j-433", jobNo: "J-0433", description: "Bracket, 40 off", startAt: at(-3, 8), estimatedHours: 12, hoursDone: 0, status: "booked", notes: "Material is in the rack by the door." },
  {
    id: "b-5", machineId: "m-mill2", jobId: "j-440", jobNo: "J-0440", description: "Valve body, 4 off", startAt: at(5, 8), estimatedHours: 8, hoursDone: 0, status: "booked", notes: "Weekend overtime agreed with the customer.",
    dayPlan: [{ date: dstr(5), start: "08:00", end: "14:00" }, { date: dstr(6), start: "08:00", end: "10:00" }],
  },
  { id: "b-6", machineId: "m-lathe1", jobId: "j-430", jobNo: "J-0430", description: "Roller, 6 off", startAt: at(0, 8), estimatedHours: 6, hoursDone: 3.5, status: "booked", notes: "Paused for the chuck jaws." },
  { id: "b-7", machineId: "m-lathe1", jobId: "j-434", jobNo: "J-0434", description: "Spindle sleeve", startAt: at(1, 8), estimatedHours: 9, hoursDone: 0, status: "booked", notes: "" },
  { id: "b-8", machineId: "m-lathe1", jobId: "j-429", jobNo: "J-0429", description: "Shaft, 25 off", startAt: at(-4, 8), estimatedHours: 16, hoursDone: 16, status: "complete", notes: "" },
  { id: "b-9", machineId: "m-lathe2", jobId: "j-438", jobNo: "J-0438", description: "Drive shaft, 8 off", startAt: at(1, 8), estimatedHours: 20, hoursDone: 0, status: "booked", notes: "Needs the steady rest." },
  { id: "b-10", machineId: "m-saw", jobId: "j-435", jobNo: "J-0435", description: "Bar cut-off, 200 pieces", startAt: at(1, 8), estimatedHours: 5, hoursDone: 0, status: "booked", notes: "" },
  { id: "b-11", machineId: "m-mill2", jobId: "j-432", jobNo: "J-0432", description: "Flange, 6 off", startAt: at(0, 8), estimatedHours: 2, hoursDone: 2, status: "complete", notes: "" },
  { id: "b-12", machineId: "m-saw", jobId: "j-442", jobNo: "J-0442", description: "Spacer, 100 off", startAt: at(8, 8), estimatedHours: 4, hoursDone: 0, status: "booked", notes: "" },
];

export const PEOPLE: PeopleMap = { "u-callum": "Callum Reeve", "u-tomas": "Tomas Whitcombe", "u-ngozi": "Ngozi Adeyemi", "u-harvey": "Harvey Lindqvist" };

export const IN_USE: InUseRow[] = [
  { run_id: "r-1", machine_id: "m-mill1", machine_name: "Mill 1", job_id: "j-431", job_no: "J-0431", booking_id: "b-1", operator_id: "u-callum", operator_name: "Callum Reeve", started_at: at(0, 8, 2), stale: false },
  { run_id: "r-3", machine_id: "m-lathe2", machine_name: "Lathe 2", job_id: "j-437", job_no: "J-0437", booking_id: null, operator_id: "u-ngozi", operator_name: "Ngozi Adeyemi", started_at: at(0, 9, 12), stale: false },
];
export const PAUSED: PausedRow[] = [
  { machine_id: "m-lathe1", paused_run_id: "run-p1", job_id: "j-430", job_no: "J-0430", operator_name: "Tomas Whitcombe", paused_by_name: null, paused_at: at(0, 9, 45) },
];
const RUNS_RAW = [
  { id: "r-1", machine_id: "m-mill1", job_id: "j-431", booking_id: "b-1", operator_id: "u-callum", started_at: at(0, 8, 2), ended_at: null, end_reason: null, jobs: { job_no: "J-0431" } },
  { id: "r-2", machine_id: "m-lathe1", job_id: "j-430", booking_id: "b-6", operator_id: "u-tomas", started_at: at(0, 8, 0), ended_at: at(0, 9, 45), end_reason: "paused", jobs: { job_no: "J-0430" } },
  { id: "r-3", machine_id: "m-lathe2", job_id: "j-437", booking_id: null, operator_id: "u-ngozi", started_at: at(0, 9, 12), ended_at: null, end_reason: null, jobs: { job_no: "J-0437" } },
  { id: "r-4", machine_id: "m-mill2", job_id: "j-432", booking_id: "b-11", operator_id: "u-harvey", started_at: at(0, 8, 0), ended_at: at(0, 10, 0), end_reason: "finished", jobs: { job_no: "J-0432" } },
];
export const RUNS: RunRow[] = runRows(RUNS_RAW);
/** Plan hours for a run that has no booking (job_machines), as run-plan reads them. */
export const RUN_PLAN = new Map<string, RunPlan>([["j-437:m-lathe2", { planHours: 7, hoursDone: 0 }]]);

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
   Preview chrome
   ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

export type Screen = "ready" | "loading" | "error" | "no-machines" | "no-bookings" | "live-error";
export const SCREENS: { v: Screen; label: string }[] = [
  { v: "ready", label: "Normal" }, { v: "loading", label: "Loading" }, { v: "error", label: "Failed to load" }, { v: "no-machines", label: "No machines yet" },
  { v: "no-bookings", label: "No bookings yet" }, { v: "live-error", label: "Live use failed to load" },
];
export const LOAD_ERROR = "Couldn't load the machine schedule.";
export const LIVE_ERROR_LEAD = "Live machine use may be out of date.";
export const LIVE_ERROR_DETAIL = "Who is on which machine couldn't be loaded.";
const titleCase = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const ROLE_OPTIONS = ROLES.map((r) => ({ value: r, label: titleCase(r) }));
const SPANS = [{ days: 7, label: "1 week" }, { days: 14, label: "2 weeks" }, { days: 28, label: "4 weeks" }];
const SPAN_OPTIONS = SPANS.map((o) => ({ value: String(o.days), label: o.label }));
const LABEL_COL = 160;
/** Narrowest a day column is drawn on any span (the 4 week span scrolls sideways instead of squeezing the bars). */
export const MIN_DAY_COL = 90;
/** Narrowest a bar is drawn (px): wide enough for "J-0431" cut short, so no bar is ever blank. */
export const MIN_BAR_PX = 44;
/** The page sentence under the title: generic, so it is the title's tooltip and screen-reader description, not a visible line. */
export const SCHEDULE_INTRO = "Book jobs onto machines and see when each machine is free.";
/** Narrowest a booking bar is drawn, as a share of its day cell (the real timeline's own floor). */
export const MIN_BAR_PERCENT = 12;
/** A booking remainder beside actual use is drawn as its own bar only from this share of the day cell (below it, the slim strip). */
export const MIN_PART_PERCENT = 30;
/** The real Show / hide list for this screen (lib/org-settings SCHEDULE_DISPLAY). */
export const SCHEDULE_COLUMNS = COLUMN_TABLES.find((t) => t.key === "schedule")!;
export const SCHEDULE_COLUMN_KEYS = SCHEDULE_COLUMNS.columns.map((c) => c.key);
export const columnScopeText = (own: boolean) => (own ? "Your own view on this device only. Everyone else, and the company setting, are not changed." : "Changes apply to everyone in this company.");
export const resetLabel = (own: boolean) => (own ? "Reset to the company view" : "Reset to default (show all columns)");

function useMedia(query: string, fallback: boolean): boolean {
  return useSyncExternalStore((cb) => { const m = window.matchMedia(query); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); }, () => window.matchMedia(query).matches, () => fallback);
}
const dash = <span className={s.none} aria-label="None">-</span>;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
/** A bar's position inside its day cell: never narrower than MIN_BAR_PX; beside actual use it starts after that block's own floor so the two never overlap. */
export function barStyle(left: number, width: number, besideRun = false): CSSProperties {
  if (besideRun && left > 0) return { left: `min(max(${left}%, ${MIN_BAR_PX + 2}px), calc(100% - ${MIN_BAR_PX}px))`, width: `max(calc(${left + width}% - max(${left}%, ${MIN_BAR_PX + 2}px)), ${MIN_BAR_PX}px)` };
  return { left: `min(${left}%, calc(100% - ${MIN_BAR_PX}px))`, width: `max(${width}%, ${MIN_BAR_PX}px)` };
}
const oneLine = (t: string) => t.replace(/\n/g, ", ");

type Sel = { kind: "booking"; id: string } | { kind: "run"; bar: RunBar; label: string } | { kind: "book"; jobId?: string; machineId?: string } | { kind: "machine"; machine: Machine | null } | { kind: "template" };

export default function SchedulePreview() { return <ToastProvider placement="bottom-right"><Inner /></ToastProvider>; }

function Inner() {
  const toast = useToast();
  const [role, setRole] = useState<Role>("admin");
  const [screen, setScreen] = useState<Screen>("ready");
  const [sel, setSelState] = useState<Sel | null>(null);
  const [span, setSpan] = useState(14);
  const [startDate, setStartDate] = useState(() => mondayOf(NOW));
  const [showFinished, setShowFinished] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);
  const [timer, setTimer] = useState<number | null>(null);
  const wide = useMedia(DESK_QUERY, true);
  const setSel = useCallback((x: Sel | null) => { setSelState(x); if (x) toast.clear(); }, [toast]);
  useEffect(() => () => { if (timer) window.clearTimeout(timer); }, [timer]);

  const own = !canManageMachines(role);
  const isVisible = (key: string) => (SCHEDULE_COLUMNS.columns.find((c) => c.key === key)?.locked ? true : !hidden.includes(key));
  const preview = useCallback((detail: string) => toast.show({ title: "Preview only", detail: `${detail} Nothing was saved.` }), [toast]);
  const loaded = screen !== "loading" && screen !== "error";
  const machines = useMemo(() => (screen === "no-machines" || !loaded ? [] : MACHINES), [screen, loaded]);
  const bookings = useMemo(() => (screen === "no-machines" || screen === "no-bookings" || !loaded ? [] : BOOKINGS), [screen, loaded]);
  const jobs = useMemo(() => (loaded ? JOBS : []), [loaded]);
  const inUse = useMemo(() => (screen === "ready" || screen === "no-bookings" ? (screen === "no-bookings" ? [] : IN_USE) : []), [screen]);
  const runs = useMemo(() => (screen === "ready" ? RUNS : []), [screen]);
  const paused = useMemo(() => (screen === "ready" ? PAUSED : []), [screen]);
  const liveError = screen === "live-error" ? LIVE_ERROR_DETAIL : null;

  const activeMachines = useMemo(() => machines.filter((m) => m.active), [machines]);
  const liveByMachine = useMemo(() => indexInUse(inUse).byMachine, [inUse]);
  const everything = useMemo(() => scheduleAll(bookings, machines, NOW), [bookings, machines]);
  const scheduled = useMemo(() => everything.filter((b) => b.status !== "complete"), [everything]);
  const shown = showFinished ? everything : scheduled;
  const finishedCount = everything.length - scheduled.length;
  const statuses = useMemo(() => activeMachines.map((m) => machineStatus(m, scheduled, NOW)), [activeMachines, scheduled]);
  const tableRows = useMemo(() => [...shown].sort((a, b) => a.start.getTime() - b.start.getTime()), [shown]);
  const runningRows = useMemo(() => unbookedRunning(inUse, bookings), [inUse, bookings]);
  const unbookedViews = useMemo(() => new Map(runningRows.filter((r) => !r.booking_id).map((r) => [r.machine_id, unbookedRunView(r.started_at, RUN_PLAN.get(`${r.job_id}:${r.machine_id}`), machines.find((m) => m.id === r.machine_id), NOW)])), [runningRows, machines]);
  const liveLeftOf = useCallback((b: ScheduledBooking): string | null => {
    const run = b.status === "complete" ? null : inUse.find((r) => r.booking_id === b.id);
    const clock = run ? runClock(run.started_at, b, NOW) : null;
    return clock && clock.leftMinutes !== null ? liveLeftText(clock.leftMinutes) : null;
  }, [inUse]);
  const requiredDate = useCallback((b: ScheduledBooking) => jobs.find((j) => (b.jobId && j.id === b.jobId) || j.jobNo === b.jobNo)?.dateRequired || "", [jobs]);
  const selected = sel?.kind === "booking" ? everything.find((b) => b.id === sel.id) ?? null : null;

  const retry = () => { setScreen("loading"); setTimer(window.setTimeout(() => { setScreen("ready"); toast.show({ title: "Preview only", detail: "Sample schedule shown again. No server was contacted." }); }, 700)); };
  const resetAll = () => { setScreen("ready"); setRole("admin"); setSelState(null); setSpan(14); setStartDate(mondayOf(NOW)); setShowFinished(false); setHidden([]); toast.clear(); };
  const pickScreen = (v: Screen) => { toast.clear(); setSelState(null); setScreen(v); };
  const setColumn = (key: string, on: boolean) => {
    setHidden((h) => (on ? h.filter((k) => k !== key) : [...new Set([...h, key])]));
    if (!own) preview("This would change what everyone in the company sees on this screen.");
  };

  return (
    <div className={cx(premiumTokens, s.root)} data-testid="schedule-preview" data-role={role}>
      <PreviewBar data-testid="preview-bar" controls={
        <Popover label="Preview controls" title="Preview controls" variant="quiet" size="sm" data-testid="dock-toggle">
          <div className={s.dock}>
            <p className={s.dockNote}>Not part of Tolra. Sample data as of Mon 23/11/2026 10:30; states are simulated, nothing is granted and no request is made.</p>
            <p className={s.dockLabel}>Who is looking (changes the drawing only)</p>
            <SegmentedControl label="Role" value={role} options={ROLE_OPTIONS} size="sm" onChange={(v) => { setRole(v); setSelState(null); toast.clear(); }} />
            <p className={s.dockLabel}>Screen state</p>
            <div className={s.dockStates} role="group" aria-label="Screen state">
              {SCREENS.map((x) => <button key={x.v} type="button" aria-pressed={screen === x.v} className={s.dockBtn} onClick={() => pickScreen(x.v)}>{x.label}</button>)}
            </div>
            <Button size="sm" variant="secondary" onClick={resetAll}>Reset preview</Button>
          </div>
        </Popover>
      } />
      <PageHeader
        title={<span title={SCHEDULE_INTRO} data-testid="schedule-title">Machine Schedule</span>}
        description={<span className={srOnly}>{SCHEDULE_INTRO}</span>}
        actions={
          <>
            <ColumnsPopover own={own} isVisible={isVisible} setColumn={setColumn} hidden={hidden} reset={() => { setHidden([]); if (!own) preview("This would show every item again for everyone in the company."); }} />
            {canBook(role) ? <Button variant="primary" data-testid="new-booking" disabled={!activeMachines.length} onClick={() => setSel({ kind: "book" })}>New booking</Button> : null}
          </>
        }
      />

      {liveError && loaded ? (
        <p role="alert" data-testid="schedule-live-error" className={cx(s.callout, s.calloutWarn)}>
          <span className={s.calloutText}><span className={s.calloutTitle}>{LIVE_ERROR_LEAD}</span> {liveError}</span>
          <Button size="sm" variant="secondary" className={s.calloutAct} onClick={retry}>Retry</Button>
        </p>
      ) : null}

      {screen === "loading" ? <LoadingState label="Loading the machine schedule" rows={6} /> : null}
      {screen === "error" ? <FailedState headingLevel={2} title={LOAD_ERROR} detail="Nothing on this page is shown until it loads, so an empty list is never mistaken for an empty shop." onRetry={retry} /> : null}

      {loaded ? (
        <>
          <MachineCards statuses={statuses} live={liveByMachine} unbooked={unbookedViews} isVisible={isVisible} />
          <div className={s.showRow}>
            <label>
              <Checkbox checked={showFinished} onChange={(e) => setShowFinished(e.target.checked)} data-testid="show-finished" />
              Show finished{finishedCount ? ` (${finishedCount})` : ""}
            </label>
          </div>
          <Timeline
            machines={activeMachines} bookings={shown} runs={runs} span={span} setSpan={setSpan} startDate={startDate} setStartDate={setStartDate} isVisible={isVisible}
            wide={wide} liveLeftOf={liveLeftOf} onSelect={(b) => setSel({ kind: "booking", id: b.id })} onSelectRun={(bar, label) => setSel({ kind: "run", bar, label })}
          />
          <JobsTable
            rows={tableRows} running={runningRows} unbooked={unbookedViews} canBook={canBook(role)} wide={wide} isVisible={isVisible} liveLeftOf={liveLeftOf} requiredDate={requiredDate}
            jobs={jobs} onOpen={(id) => setSel({ kind: "booking", id })} onBookIt={(jobId, machineId) => setSel({ kind: "book", jobId, machineId })}
          />
          <MachinesTable machines={machines} manage={canManageMachines(role)} wide={wide} isVisible={isVisible} onEdit={(m) => setSel({ kind: "machine", machine: m })} onAdd={() => setSel({ kind: "machine", machine: null })} onTemplate={() => setSel({ kind: "template" })} />
        </>
      ) : null}

      {sel?.kind === "book" ? (
        <BookSheet role={role} machines={activeMachines} jobs={jobs} scheduled={scheduled} paused={paused} initialJobId={sel.jobId} initialMachineId={sel.machineId} onClose={() => setSelState(null)}
          onBooked={(jobNo, machine) => { setSelState(null); preview(`${jobNo} would be booked onto ${machine}.`); }} />
      ) : null}
      {selected ? (
        <BookingSheet key={selected.id} role={role} booking={selected} liveLeft={liveLeftOf(selected)} required={requiredDate(selected)} onClose={() => setSelState(null)}
          onDone={(detail) => { setSelState(null); preview(detail); }} />
      ) : null}
      {sel?.kind === "run" ? <RunSheet bar={sel.bar} label={sel.label} onClose={() => setSelState(null)} /> : null}
      {sel?.kind === "machine" ? <MachineSheet machine={sel.machine} onClose={() => setSelState(null)} onSaved={(name, adding) => { setSelState(null); preview(`${name} would be ${adding ? "added" : "updated"}.`); }} /> : null}
      {sel?.kind === "template" ? <TemplateSheet onClose={() => setSelState(null)} onAdd={(n) => { setSelState(null); preview(n === 1 ? "1 machine would be added." : `${n} machines would be added.`); }} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
   Show / hide (the real ColumnToggle, as a shared popover of switches; locked items stay as plain "Always shown" rows)
   ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function ColumnsPopover({ own, isVisible, setColumn, hidden, reset }: { own: boolean; isVisible: (k: string) => boolean; setColumn: (k: string, on: boolean) => void; hidden: string[]; reset: () => void }) {
  return (
    <Popover label="Show / hide" title={`${SCHEDULE_COLUMNS.label}: show / hide`} variant="secondary" data-testid="columns-toggle">
      <p className={s.hint} data-testid="column-scope" style={{ maxWidth: 280, marginBottom: 4 }}>{columnScopeText(own)}</p>
      <div>
        {SCHEDULE_COLUMNS.columns.map((c) => c.locked
          ? <p key={c.key} className={s.hint} style={{ display: "flex", justifyContent: "space-between", minHeight: 32, alignItems: "center", margin: 0 }}><span>{c.label}</span><span>Always shown</span></p>
          : <Switch key={c.key} label={c.label} checked={isVisible(c.key)} onChange={(on) => setColumn(c.key, on)} data-testid={`col-${c.key}`} />)}
      </div>
      <div style={{ paddingTop: 6 }}><Button size="sm" variant="secondary" disabled={!hidden.length} onClick={reset}>{resetLabel(own)}</Button></div>
    </Popover>
  );
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
   Machine status cards
   ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function MachineCards({ statuses, live, unbooked, isVisible }: { statuses: ReturnType<typeof machineStatus>[]; live: Map<string, InUseRow>; unbooked: Map<string, ReturnType<typeof unbookedRunView>>; isVisible: (k: string) => boolean }) {
  if (!statuses.length || !isVisible("status-cards")) return null;
  return (
    <section aria-labelledby="status-h">
      <h2 id="status-h" className={s.srOnly}>Machine status</h2>
      <ul className={s.cards}>
        {statuses.map((st) => {
          const l = live.get(st.machine.id);
          const text = statusCardText(st, l, NOW, unbooked.get(st.machine.id));
          const red = text.inUse || st.busy;
          const tone: StatusTone = red ? "danger" : "ok";
          return (
            <li key={st.machine.id} className={cx(s.card, text.inUse && s.cardInUse)} data-testid="machine-status" data-machine={st.machine.name} data-in-use={text.inUse ? "true" : undefined}>
              <div className={s.cardHead}>
                <div>
                  <h3 className={cx(typeScale.card, s.cardName)}>{st.machine.name}</h3>
                  {st.machine.type && isVisible("machine-type") ? <p className={cx(typeScale.secondary, s.cardType)}>{st.machine.type}</p> : null}
                </div>
                <StatusBadge tone={tone} className={s.pill}><span data-testid="machine-status-pill">{text.pill}</span></StatusBadge>
              </div>
              {text.staleNote ? <p className={s.cardStale}>{text.staleNote}</p> : null}
              <p className={s.cardLine} data-testid={l ? "machine-in-use" : undefined}>{text.body}</p>
              {isVisible("next-free") ? (
                <p className={s.cardNext}>Next free: <b>{text.nextFree}</b>{st.next ? <> · Next job {st.next.jobNo} from {fmtDayDateTime(st.nextStart ?? st.next.start)}</> : null}</p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
   Machine timeline (the lanes). Click or Enter on a bar opens it. There is no drag and drop on the real page and none here.
   ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

type Segment = { booking: ScheduledBooking; left: number; width: number; first: boolean; planned?: BookingSegment; outOfHours?: boolean; from?: Date; to?: Date };

function Timeline({ machines, bookings, runs, span, setSpan, startDate, setStartDate, isVisible, liveLeftOf, onSelect, onSelectRun, wide }: {
  wide: boolean; machines: Machine[]; bookings: ScheduledBooking[]; runs: RunRow[]; span: number; setSpan: (n: number) => void; startDate: Date; setStartDate: (d: Date) => void; isVisible: (k: string) => boolean;
  liveLeftOf: (b: ScheduledBooking) => string | null; onSelect: (b: ScheduledBooking) => void; onSelectRun: (bar: RunBar, label: string) => void;
}) {
  const days = useMemo(() => Array.from({ length: span }, (_, i) => addDays(startDate, i)), [span, startDate]);
  const todayIndex = days.findIndex((d) => sameDay(d, NOW));
  const nowFraction = Math.min(1, Math.max(0, (NOW.getHours() + NOW.getMinutes() / 60 - 8) / 8));
  const minCol = MIN_DAY_COL;
  const cols = `${LABEL_COL}px repeat(${days.length}, minmax(${minCol}px, 1fr))`;

  function segmentsFor(machine: Machine, day: Date, dayIdx: number): Segment[] {
    const { start, end } = windowFor(day, machine);
    const total = end.getTime() - start.getTime();
    if (total <= 0) return [];
    const dayKey = localDateString(day);
    return bookings
      .filter((b) => b.machine.id === machine.id && (b.segments?.length ? b.segments.some((x) => x.date === dayKey) : worksOn(day, machine, b.start)))
      .flatMap((b) => {
        const planned = b.segments?.find((x) => x.date === dayKey);
        let from = Math.max((planned ?? b).start.getTime(), start.getTime());
        let to = Math.min((planned ?? { end: b.finish }).end.getTime(), end.getTime());
        const outOfHours = planned ? planned.start.getTime() < start.getTime() || planned.end.getTime() > end.getTime() : undefined;
        if (to <= from) {
          if (!planned) return [];
          from = to = planned.end.getTime() <= start.getTime() ? start.getTime() : end.getTime();
        }
        const firstVisibleDay = b.segments?.length
          ? days.findIndex((d) => b.segments!.some((x) => x.date === localDateString(d)))
          : days.findIndex((d) => { const w = windowFor(d, machine); return worksOn(d, machine, b.start) && Math.min(b.finish.getTime(), w.end.getTime()) > Math.max(b.start.getTime(), w.start.getTime()); });
        const width = Math.max(MIN_BAR_PERCENT, ((to - from) / total) * 100);
        const left = Math.min(((from - start.getTime()) / total) * 100, 100 - width);
        return [{ booking: b, left, width, first: dayIdx === firstVisibleDay, planned, outOfHours, from: new Date(from), to: new Date(to) }];
      });
  }
  const bookingTitle = (seg: Segment, machine: Machine) =>
    `${seg.booking.jobNo} on ${machine.name}\nStart ${fmtDayDateTime(seg.booking.start)}\nEst. finish ${fmtDayDateTime(seg.booking.finish)}\n${liveLeftOf(seg.booking) ?? `${formatHours(seg.booking.hoursLeft)} left`} (${seg.booking.status})${seg.planned ? `\nSplit by day: ${fmtDateText(seg.planned.date, { weekday: "short" })} ${seg.planned.from}-${seg.planned.to} (${formatMinutes(seg.planned.minutes)})${seg.outOfHours ? `, partly or wholly outside ${machine.name}'s hours (drawn at the edge of the day)` : ""}` : ""}`;
  const rangeLabel = `${fmtDateText(localDateString(days[0]))} - ${fmtDateText(localDateString(days[days.length - 1]), { year: true })}`;
  const legend = isVisible("legend");

  return (
    <section className={s.panel} aria-labelledby="tl-h" data-testid="timeline">
      <div className={cx(s.panelHead, s.tlHead)}>
        <div>
          <h2 id="tl-h" className={cx(typeScale.section, s.panelTitle)}>Machine timeline</h2>
          <p className={s.panelSub}><span className={tabularNumbers}>{rangeLabel}</span>.{legend ? <span className={s.legendText}> {scheduleLegendText()}</span> : null}</p>
        </div>
        <div className={s.panelControls}>
          <SegmentedControl label="Timeline length" value={String(span)} options={SPAN_OPTIONS} onChange={(v) => setSpan(Number(v))} data-testid="span" />
          <Button aria-label="Previous" onClick={() => setStartDate(addDays(startDate, -span))} data-testid="prev">Previous</Button>
          <Button onClick={() => setStartDate(mondayOf(NOW))} data-testid="today">Today</Button>
          <Button aria-label="Next" onClick={() => setStartDate(addDays(startDate, span))} data-testid="next">Next</Button>
        </div>
      </div>
      {!machines.length ? <p className={s.tlNoMachines} data-testid="no-machines-timeline">No machines to show. Add a machine first.</p> : !wide ? (
        <div className={s.agenda} data-testid="agenda">
          {machines.map((machine) => (
            <section key={machine.id} className={s.agMachine} aria-label={`${machine.name}, day by day`} data-testid="agenda-machine" data-machine={machine.name}>
              <header className={s.agHead}>
                <h3 className={s.agName}>{machine.name}</h3>
                {machine.type && isVisible("machine-type") ? <span className={s.tlType}>{machine.type}</span> : null}
              </header>
              <ol className={s.agDays}>
                {days.map((day, i) => {
                  const working = isWorkingDay(day, machine);
                  const segments = segmentsFor(machine, day, i);
                  const actual = runBarsFor(runs, machine, day, NOW);
                  const isToday = i === todayIndex;
                  const empty = !segments.length && !actual.length;
                  return (
                    <li key={i} className={cx(s.agDay, isToday && s.agToday, !working && s.agOff)} data-testid="agenda-day" data-today={isToday ? "true" : undefined} aria-current={isToday ? "date" : undefined}>
                      <h4 className={s.agDate}>{fmtDateText(localDateString(day), { weekday: "short" })}{!working ? <span className={s.agTag}>Not normally worked</span> : null}</h4>
                      <div className={s.agItems}>
                        {isToday && isVisible("now-marker") ? <p className={s.agNow} data-testid="agenda-now">Now, {timeOf(NOW)}</p> : null}
                        {segments.map((seg, k) => {
                          const done = seg.booking.status === "complete";
                          const running = !done && seg.booking.status === "running";
                          const word = done ? "Complete" : running ? "Running" : "Booked";
                          const state = done ? "complete" : running ? "running" : "booked";
                          const mins = seg.from && seg.to ? Math.round((seg.to.getTime() - seg.from.getTime()) / 60000) : 0;
                          const timeText = seg.planned ? `${seg.planned.from}-${seg.planned.to}, ${formatMinutes(seg.planned.minutes)}` : seg.from && seg.to ? `${timeOf(seg.from)}-${timeOf(seg.to)}, ${formatMinutes(mins)}` : "";
                          return (
                            <button key={`${seg.booking.id}-${k}`} type="button" data-booking-id={seg.booking.id} data-testid="agenda-booking" data-state={state} aria-label={`${word}. ${seg.booking.jobNo || "Booking"}. ${timeText}${seg.planned ? ". Split by day" : ""}${seg.outOfHours ? ". Partly or wholly outside the machine's hours" : ""}. ${oneLine(bookingTitle(seg, machine))}`}
                              onClick={() => onSelect(seg.booking)} className={cx(s.agItem, s[`s_${state}`])}>
                              <span className={s.agWord}>{word}</span>{" "}
                              <span className={s.agJob}>{seg.booking.jobNo || "Booking"}</span>{" "}
                              <span className={s.agWhen}>{timeText}{seg.planned ? ", split by day" : ""}{seg.outOfHours ? ", out of hours" : ""}</span>
                            </button>
                          );
                        })}
                        {actual.map((bar) => {
                          const word = bar.kind === "running" ? "Running" : bar.kind === "paused" ? "Paused" : "Finished";
                          const state = bar.kind === "running" ? "running" : bar.kind === "paused" ? "paused" : "complete";
                          const mins = Math.round((bar.to.getTime() - bar.from.getTime()) / 60000);
                          const who = personName(PEOPLE, bar.run.operator_id);
                          return (
                            <button key={bar.run.id} type="button" data-testid="agenda-run" data-run-id={bar.run.id} data-kind={bar.kind} aria-label={`Actual use: ${word}. ${bar.run.job_no || "Run"}. ${timeOf(bar.from)}-${bar.open ? "now" : timeOf(bar.to)}, ${formatMinutes(mins)}, ${who}${bar.outOfHours ? ". Partly or wholly outside the machine's hours" : ""}. ${runBarLabel(bar, machine.name, PEOPLE, NOW)}`}
                              onClick={() => onSelectRun(bar, runBarLabel(bar, machine.name, PEOPLE, NOW))} className={cx(s.agItem, s.agRun, s[`s_${state}`])}>
                              <span className={s.agWord}>Actual use: {word}</span>{" "}
                              <span className={s.agJob}>{bar.run.job_no || "Run"}</span>{" "}
                              <span className={s.agWhen}>{timeOf(bar.from)}-{bar.open ? "now" : timeOf(bar.to)}, {formatMinutes(mins)}, {who}{bar.outOfHours ? ", out of hours" : ""}</span>
                            </button>
                          );
                        })}
                        {empty && working ? <p className={s.agFree}>Free</p> : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      ) : (
        <div className={s.tlScroll} role="region" aria-label="Machine timeline, scrolls sideways" tabIndex={0}>
          <div className={s.tlGrid} style={{ minWidth: LABEL_COL + days.length * minCol, ["--cols" as string]: cols } as CSSProperties}>
            <div className={cx(s.tlRow, s.tlHeadRow)}>
              <div className={s.tlLabel}>Machine</div>
              {days.map((day, i) => {
                const weekend = day.getDay() === 0 || day.getDay() === 6;
                const isToday = i === todayIndex;
                return (
                  <div key={i} data-testid="day-header" data-today={isToday ? "true" : undefined} className={cx(s.tlDay, weekend && s.tlWeekend, isToday && s.tlToday)} aria-current={isToday ? "date" : undefined}>
                    <span className={s.tlDayName}>{day.toLocaleDateString("en-GB", { weekday: "short" })}</span>
                    <span className={s.tlDayDate}>{fmtDateText(localDateString(day))}</span>
                  </div>
                );
              })}
            </div>
            <div style={{ position: "relative" }} className={s.tlNowPad}>
              {machines.map((machine) => (
                <div key={machine.id} className={s.tlRow} data-testid="lane" data-machine={machine.name}>
                  <div className={s.tlLabel}>
                    <p className={s.tlMachine} title={machine.name}>{machine.name}</p>
                    {machine.type && isVisible("machine-type") ? <span className={s.tlType}>{machine.type}</span> : null}
                  </div>
                  {days.map((day, i) => {
                    const working = isWorkingDay(day, machine);
                    const segments = segmentsFor(machine, day, i);
                    const actual = runBarsFor(runs, machine, day, NOW);
                    const dayName = fmtDateText(localDateString(day), { weekday: "long", numberAs: "full" });
                    return (
                      <div key={i} className={cx(s.tlLane, !working && s.tlOff)} title={working ? `${machine.name}, ${dayName}${segments.length ? "" : ": free"}` : `${dayName}: not normally worked`}>
                        {segments.flatMap((seg) => {
                          // with no machine use in this cell the booking is always a full, labelled bar (v2: no blank slim strips). Beside actual use, a remainder too narrow to read (under 30% of the day) is not drawn as a bar of its own:
                          // the booking keeps its slim strip along the top (as when it is wholly covered) and its job number is on the machine-use bar above it.
                          const parts = uncoveredParts(seg.left, seg.width, actual.map((bar) => ({ left: bar.usedLeft, width: bar.usedWidth }))).filter((part) => !actual.length || part.width >= MIN_PART_PERCENT);
                          if (!parts.length) return [{ seg: { ...seg, first: false }, partIdx: 0, covered: true }];
                          return parts.map((part, partIdx) => ({ seg: { ...seg, left: part.left, width: part.width, first: seg.first && partIdx === 0 }, partIdx, covered: false }));
                        }).map(({ seg, partIdx, covered }) => {
                          const done = seg.booking.status === "complete";
                          const running = !done && seg.booking.status === "running";
                          const state = done ? "complete" : running ? "running" : "booked";
                          // the accessible name starts with exactly the words drawn on the bar (WCAG label in name), then the full description (which is also the title)
                          const drawn = covered ? "" : [
                            isVisible("running-badge") && seg.first && running ? "Running" : isVisible("running-badge") && seg.first && done ? "Complete" : "",
                            isVisible("bar-labels") ? seg.booking.jobNo || "Booking" : "",
                            isVisible("bar-labels") && seg.planned ? `${seg.planned.from}-${seg.planned.to} ${formatMinutes(seg.planned.minutes)}${seg.outOfHours ? " (out of hours)" : ""}` : "",
                          ].filter(Boolean).join(" ");
                          const label = covered ? `${seg.booking.jobNo} on ${machine.name}, hidden under machine use (${seg.booking.status})` : `${drawn ? `${drawn}. ` : ""}${oneLine(bookingTitle(seg, machine))}`;
                          return (
                            <button key={`${seg.booking.id}-${partIdx}`} type="button" data-booking-id={seg.booking.id} data-covered={covered ? "true" : undefined} data-testid="booking-bar" data-state={state}
                              aria-label={label} title={bookingTitle(seg, machine)} data-plan-date={seg.planned?.date} data-out-of-hours={seg.outOfHours ? "true" : undefined}
                              onClick={() => onSelect(seg.booking)} className={cx(s.bar, s[`s_${state}`], covered && s.covered, seg.outOfHours && s.ooh)} style={barStyle(seg.left, seg.width, !covered && actual.length > 0)}>
                              {covered ? null : (
                                <span className={s.barText}>
                                  {isVisible("running-badge") && seg.first && running ? <><span className={s.barWord}>Running</span>{" "}</> : null}
                                  {isVisible("running-badge") && seg.first && done ? <><span className={s.barWord}>Complete</span>{" "}</> : null}
                                  {!isVisible("bar-labels") ? null : <><span className={s.barJob} data-testid="bar-label">{seg.booking.jobNo || "Booking"}</span>{" "}</>}
                                  {isVisible("bar-labels") && seg.planned ? <small className={s.barSub}>{seg.planned.from}-{seg.planned.to} {formatMinutes(seg.planned.minutes)}{seg.outOfHours ? " (out of hours)" : ""}</small> : null}
                                </span>
                              )}
                            </button>
                          );
                        })}
                        {actual.map((bar) => {
                          const label = runBarLabel(bar, machine.name, PEOPLE, NOW);
                          const word = bar.kind === "running" ? "Running" : bar.kind === "paused" ? "Paused" : "Finished";
                          const state = bar.kind === "running" ? "running" : bar.kind === "paused" ? "paused" : "complete";
                          return (
                            <button key={bar.run.id} type="button" data-testid="run-bar" data-run-id={bar.run.id} data-state={bar.open ? "open" : "ended"} data-kind={bar.kind} data-from={timeOf(bar.from)} data-to={timeOf(bar.to)}
                              aria-label={`${label}${bar.outOfHours ? ` (partly or wholly outside ${machine.name}'s hours, drawn at the edge of the day)` : ""}`} title={label}
                              onClick={() => onSelectRun(bar, label)} className={cx(s.bar, s.run, s[`s_${state}`], bar.outOfHours && s.ooh)} style={{ left: `min(${bar.left}%, calc(100% - ${MIN_BAR_PX}px))`, width: `max(${bar.width}%, ${MIN_BAR_PX}px)` }}>
                              {bar.marks.map((m) => <span key={m} aria-hidden="true" className={s.runMark} style={{ left: `${m}%` }} />)}
                              <span className={s.barText}>
                                {isVisible("running-badge") ? <><span className={s.barWord}>{word}</span>{" "}</> : null}
                                {isVisible("bar-labels") ? <span className={s.barJob} data-testid="bar-label">{bar.run.job_no || "Run"}</span> : null}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              ))}
              {todayIndex >= 0 && isVisible("now-marker") ? (
                <div data-testid="now-marker" className={s.tlNow} aria-hidden="true" style={{ left: `calc(${LABEL_COL}px + (100% - ${LABEL_COL}px) * ${(todayIndex + nowFraction) / days.length})` }}>
                  <span data-testid="now-marker-label" className={s.tlNowTag} style={(todayIndex + nowFraction) / days.length > 0.9 ? { right: 4 } : { left: 4 }}>Now</span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
      {legend ? (
        <div className={s.panelBody}>
          <ul className={s.legend} data-testid="schedule-legend" aria-label="Colour legend">
            {SCHEDULE_ORDER.map((state) => (
              <li key={state} data-state={state}>
                <span aria-hidden="true" className={cx(s.swatch, state === "free" && s.swatchFree, state !== "free" && s[`s_${state}`])} />
                {SCHEDULE_STATES[state].label}
              </li>
            ))}
            <li><span aria-hidden="true" className={cx(s.swatch, s.swatchOff)} /> Non-working day</li>
          </ul>
        </div>
      ) : <div style={{ height: 14 }} />}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
   Jobs on machines
   ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function JobsTable({ rows, running, unbooked, canBook: book, wide, isVisible, liveLeftOf, requiredDate, jobs, onOpen, onBookIt }: {
  rows: ScheduledBooking[]; running: InUseRow[]; unbooked: Map<string, ReturnType<typeof unbookedRunView>>; canBook: boolean; wide: boolean; isVisible: (k: string) => boolean;
  liveLeftOf: (b: ScheduledBooking) => string | null; requiredDate: (b: ScheduledBooking) => string; jobs: ScheduleJob[]; onOpen: (id: string) => void; onBookIt: (jobId: string, machineId: string) => void;
}) {
  if (!isVisible("jobs-table")) return null;
  const left = isVisible("hours-left");
  const empty = !rows.length && !running.length;
  const hoursLeftOf = (b: ScheduledBooking) => (liveLeftOf(b)
    ? <span className={s.hoursLeft} data-testid="live-hours-left"><b style={{ fontWeight: 650 }}>{liveLeftOf(b)}</b><span className={s.whenSub}>{formatHoursClock(b.estimatedHours)} booked</span></span>
    : <span className={s.hoursLeft}><b style={{ fontWeight: 650 }}>{formatHours(b.hoursLeft)}</b><span className={s.whenSub}>of {formatHours(b.estimatedHours)}</span></span>);
  return (
    <section className={cx(s.panel, s.tbl)} aria-labelledby="jobs-h" data-testid="jobs-table">
      <div className={s.panelHead}><h2 id="jobs-h" className={cx(typeScale.section, s.panelTitle)}>Jobs on machines</h2></div>
      {empty ? <p className={s.tlNoMachines} data-testid="jobs-empty">No jobs booked onto machines yet.</p> : wide ? (
        <ScrollTable label="Jobs on machines, table">
          <thead><tr><th scope="col">Job</th><th scope="col">Machine</th><th scope="col">Start</th><th scope="col">Est. finish</th>{left ? <th scope="col">Hours left</th> : null}<th scope="col">Status</th><th scope="col">Required</th><th scope="col" className={s.actCol}><span className={s.srOnly}>Action</span></th></tr></thead>
          <tbody>
            {running.map((r) => {
              const req = jobs.find((j) => j.id === r.job_id)?.dateRequired || "";
              const view = r.booking_id ? undefined : unbooked.get(r.machine_id);
              return (
                <tr key={`run-${r.run_id}`} className={s.unbooked} data-testid="running-unbooked" data-job-id={r.job_id}>
                  <td><span className={s.job}>{r.job_no || "—"}</span></td>
                  <td>{r.machine_name}</td>
                  <td><DayTime value={r.started_at} /></td>
                  <td data-testid="unbooked-finish">{view ? unbookedFinishText(view) : "-"}</td>
                  {left ? <td data-testid="unbooked-left">{view ? unbookedLeftText(view) : "-"}</td> : null}
                  <td><div className={s.statusCell}><StatusBadge tone="danger">Running now (not booked)</StatusBadge><span className={s.statusNote}>by {r.operator_name ?? "—"} since {sinceText(r.started_at, NOW)}{view?.clock ? `, ${runningForText(view.clock.elapsedMinutes)}` : ""}</span></div></td>
                  <td>{req ? fmtDate(req) : dash}</td>
                  <td className={s.actCol}>{book ? <Button size="sm" onClick={() => onBookIt(r.job_id, r.machine_id)} aria-label={`Book it, ${r.job_no} on ${r.machine_name}`}>Book it</Button> : null}</td>
                </tr>
              );
            })}
            {rows.map((b) => {
              const req = requiredDate(b);
              const late = afterRequiredDate(b, req);
              return (
                <tr key={b.id} className={b.status === "complete" ? s.done : undefined} data-testid="job-row" data-booking-id={b.id}>
                  <td><div className={s.jobCell}><span className={s.job}>{b.jobNo || "-"}</span><span className={s.jobDesc}>{b.description}</span></div></td>
                  <td>{b.machine.name}</td>
                  <td><DayTime value={b.start} /></td>
                  <td><span className={s.when}><DayTime value={b.finish} />{late ? <StatusBadge tone="danger" className={s.late}>After required date</StatusBadge> : null}</span></td>
                  {left ? <td>{hoursLeftOf(b)}</td> : null}
                  <td><StatusBadge tone={b.status === "complete" ? "ok" : b.status === "running" ? "progress" : bookedNotStarted(b, NOW) ? "warn" : "neutral"}>{bookingStatusLabel(b, NOW)}</StatusBadge></td>
                  <td>{req ? fmtDate(req) : dash}</td>
                  <td className={s.actCol}><Button size="sm" onClick={() => onOpen(b.id)} aria-label={`${book ? "Update" : "View"} ${b.jobNo} on ${b.machine.name}`}>{book ? "Update" : "View"}</Button></td>
                </tr>
              );
            })}
          </tbody>
        </ScrollTable>
      ) : (
        <ul className={s.cardList}>
          {running.map((r) => {
            const req = jobs.find((j) => j.id === r.job_id)?.dateRequired || "";
            const view = r.booking_id ? undefined : unbooked.get(r.machine_id);
            return (
              <li key={`run-${r.run_id}`} className={cx(s.rowCard, s.rowCardUn)} data-testid="running-unbooked">
                <div className={s.rowCardHead}><span className={s.job}>{r.job_no || "—"}</span><StatusBadge tone="danger">Running now (not booked)</StatusBadge></div>
                <p className={s.statusNote} style={{ margin: 0 }}>by {r.operator_name ?? "—"} since {sinceText(r.started_at, NOW)}{view?.clock ? `, ${runningForText(view.clock.elapsedMinutes)}` : ""}</p>
                <dl className={s.rowCardGrid}>
                  <div><dt>Machine</dt><dd>{r.machine_name}</dd></div>
                  <div><dt>Start</dt><dd><DayTime value={r.started_at} /></dd></div>
                  <div><dt>Est. finish</dt><dd>{view ? unbookedFinishText(view) : "-"}</dd></div>
                  {left ? <div><dt>Hours left</dt><dd>{view ? unbookedLeftText(view) : "-"}</dd></div> : null}
                  <div><dt>Required</dt><dd>{req ? fmtDate(req) : "-"}</dd></div>
                </dl>
                {book ? <div className={s.rowCardAct}><Button size="sm" onClick={() => onBookIt(r.job_id, r.machine_id)}>Book it</Button></div> : null}
              </li>
            );
          })}
          {rows.map((b) => {
            const req = requiredDate(b);
            const late = afterRequiredDate(b, req);
            return (
              <li key={b.id} className={s.rowCard} data-testid="job-row" data-booking-id={b.id}>
                <div className={s.rowCardHead}>
                  <div className={s.jobCell}><span className={s.job}>{b.jobNo || "-"}</span><span className={s.jobDesc}>{b.description}</span></div>
                  <StatusBadge tone={b.status === "complete" ? "ok" : b.status === "running" ? "progress" : bookedNotStarted(b, NOW) ? "warn" : "neutral"}>{bookingStatusLabel(b, NOW)}</StatusBadge>
                </div>
                <dl className={s.rowCardGrid}>
                  <div><dt>Machine</dt><dd>{b.machine.name}</dd></div>
                  <div><dt>Start</dt><dd><DayTime value={b.start} /></dd></div>
                  <div><dt>Est. finish</dt><dd><DayTime value={b.finish} />{late ? <><br /><StatusBadge tone="danger" className={s.late}>After required date</StatusBadge></> : null}</dd></div>
                  {left ? <div><dt>Hours left</dt><dd>{liveLeftOf(b) ? `${liveLeftOf(b)} (${formatHoursClock(b.estimatedHours)} booked)` : `${formatHours(b.hoursLeft)} of ${formatHours(b.estimatedHours)}`}</dd></div> : null}
                  <div><dt>Required</dt><dd>{req ? fmtDate(req) : "-"}</dd></div>
                </dl>
                <div className={s.rowCardAct}><Button size="sm" onClick={() => onOpen(b.id)} aria-label={`${book ? "Update" : "View"} ${b.jobNo} on ${b.machine.name}`}>{book ? "Update" : "View"}</Button></div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function DayTime({ value }: { value: string | Date }) {
  const at = value instanceof Date ? value : new Date(value);
  return <span className={cx(s.when, tabularNumbers)}><span>{fmtDateText(at, { weekday: "short" })}</span><span className={s.whenSub}>{at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span></span>;
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
   Machines
   ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

const workingDaysText = (m: Machine) => WEEKDAY_OPTIONS.filter((d) => m.workingDays.includes(d.dow)).map((d) => d.label).join(", ");

function MachinesTable({ machines, manage, wide, isVisible, onEdit, onAdd, onTemplate }: { machines: Machine[]; manage: boolean; wide: boolean; isVisible: (k: string) => boolean; onEdit: (m: Machine) => void; onAdd: () => void; onTemplate: () => void }) {
  if (!isVisible("machines-table")) return null;
  const emptyNote = (
    <p className={s.tlNoMachines} data-testid="machines-empty">
      No machines yet.{manage ? <> Add your own, or <button type="button" className={s.linkBtn} onClick={onTemplate}>choose from an example list</button>.</> : null}
    </p>
  );
  return (
    <section id="machines" className={cx(s.panel, s.tbl)} aria-labelledby="machines-h" data-testid="machines-table">
      <div className={s.panelHead}>
        <h2 id="machines-h" className={cx(typeScale.section, s.panelTitle)}>Machines</h2>
        {manage ? <Button onClick={onAdd} data-testid="add-machine">Add machine</Button> : null}
      </div>
      {!machines.length ? emptyNote : wide ? (
        <ScrollTable label="Machines, table">
          <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col" className={s.numCol}>Hours per day</th><th scope="col">Working days</th><th scope="col">Active</th><th scope="col" className={s.actCol}><span className={s.srOnly}>Action</span></th></tr></thead>
          <tbody>
            {machines.map((m) => (
              <tr key={m.id} data-testid="machine-row">
                <td><span className={s.job}>{m.name}</span></td>
                <td>{m.type || dash}</td>
                <td className={cx(s.numCol, tabularNumbers)}>{m.hoursPerDay}</td>
                <td>{workingDaysText(m)}</td>
                <td><StatusBadge tone={m.active ? "ok" : "neutral"}>{m.active ? "Yes" : "No"}</StatusBadge></td>
                <td className={s.actCol}>{manage ? <Button size="sm" onClick={() => onEdit(m)} aria-label={`Edit ${m.name}`}>Edit</Button> : null}</td>
              </tr>
            ))}
          </tbody>
        </ScrollTable>
      ) : (
        <ul className={s.cardList}>
          {machines.map((m) => (
            <li key={m.id} className={s.rowCard} data-testid="machine-row">
              <div className={s.rowCardHead}><span className={s.job}>{m.name}</span><StatusBadge tone={m.active ? "ok" : "neutral"}>{m.active ? "Active: Yes" : "Active: No"}</StatusBadge></div>
              <dl className={s.rowCardGrid}>
                <div><dt>Type</dt><dd>{m.type || "-"}</dd></div>
                <div><dt>Hours per day</dt><dd className={tabularNumbers}>{m.hoursPerDay}</dd></div>
                <div><dt>Working days</dt><dd>{workingDaysText(m)}</dd></div>
              </dl>
              {manage ? <div className={s.rowCardAct}><Button size="sm" onClick={() => onEdit(m)} aria-label={`Edit ${m.name}`}>Edit</Button></div> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
   Sheets
   ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- */

function RunSheet({ bar, label, onClose }: { bar: RunBar; label: string; onClose: () => void }) {
  return (
    <Sheet open size="sm" title="Actual machine use" description="What happened on the machine (from Start, Pause and Finish). The booking, if any, stays the plan." onClose={onClose} closeButton={false} testId="run-sheet"
      footer={<Button variant="primary" onClick={onClose}>Close</Button>}>
      <div data-testid="run-detail" style={{ display: "grid", gap: 6, fontSize: 14 }}>
        <p style={{ margin: 0 }}>{label}</p>
        <p className={s.muted2} style={{ margin: 0 }}>Started {fmtDayDateTime(bar.run.started_at)}{bar.run.ended_at ? `, ended ${fmtDayDateTime(new Date(bar.run.ended_at))}` : ", still running"}.</p>
        {!bar.run.booking_id ? <p className={s.muted2} style={{ margin: 0 }}>Not booked on the schedule.</p> : null}
      </div>
    </Sheet>
  );
}

function TemplateSheet({ onClose, onAdd }: { onClose: () => void; onAdd: (n: number) => void }) {
  const [picks, setPicks] = useState<string[]>([]);
  return (
    <Sheet open size="sm" title="Example machine list" description="A starting template, not your shop's machines. Tick only the ones you have; you can rename them later." onClose={onClose} closeButton={false} testId="template-sheet"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!picks.length} data-testid="template-add" onClick={() => onAdd(picks.length)}>Add {picks.length || ""} selected</Button></>}>
      <div role="group" aria-label="Example machines">
        {DEMO_MACHINES.map((name) => (
          <label key={name} className={s.checkRow}>
            <Checkbox checked={picks.includes(name)} onChange={(e) => setPicks((p) => (e.target.checked ? [...p, name] : p.filter((x) => x !== name)))} />
            <span>{name}</span>
          </label>
        ))}
      </div>
    </Sheet>
  );
}

function MachineSheet({ machine, onClose, onSaved }: { machine: Machine | null; onClose: () => void; onSaved: (name: string, adding: boolean) => void }) {
  const [f, setF] = useState<MachineForm>({ name: machine?.name ?? "", type: machine?.type ?? "", hoursPerDay: String(machine?.hoursPerDay ?? 8), workingDays: machine?.workingDays ?? DEFAULT_WORKING_DAYS, active: machine?.active ?? true });
  const [problem, setProblem] = useState<MachineProblem | null>(null);
  useEffect(() => setProblem(null), [f]);
  const nameRef = useRef<HTMLInputElement>(null);
  const hoursRef = useRef<HTMLInputElement>(null);
  const daysRef = useRef<HTMLInputElement>(null);
  useEffect(() => { const t = window.setTimeout(() => nameRef.current?.focus(), 30); return () => window.clearTimeout(t); }, []);
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    const p = validateMachine(f);
    setProblem(p);
    if (p) { (p.field === "name" ? nameRef : p.field === "hours" ? hoursRef : daysRef).current?.focus(); return; }
    onSaved(f.name.trim(), !machine);
  };
  return (
    <Sheet open size="sm" title={machine ? "Edit machine" : "Add machine"} description="Working hours start at 08:00 on each working day." onClose={onClose} closeButton={false} testId="machine-sheet"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" data-testid="save-machine" onClick={() => submit()}>Save machine</Button></>}>
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        <Field label="Machine name" error={problem?.field === "name" ? problem.message : undefined}>
          <Input ref={nameRef} name="name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Machine name" />
        </Field>
        <Field label="Type" optional><Input name="type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })} placeholder="Type (e.g. CNC lathe)" /></Field>
        <Field label="Hours per working day" error={problem?.field === "hours" ? problem.message : undefined}>
          <Input ref={hoursRef} name="hours_per_day" type="number" inputMode="decimal" step="0.5" min="0.5" max="16" value={f.hoursPerDay} onChange={(e) => setF({ ...f, hoursPerDay: e.target.value })} />
        </Field>
        <fieldset className={s.group}>
          <legend className={s.groupLegend}>Working days</legend>
          <div className={s.dayChecks}>
            {WEEKDAY_OPTIONS.map((d, i) => (
              <label key={d.dow} className={s.check}>
                <Checkbox ref={i === 0 ? daysRef : undefined} checked={f.workingDays.includes(d.dow)} onChange={(e) => setF({ ...f, workingDays: e.target.checked ? [...f.workingDays, d.dow] : f.workingDays.filter((x) => x !== d.dow) })} />
                {d.label}
              </label>
            ))}
          </div>
          {problem?.field === "days" ? <p className={s.fieldErr} role="alert">{problem.message}</p> : null}
        </fieldset>
        <label className={s.checkRow}><Checkbox checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /><span>Active (shown on the schedule)</span></label>
      </form>
    </Sheet>
  );
}

/** Split by day: rows of a date, a start and an end time, the real day-plan maths, the running total against the estimate and the reason saving is blocked. */
function useSplit(initial: Booking["dayPlan"]) {
  const [on, setOn] = useState(Boolean(initial?.length));
  const [rows, setRows] = useState<DayPlanRow[]>(() => (initial?.length ? initial.map((e) => ({ date: e.date, start: e.start, end: inputEnd(e.end) })) : []));
  const endFor = (start: string, minutes: number) => { const [h, m] = start.split(":").map(Number); const t = Math.min(1440, h * 60 + m + Math.max(0, minutes)); return inputEnd(`${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`); };
  function toggle(next: boolean, estimatedHours: number, seedDate: string, seedTime: string) {
    setOn(next);
    if (next && !rows.length) { const minutes = estimatedHours > 0 ? estimateMinutes(estimatedHours) : 0; setRows([{ date: seedDate, start: seedTime, end: minutes ? endFor(seedTime, minutes) : "" }]); }
  }
  return { on, rows, setRows, toggle, endFor, check: (estimatedHours: number): DayPlanCheck => validateDayPlan(rows, estimatedHours) };
}
type Split = ReturnType<typeof useSplit>;

function SplitField({ split, estimatedHours, check }: { split: Split; estimatedHours: number; check: DayPlanCheck }) {
  const { on, rows, setRows } = split;
  const remaining = (estimatedHours > 0 ? estimateMinutes(estimatedHours) : 0) - check.minutes;
  const update = (i: number, patch: Partial<DayPlanRow>) => setRows(rows.map((r, k) => (k === i ? { ...r, ...patch } : r)));
  const addDay = () => {
    const last = rows[rows.length - 1];
    const date = last && parseLocalDate(last.date) ? addDaysToDate(last.date, 1) : "";
    const start = workStartOn(DEFAULT_WORKING_HOURS, date ? isoWeekday(date) : null);
    setRows([...rows, { date, start, end: remaining > 0 ? split.endFor(start, remaining) : "" }]);
  };
  return (
    <div className={s.toggleBox}>
      <label className={s.checkRow} style={{ marginLeft: -12 }}>
        <Checkbox checked={on} onChange={(e) => split.toggle(e.target.checked, estimatedHours, split.rows[0]?.date || localDateString(NOW), split.rows[0]?.start || "08:00")} data-testid="split-toggle" />
        <span><b style={{ fontWeight: 600 }}>Split by day</b> <span className={s.muted}>(choose the days and times yourself)</span></span>
      </label>
      {on ? (
        <div className={s.splitRows} data-testid="day-plan" style={{ paddingBottom: 10 }}>
          <p className={s.hint}>
            Each day is worked from its start to its end, weekends included. Normal working hours are {workingHoursLabel(DEFAULT_WORKING_HOURS)}: time outside them is marked out of hours but allowed.
            Work past midnight goes on the next day (22:00 to 00:00, then 00:00 to 06:00); an end of 00:00 means midnight. Leave this off to use the machine&apos;s working days.
          </p>
          {rows.map((row, i) => {
            const minutes = rowMinutes(row);
            const part = minutes && parseLocalDate(row.date) ? dayHoursSplit({ date: row.date, start: row.start, end: storedEnd(row.end) }, DEFAULT_WORKING_HOURS) : null;
            const n = i + 1;
            return (
              <div key={i} data-testid="day-plan-row">
                <div className={s.splitRow}>
                  <Field label={row.date && parseLocalDate(row.date) ? fmtDateText(row.date, { weekday: "short" }) : `Day ${n}`}><Input type="date" aria-label={`Day ${n} date`} value={row.date} onChange={(e) => update(i, { date: e.target.value })} /></Field>
                  <Field label="Start"><Input type="time" aria-label={`Day ${n} start`} value={row.start} onChange={(e) => update(i, { start: e.target.value })} /></Field>
                  <Field label="End"><Input type="time" aria-label={`Day ${n} end`} value={row.end} onChange={(e) => update(i, { end: e.target.value })} /></Field>
                  <Button aria-label={`Remove day ${n}`} onClick={() => setRows(rows.filter((_, k) => k !== i))} style={{ width: 48, padding: 0 }}>x</Button>
                </div>
                {part ? <p className={s.splitNote} data-testid="day-plan-row-summary"><b>{formatMinutes(part.total)}</b>: basic {formatMinutes(part.basic)}, out of hours {formatMinutes(part.outOfHours)}</p> : null}
                {part && !part.workingDay ? <p className={cx(s.splitNote, s.splitWarn)}>Not a normal working day: all of it is out of hours.</p>
                  : part && part.outOfHours > 0 ? <p className={cx(s.splitNote, s.splitWarn)}>Out of hours: {formatMinutes(part.outOfHours)} outside {workingHoursLabel(DEFAULT_WORKING_HOURS)}.</p> : null}
              </div>
            );
          })}
          <div className={s.splitFoot}>
            <Button onClick={addDay} disabled={rows.length >= 62}>Add day</Button>
            <p className={cx(s.splitTotal, check.ok ? s.splitOk : s.splitBad)} data-testid="day-plan-total" aria-live="polite">Total {formatMinutes(check.minutes)} of {estimatedHours > 0 ? formatMinutes(estimateMinutes(estimatedHours)) : "?"}</p>
          </div>
          {!check.ok ? <p role="alert" className={cx(s.callout, s.calloutWarn)} data-testid="day-plan-message">{check.message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function BookSheet({ role, machines, jobs, scheduled, paused, initialJobId, initialMachineId, onClose, onBooked }: {
  role: Role; machines: Machine[]; jobs: ScheduleJob[]; scheduled: ScheduledBooking[]; paused: PausedRow[]; initialJobId?: string; initialMachineId?: string; onClose: () => void; onBooked: (jobNo: string, machine: string) => void;
}) {
  const isAdmin = canOverride(role);
  const open = useMemo(() => jobs.filter((j) => !j.finishedAt), [jobs]);
  const [jobId, setJobId] = useState(() => (initialJobId && jobs.some((j) => j.id === initialJobId) ? initialJobId : ""));
  const [manualJobNo, setManualJobNo] = useState("");
  const [machineId, setMachineId] = useState(() => (initialMachineId && machines.some((m) => m.id === initialMachineId) ? initialMachineId : machines[0]?.id || ""));
  const [startTouched, setStartTouched] = useState(false);
  const [startOverride, setStartOverride] = useState("");
  const [hours, setHours] = useState(() => { const j = jobs.find((x) => x.id === initialJobId); return j?.estimatedHours != null ? String(j.estimatedHours) : ""; });
  const [notes, setNotes] = useState("");
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState("");
  const [checkedRun, setCheckedRun] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const split = useSplit(null);
  const toast = useToast();
  const summaryRef = useRef<HTMLParagraphElement>(null);

  const machine = machines.find((m) => m.id === machineId);
  const job = jobs.find((j) => j.id === jobId);
  const pause = machine ? (paused.find((r) => r.machine_id === machine.id && r.job_id !== jobId) ?? null) : null;
  const needsCheck = Boolean(pause && checkedRun !== pause.paused_run_id);
  const defaultStart = useMemo(() => (machine ? toLocalInputValue(startAfterBooking(machineStatus(machine, scheduled, NOW).nextFree, machine)) : ""), [machine, scheduled]);
  const start = startTouched ? startOverride : defaultStart;
  // a message about an earlier try goes away as soon as the person changes anything it could be about
  useEffect(() => setError(null), [jobId, manualJobNo, machineId, hours, start, split.on, checkedRun]);
  const hoursNum = Number(hours);
  const startDate = start ? new Date(start) : null;
  const validStart = Boolean(startDate) && !Number.isNaN(startDate!.getTime());
  const check = split.check(hoursNum);
  const planned = split.on && check.ok ? planSegments(check.plan) : null;
  const finish = planned?.length ? planned[planned.length - 1].end : !split.on && machine && validStart && hoursNum >= 0 && hours !== "" ? computeFinish(startDate!, hoursNum, machine) : null;
  const overlaps = machine && finish && (planned?.length || validStart) ? findOverlaps(machine, scheduled, planned?.[0]?.start ?? startDate!, finish, undefined, planned) : [];

  function pickJob(id: string) { setJobId(id); const next = jobs.find((j) => j.id === id); if (next?.estimatedHours != null) setHours(String(next.estimatedHours)); }
  function startAfterCurrent() {
    if (!machine) return;
    setNote(null);
    if (split.on) {
      const firstRow = split.rows.filter((r) => r.date).sort((a, b) => a.date.localeCompare(b.date))[0];
      const first = firstRow?.date;
      if (!first) { setNote("Add a date to a day first."); return; }
      const firstStart = firstRow.start || workStartOn(DEFAULT_WORKING_HOURS, isoWeekday(first));
      const found = splitClearShift(split.rows, first, firstStart, hoursNum, machine, scheduled);
      if (!found.ok) { setNote(found.reason === "invalid" ? found.message : `Couldn't find a free slot after ${CLEAR_START_MAX_STEPS} tries. Pick a start yourself.`); return; }
      if (found.shift <= 0) setNote("Already starts after the current booking.");
      else split.setRows(split.rows.map((r) => (r.date ? { ...r, date: addDaysToDate(r.date, found.shift) } : r)));
      return;
    }
    if (!startDate || !validStart) return;
    const clear = nextClearStart(startDate, machine, (t) => findOverlaps(machine, scheduled, t, computeFinish(t, hoursNum, machine)));
    if (!clear) { setNote(`Couldn't find a free slot after ${CLEAR_START_MAX_STEPS} tries. Pick a start yourself.`); return; }
    setStartTouched(true);
    setStartOverride(toLocalInputValue(clear));
  }
  function submit(e?: FormEvent) {
    e?.preventDefault();
    const jobNo = job?.jobNo || manualJobNo.trim();
    const problem = validateBooking({ jobId, manualJobNo, jobNo, hasMachine: Boolean(machine), hours: hoursNum, splitOn: split.on, splitOk: check.ok, splitMessage: check.ok ? "" : check.message, startValid: validStart, needsCheck, pauseOperator: pause?.operator_name ?? null });
    setError(problem);
    if (problem) { window.setTimeout(() => summaryRef.current?.focus(), 0); return; }
    onBooked(jobNo, machine!.name);
  }
  const disabled = bookDisabled({ saving: false, needsCheck, splitOn: split.on, splitOk: check.ok, overlaps: overlaps.length, isAdmin, override, reason });

  return (
    <Sheet open size="md" title="Book job onto machine" description="The finish time only counts the machine's working hours." onClose={onClose} closeButton={false} testId="book-sheet"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={disabled} data-testid="book-submit" onClick={() => submit()}>{overlaps.length ? "Book anyway" : "Book job"}</Button></>}>
      <form onSubmit={submit} noValidate style={{ display: "contents" }}>
        {error ? <p ref={summaryRef} tabIndex={-1} role="alert" className={s.summary} data-testid="book-error">{error}</p> : null}
        <Field label="Job">
          <Select value={jobId} onChange={(e) => pickJob(e.target.value)} data-testid="book-job">
            <option value="">Other (type job number)</option>
            {open.map((j) => <option key={j.id} value={j.id}>{j.jobNo}{j.description ? ` - ${j.description}` : ""}</option>)}
          </Select>
        </Field>
        {!jobId ? <Field label="Job number"><Input placeholder="Job number" value={manualJobNo} onChange={(e) => setManualJobNo(e.target.value)} data-testid="book-jobno" /></Field> : null}
        <Field label="Machine">
          <Select value={machineId} onChange={(e) => setMachineId(e.target.value)} data-testid="book-machine">{machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
        </Field>
        <div className={s.formGrid}>
          {split.on ? (
            <Field label="Start"><p className={s.muted2} style={{ margin: 0, minHeight: 40, display: "flex", alignItems: "center" }}>The first day&apos;s start time below</p></Field>
          ) : (
            <Field label="Start (next free slot by default)"><Input type="datetime-local" value={start} onChange={(e) => { setStartTouched(true); setStartOverride(e.target.value); }} data-testid="book-start" /></Field>
          )}
          <Field label={`Estimated hours${job?.estimatedHours != null ? " (setup + run from worksheet)" : ""}`}>
            <Input type="number" inputMode="decimal" min="0" step="0.5" value={hours} onChange={(e) => setHours(e.target.value)} data-testid="book-hours" />
          </Field>
        </div>
        {job?.estimatedHours == null && job ? <p className={s.hint}>No setup, run or quoted time on this job&apos;s worksheet, so enter the hours.</p> : null}
        <SplitField split={split} estimatedHours={hoursNum} check={check} />
        <Field label="Notes" optional><Textarea placeholder="Notes (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {finish ? <p className={s.estimate} data-testid="book-finish">Estimated finish: <b>{fmtDayDateTime(finish)}</b></p> : null}
        {pause && machine ? (
          <div data-testid="book-paused-warning" data-run-id={pause.paused_run_id} className={cx(s.callout, s.calloutWarn)} style={{ alignItems: "flex-start" }}>
            <p className={s.calloutText}>{pausedWarningText(pause, machine.name, NOW)}</p>
            {needsCheck ? (
              <Button size="sm" onClick={() => { setCheckedRun(pause.paused_run_id); toast.show({ title: "Preview only", detail: "The check would be recorded. Nothing was saved." }); }} data-testid="book-checked">{`I've checked, use the ${machine.name}`}</Button>
            ) : <p data-testid="book-paused-checked" className={s.calloutText} style={{ fontWeight: 650 }}>Checked (preview: not recorded).</p>}
          </div>
        ) : null}
        {overlaps.length ? (
          <div className={cx(s.callout, s.calloutWarn)} style={{ flexDirection: "column", alignItems: "stretch" }} data-testid="book-overlap">
            <p className={s.calloutTitle} style={{ margin: 0 }}>This overlaps {overlaps.map((b) => b.jobNo).join(", ")} on {machine?.name}.</p>
            <div><Button size="sm" onClick={startAfterCurrent} data-testid="start-after">Start after current booking</Button></div>
            {note ? <p role="status" style={{ margin: 0 }}>{note}</p> : null}
            {isAdmin ? (
              <div className={s.override}>
                <label className={s.checkRow}><Checkbox checked={override} onChange={(e) => setOverride(e.target.checked)} data-testid="book-override" /><span>Book anyway (admin; recorded with your reason)</span></label>
                {override ? <Textarea data-testid="override-reason" placeholder={`Why this booking goes over the other job (required, ${OVERRIDE_REASON_MIN} to ${OVERRIDE_REASON_MAX} characters)`} aria-label="Reason for booking over the other job" maxLength={OVERRIDE_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} /> : null}
              </div>
            ) : <p style={{ margin: 0 }}>{OVERRIDE_ONLY_ADMIN}</p>}
          </div>
        ) : null}
      </form>
    </Sheet>
  );
}

function BookingSheet({ role, booking, liveLeft, required, onClose, onDone }: { role: Role; booking: ScheduledBooking; liveLeft: string | null; required: string; onClose: () => void; onDone: (detail: string) => void }) {
  const edit = canBook(role);
  const del = canManageMachines(role);
  const isAdmin = canOverride(role);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [override, setOverride] = useState(false);
  const [reason, setReason] = useState("");
  const [hoursDone, setHoursDone] = useState(String(booking.hoursDone));
  const [estimated, setEstimated] = useState(String(booking.estimatedHours));
  const [status, setStatus] = useState<BookingStatus>(booking.status);
  const [notes, setNotes] = useState(booking.notes);
  const [error, setError] = useState<string | null>(null);
  const split = useSplit(booking.dayPlan);
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const check = split.check(Number(estimated));
  const blocked = split.on && !check.ok;
  const planEnded = Boolean(booking.segments?.length) && booking.status !== "complete" && booking.hoursLeft > 0 && booking.finish.getTime() < NOW.getTime();
  const name = `${booking.jobNo} on ${booking.machine.name}`;
  useEffect(() => setError(null), [hoursDone, estimated, split.on]);
  const fail = (m: string) => { setError(m); window.setTimeout(() => summaryRef.current?.focus(), 0); };

  function save() {
    const est = Number(estimated), done = Number(hoursDone);
    if (!(est >= 0) || !(done >= 0)) return fail(BOOKING_HOURS_NEGATIVE);
    if (split.on && !check.ok) return fail(check.message);
    onDone(`${name} would be updated.`);
  }
  function mark(next: "running" | "complete") {
    if (blocked) { onDone(`${SPLIT_STATUS_ONLY} ${name} would be marked ${next}.`); return; }
    onDone(`${name} would be marked ${next}.`);
  }
  const foot = !edit ? <Button variant="primary" onClick={onClose}>Close</Button> : confirmRemove ? (
    <div className={s.footSplit}>
      <p role="alert" className={s.confirmLine}>Remove this booking? This can&apos;t be undone.</p>
      <Button className={s.dangerBtn} data-testid="confirm-remove" onClick={() => onDone(`${name} would be removed.`)}>Yes, remove booking</Button>
      <Button onClick={() => setConfirmRemove(false)} data-testid="keep-booking">Keep booking</Button>
    </div>
  ) : (
    <div className={s.footSplit}>
      {del ? <Button className={s.dangerBtn} data-testid="remove-booking" onClick={() => setConfirmRemove(true)}>Remove booking</Button> : null}
      <span className={s.footGrow} />
      {/* Always both, in the same place whatever the status (a button that is not for this status is disabled, never moved or removed). */}
      <Button disabled={booking.status !== "booked"} data-testid="mark-running" onClick={() => mark("running")}>Mark running</Button>
      <Button disabled={booking.status === "complete"} data-testid="mark-complete" onClick={() => mark("complete")}>Mark complete</Button>
      <Button variant="primary" disabled={blocked} data-testid="save-booking" onClick={save}>Save</Button>
    </div>
  );
  return (
    <Sheet open size="md" title={name} description={booking.description || "Machine booking"} onClose={onClose} closeButton={false} testId="booking-sheet" footer={foot}>
      <dl className={s.defs}>
        <dt>Start</dt><dd><span className={tabularNumbers}>{fmtDayDateTime(booking.start)}</span></dd>
        <dt>Estimated finish</dt><dd><span className={tabularNumbers}>{fmtDayDateTime(booking.finish)}</span></dd>
        <dt>Hours left</dt><dd data-testid="booking-hours-left" className={tabularNumbers}>{liveLeft ?? formatHours(booking.hoursLeft)}</dd>
        {booking.dayPlan?.length ? <><dt>Split by day</dt><dd data-testid="booking-day-plan">{formatDayPlan(booking.dayPlan)}</dd></> : null}
        {required ? <><dt>Required</dt><dd className={tabularNumbers}>{fmtDate(required)}</dd></> : null}
      </dl>
      {planEnded ? <p className={cx(s.callout, s.calloutWarn)}>The planned days have passed and {formatHours(booking.hoursLeft)} are still left. A split doesn&apos;t move on by itself: add days to it, or turn Split by day off.</p> : null}
      {edit ? (
        <>
          {error ? <p ref={summaryRef} tabIndex={-1} role="alert" className={s.summary} data-testid="booking-error">{error}</p> : null}
          <div className={s.formGrid}>
            <Field label="Hours done"><Input type="number" inputMode="decimal" min="0" step="0.5" value={hoursDone} onChange={(e) => setHoursDone(e.target.value)} data-testid="hours-done" /></Field>
            <Field label="Estimated hours"><Input type="number" inputMode="decimal" min="0" step="0.5" value={estimated} onChange={(e) => setEstimated(e.target.value)} data-testid="estimated" /></Field>
          </div>
          <Field label="Status">
            <Select value={status} onChange={(e) => setStatus(e.target.value as BookingStatus)} data-testid="booking-status">
              {(Object.keys(STATUS_LABEL) as BookingStatus[]).map((k) => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}
            </Select>
          </Field>
          <SplitField split={split} estimatedHours={Number(estimated)} check={check} />
          <Field label="Notes" optional><Textarea placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          {isAdmin ? (
            <div className={s.override}>
              <label className={s.checkRow}><Checkbox checked={override} onChange={(e) => setOverride(e.target.checked)} data-testid="booking-override" /><span>If this change overlaps another job, book anyway (admin; recorded with your reason)</span></label>
              {override ? <Textarea data-testid="override-reason" placeholder={`Why this booking goes over the other job (required, ${OVERRIDE_REASON_MIN} to ${OVERRIDE_REASON_MAX} characters)`} aria-label="Reason for booking over the other job" maxLength={OVERRIDE_REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} /> : null}
            </div>
          ) : null}
        </>
      ) : <p className={s.muted2} style={{ margin: 0 }} data-testid="booking-readonly">Status: {bookingStatusLabel(booking, NOW)}. {booking.notes}</p>}
    </Sheet>
  );
}

/** Used by tests: where a person reads "Preview only" on the toast. */
export const PREVIEW_TOAST_TITLE = "Preview only";
