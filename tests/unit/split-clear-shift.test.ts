/**
 * Split by day, Start after current booking (splitClearShift), in the UK time zone so the clock change on Sun 25 Oct 2026 (01:00 to 01:59
 * happens twice) and the skipped hour on Sun 29 Mar 2026 are covered wherever the tests run.
 */
process.env.TZ = "Europe/London";

import { describe, expect, it } from "vitest";

import { DEFAULT_WORKING_DAYS, scheduleBooking, splitClearShift, type Booking, type DayPlanEntry, type Machine, type ScheduledBooking } from "@/lib/machine-schedule";

const mill: Machine = { id: "m1", name: "TEST Mill", type: "", hoursPerDay: 8, workingDays: DEFAULT_WORKING_DAYS, active: true };
const now = new Date(2026, 9, 19, 7, 0);
const book = (id: string, start: Date, hours: number, dayPlan?: DayPlanEntry[]): ScheduledBooking =>
  scheduleBooking({ id, machineId: "m1", jobId: null, jobNo: `J-${id}`, description: "", startAt: start.toISOString(), estimatedHours: hours, hoursDone: 0, status: "booked", notes: "", dayPlan: dayPlan ?? null } as Booking, mill, now);

describe("splitClearShift", () => {
  it("runs in the UK zone", () => {
    expect(new Date(2026, 6, 1, 12, 0).getTimezoneOffset()).toBe(-60);
    expect(new Date(2026, 0, 1, 12, 0).getTimezoneOffset()).toBe(0);
  });

  it("a split starting before the machine's 08:00 window moves one day, not two (Mon 06:00-10:00 against a Mon 08:00-16:00 booking lands on Tuesday)", () => {
    const scheduled = [book("A", new Date(2026, 9, 19, 8), 8)];
    expect(scheduled[0].finish).toEqual(new Date(2026, 9, 19, 16));
    expect(splitClearShift([{ date: "2026-10-19", start: "06:00", end: "10:00" }], "2026-10-19", "06:00", 4, mill, scheduled)).toEqual({ ok: true, shift: 1 });
  });

  it("keeps the gaps between the days: the whole split moves by the same number of days", () => {
    const scheduled = [book("A", new Date(2026, 9, 19, 8), 8)];
    const rows = [{ date: "2026-10-19", start: "07:00", end: "09:00" }, { date: "2026-10-21", start: "07:00", end: "09:00" }];
    expect(splitClearShift(rows, "2026-10-19", "07:00", 4, mill, scheduled)).toEqual({ ok: true, shift: 1 });
  });

  it("a clash that ends by the first day's start time keeps the same day, and a clear split needs no move", () => {
    const early = [book("E", new Date(2026, 9, 19, 3), 2, [{ date: "2026-10-19", start: "03:00", end: "05:00" }])];
    expect(splitClearShift([{ date: "2026-10-19", start: "06:00", end: "10:00" }], "2026-10-19", "06:00", 4, mill, early)).toEqual({ ok: true, shift: 0 });
    const touching = [book("T", new Date(2026, 9, 19, 4), 2, [{ date: "2026-10-19", start: "04:00", end: "06:00" }])];
    expect(splitClearShift([{ date: "2026-10-19", start: "06:00", end: "10:00" }], "2026-10-19", "06:00", 4, mill, touching)).toEqual({ ok: true, shift: 0 });
  });

  it("a clash ending after the first day's start moves to the next day even when it ends mid-morning", () => {
    const late = [book("L", new Date(2026, 9, 19, 5), 3, [{ date: "2026-10-19", start: "05:00", end: "08:00" }])];
    expect(splitClearShift([{ date: "2026-10-19", start: "06:00", end: "10:00" }], "2026-10-19", "06:00", 4, mill, late)).toEqual({ ok: true, shift: 1 });
  });

  it("works across the clock change on Sun 25 Oct 2026", () => {
    const sat = [book("S", new Date(2026, 9, 24, 8), 4, [{ date: "2026-10-24", start: "08:00", end: "12:00" }])];
    expect(splitClearShift([{ date: "2026-10-24", start: "06:00", end: "10:00" }], "2026-10-24", "06:00", 4, mill, sat)).toEqual({ ok: true, shift: 1 });
    const sun = [book("U", new Date(2026, 9, 25, 8), 8, [{ date: "2026-10-25", start: "08:00", end: "16:00" }])];
    expect(splitClearShift([{ date: "2026-10-25", start: "06:00", end: "10:00" }], "2026-10-25", "06:00", 4, mill, sun)).toEqual({ ok: true, shift: 1 });
  });

  it("a shifted plan that fails validation is not 'no clash': it stops with the validation message", () => {
    // Sat 28 Mar 2026 01:30-09:30 clashes; the next day, Sun 29 Mar, has no 01:30 (the clocks go forward that night).
    const sat = [book("S", new Date(2026, 2, 28, 8), 4, [{ date: "2026-03-28", start: "08:00", end: "12:00" }])];
    const result = splitClearShift([{ date: "2026-03-28", start: "01:30", end: "09:30" }], "2026-03-28", "01:30", 8, mill, sat);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe("invalid");
    expect(!result.ok && result.reason === "invalid" && result.message).toMatch(/The start time 01:30 doesn't exist on Sun 29 Mar/);
  });

  it("gives up as 'none' when every day is taken", () => {
    const wall = Array.from({ length: 80 }, (_, i) => book(`W${i}`, new Date(2026, 9, 19 + i, 5), 3, [{ date: new Date(2026, 9, 19 + i).toLocaleDateString("en-CA"), start: "05:00", end: "08:00" }]));
    expect(splitClearShift([{ date: "2026-10-19", start: "06:00", end: "10:00" }], "2026-10-19", "06:00", 4, mill, wall)).toEqual({ ok: false, reason: "none" });
  });
});
