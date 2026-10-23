/** Bookings for a new job made on the Job Board (migration 042): one per machine, in parallel, from the next free slot, with clashes. */
import { describe, expect, it } from "vitest";

import { type Booking, type Machine, defaultJobStart, planJobBookings, scheduleAll } from "@/lib/machine-schedule";

const machine = (id: string, over: Partial<Machine> = {}): Machine => ({ id, name: id, type: "", hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5], active: true, ...over });
const booking = (id: string, machineId: string, startAt: Date, hours: number, jobNo = `J-${id}`): Booking => ({
  id, machineId, jobId: null, jobNo, description: "", startAt: startAt.toISOString(), estimatedHours: hours, hoursDone: 0, status: "booked", notes: "",
});
// Monday 2 November 2026, 07:00 local: before the working day starts.
const NOW = new Date(2026, 10, 2, 7, 0, 0);
const at = (day: number, hour: number) => new Date(2026, 10, day, hour, 0, 0);

describe("planJobBookings", () => {
  const mill = machine("mill");
  const lathe = machine("lathe");
  const machines = [mill, lathe];

  it("books every machine in parallel from its own next free slot by default", () => {
    // The mill is busy Monday 08:00 to 12:00; the lathe is free.
    const scheduled = scheduleAll([booking("1", "mill", at(2, 8), 4)], machines, NOW);
    expect(defaultJobStart(mill, scheduled, NOW)).toEqual(at(2, 8));
    const plan = planJobBookings([{ machineId: "mill", hours: 2 }, { machineId: "lathe", hours: 10 }], machines, scheduled, NOW);
    expect(plan.bookings.map((b) => [b.machine.id, b.start, b.finish])).toEqual([
      ["mill", at(2, 8), at(2, 10)],
      ["lathe", at(2, 8), at(3, 10)],
    ]);
    // Not started yet at 07:00, so the mill's next free slot (the schedule dialog's default too) is 08:00, over that booking: a clash.
    expect(plan.clashes).toEqual([{ machine_id: "mill", job_no: "J-1" }]);
    expect(plan.payload).toEqual([
      { machine_id: "mill", hours: 2, start_at: at(2, 8).toISOString() },
      { machine_id: "lathe", hours: 10, start_at: at(2, 8).toISOString() },
    ]);
  });

  it("follows the busy machine to its next free time once its booking has started (hours left counted from now)", () => {
    const now = at(2, 9);
    const scheduled = scheduleAll([booking("1", "mill", at(2, 8), 4)], machines, now);
    const plan = planJobBookings([{ machineId: "mill", hours: 2 }], machines, scheduled, now);
    expect(plan.bookings[0].start).toEqual(at(2, 13));
    expect(plan.clashes).toEqual([]);
  });

  it("reports a clash per machine and job number for a start chosen by hand, and none for a free slot", () => {
    const scheduled = scheduleAll([booking("1", "mill", at(3, 8), 8, "J-0007"), booking("2", "mill", at(4, 8), 8, "J-0008")], machines, NOW);
    const plan = planJobBookings([{ machineId: "mill", hours: 12, start: at(3, 12) }, { machineId: "lathe", hours: 4, start: at(3, 12) }], machines, scheduled, NOW);
    expect(plan.bookings[0].finish).toEqual(at(4, 16));
    expect(plan.clashes).toEqual([{ machine_id: "mill", job_no: "J-0007" }, { machine_id: "mill", job_no: "J-0008" }]);
    expect(plan.bookings[1].clashes).toEqual([]);
  });

  it("ignores complete bookings, unknown machines and zero hours", () => {
    const done = { ...booking("1", "mill", at(3, 8), 8), status: "complete" as const };
    const scheduled = scheduleAll([done], machines, NOW);
    const plan = planJobBookings([{ machineId: "mill", hours: 4, start: at(3, 8) }, { machineId: "gone", hours: 2 }, { machineId: "lathe", hours: 0, start: at(3, 8) }], machines, scheduled, NOW);
    expect(plan.bookings.map((b) => [b.machine.id, b.hours, b.clashes.length])).toEqual([["mill", 4, 0], ["lathe", 0, 0]]);
    expect(plan.bookings[1].finish).toEqual(at(3, 8));
  });

  it("on a Saturday night the next free slot is Monday 08:00 (why the e2e clash fixture sits a week out, never two days)", () => {
    // Saturday 17 October 2026, 22:25: the time the labelled e2e runs failed.
    const saturday = new Date(2026, 9, 17, 22, 25);
    const twoDaysOn = booking("1", "mill", new Date(2026, 9, 19, 9), 4);
    const scheduled = scheduleAll([twoDaysOn], machines, saturday);
    const plan = planJobBookings([{ machineId: "mill", hours: 3 }], machines, scheduled, saturday);
    expect(plan.bookings[0].start).toEqual(new Date(2026, 9, 19, 8));
    expect(plan.clashes).toEqual([{ machine_id: "mill", job_no: "J-1" }]);
    // A week on (the next weekday from Saturday 24th: Monday 26th) is clear of it.
    const weekOn = scheduleAll([booking("2", "mill", new Date(2026, 9, 26, 9), 4)], machines, saturday);
    expect(planJobBookings([{ machineId: "mill", hours: 3 }], machines, weekOn, saturday).clashes).toEqual([]);
  });

  it("starts a weekend start on consecutive days, as the schedule does", () => {
    const plan = planJobBookings([{ machineId: "mill", hours: 12, start: new Date(2026, 10, 7, 8) }], machines, [], NOW);
    expect(plan.bookings[0].finish).toEqual(new Date(2026, 10, 8, 12));
  });
});
