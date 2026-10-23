import { describe, expect, it } from "vitest";

import { autoBookedLines, databaseAutoBooks, notBookedYet, ukDateTime } from "@/lib/auto-booking";

describe("auto-booking messages (migration 061)", () => {
  it("formats in UK time whatever the device's zone: BST before 25 Oct, GMT after", () => {
    expect(ukDateTime("2026-10-20T09:00:00Z")).toBe("Tue 20 Oct 10:00");
    expect(ukDateTime("2026-10-26T09:00:00Z")).toBe("Mon 26 Oct 09:00");
  });

  it("names each machine the database booked at its next free slot, with its start and finish", () => {
    const lines = autoBookedLines([
      { machine_id: "m1", machine: "Mill", hours: 4, start_at: "2026-10-20T09:00:00Z", booking_id: "b1", auto_booked: true, finish_at: "2026-10-20T13:00:00Z" },
      { machine_id: "m2", machine: "Lathe", hours: 3, start_at: "2026-10-21T07:00:00Z", booking_id: "b2", auto_booked: false, finish_at: "2026-10-21T10:00:00Z" },
      { machine_id: "m3", machine: "Saw", hours: 0, start_at: null, booking_id: null, auto_booked: false, finish_at: null },
    ], (id) => (id === "m1" ? "Mill 1" : undefined));
    expect(lines).toEqual(["Mill 1: Booked on the schedule from Tue 20 Oct 10:00 until Tue 20 Oct 14:00"]);
  });

  it("tells a database that auto-books (061 keys) from one that doesn't, and finds new machines left unbooked", () => {
    expect(databaseAutoBooks([{ machine_id: "m1", hours: 1, start_at: null, booking_id: null, auto_booked: false }])).toBe(true);
    const old = [{ machine_id: "m1", hours: 2, start_at: null, booking_id: null }, { machine_id: "m2", hours: 0, start_at: null, booking_id: null },
      { machine_id: "m3", hours: 2, start_at: null, booking_id: null }];
    expect(databaseAutoBooks(old)).toBe(false);
    expect(databaseAutoBooks(null)).toBe(false);
    expect(notBookedYet(old, new Set(["m1", "m2"])).map((m) => m.machine_id)).toEqual(["m1"]);
  });
});
