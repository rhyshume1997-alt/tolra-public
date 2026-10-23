import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKING_DAYS, addDaysToDate, bookedNotStarted, computeFinish, dayPlanFromRow, daysBetweenDates, findOverlaps, formatDayPlan, machineStatus, planSegments, scheduleAll, scheduleBooking, selfCheckFinish,
  dayHoursSplit, dayMinutes, formatMinutes, localMoment, validateDayPlan, worksOn, type Booking, type DayPlanEntry, type Machine,
} from "@/lib/machine-schedule";

/** A day of a plan from 08:00 (or `start`) for `hours` whole or part hours. */
const d = (date: string, hours: number, start = "08:00"): DayPlanEntry => {
  const [h, m] = start.split(":").map(Number);
  const end = h * 60 + m + Math.round(hours * 60);
  return { date, start, end: `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}` };
};

const machine = { hoursPerDay: 8, workingDays: DEFAULT_WORKING_DAYS };

describe("computeFinish", () => {
  it("20h from Fri 08:00 on an 8h Mon-Fri machine ends Tue 12:00", () => {
    const end = computeFinish(new Date(2026, 9, 9, 8, 0), 20, machine);
    expect([end.getFullYear(), end.getMonth(), end.getDate(), end.getHours(), end.getMinutes()]).toEqual([2026, 9, 13, 12, 0]);
    expect(end.getDay()).toBe(2);
  });

  // Weekend/overtime work is chosen by starting a booking on a non-working day (Rhys, 12 Oct 2026). This replaces the old
  // "weekend work starts on Monday morning" rule, which was the reported bug.
  it("a Saturday 2h booking is worked on the Saturday", () => {
    const end = computeFinish(new Date(2026, 9, 10, 10, 0), 2, machine);
    expect([end.getDate(), end.getHours()]).toEqual([10, 12]);
  });

  it("a Saturday 12h booking runs on into Sunday (8h Sat, 4h Sun), not Monday", () => {
    const end = computeFinish(new Date(2026, 9, 10, 8, 0), 12, machine);
    expect([end.getDate(), end.getDay(), end.getHours()]).toEqual([11, 0, 12]);
  });

  it("a Saturday 20h booking runs Saturday, Sunday, then Monday", () => {
    const end = computeFinish(new Date(2026, 9, 10, 8, 0), 20, machine);
    expect([end.getDate(), end.getDay(), end.getHours()]).toEqual([12, 1, 12]);
  });

  it("a Saturday start before 08:00 begins at 08:00 that Saturday", () => {
    const end = computeFinish(new Date(2026, 9, 10, 6, 0), 1, machine);
    expect([end.getDate(), end.getHours()]).toEqual([10, 9]);
  });

  it("a Monday-Friday booking is unchanged: a Friday overrun moves to Monday", () => {
    const end = computeFinish(new Date(2026, 9, 9, 14, 0), 6, machine); // 2h Fri + 4h Mon
    expect([end.getDate(), end.getDay(), end.getHours()]).toEqual([12, 1, 12]);
  });

  it("a Saturday booking across the BST change (clocks go back Sun 25 Oct 2026) keeps 08:00 local windows", () => {
    const end = computeFinish(new Date(2026, 9, 24, 8, 0), 12, machine); // 8h Sat 24th, 4h Sun 25th
    expect([end.getMonth(), end.getDate(), end.getHours(), end.getMinutes()]).toEqual([9, 25, 12, 0]);
  });

  it("finishes within the same day when it fits", () => {
    const end = computeFinish(new Date(2026, 9, 12, 8, 0), 8, machine);
    expect([end.getDate(), end.getHours()]).toEqual([12, 16]);
  });

  it("built-in self check passes", () => {
    expect(selfCheckFinish()).toBe(true);
  });
});

