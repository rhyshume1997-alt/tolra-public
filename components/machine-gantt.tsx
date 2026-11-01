"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatHours, formatMinutes, isWorkingDay, localDateString, mondayOf, timeOf, windowFor, worksOn,
  type BookingSegment, type Machine, type ScheduledBooking,
} from "@/lib/machine-schedule";
import { useColumnVisibility } from "@/lib/org-settings";
import { fmtDateText, fmtDayDateTime } from "@/lib/dates";
import type { PeopleMap } from "@/lib/people";
import { SCHEDULE_FREE_FILL, SCHEDULE_ORDER, SCHEDULE_STATES, scheduleBlockClass, scheduleLegendText } from "@/lib/status-colours";
import { runBarLabel, runBarsFor, uncoveredParts, type RunBar, type RunRow } from "@/lib/schedule-live";

const SPANS = [{ days: 7, label: "1 week" }, { days: 14, label: "2 weeks" }, { days: 28, label: "4 weeks" }];
const LABEL_COL = 150;

type Props = {
  machines: Machine[];
  bookings: ScheduledBooking[];
  now: Date;
  /** A running booking's live "3:35 left" / "0:20 over" (the same calculation as the Job Board and the booking dialog); null shows the stored hours left. */
  liveLeftOf?: (booking: ScheduledBooking) => string | null;
  onSelect?: (booking: ScheduledBooking) => void;
  /** Live use (migration 044): machine runs in the visible window, drawn as full-height blocks over the planned bookings, like them. */
  runs?: RunRow[];
  people?: PeopleMap;
  onSelectRun?: (bar: RunBar, label: string) => void;
  /** The visible window [start, end) whenever it changes (span or week), so the page can load that window's runs. */
  onRangeChange?: (start: Date, end: Date) => void;
};

/** Narrowest a booking bar is drawn, as a share of its day cell (about 6px at the narrowest column). */
const MIN_BAR_PERCENT = 12;

