import { describe, expect, it } from "vitest";

import { CLEAR_START_MAX_STEPS, DEFAULT_WORKING_DAYS, computeFinish, findOverlaps, nextClearStart, scheduleBooking, startAfterBooking, type Booking, type Machine, type ScheduledBooking } from "@/lib/machine-schedule";

const mill: Machine = { id: "m1", name: "TEST Mill", type: "", hoursPerDay: 8, workingDays: DEFAULT_WORKING_DAYS, active: true };
// Monday 19 Oct 2026, before every booking below starts.
const now = new Date(2026, 9, 19, 7, 0);
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m);
const parts = (d: Date) => [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
const book = (id: string, start: Date, hours: number): ScheduledBooking =>
  scheduleBooking({ id, machineId: "m1", jobId: null, jobNo: `J-${id}`, description: "", startAt: start.toISOString(), estimatedHours: hours, hoursDone: 0, status: "booked", notes: "" } as Booking, mill, now);

/** What the booking form passes: the clashes of a `hours` job starting at `start`. */
const clashesFor = (scheduled: ScheduledBooking[], hours: number) => (start: Date) => findOverlaps(mill, scheduled, start, computeFinish(start, hours, mill));

describe("startAfterBooking", () => {
  it("rounds up to the next whole minute, then to the working hours", () => {
    expect(parts(startAfterBooking(at(22, 13, 0), mill))).toEqual([10, 22, 13, 0, 0]);
    expect(parts(startAfterBooking(new Date(2026, 9, 22, 13, 12, 41), mill))).toEqual([10, 22, 13, 13, 0]);
    expect(parts(startAfterBooking(at(23, 16, 0), mill))).toEqual([10, 26, 8, 0, 0]);
  });
});

describe("nextClearStart (Start after current booking)", () => {
  // A 09:00-11:00, B 11:00-13:00, C 13:30-15:00 on an 8 h Mon-Fri machine (08:00-16:00).
  const scheduled = [book("A", at(19, 9), 2), book("B", at(19, 11), 2), book("C", at(19, 13, 30), 1.5)];

  it("a 2 h job from 09:30 clears every chained booking: it lands at 15:00 or later with no overlap left", () => {
    expect(clashesFor(scheduled, 2)(at(19, 9, 30)).map((b) => b.id)).toEqual(["A", "B"]);
    const clear = nextClearStart(at(19, 9, 30), mill, clashesFor(scheduled, 2))!;
    expect(clear).not.toBeNull();
    expect(clear.getTime()).toBeGreaterThanOrEqual(at(19, 15).getTime());
    expect(clashesFor(scheduled, 2)(clear)).toEqual([]);
    expect(parts(clear)).toEqual([10, 19, 15, 0, 0]);
  });

  it("one step is not enough: the end of the first clash (13:00) still clashes with C", () => {
    expect(clashesFor(scheduled, 2)(startAfterBooking(at(19, 13), mill)).map((b) => b.id)).toEqual(["C"]);
  });

  it("a start that clashes with nothing is returned as it is", () => {
    expect(nextClearStart(at(20, 8), mill, clashesFor(scheduled, 2))).toEqual(at(20, 8));
  });

  it("gives up with null after the cap when there is always another clash", () => {
    // 120 back-to-back one-hour bookings from Monday 08:00: a 2 h job moves on 2 h a step, so 50 steps cannot clear them.
    const wall: ScheduledBooking[] = [];
    let cursor = at(19, 8);
    for (let i = 0; i < 120; i++) {
      const next = book(`W${i}`, cursor, 1);
      wall.push(next);
      cursor = startAfterBooking(next.finish, mill);
    }
    let calls = 0;
    const clashes = (start: Date) => { calls += 1; return clashesFor(wall, 2)(start); };
    expect(nextClearStart(at(19, 8), mill, clashes)).toBeNull();
    expect(calls).toBe(CLEAR_START_MAX_STEPS);
    expect(nextClearStart(at(19, 8), mill, clashesFor(wall, 2), { maxSteps: 200 })).not.toBeNull();
  });
});
