"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { clockMinutes, hoursForDay, workStartOn, type WorkingHours } from "@/lib/company";
import {
  addDaysToDate, clockText, dayHoursSplit, estimateMinutes, formatMinutes, formatPlanDate, inputEnd, localDateString, localMoment, parseLocalDate,
  isoWeekday, rowMinutes, storedEnd, validateDayPlan,
  type DayPlanCheck, type DayPlanEntry, type DayPlanRow,
} from "@/lib/machine-schedule";
import { workingHoursLabel } from "@/lib/working-hours";

/** "08:00-14:30": the working hours of the weekday `date` falls on. */
function dayHoursText(hours: WorkingHours, date: string) {
  const d = hoursForDay(hours, isoWeekday(date));
  return `${d?.start ?? hours.workStart}-${d?.end ?? hours.workEnd}`;
}

/** The end of a day that starts at `start` and carries up to `minutes`, as a time input shows it (never past midnight: "00:00" = 24:00). */
function endFor(start: string, minutes: number) {
  const from = clockMinutes(start) ?? 0;
  return inputEnd(clockText(Math.min(1440, from + Math.max(0, minutes))));
}

/** Form state for "Split by day": on/off and the rows being edited. Turning it off keeps the rows for this session; saving with it off stores no plan. */
export function useDayPlanForm(initial: DayPlanEntry[] | null | undefined) {
  const [on, setOn] = useState(Boolean(initial?.length));
  const [rows, setRows] = useState<DayPlanRow[]>(() => (initial?.length ? initial.map((e) => ({ date: e.date, start: e.start, end: inputEnd(e.end) })) : []));

  /**
   * Turning it on starts with one day: the booking's start date and time (`seedDate`, `seedTime`), ending when the estimated hours are
   * used up or at midnight, whichever is first. The rest is shared out with Add day.
   */
  function toggle(next: boolean, estimatedHours: number, seedDate: string, seedTime: string) {
    setOn(next);
    if (next && !rows.length) {
      const minutes = estimatedHours > 0 ? estimateMinutes(estimatedHours) : 0;
      setRows([{ date: seedDate, start: seedTime, end: minutes ? endFor(seedTime, minutes) : "" }]);
    }
  }

  return { on, rows, setRows, toggle, check: (estimatedHours: number): DayPlanCheck => validateDayPlan(rows, estimatedHours) };
}

/** The first moment of a plan, as it is stored in start_at: the first day's date and start time, local time. */
export function planStartIso(plan: DayPlanEntry[]) {
  return (localMoment(plan[0].date, plan[0].start) ?? parseLocalDate(plan[0].date) ?? new Date()).toISOString();
}

/** A date input's value for today, used when a booking has no start to seed the first day from. */
export const todayString = () => localDateString(new Date());

/**
 * "Split by day": rows of a date, a start and an end time, each with its total split into basic and out-of-hours time against the
 * company's working hours (display only: never pay), a running total against the booking's estimated hours, and the reason saving is
 * blocked until the two match to the minute. Every control is at least 44 px high.
 */