describe("weekend bookings on the schedule", () => {
  const mill: Machine = { id: "m1", name: "Mill", type: "", hoursPerDay: 8, workingDays: [...DEFAULT_WORKING_DAYS], active: true };
  const booking = (start: Date, hours: number, status: Booking["status"] = "booked"): Booking => ({
    id: `b-${start.getTime()}`, machineId: "m1", jobId: null, jobNo: "J-1", description: "", startAt: start.toISOString(),
    estimatedHours: hours, hoursDone: 0, status, notes: "",
  });

  it("a booking saved for Saturday stays on Saturday and runs into Sunday", () => {
    const s = scheduleBooking(booking(new Date(2026, 9, 10, 8, 0), 12), mill, new Date(2026, 9, 5));
    expect([s.start.getDate(), s.finish.getDate(), s.finish.getHours()]).toEqual([10, 11, 12]);
  });

  it("a past 'booked' booking is drawn on to the end of the day from now, while a complete one ends at start + estimate", () => {
    const now = new Date(2026, 9, 15, 9, 0); // Thursday
    const start = new Date(2026, 9, 12, 10, 0); // Monday 10:00, 2h
    const open = scheduleBooking(booking(start, 2), mill, now);
    const done = scheduleBooking(booking(start, 2, "complete"), mill, now);
    expect([open.finish.getDate(), open.finish.getHours()]).toEqual([15, 11]);
    expect([done.finish.getDate(), done.finish.getHours()]).toEqual([12, 12]);
  });

  it("a weekday job still running on a Saturday doesn't make that Saturday worked", () => {
    const s = scheduleBooking(booking(new Date(2026, 9, 9, 8, 0), 12, "running"), mill, new Date(2026, 9, 10, 9, 0));
    // Counted from Saturday "now": the 12h left are Mon 08:00-16:00 and Tue 08:00-12:00.
    expect([s.finish.getDate(), s.finish.getHours()]).toEqual([13, 12]);
  });

  it("a weekend booking still running on Sunday keeps running Sunday, then Monday", () => {
    // 12h left counted from Sunday 08:00: 8h Sunday, 4h Monday.
    const s = scheduleBooking(booking(new Date(2026, 9, 10, 8, 0), 12, "running"), mill, new Date(2026, 9, 11, 8, 0));
    expect([s.finish.getDate(), s.finish.getHours()]).toEqual([12, 12]);
  });

  it("the timeline draws a weekend booking on Saturday and Sunday, and never a weekday booking on a weekend", () => {
    const sat = new Date(2026, 9, 10, 12, 0);
    const sun = new Date(2026, 9, 11, 12, 0);
    expect(worksOn(sat, mill, new Date(2026, 9, 10, 9, 0))).toBe(true);
    expect(worksOn(sun, mill, new Date(2026, 9, 10, 9, 0))).toBe(true);
    expect(worksOn(sat, mill, new Date(2026, 9, 9, 8, 0))).toBe(false);
    expect(worksOn(sun, mill, new Date(2026, 9, 9, 8, 0))).toBe(false);
    expect(worksOn(new Date(2026, 9, 12, 12, 0), mill)).toBe(true);
  });

  it("next free time follows a running weekend booking", () => {
    const sched = [scheduleBooking(booking(new Date(2026, 9, 10, 8, 0), 2, "running"), mill, new Date(2026, 9, 10, 9, 0))];
    const status = machineStatus(mill, sched, new Date(2026, 9, 10, 9, 0));
    expect(status.busy).toBe(true);
    expect([status.nextFree.getDate(), status.nextFree.getHours()]).toEqual([10, 11]); // 2h left from 09:00
  });
});

// ---------- Split by day (the booking day-plan migration) ----------

