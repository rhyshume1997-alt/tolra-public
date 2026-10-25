import { describe, expect, it } from "vitest";

import { DEFAULT_WORKING_DAYS, findOverlaps, scheduleBooking, startAfterBooking, toLocalInputValue, computeFinish, type Booking, type Machine } from "@/lib/machine-schedule";

const mill: Machine = { id: "m1", name: "TEST Mill", type: "", hoursPerDay: 8, workingDays: DEFAULT_WORKING_DAYS, active: true };
const booking = (over: Partial<Booking>): Booking => ({ id: "b1", machineId: "m1", jobId: null, jobNo: "J-1", description: "", startAt: new Date(2026, 9, 22, 9, 0).toISOString(), estimatedHours: 2, hoursDone: 0, status: "booked", notes: "", ...over });
const parts = (d: Date) => [d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];

describe("startAfterBooking (the booking form's Start after current booking)", () => {
  it("a clash that ends with seconds in it (a not-started booking counted from now): the new start is the next whole minute, clear of it", () => {
    // Thu 22 Oct 2026 11:12:41: a booked, 2 h booking whose start passed ends at now + 2 h, seconds included.
    const now = new Date(2026, 9, 22, 11, 12, 41);
    const clash = scheduleBooking(booking({ startAt: new Date(2026, 9, 22, 9, 0).toISOString() }), mill, now);
    expect(parts(clash.finish)).toEqual([10, 22, 13, 12, 41]);
    // What the form did before: the minute box floors 13:12:41 to 13:12, which is still inside the clash, so the button seemed to do nothing.
    const floored = new Date(toLocalInputValue(clash.finish));
    expect(findOverlaps(mill, [clash], floored, computeFinish(floored, 1, mill))).toHaveLength(1);
    const after = startAfterBooking(clash.finish, mill);
    expect(parts(after)).toEqual([10, 22, 13, 13, 0]);
    expect(findOverlaps(mill, [clash], new Date(toLocalInputValue(after)), computeFinish(after, 1, mill))).toEqual([]);
  });

  it("a whole-minute end is kept as it is", () => {
    expect(parts(startAfterBooking(new Date(2026, 9, 22, 13, 0, 0), mill))).toEqual([10, 22, 13, 0, 0]);
  });

  it("an end at the close of the working day starts the next working morning; a Friday end starts Monday", () => {
    expect(parts(startAfterBooking(new Date(2026, 9, 22, 16, 0, 0), mill))).toEqual([10, 23, 8, 0, 0]);
    expect(parts(startAfterBooking(new Date(2026, 9, 23, 16, 0, 0), mill))).toEqual([10, 26, 8, 0, 0]);
    // 15:59:30 rounds up to 16:00, which is the close: the next working morning.
    expect(parts(startAfterBooking(new Date(2026, 9, 23, 15, 59, 30), mill))).toEqual([10, 26, 8, 0, 0]);
  });

  it("a machine with no hours settings takes the end as it is (rounded up to the minute)", () => {
    expect(parts(startAfterBooking(new Date(2026, 9, 24, 13, 0, 5), { hoursPerDay: 0, workingDays: [] }))).toEqual([10, 24, 13, 1, 0]);
  });
});

describe("a not-started booking's Est. finish (the SMOKE-TEST 061 bookings on a 2 h job)", () => {
  // scheduleBooking: remaining hours are counted from NOW once the start has passed ("Booked, not started"), through the machine's working hours.
  it("started Thu 09:00, not started, seen Thu 17:30 after the machine closed: finish is Fri 10:00 (working hours), not a bug", () => {
    const b = scheduleBooking(booking({}), mill, new Date(2026, 9, 22, 17, 30));
    expect(parts(b.finish)).toEqual([10, 23, 10, 0, 0]);
  });

  it("the same booking seen at Thu 11:00 finishes Thu 13:00", () => {
    const b = scheduleBooking(booking({}), mill, new Date(2026, 9, 22, 11, 0));
    expect(parts(b.finish)).toEqual([10, 22, 13, 0, 0]);
  });

  it("other bookings on the machine do not push it (no chaining in the finish itself)", () => {
    const other = scheduleBooking(booking({ id: "b0", jobNo: "J-0", estimatedHours: 6 }), mill, new Date(2026, 9, 22, 11, 0));
    const b = scheduleBooking(booking({ id: "b2", jobNo: "J-2" }), mill, new Date(2026, 9, 22, 11, 0));
    expect(other.finish.getTime()).not.toBe(b.finish.getTime());
    expect(parts(b.finish)).toEqual([10, 22, 13, 0, 0]);
  });
});
