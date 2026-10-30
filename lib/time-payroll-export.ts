/**
 * The payroll export (E4d): every person's paid hours for a pay period, in one spreadsheet for the accountant / payroll, from the same
 * week figures the weekly hours review shows (lib/time-week.ts loadWeek, no new queries).
 *
 * One row per person per WEEK (Monday to Sunday), so a month is 4 or 5 rows each and every row is the week the approval covers. The period is
 * whole weeks: the first week and a number of weeks (1 to 5).
 *
 * Rounding: each figure is rounded ONCE, to the whole minute, with the review's own helper (roundMinutes) from the exact week sum, exactly as the
 * review's Paid / Clocked / Breaks and the approval snapshot do (Paid is worked out from the exact times, never from the rounded Clocked and Breaks),
 * then written as hours to 2 dp and as h:mm (the review's hm()), so this file and the screen never differ. Hours only: no rates or pay.
 *
 * Overtime is not computed (the JNR controller, Sun 18 Oct 2026): it is the paid hours on days with a SAVED Overtime tick, as the review totals it.
 * Ticks that are only suggestions are not counted, and the number of such days is given so payroll knows to ask.
 */
import { DAY_FLAG_KEYS, DAY_FLAG_LABEL, type DayFlagKey } from "@/lib/time-day-flags";
import type { SheetColumn } from "@/lib/spreadsheet";
import { FLAG_TEXT, addDays, hm, roundMinutes, weekStartOf } from "@/lib/time-sheet";
import { type PersonWeek, WEEK_STATE_TEXT } from "@/lib/time-week";

export const PAYROLL_MAX_WEEKS = 5;

/** The weeks a pay period covers: the Monday on or before `from`, then `count` (1 to 5) consecutive weeks. */
export function payrollWeeks(from: string, count: number): { weekStarts: string[]; start: string; end: string } {
  const first = weekStartOf(from);
  const n = Math.min(PAYROLL_MAX_WEEKS, Math.max(1, Math.floor(Number.isFinite(count) ? count : 1)));
  const weekStarts = Array.from({ length: n }, (_, i) => addDays(first, i * 7));
  return { weekStarts, start: first, end: addDays(first, n * 7 - 1) };
}

/** "Acme Ltd Payroll Hours 2026-10-19 to 2026-11-01" (exportSpreadsheet makes it file-safe and adds the day it was exported). */
export function payrollFileBase(company: string, start: string, end: string): string {
  return `${company.trim() || "Company"} Payroll Hours ${start} to ${end}`;
}

export type PayrollRow = {
  person: string;
  weekStart: string;
  weekEnd: string;
  daysWorked: number;
  clockedMinutes: number;
  breakMinutes: number;
  paidMinutes: number;
  /** Saved ticks only: days, and the paid minutes on those days (the review's per-type totals). */
  ticks: Record<DayFlagKey, { days: number; paidMinutes: number }>;
  suggestedDays: number;
  approval: string;
  approved: boolean;
  approvedBy: string;
  approvedOn: string;
  checks: string;
};

/** Whole minutes (rounded once, like the review) as hours to 2 dp. */
export const roundedHours = (minutes: number) => Math.round((Math.max(0, roundMinutes(minutes)) / 60) * 100) / 100;

export type PayrollWeek = { weekStart: string; people: PersonWeek[] };

/** People in name order, then weeks in date order. A person's week with no entry, flag, job time or tick at all is left out; one open shift (clock-in, no clock-out) is kept, 0 paid, with its check. `names` maps a user id to the name shown. */
export function payrollRows(weeks: PayrollWeek[], names: Record<string, string | null>, unknownName = "Unknown"): PayrollRow[] {
  const rows: PayrollRow[] = [];
  for (const { weekStart, people } of weeks) {
    for (const p of people) {
      const w = p.week;
      const tickedDays = p.dayFlags?.days.some((d) => DAY_FLAG_KEYS.some((k) => d.flags[k])) ?? false;
      // Anyone with any entry, flag or job time that week is in the file: an open shift (clock-in, no clock-out) counts 0 paid but must still be seen, with its check.
      const anyEntry = w.days.some((d) => d.sessions.length > 0 || d.flags.length > 0 || d.worked);
      if (w.daysWorked === 0 && w.labour <= 0 && w.attendance <= 0 && w.flags.length === 0 && !anyEntry && !tickedDays) continue;
      const state = p.status?.state ?? "not_approved";
      const name = names[p.userId] ?? unknownName;
      const totals = p.dayFlags?.totals;
      rows.push({
        person: name,
        weekStart,
        weekEnd: addDays(weekStart, 6),
        daysWorked: w.daysWorked,
        clockedMinutes: w.attendance,
        breakMinutes: w.breakDeduction,
        paidMinutes: w.paid,
        ticks: Object.fromEntries(DAY_FLAG_KEYS.map((k) => [k, { days: totals?.[k].days ?? 0, paidMinutes: totals?.[k].paidMinutes ?? 0 }])) as PayrollRow["ticks"],
        suggestedDays: p.dayFlags?.suggestedDays ?? 0,
        approval: WEEK_STATE_TEXT[state],
        approved: state === "approved",
        approvedBy: state === "approved" ? (names[p.status?.approved_by ?? ""] ?? unknownName) : "",
        approvedOn: state === "approved" ? (p.status?.approved_at?.slice(0, 10) ?? "") : "",
        checks: w.flags.map((f) => FLAG_TEXT[f] ?? f).join("; "),
      });
    }
  }
  return rows.sort((a, b) => a.person.localeCompare(b.person) || a.weekStart.localeCompare(b.weekStart));
}

/** Weeks in the file that are not approved (payroll should not rely on these yet). */
export const unapprovedCount = (rows: PayrollRow[]) => rows.filter((r) => !r.approved).length;

const tickColumns = (key: DayFlagKey): SheetColumn<PayrollRow>[] => [
  { header: `${DAY_FLAG_LABEL[key]} Days`, type: "number", value: (r) => r.ticks[key].days },
  { header: `${DAY_FLAG_LABEL[key]} Paid (hours)`, type: "number", value: (r) => roundedHours(r.ticks[key].paidMinutes) },
];

export const PAYROLL_COLUMNS: SheetColumn<PayrollRow>[] = [
  { header: "Person", type: "text", value: (r) => r.person },
  { header: "Week Starting", type: "date", value: (r) => r.weekStart },
  { header: "Week Ending", type: "date", value: (r) => r.weekEnd },
  { header: "Days Worked", type: "number", value: (r) => r.daysWorked },
  { header: "Clocked (hours)", type: "number", value: (r) => roundedHours(r.clockedMinutes) },
  { header: "Breaks Deducted (hours)", type: "number", value: (r) => roundedHours(r.breakMinutes) },
  { header: "Paid (hours)", type: "number", value: (r) => roundedHours(r.paidMinutes) },
  { header: "Paid (h:mm)", type: "text", value: (r) => hm(r.paidMinutes) },
  ...DAY_FLAG_KEYS.flatMap(tickColumns),
  { header: "Unsaved Suggested Tick Days", type: "number", value: (r) => r.suggestedDays },
  { header: "Approval", type: "text", value: (r) => r.approval },
  { header: "Approved By", type: "text", value: (r) => r.approvedBy },
  { header: "Approved On", type: "date", value: (r) => r.approvedOn },
  { header: "Checks", type: "text", value: (r) => r.checks },
];