describe("a booking split by day", () => {
  const mill: Machine = { id: "m1", name: "Mill", type: "", hoursPerDay: 8, workingDays: [...DEFAULT_WORKING_DAYS], active: true };
  const planned = (plan: DayPlanEntry[] | null | undefined, extra: Partial<Booking> = {}): Booking => ({
    id: "b-plan", machineId: "m1", jobId: null, jobNo: "J-PLAN", description: "", startAt: new Date(2026, 9, 10, 8, 0).toISOString(),
    estimatedHours: plan ? plan.reduce((sum, day) => sum + (dayMinutes(day) ?? 0), 0) / 60 : 8, hoursDone: 0, status: "booked", notes: "", dayPlan: plan, ...extra,
  });
  const at = (d: Date) => [d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()];
  const SAT_SUN = [d("2026-10-10", 6), d("2026-10-11", 2)];

  it("works exactly the hours on the dates, weekend days included: 6h Saturday, 2h Sunday", () => {
    const s = scheduleBooking(planned(SAT_SUN), mill, new Date(2026, 9, 5));
    expect(at(s.start)).toEqual([9, 10, 8, 0]);
    expect(at(s.finish)).toEqual([9, 11, 10, 0]);
    expect(s.segments?.map((seg) => [seg.date, seg.hours, seg.start.getHours(), seg.end.getHours()])).toEqual([["2026-10-10", 6, 8, 14], ["2026-10-11", 2, 8, 10]]);
  });

  it("starts at the first day's start whatever start_at says, and a later start_at doesn't push it", () => {
    const s = scheduleBooking(planned(SAT_SUN, { startAt: new Date(2026, 9, 10, 13, 30).toISOString() }), mill, new Date(2026, 9, 5));
    expect(at(s.start)).toEqual([9, 10, 8, 0]);
    const early = scheduleBooking(planned(SAT_SUN, { startAt: new Date(2026, 9, 1, 3, 0).toISOString() }), mill, new Date(2026, 9, 5));
    expect(at(early.start)).toEqual([9, 10, 8, 0]);
  });

  it("keeps each day's wall-clock times across the clock changes (BST ends Sun 25 Oct 2026, starts Sun 29 Mar 2026)", () => {
    const autumn = planSegments([d("2026-10-24", 8), d("2026-10-25", 4), d("2026-10-26", 3)]);
    expect(autumn.map((seg) => [seg.start.getDate(), seg.start.getHours(), seg.end.getHours(), seg.end.getMinutes()])).toEqual([[24, 8, 16, 0], [25, 8, 12, 0], [26, 8, 11, 0]]);
    const spring = planSegments([d("2026-03-28", 8), d("2026-03-29", 8), d("2026-03-30", 8)]);
    expect(spring.map((seg) => [seg.start.getDate(), seg.start.getHours(), seg.end.getHours()])).toEqual([[28, 8, 16], [29, 8, 16], [30, 8, 16]]);
  });

  it("overrides the default rule: a Monday start with a plan for Mon 2h and Wed 6h finishes Wednesday 14:00, and a day over the machine's hours is worked as planned", () => {
    const monday = new Date(2026, 9, 12, 8, 0).toISOString();
    const withoutPlan = scheduleBooking(planned(null, { startAt: monday, estimatedHours: 8 }), mill, new Date(2026, 9, 5));
    expect(at(withoutPlan.finish)).toEqual([9, 12, 16, 0]);
    const withPlan = scheduleBooking(planned([d("2026-10-12", 2), d("2026-10-14", 6)], { startAt: monday }), mill, new Date(2026, 9, 5));
    expect(at(withPlan.finish)).toEqual([9, 14, 14, 0]);
    const long = scheduleBooking(planned([d("2026-10-12", 10)]), mill, new Date(2026, 9, 5));
    expect(at(long.finish)).toEqual([9, 12, 18, 0]);
  });

  it("a plan doesn't roll forward: days already gone count as worked and the finish stays where the plan puts it", () => {
    const s = scheduleBooking(planned(SAT_SUN, { status: "running", hoursDone: 3 }), mill, new Date(2026, 9, 11, 9, 0));
    expect(at(s.finish)).toEqual([9, 11, 10, 0]);
    expect(s.hoursLeft).toBe(5);
    // After the last planned day, hours still left leave the finish in the past (the page says so) rather than inventing new days.
    const late = scheduleBooking(planned(SAT_SUN, { status: "running", hoursDone: 3 }), mill, new Date(2026, 9, 20, 9, 0));
    expect(at(late.finish)).toEqual([9, 11, 10, 0]);
    expect(late.hoursLeft).toBe(5);
    expect(scheduleBooking(planned(SAT_SUN, { status: "complete", hoursDone: 8 }), mill, new Date(2026, 9, 20)).hoursLeft).toBe(0);
  });

  it("no plan (null, missing, empty or unreadable) is exactly the default rule", () => {
    const base = planned(undefined, { startAt: new Date(2026, 9, 10, 8, 0).toISOString(), estimatedHours: 12 });
    const want = scheduleBooking({ ...base, dayPlan: undefined }, mill, new Date(2026, 9, 5));
    expect(at(want.finish)).toEqual([9, 11, 12, 0]); // 8h Saturday, 4h Sunday, as before
    for (const none of [null, [] as DayPlanEntry[], dayPlanFromRow("nonsense"), dayPlanFromRow([d("2026-02-30", 3)]), dayPlanFromRow([{ date: "2026-10-10", hours: 3 }])]) {
      const s = scheduleBooking({ ...base, dayPlan: none }, mill, new Date(2026, 9, 5));
      expect(s.segments).toBeUndefined();
      expect(s.start).toEqual(want.start);
      expect(s.finish).toEqual(want.finish);
    }
  });

  it("machine status follows the plan: busy only on planned days, free on a skipped Sunday, next free after the whole plan", () => {
    const fri = new Date(2026, 9, 9, 8, 0).toISOString();
    const sched = scheduleAll([planned([d("2026-10-09", 4), d("2026-10-11", 2), d("2026-10-12", 3)], { startAt: fri, estimatedHours: 9 })], [mill], new Date(2026, 9, 9));
    const onFriday = machineStatus(mill, sched, new Date(2026, 9, 9, 10, 0));
    expect(onFriday.busy).toBe(true);
    expect(at(onFriday.nextFree)).toEqual([9, 12, 11, 0]);
    const saturday = machineStatus(mill, sched, new Date(2026, 9, 10, 10, 0)); // a gap: nothing planned Saturday
    expect(saturday.busy).toBe(false);
    expect(saturday.next).not.toBeNull();
    expect(at(saturday.nextStart!)).toEqual([9, 11, 8, 0]);
    const sunday = machineStatus(mill, sched, new Date(2026, 9, 11, 9, 0));
    expect(sunday.busy).toBe(true);
    expect(at(sunday.current!.finish)).toEqual([9, 12, 11, 0]);
    expect(machineStatus(mill, sched, new Date(2026, 9, 13, 8, 0)).busy).toBe(false);
  });

  it("a default booking right after a plan chains onto it for next free", () => {
    const plan = planned(SAT_SUN, { id: "p" });
    const after = planned(null, { id: "d", startAt: new Date(2026, 9, 11, 9, 0).toISOString(), estimatedHours: 3, status: "booked" });
    const sched = scheduleAll([plan, after], [mill], new Date(2026, 9, 10, 9, 0));
    const status = machineStatus(mill, sched, new Date(2026, 9, 10, 9, 0));
    expect(status.current?.id).toBe("p");
    // Sunday 09:00 start (a non-working day, so every day): 3h from 09:00 = 12:00, inside the plan's Sunday window until 10:00, so it chains.
    expect(at(status.nextFree)).toEqual([9, 11, 12, 0]);
  });

  it("overlaps follow the days of a plan: a Sunday clash is a clash, a free Sunday between two planned days is not", () => {
    const plan = scheduleAll([planned([d("2026-10-10", 4), d("2026-10-12", 4)])], [mill], new Date(2026, 9, 5));
    const sunday = [new Date(2026, 9, 11, 9, 0), new Date(2026, 9, 11, 12, 0)] as const;
    expect(findOverlaps(mill, plan, sunday[0], sunday[1])).toEqual([]);
    expect(findOverlaps(mill, plan, new Date(2026, 9, 10, 9, 0), new Date(2026, 9, 10, 10, 0))).toHaveLength(1);
    expect(findOverlaps(mill, plan, new Date(2026, 9, 12, 11, 0), new Date(2026, 9, 12, 13, 0))).toHaveLength(1);
    expect(findOverlaps(mill, plan, new Date(2026, 9, 12, 12, 0), new Date(2026, 9, 12, 13, 0))).toHaveLength(0); // the plan's Monday ends at 12:00
    expect(findOverlaps(mill, plan, new Date(2026, 9, 10, 9, 0), new Date(2026, 9, 10, 10, 0), "b-plan")).toEqual([]);
    // A new split checked against an ordinary booking: only its own days count.
    const ordinary = scheduleAll([planned(null, { id: "o", startAt: new Date(2026, 9, 11, 8, 0).toISOString(), estimatedHours: 4 })], [mill], new Date(2026, 9, 5));
    const candidate = planSegments([d("2026-10-10", 3), d("2026-10-12", 3)]);
    expect(findOverlaps(mill, ordinary, candidate[0].start, candidate[1].end, undefined, candidate)).toEqual([]);
    expect(findOverlaps(mill, ordinary, candidate[0].start, candidate[1].end)).toHaveLength(1); // as one block it would clash
    const onSunday = planSegments([d("2026-10-11", 2)]);
    expect(findOverlaps(mill, ordinary, onSunday[0].start, onSunday[0].end, undefined, onSunday)).toHaveLength(1);
  });
});