export function DayPlanField({ on, onToggle, rows, setRows, estimatedHours, check, workingHours }: {
  on: boolean;
  onToggle: (next: boolean) => void;
  rows: DayPlanRow[];
  setRows: (rows: DayPlanRow[]) => void;
  estimatedHours: number;
  check: DayPlanCheck;
  workingHours: WorkingHours;
}) {
  const remaining = (estimatedHours > 0 ? estimateMinutes(estimatedHours) : 0) - check.minutes;

  function update(index: number, patch: Partial<DayPlanRow>) {
    setRows(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  /** A new day: the day after the last, from the working-hours start, carrying the minutes still to place (up to midnight). */
  function addDay() {
    const last = rows[rows.length - 1];
    const date = last && parseLocalDate(last.date) ? addDaysToDate(last.date, 1) : "";
    const start = workStartOn(workingHours, date ? isoWeekday(date) : null);
    setRows([...rows, { date, start, end: remaining > 0 ? endFor(start, remaining) : "" }]);
  }

  return (
    <fieldset className="grid gap-3 rounded-lg border border-slate-200 p-3">
      <legend className="sr-only">Split by day</legend>
      <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-slate-800">
        <input type="checkbox" className="size-5" checked={on} onChange={(e) => onToggle(e.target.checked)} />
        Split by day
        <span className="font-normal text-slate-500">(choose the days and times yourself)</span>
      </label>
      {on ? (
        <div className="grid gap-3" data-testid="day-plan">
          <p className="text-xs text-slate-500">
            Each day is worked from its start to its end, weekends included. Normal working hours are {workingHoursLabel(workingHours)}: time outside them is marked out of hours but allowed.
            Work past midnight goes on the next day (22:00 to 00:00, then 00:00 to 06:00); an end of 00:00 means midnight. Leave this off to use the machine&apos;s working days.
          </p>
          {rows.map((row, index) => {
            const minutes = rowMinutes(row);
            const split = minutes && parseLocalDate(row.date) ? dayHoursSplit({ date: row.date, start: row.start, end: storedEnd(row.end) }, workingHours) : null;
            const n = index + 1;
            return (
              <div key={index} className="grid gap-1" data-testid="day-plan-row">
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.75rem] items-end gap-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_2.75rem]">
                  <label className="col-span-3 grid min-w-0 gap-1 text-xs font-medium text-slate-600 sm:col-span-1">
                    {row.date && parseLocalDate(row.date) ? formatPlanDate(row.date) : `Day ${n}`}
                    <Input type="date" aria-label={`Day ${n} date`} className="h-11" value={row.date} onChange={(e) => update(index, { date: e.target.value })} />
                  </label>
                  <label className="grid min-w-0 gap-1 text-xs font-medium text-slate-600">Start
                    <Input type="time" aria-label={`Day ${n} start`} className="h-11" value={row.start} onChange={(e) => update(index, { start: e.target.value })} />
                  </label>
                  <label className="grid min-w-0 gap-1 text-xs font-medium text-slate-600">End
                    <Input type="time" aria-label={`Day ${n} end`} className="h-11" value={row.end} onChange={(e) => update(index, { end: e.target.value })} />
                  </label>
                  <Button type="button" variant="outline" size="icon" className="size-11" aria-label={`Remove day ${n}`} onClick={() => setRows(rows.filter((_, i) => i !== index))}><X className="size-4" /></Button>
                </div>
                {split ? (
                  <p className="text-xs text-slate-600" data-testid="day-plan-row-summary">
                    <span className="font-semibold text-slate-800">{formatMinutes(split.total)}</span>: basic {formatMinutes(split.basic)}, out of hours {formatMinutes(split.outOfHours)}
                  </p>
                ) : null}
                {split && !split.workingDay ? (
                  <p className="text-xs font-medium text-amber-800" data-testid="day-plan-row-note">Not a normal working day: all of it is out of hours.</p>
                ) : split && split.outOfHours > 0 ? (
                  <p className="text-xs font-medium text-amber-800" data-testid="day-plan-row-note">Out of hours: {formatMinutes(split.outOfHours)} outside {dayHoursText(workingHours, row.date)}.</p>
                ) : null}
              </div>
            );
          })}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button type="button" variant="outline" className="min-h-11" onClick={addDay} disabled={rows.length >= 62}><Plus className="size-4" /> Add day</Button>
            <p className={`text-sm font-semibold ${check.ok ? "text-emerald-700" : "text-amber-800"}`} data-testid="day-plan-total" aria-live="polite">
              Total {formatMinutes(check.minutes)} of {estimatedHours > 0 ? formatMinutes(estimateMinutes(estimatedHours)) : "?"}
            </p>
          </div>
          {!check.ok ? <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" data-testid="day-plan-message">{check.message}</p> : null}
        </div>
      ) : null}
    </fieldset>
  );
}