function addDays(date: Date, n: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * `planned` is set on a day of a booking split by day: what is worked that day. `outOfHours` is set when some of that day's real times
 * fall outside the machine's window for the cell: the bar is then drawn clamped inside the cell (at its edge when none of it is inside)
 * and marked, with the exact times in its label and title, so nothing is clipped silently.
 */
type Segment = { booking: ScheduledBooking; left: number; width: number; first: boolean; planned?: BookingSegment; outOfHours?: boolean };

export function MachineGantt({ machines, bookings, now, liveLeftOf, onSelect, runs = [], people = {}, onSelectRun, onRangeChange }: Props) {
  const { isVisible } = useColumnVisibility("schedule");
  const [span, setSpan] = useState(14);
  const [startDate, setStartDate] = useState(() => mondayOf(new Date()));

  const days = useMemo(() => Array.from({ length: span }, (_, i) => addDays(startDate, i)), [span, startDate]);
  useEffect(() => { onRangeChange?.(startDate, addDays(startDate, span)); }, [startDate, span, onRangeChange]);
  const todayIndex = days.findIndex((d) => sameDay(d, now));
  const nowFraction = Math.min(1, Math.max(0, (now.getHours() + now.getMinutes() / 60 - 8) / 8));
  const minCol = span >= 28 ? 38 : span >= 14 ? 52 : 84;

  function segmentsFor(machine: Machine, day: Date, dayIdx: number): Segment[] {
    const { start, end } = windowFor(day, machine);
    const total = end.getTime() - start.getTime();
    if (total <= 0) return [];
    // Every day a booking is worked gets its bar, non-working days included when the booking was started on one
    // (weekend or overtime work). A weekday booking is never drawn on a weekend: it isn't worked then.
    // A booking split by day is drawn on exactly the days of its plan, weekends included, each as long as that day's hours.
    const dayKey = localDateString(day);
    return bookings
      .filter((b) => b.machine.id === machine.id && (b.segments?.length ? b.segments.some((s) => s.date === dayKey) : worksOn(day, machine, b.start)))
      .flatMap((b) => {
        const planned = b.segments?.find((s) => s.date === dayKey);
        let from = Math.max((planned ?? b).start.getTime(), start.getTime());
        let to = Math.min((planned ?? { end: b.finish }).end.getTime(), end.getTime());
        const outOfHours = planned ? planned.start.getTime() < start.getTime() || planned.end.getTime() > end.getTime() : undefined;
        if (to <= from) {
          if (!planned) return [];
          // A planned day wholly outside the machine's window (00:00 to 06:00, or 18:00 to 22:00): drawn at the nearest edge of the cell.
          from = to = planned.end.getTime() <= start.getTime() ? start.getTime() : end.getTime();
        }
        const firstVisibleDay = b.segments?.length
          ? days.findIndex((d) => b.segments!.some((s) => s.date === localDateString(d)))
          : days.findIndex((d) => {
            const w = windowFor(d, machine);
            return worksOn(d, machine, b.start) && Math.min(b.finish.getTime(), w.end.getTime()) > Math.max(b.start.getTime(), w.start.getTime());
          });
        // A booking that only just starts before closing time (or ends just after opening) would be a sliver under a pixel wide
        // on the cell's edge, where the neighbouring cell takes the click. Keep every bar wide enough to hit, inside its own cell.
        const width = Math.max(MIN_BAR_PERCENT, ((to - from) / total) * 100);
        const left = Math.min(((from - start.getTime()) / total) * 100, 100 - width);
        return [{ booking: b, left, width, first: dayIdx === firstVisibleDay, planned, outOfHours }];
      });
  }

  /** The bar's tooltip and, with the labels hidden, its accessible name. */
  function bookingTitle(seg: Segment, machine: Machine) {
    return `${seg.booking.jobNo} on ${machine.name}\nStart ${fmtDayDateTime(seg.booking.start)}\nEst. finish ${fmtDayDateTime(seg.booking.finish)}\n${liveLeftOf?.(seg.booking) ?? `${formatHours(seg.booking.hoursLeft)} left`} (${seg.booking.status})${seg.planned ? `\nSplit by day: ${fmtDateText(seg.planned.date, { weekday: "short" })} ${seg.planned.from}-${seg.planned.to} (${formatMinutes(seg.planned.minutes)})${seg.outOfHours ? `, partly or wholly outside ${machine.name}'s hours (drawn at the edge of the day)` : ""}` : ""}`;
  }

  // Days are this device's calendar days (localDateString), shown in the person's date format.
  const rangeLabel = `${fmtDateText(localDateString(days[0]))} - ${fmtDateText(localDateString(days[days.length - 1]), { year: true })}`;

  return (
    <Card>
      <CardHeader className="gap-3 md:flex md:flex-row md:items-center md:justify-between">
        <div>
          <CardTitle className="text-lg">Machine timeline</CardTitle>
          <p className="mt-1 text-sm text-slate-500">{rangeLabel}.{isVisible("legend") ? ` ${scheduleLegendText()}` : ""}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5" role="group" aria-label="Timeline length">
            {SPANS.map((option) => (
              <button
                key={option.days}
                type="button"
                onClick={() => setSpan(option.days)}
                className={`min-h-9 rounded-md px-3 text-sm font-medium ${span === option.days ? "bg-brand text-brand-ink" : "text-slate-600 hover:bg-slate-100"}`}
              >{option.label}</button>
            ))}
          </div>
          <Button variant="outline" size="icon" aria-label="Previous" className="min-h-9" onClick={() => setStartDate(addDays(startDate, -span))}><ChevronLeft className="size-4" /></Button>
          <Button variant="outline" className="min-h-9" onClick={() => setStartDate(mondayOf(new Date()))}>Today</Button>
          <Button variant="outline" size="icon" aria-label="Next" className="min-h-9" onClick={() => setStartDate(addDays(startDate, span))}><ChevronRight className="size-4" /></Button>
        </div>
      </CardHeader>
      <CardContent>
        {!machines.length ? <p className="py-8 text-center text-sm text-slate-500">No machines to show. Add a machine first.</p> : (
          <div className="overflow-x-auto">
            <div className="relative" style={{ minWidth: LABEL_COL + days.length * minCol }}>
              <div className="grid border-b border-slate-200" style={{ gridTemplateColumns: `${LABEL_COL}px repeat(${days.length}, minmax(0, 1fr))` }}>
                <div className="sticky left-0 z-20 bg-white p-2 text-xs font-semibold uppercase text-slate-500">Machine</div>
                {days.map((day, i) => {
                  const isToday = i === todayIndex;
                  const weekend = day.getDay() === 0 || day.getDay() === 6;
                  return (
                    <div key={i} data-testid="day-header" data-today={isToday ? "true" : undefined} className={`border-l border-slate-100 px-1 py-1.5 text-center text-[11px] leading-tight ${isToday ? "bg-brand font-semibold text-white" : weekend ? "bg-slate-50 text-slate-400" : "text-slate-600"}`}>
                      <div>{day.toLocaleDateString("en-GB", { weekday: "short" })}</div>
                      <div>{span >= 28 ? day.getDate() : fmtDateText(localDateString(day))}</div>
                    </div>
                  );
                })}
              </div>
              {/* The rows and the Now marker share a box below the day header, so the marker's label (under the last row) never covers a day name. */}
              <div className="relative pb-5">
              {machines.map((machine) => (
                <div key={machine.id} className="grid border-b border-slate-100" style={{ gridTemplateColumns: `${LABEL_COL}px repeat(${days.length}, minmax(0, 1fr))` }}>
                  <div className="sticky left-0 z-20 flex flex-col justify-center bg-white p-2">
                    <span className="truncate text-sm font-semibold text-slate-900" title={machine.name}>{machine.name}</span>
                    {machine.type && isVisible("machine-type") ? <span className="truncate text-[11px] text-slate-500">{machine.type}</span> : null}
                  </div>
                  {days.map((day, i) => {
                    const working = isWorkingDay(day, machine);
                    const segments = segmentsFor(machine, day, i);
                    const actual = runBarsFor(runs, machine, day, now);
                    return (
                      <div
                        key={i}
                        className={`relative h-12 border-l border-slate-100 ${working ? SCHEDULE_FREE_FILL : "bg-slate-100 [background-image:repeating-linear-gradient(135deg,transparent,transparent_4px,rgba(100,116,139,0.18)_4px,rgba(100,116,139,0.18)_5px)]"}`}
                        title={working ? `${machine.name}, ${fmtDateText(localDateString(day), { weekday: "long", numberAs: "full" })}${segments.length ? "" : ": free"}` : `${fmtDateText(localDateString(day), { weekday: "long", numberAs: "full" })}: not normally worked`}
                      >
                        {segments.flatMap((seg) => {
                          // Hours with actual machine use show the use block (drawn below); the booking shows only the rest, in blue.
                          const parts = uncoveredParts(seg.left, seg.width, actual.map((bar) => ({ left: bar.usedLeft, width: bar.usedWidth })));
                          // Wholly covered by use: keep a slim strip along the top so the booking stays clickable, focusable and announced.
                          if (!parts.length) return [{ seg: { ...seg, first: false }, partIdx: 0, covered: true }];
                          return parts.map((part, partIdx) => ({ seg: { ...seg, left: part.left, width: part.width, first: seg.first && partIdx === 0 }, partIdx, covered: false }));
                        }).map(({ seg, partIdx, covered }) => {
                          const done = seg.booking.status === "complete";
                          const running = !done && seg.booking.status === "running";
                          return (
                            <button
                              key={`${seg.booking.id}-${partIdx}`}
                              type="button"
                              data-booking-id={seg.booking.id}
                              data-covered={covered ? "true" : undefined}
                              aria-label={covered ? `${seg.booking.jobNo} on ${machine.name}, hidden under machine use (${seg.booking.status})` : isVisible("bar-labels") ? undefined : bookingTitle(seg, machine)}
                              data-plan-date={seg.planned?.date}
                              data-plan-hours={seg.planned?.hours}
                              data-plan-start={seg.planned?.from}
                              data-plan-end={seg.planned?.to}
                              data-out-of-hours={seg.outOfHours ? "true" : undefined}
                              onClick={() => onSelect?.(seg.booking)}
                              className={`absolute ${covered ? "inset-y-auto top-0 z-[6] h-2" : "inset-y-1"} overflow-hidden px-1 text-left text-[10px] font-semibold leading-tight focus:outline-none focus-visible:ring-2 focus-visible:ring-brand ${scheduleBlockClass(done ? "complete" : running ? "running" : "booked")} hover:brightness-110 ${seg.outOfHours ? "border-y-2 border-dashed border-amber-300" : ""}`}
                              style={{ left: `${seg.left}%`, width: `${seg.width}%` }}
                              title={bookingTitle(seg, machine)}
                            >
                              {isVisible("running-badge") && seg.first && running ? <span className="block [overflow-wrap:anywhere] uppercase tracking-wide">Running</span> : null}
                              {isVisible("running-badge") && seg.first && done ? <span className="flex min-w-0 items-center gap-0.5 uppercase tracking-wide"><Check aria-hidden className="size-3 shrink-0" /><span className="min-w-0 [overflow-wrap:anywhere]">Complete</span></span> : null}
                              {!isVisible("bar-labels") ? null : seg.planned
                                ? <span className="block [overflow-wrap:anywhere]">{seg.first ? <>{seg.booking.jobNo} </> : null}<span className="font-normal">{seg.planned.from}-{seg.planned.to} {formatMinutes(seg.planned.minutes)}</span>{seg.outOfHours ? <span className="font-normal"> (out of hours)</span> : null}</span>
                                : seg.first ? <span className="block [overflow-wrap:anywhere]">{seg.booking.jobNo}</span> : null}
                            </button>
                          );
                        })}
                        {actual.map((bar) => {
                          const label = runBarLabel(bar, machine.name, people, now);
                          return (
                            <button
                              key={bar.run.id}
                              type="button"
                              data-testid="run-bar"
                              data-run-id={bar.run.id}
                              data-job-id={bar.run.job_id}
                              data-state={bar.open ? "open" : "ended"}
                              data-kind={bar.kind}
                              data-from={timeOf(bar.from)}
                              data-to={timeOf(bar.to)}
                              data-out-of-hours={bar.outOfHours ? "true" : undefined}
                              aria-label={`${label}${bar.outOfHours ? ` (partly or wholly outside ${machine.name}'s hours, drawn at the edge of the day)` : ""}`}
                              title={label}
                              onClick={() => onSelectRun?.(bar, label)}
                              className={`absolute inset-y-1 z-[5] overflow-hidden px-1 text-left text-[10px] font-semibold leading-tight focus:outline-none focus-visible:ring-2 focus-visible:ring-brand hover:brightness-110 ${scheduleBlockClass(bar.kind === "running" ? "running" : bar.kind === "paused" ? "paused" : "complete")} ${bar.outOfHours ? "border-y-2 border-dashed border-amber-300" : ""}`}
                              style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
                            >
                              {bar.marks.map((m) => <span key={m} aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-white/40" style={{ left: `${m}%` }} />)}
                              {isVisible("running-badge") ? <span className="relative flex min-w-0 items-center gap-0.5 uppercase tracking-wide">
                                {bar.kind === "finished" ? <Check aria-hidden className="size-3 shrink-0" /> : null}
                                <span className="min-w-0 [overflow-wrap:anywhere]">{bar.kind === "running" ? "Running" : bar.kind === "paused" ? "Paused" : "Finished"}</span>
                              </span> : null}
                              {isVisible("bar-labels") ? <span className="relative block [overflow-wrap:anywhere] font-normal">{bar.run.job_no}</span> : null}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              ))}
              {todayIndex >= 0 && isVisible("now-marker") ? (
                <div
                  data-testid="now-marker"
                  className="pointer-events-none absolute bottom-0 top-0 z-10 w-0.5 bg-brand"
                  style={{ left: `calc(${LABEL_COL}px + (100% - ${LABEL_COL}px) * ${(todayIndex + nowFraction) / days.length})` }}
                  aria-hidden
                ><span data-testid="now-marker-label" className={`absolute bottom-0 whitespace-nowrap rounded-none bg-brand px-1 text-[10px] font-semibold leading-4 text-white ${(todayIndex + nowFraction) / days.length > 0.9 ? "right-1" : "left-1"}`}>Now</span></div>
              ) : null}
              </div>
            </div>
          </div>
        )}
        {isVisible("legend") ? <div data-testid="schedule-legend" className="mt-3 flex flex-wrap gap-4 text-xs text-slate-600">
          {SCHEDULE_ORDER.map((state) => (
            <span key={state} data-testid="schedule-legend-item" data-state={state} className="flex items-center gap-1.5">
              <span className={`flex size-3 items-center justify-center rounded-sm ${scheduleBlockClass(state)} ${state === "free" ? "ring-1 ring-slate-300" : ""}`}>{state === "complete" ? <Check aria-hidden className="size-2.5" /> : null}</span> {SCHEDULE_STATES[state].label}
            </span>
          ))}
          <span className="flex items-center gap-1.5"><span className="size-3 rounded-sm bg-slate-200" /> Non-working day</span>
        </div> : null}
      </CardContent>
    </Card>
  );
}