describe("validating the Split by day rows", () => {
  const rows = (...r: [string, string, string][]) => r.map(([date, start, end]) => ({ date, start, end }));
  const message = (r: ReturnType<typeof validateDayPlan>) => (r.ok ? "ok" : r.message);

  it("accepts rows that add up to the minute, sorted by date, and saves the estimate", () => {
    const r = validateDayPlan(rows(["2026-10-11", "08:00", "10:00"], ["2026-10-10", "05:00", "11:00"]), 8);
    expect(r).toEqual({ ok: true, plan: [{ date: "2026-10-10", start: "05:00", end: "11:00" }, { date: "2026-10-11", start: "08:00", end: "10:00" }], minutes: 480, estimatedHours: 8 });
  });

  it("minutes are the source of truth: 3.33h is 200 minutes, and a float artefact estimate (1.1 + 2.2) is 198", () => {
    expect(validateDayPlan(rows(["2026-10-10", "08:00", "11:20"]), 3.33).ok).toBe(true);
    expect(message(validateDayPlan(rows(["2026-10-10", "08:00", "11:19"]), 3.33))).toBe("The days add up to 3h 19m but the job is 3h 20m (1m short). Make them match to save.");
    const r = validateDayPlan(rows(["2026-10-10", "08:00", "09:06"], ["2026-10-11", "08:00", "10:12"]), 1.1 + 2.2);
    expect(r.ok && r.estimatedHours).toBe(3.3);
  });

  it("an end of 00:00 (a time input can't show 24:00) is midnight and is stored as 24:00; 00:00 to 00:00 is a whole day", () => {
    const r = validateDayPlan(rows(["2026-10-12", "22:00", "00:00"], ["2026-10-13", "00:00", "06:00"]), 8);
    expect(r.ok && r.plan).toEqual([{ date: "2026-10-12", start: "22:00", end: "24:00" }, { date: "2026-10-13", start: "00:00", end: "06:00" }]);
    expect(validateDayPlan(rows(["2026-10-12", "00:00", "00:00"]), 24).ok).toBe(true);
  });

  it("refuses an end at or before the start (no overnight wrap) and missing times", () => {
    expect(message(validateDayPlan(rows(["2026-10-10", "22:00", "06:00"]), 8))).toMatch(/Sat 10 Oct ends at or before it starts.*next day/);
    expect(message(validateDayPlan(rows(["2026-10-10", "08:00", "08:00"]), 8))).toMatch(/ends at or before it starts/);
    expect(message(validateDayPlan(rows(["2026-10-10", "", "16:00"]), 8))).toMatch(/Enter a start and end time for Sat 10 Oct/);
    expect(message(validateDayPlan(rows(["2026-10-10", "08:00", ""]), 8))).toMatch(/Enter a start and end time/);
  });

  it("refuses dates outside 2000 to 2100, as the database does", () => {
    expect(message(validateDayPlan(rows(["1999-12-31", "08:00", "16:00"]), 8))).toMatch(/1999-12-31 is out of range.*2000 to 2100/);
    expect(message(validateDayPlan(rows(["2101-01-01", "08:00", "16:00"]), 8))).toMatch(/2101-01-01 is out of range/);
    expect(validateDayPlan(rows(["2000-01-01", "08:00", "12:00"], ["2100-12-31", "08:00", "12:00"]), 8).ok).toBe(true);
  });

  it("blocks a total that doesn't match, saying by how much", () => {
    const short = validateDayPlan(rows(["2026-10-10", "08:00", "14:00"], ["2026-10-11", "08:00", "09:30"]), 8);
    expect(message(short)).toBe("The days add up to 7h 30m but the job is 8h (30m short). Make them match to save.");
    expect(short.minutes).toBe(450);
    expect(message(validateDayPlan(rows(["2026-10-10", "08:00", "14:00"], ["2026-10-11", "08:00", "11:00"]), 8))).toContain("(1h over)");
  });

  it("blocks no rows, a missing or impossible date, a repeated date, too many days, and no estimate", () => {
    expect(message(validateDayPlan([], 8))).toMatch(/Add at least one day/);
    expect(message(validateDayPlan(rows(["", "08:00", "16:00"]), 8))).toMatch(/Pick a date/);
    expect(message(validateDayPlan(rows(["2026-02-30", "08:00", "16:00"]), 8))).toMatch(/Pick a date/);
    expect(message(validateDayPlan(rows(["2026-10-10", "08:00", "12:00"], ["2026-10-10", "13:00", "17:00"]), 8))).toMatch(/Sat 10 Oct is listed twice/);
    expect(message(validateDayPlan(rows(["2026-10-10", "08:00", "16:00"]), 0))).toMatch(/estimated hours first/);
    expect(message(validateDayPlan(rows(["2026-10-10", "08:00", "16:00"]), 8.333))).toMatch(/2 decimal places/);
    const days = (n: number) => Array.from({ length: n }, (_, i) => ({ date: addDaysToDate("2026-10-01", i), start: "08:00", end: "09:00" }));
    expect(message(validateDayPlan(days(63), 63))).toMatch(/at most 62/);
    expect(validateDayPlan(days(62), 62).ok).toBe(true);
  });

  it("a long day outside working hours is allowed: working hours never block", () => {
    expect(validateDayPlan(rows(["2026-10-10", "05:00", "22:00"]), 17).ok).toBe(true);
  });

  it("reads the database's plan back, and anything unreadable as no plan", () => {
    const plan = [{ date: "2026-10-10", start: "05:00", end: "13:00" }, { date: "2026-10-11", start: "22:00", end: "24:00" }];
    expect(dayPlanFromRow(plan)).toEqual(plan);
    expect(dayPlanFromRow(null)).toBeNull();
    expect(dayPlanFromRow([])).toBeNull();
    expect(dayPlanFromRow([{ date: "2026-10-10", hours: 6 }])).toBeNull();
    expect(dayPlanFromRow([{ date: "2026-10-10", start: "13:00", end: "05:00" }])).toBeNull();
    expect(formatDayPlan(plan)).toBe("Sat 10 Oct 05:00-13:00 (8h), Sun 11 Oct 22:00-24:00 (2h)");
  });

  it("formats minutes exactly", () => {
    expect([formatMinutes(1020), formatMinutes(200), formatMinutes(45), formatMinutes(0)]).toEqual(["17h", "3h 20m", "45m", "0h"]);
  });
});

