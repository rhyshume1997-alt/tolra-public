import { describe, expect, it } from "vitest";

import { parseWorkingHours } from "@/lib/company";
import { BREAK_MINUTES, LUNCH_MINUTES, MIN_DAY_HOURS, formatHoursMinutes, paidDay, paidWeek, workingHoursLabel } from "@/lib/working-hours";

// JNR: Monday to Thursday 08:00-16:00, Friday 08:00-14:30, breaks unpaid. Hand-worked, not derived from the code:
//   Mon-Thu: 8:00 at work, less 0:45 = 7:15 paid, each. Fri: 6:30 at work, less 0:45 = 5:45 paid.
//   Week: at work 4 x 8:00 + 6:30 = 38:30; breaks 5 x 0:45 = 3:45; paid 4 x 7:15 + 5:45 = 34:45.
const jnr = { 1: { start: "08:00", end: "16:00" }, 2: { start: "08:00", end: "16:00" }, 3: { start: "08:00", end: "16:00" }, 4: { start: "08:00", end: "16:00" }, 5: { start: "08:00", end: "14:30" } };

describe("paid hours (display only)", () => {
  it("uses the job sheet's break rule", () => {
    expect([LUNCH_MINUTES, BREAK_MINUTES, MIN_DAY_HOURS]).toEqual([30, 15, 6]);
  });

  it("JNR: Mon-Thu 7:15 each, Fri 5:45, week 34:45 paid (38:30 at work, 3:45 breaks)", () => {
    for (const day of [1, 2, 3, 4]) expect(formatHoursMinutes(paidDay(jnr[day as 1].start, jnr[day as 1].end)!.paid)).toBe("7:15");
    expect(formatHoursMinutes(paidDay("08:00", "14:30")!.paid)).toBe("5:45");
    const week = paidWeek(Object.values(jnr));
    expect([formatHoursMinutes(week.atWork), formatHoursMinutes(week.breaks), formatHoursMinutes(week.paid)]).toEqual(["38:30", "3:45", "34:45"]);
  });

  it("a day of 6 hours or more at work loses lunch and break; a shorter day loses nothing", () => {
    expect(paidDay("08:00", "14:00")).toEqual({ atWork: 360, breaks: 45, paid: 315 });
    expect(paidDay("08:00", "13:59")).toEqual({ atWork: 359, breaks: 0, paid: 359 });
    expect(paidDay("08:00", "12:00")).toEqual({ atWork: 240, breaks: 0, paid: 240 });
  });

  it("an end of 00:00 or 24:00 is midnight", () => {
    expect(paidDay("16:00", "00:00")).toEqual({ atWork: 480, breaks: 45, paid: 435 });
    expect(paidDay("16:00", "24:00")).toEqual({ atWork: 480, breaks: 45, paid: 435 });
  });

  it("anything that isn't a start before a finish is not a day", () => {
    expect(paidDay("", "16:00")).toBeNull();
    expect(paidDay("08:00", "")).toBeNull();
    expect(paidDay("16:00", "08:00")).toBeNull();
    expect(paidDay("08:00", "08:00")).toBeNull();
    expect(paidDay("00:00", "00:00")).toBeNull();
    expect(paidDay("8:00", "16:00")).toBeNull();
  });

  it("the week skips days that aren't valid or aren't worked", () => {
    expect(paidWeek([{ start: "08:00", end: "16:00" }, { start: "16:00", end: "08:00" }, null, undefined])).toEqual({ atWork: 480, breaks: 45, paid: 435 });
    expect(paidWeek([])).toEqual({ atWork: 0, breaks: 0, paid: 0 });
  });

  it("formats minutes as h:mm", () => {
    expect([0, 5, 60, 435, 2085, 2310].map(formatHoursMinutes)).toEqual(["0:00", "0:05", "1:00", "7:15", "34:45", "38:30"]);
  });
});

describe("working hours label", () => {
  it("JNR: Mon–Thu 08:00–16:00, Fri 08:00–14:30", () => {
    expect(workingHoursLabel(parseWorkingHours({ workStart: "08:00", workEnd: "16:00", workDays: [1, 2, 3, 4, 5], workHoursByDay: jnr }))).toBe("Mon–Thu 08:00–16:00, Fri 08:00–14:30");
  });

  it("an old profile joins its days: Mon–Fri 08:00–16:00", () => {
    expect(workingHoursLabel(parseWorkingHours({}))).toBe("Mon–Fri 08:00–16:00");
  });

  it("one or two days are named, gaps split a run, midnight reads 00:00", () => {
    expect(workingHoursLabel(parseWorkingHours({ workDays: [1, 2] }))).toBe("Mon, Tue 08:00–16:00");
    expect(workingHoursLabel(parseWorkingHours({ workDays: [1, 2, 4, 5, 7] }))).toBe("Mon, Tue 08:00–16:00, Thu, Fri 08:00–16:00, Sun 08:00–16:00");
    expect(workingHoursLabel(parseWorkingHours({ workDays: [6], workHoursByDay: { 6: { start: "14:00", end: "24:00" } } }))).toBe("Sat 14:00–00:00");
  });
});
