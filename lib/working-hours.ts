/** Planned paid hours for display only; actual pay uses clock records and the same company time settings. */

import { clockMinutes, hoursForDay, type DayHours, type WorkingHours } from "@/lib/company";

import { DEFAULT_TIME_SETTINGS, type TimeSettings } from "@/lib/time-sheet";

export const LUNCH_MINUTES = DEFAULT_TIME_SETTINGS.lunchMinutes;
export const BREAK_MINUTES = DEFAULT_TIME_SETTINGS.breakMinutes;
export const MIN_DAY_HOURS = DEFAULT_TIME_SETTINGS.breakMinDayHours;

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
export function paidDay(start: string, end: string, settings: TimeSettings = DEFAULT_TIME_SETTINGS): DayPaid | null {
  const s = clockMinutes(start);
  const e = s === null ? null : endMinutes(end, s);
  if (s === null || e === null || e <= s) return null;
  const atWork = e - s;
  const breaks = settings.breaksPaid ? 0 : Math.min(atWork, atWork >= settings.breakMinDayHours * 60 ? settings.lunchMinutes + settings.breakMinutes : 0);
  return { atWork, breaks, paid: atWork - breaks };
}

export type WeekPaid = { atWork: number; breaks: number; paid: number };

/** The week's totals over the days given (days that aren't valid are left out). */
export function paidWeek(days: Array<DayHours | null | undefined>, settings: TimeSettings = DEFAULT_TIME_SETTINGS): WeekPaid {
  const total = { atWork: 0, breaks: 0, paid: 0 };
  for (const day of days) {
    const d = day ? paidDay(day.start, day.end, settings) : null;
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

export function paidHoursExplanation(settings: TimeSettings): string {
  return settings.breaksPaid
    ? "Breaks are paid. Paid time is clock in to clock out, including breaks."
    : `Breaks are unpaid. Paid time is clock in to clock out minus breaks: on a day of ${settings.breakMinDayHours} hours or more, ${settings.lunchMinutes} + ${settings.breakMinutes} minutes, or the breaks you clocked if longer; on a shorter day, the breaks you clocked.`;
}