describe("a day of a plan against the company's working hours (display only)", () => {
  const hours = { workStart: "08:00", workEnd: "16:00", workDays: [1, 2, 3, 4, 5] };

  it("05:00 to 22:00 on a Monday is 17h: basic 8h, out of hours 9h", () => {
    expect(dayHoursSplit({ date: "2026-10-12", start: "05:00", end: "22:00" }, hours)).toEqual({ total: 1020, basic: 480, outOfHours: 540, workingDay: true });
  });

  it("inside, partly outside and wholly outside the working hours", () => {
    expect(dayHoursSplit({ date: "2026-10-12", start: "09:00", end: "12:00" }, hours)).toEqual({ total: 180, basic: 180, outOfHours: 0, workingDay: true });
    expect(dayHoursSplit({ date: "2026-10-12", start: "05:00", end: "13:00" }, hours)).toMatchObject({ basic: 300, outOfHours: 180 });
    expect(dayHoursSplit({ date: "2026-10-12", start: "22:00", end: "24:00" }, hours)).toMatchObject({ basic: 0, outOfHours: 120 });
  });

  it("a Saturday is not a working day: all of it is out of hours", () => {
    expect(dayHoursSplit({ date: "2026-10-10", start: "08:00", end: "14:00" }, hours)).toEqual({ total: 360, basic: 0, outOfHours: 360, workingDay: false });
    expect(dayHoursSplit({ date: "2026-10-10", start: "08:00", end: "14:00" }, { ...hours, workDays: [1, 2, 3, 4, 5, 6] }).workingDay).toBe(true);
    expect(dayHoursSplit({ date: "2026-10-11", start: "08:00", end: "14:00" }, { ...hours, workDays: [7] })).toMatchObject({ basic: 360, workingDay: true });
  });

  it("uses the company's own hours: 07:00 to 15:30", () => {
    expect(dayHoursSplit({ date: "2026-10-12", start: "05:00", end: "22:00" }, { ...hours, workStart: "07:00", workEnd: "15:30" })).toMatchObject({ basic: 510, outOfHours: 510 });
  });

  it("each day uses its own hours: JNR works Mon-Thu 08:00-16:00 and Fri 08:00-14:30", () => {
    const jnr = { workStart: "08:00", workEnd: "16:00", workDays: [1, 2, 3, 4, 5], workHoursByDay: { 1: { start: "08:00", end: "16:00" }, 2: { start: "08:00", end: "16:00" }, 3: { start: "08:00", end: "16:00" }, 4: { start: "08:00", end: "16:00" }, 5: { start: "08:00", end: "14:30" } } };
    // Friday 16 Oct 2026: 08:00-16:00 is 8h, of which 6h 30m is basic (to 14:30) and 1h 30m out of hours.
    expect(dayHoursSplit({ date: "2026-10-16", start: "08:00", end: "16:00" }, jnr)).toEqual({ total: 480, basic: 390, outOfHours: 90, workingDay: true });
    // The same booking on Thursday 15 Oct is all basic.
    expect(dayHoursSplit({ date: "2026-10-15", start: "08:00", end: "16:00" }, jnr)).toEqual({ total: 480, basic: 480, outOfHours: 0, workingDay: true });
    // Friday after 14:30 is all out of hours; Saturday is not a working day.
    expect(dayHoursSplit({ date: "2026-10-16", start: "14:30", end: "17:00" }, jnr)).toMatchObject({ basic: 0, outOfHours: 150 });
    expect(dayHoursSplit({ date: "2026-10-17", start: "08:00", end: "12:00" }, jnr)).toMatchObject({ basic: 0, workingDay: false });
  });

  it("a worked day with no per-day entry uses workStart..workEnd", () => {
    const old = { workStart: "07:00", workEnd: "15:30", workDays: [1, 2, 3, 4, 5] };
    expect(dayHoursSplit({ date: "2026-10-16", start: "05:00", end: "22:00" }, old)).toMatchObject({ basic: 510, outOfHours: 510 });
  });

  it("builds local moments, 24:00 being the next midnight", () => {
    const end = localMoment("2026-10-12", "24:00")!;
    expect([end.getDate(), end.getHours(), end.getMinutes()]).toEqual([13, 0, 0]);
    expect(localMoment("2026-10-12", "25:00")).toBeNull();
    expect(localMoment("2026-02-30", "08:00")).toBeNull();
  });

  it("moves dates by calendar days across a clock change", () => {
    expect(addDaysToDate("2026-10-24", 2)).toBe("2026-10-26");
    expect(addDaysToDate("2026-03-28", 2)).toBe("2026-03-30");
    expect(daysBetweenDates("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetweenDates("2026-03-28", "2026-03-30")).toBe(2);
  });
});

describe("Booked, not started (display only)", () => {
  const now = new Date("2026-10-21T12:00:00Z");
  const b = (over: Partial<{ status: "booked" | "running" | "complete"; hoursDone: number; start: Date }> = {}) => ({ status: "booked" as const, hoursDone: 0, start: new Date("2026-10-21T08:00:00Z"), ...over });

  it("a booked booking whose start has passed with no run started reads Booked, not started", () => {
    expect(bookedNotStarted(b(), now)).toBe(true);
    expect(bookedNotStarted(b({ start: now }), now)).toBe(true);
  });
  it("a booking still to come is plain Booked", () => {
    expect(bookedNotStarted(b({ start: new Date("2026-10-21T13:00:00Z") }), now)).toBe(false);
  });
  it("running, complete, or a booking that has had hours done (paused) is not 'not started'", () => {
    expect(bookedNotStarted(b({ status: "running" }), now)).toBe(false);
    expect(bookedNotStarted(b({ status: "complete" }), now)).toBe(false);
    expect(bookedNotStarted(b({ hoursDone: 1.5 }), now)).toBe(false);
  });
  it("the machine stays occupied: a past-start booked booking still blocks from now, status unchanged", () => {
    const m = { id: "m1", name: "Mill", type: "Mill", hoursPerDay: 8, workingDays: [0, 1, 2, 3, 4, 5, 6], active: true };
    const booking: Booking = { id: "b1", machineId: "m1", jobId: null, jobNo: "J-1", description: "", startAt: "2026-10-21T08:00:00Z", estimatedHours: 2, hoursDone: 0, status: "booked", notes: "" };
    const scheduled = scheduleBooking(booking, m, now);
    expect(scheduled.status).toBe("booked");
    expect(scheduled.finish.getTime()).toBeGreaterThan(now.getTime());
    expect(machineStatus(m, [scheduled], now).nextFree.getTime()).toBeGreaterThanOrEqual(scheduled.finish.getTime());
  });
});
