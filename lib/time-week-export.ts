/**
 * The weekly hours review (components/time/week-review.tsx) as a spreadsheet: one row per person per day that has time or
 * a day tick, from what the review already holds (no new queries). Hours only: no rates or pay, as on the screen.
 *
 * Person, Date, Clock In / Clock Out (first start, last end of the day, UK time; Clock Out is empty while still clocked in),
 * Clocked (clock in to out), Breaks Deducted (the unpaid breaks taken off, as the review's Breaks column), Paid, all in
 * hours to 2 dp; the four day ticks ("Yes" saved, "Suggested" not saved yet, so not counted in the week's totals); and
 * Job Time: "J-0001 2.50; J-0002 1.00" (hours on each job, from the person's job time lines).
 */
import type { DayFlagKey, EffectiveDayFlags } from "@/lib/time-day-flags";
import { DAY_FLAG_KEYS, DAY_FLAG_LABEL } from "@/lib/time-day-flags";
import { localTimeOf, type DayTotals } from "@/lib/time-sheet";
import type { SheetColumn } from "@/lib/spreadsheet";
import type { PersonWeek } from "@/lib/time-week";

export type WeekExportRow = {
  person: string;
  date: string;
  clockIn: string;
  clockOut: string;
  clockedMinutes: number;
  breakMinutes: number;
  paidMinutes: number;
  ticks: Record<DayFlagKey, "saved" | "suggested" | "">;
  jobs: string;
};

const hours = (minutes: number) => Math.round((minutes / 60) * 100) / 100;

function tick(flags: EffectiveDayFlags | undefined, key: DayFlagKey): "saved" | "suggested" | "" {
  if (!flags || !flags.flags[key]) return "";
  return flags.source === "suggested" ? "suggested" : "saved";
}

function jobsText(day: DayTotals, jobNos: Record<string, { job_no: string }>): string {
  return day.jobs.filter((line) => line.minutes > 0).map((line) => `${jobNos[line.jobId]?.job_no ?? "Job"} ${hours(line.minutes).toFixed(2)}`).join("; ");
}

/** The week as shown: people in the order given, their days in date order. `names` maps a user id to the name shown. */
export function weekExportRows(people: PersonWeek[], names: Record<string, string | null>, jobs: Record<string, { job_no: string }>, unknownName = "Unknown"): WeekExportRow[] {
  return people.flatMap((p) => p.week.days.flatMap((day): WeekExportRow[] => {
    const flags = p.dayFlags?.days.find((d) => d.date === day.date);
    const ticked = DAY_FLAG_KEYS.some((k) => tick(flags, k));
    if (day.attendance <= 0 && day.labour <= 0 && !ticked) return [];
    const started = day.sessions.filter((s) => s.start !== null);
    const first = started[0]?.start ?? null;
    const last = started.at(-1)?.end ?? null;
    return [{
      person: names[p.userId] ?? unknownName,
      date: day.date,
      clockIn: first === null ? "" : localTimeOf(new Date(first)),
      clockOut: last === null ? "" : localTimeOf(new Date(last)),
      clockedMinutes: day.attendance,
      breakMinutes: day.breakDeduction,
      paidMinutes: day.paid,
      ticks: { overtime: tick(flags, "overtime"), saturday: tick(flags, "saturday"), sunday: tick(flags, "sunday"), bank_holiday: tick(flags, "bank_holiday") },
      jobs: jobsText(day, jobs),
    }];
  }));
}

const tickColumn = (key: DayFlagKey): SheetColumn<WeekExportRow> => ({
  header: DAY_FLAG_LABEL[key], type: "text", value: (r) => (r.ticks[key] === "saved" ? "Yes" : r.ticks[key] === "suggested" ? "Suggested" : ""),
});

export const WEEK_COLUMNS: SheetColumn<WeekExportRow>[] = [
  { header: "Person", type: "text", value: (r) => r.person },
  { header: "Date", type: "date", value: (r) => r.date },
  { header: "Clock In", type: "text", value: (r) => r.clockIn },
  { header: "Clock Out", type: "text", value: (r) => r.clockOut },
  { header: "Clocked (hours)", type: "number", value: (r) => hours(r.clockedMinutes) },
  { header: "Breaks Deducted (hours)", type: "number", value: (r) => hours(r.breakMinutes) },
  { header: "Paid (hours)", type: "number", value: (r) => hours(r.paidMinutes) },
  ...DAY_FLAG_KEYS.map(tickColumn),
  { header: "Job Time (hours)", type: "text", value: (r) => r.jobs },
];
