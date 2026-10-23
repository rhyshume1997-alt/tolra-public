/**
 * Working hours shown as paid hours: for DISPLAY only (Settings > Company details > Working hours). Pay comes from clock in and out,
 * never from these figures.
 *
 * The break rule matches the job sheet's defaults (migration 050, time settings; not merged yet): on a day of MIN_DAY_HOURS or more at
 * work, LUNCH_MINUTES of lunch and BREAK_MINUTES of break come off unpaid; on a shorter day nothing comes off.
 */

import { clockMinutes, hoursForDay, type DayHours, type WorkingHours } from "@/lib/company";

export const LUNCH_MINUTES = 30;
export const BREAK_MINUTES = 15;
export const MIN_DAY_HOURS = 6;

export type DayPaid = { atWork: number; breaks: number; paid: number };

/** An end of 00:00 (what a time input gives for midnight) or 24:00 is the end of the day. */
function endMinutes(end: string, start: number) {
  const minutes = clockMinutes(end, true);
  return minutes === 0 && start > 0 ? 1440 : minutes;
}

/**
 * Minutes at work (finish - start), unpaid breaks and paid time for one day. Null when the start or finish isn't a valid time, or the
 * finish isn't after the start.
 */
export function paidDay(start: string, end: string): DayPaid | null {
  const s = clockMinutes(start);
  const e = s === null ? null : endMinutes(end, s);
  if (s === null || e === null || e <= s) return null;
  const atWork = e - s;
  const breaks = atWork >= MIN_DAY_HOURS * 60 ? LUNCH_MINUTES + BREAK_MINUTES : 0;
  return { atWork, breaks, paid: atWork - breaks };
}

export type WeekPaid = { atWork: number; breaks: number; paid: number };

/** The week's totals over the days given (days that aren't valid are left out). */
export function paidWeek(days: Array<DayHours | null | undefined>): WeekPaid {
  const total = { atWork: 0, breaks: 0, paid: 0 };
  for (const day of days) {
    const d = day ? paidDay(day.start, day.end) : null;
    if (!d) continue;
    total.atWork += d.atWork;
    total.breaks += d.breaks;
    total.paid += d.paid;
  }
  return total;
}

/** Minutes as h:mm, e.g. 435 -> "7:15", 2085 -> "34:45". */
export function formatHoursMinutes(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The 24:00 stored for midnight reads as 00:00 on screen. */
const clockText = (value: string) => (value === "24:00" ? "00:00" : value);

/**
 * A short summary of the working hours, runs of days with the same hours joined: "Mon–Thu 08:00–16:00, Fri 08:00–14:30".
 * A single day is its name, two days in a row are "Mon, Tue", three or more in a row are "Mon–Wed".
 */
export function workingHoursLabel(hours: WorkingHours): string {
  const groups: Array<{ days: number[]; text: string }> = [];
  for (let day = 1; day <= 7; day++) {
    const d = hoursForDay(hours, day);
    if (!d) continue;
    const text = `${clockText(d.start)}–${clockText(d.end)}`;
    const last = groups[groups.length - 1];
    if (last && last.text === text && last.days[last.days.length - 1] === day - 1) last.days.push(day);
    else groups.push({ days: [day], text });
  }
  return groups.map(({ days, text }) => {
    const names = days.length >= 3 ? `${DAY_NAMES[days[0] - 1]}–${DAY_NAMES[days[days.length - 1] - 1]}` : days.map((d) => DAY_NAMES[d - 1]).join(", ");
    return `${names} ${text}`;
  }).join(", ");
}
