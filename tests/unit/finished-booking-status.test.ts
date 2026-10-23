/** B31: a booking whose job is finished (or which is complete) never reads "booked" on the schedule or the Job Board. */
import { describe, expect, it } from "vitest";

import { chipBookingSuffix } from "@/lib/job-machine-plan";
import { completeFinishedJobBookings, type Booking } from "@/lib/machine-schedule";

describe("chipBookingSuffix", () => {
  it("says booked only for a still-booked booking on an open job", () => {
    expect(chipBookingSuffix({ state: "booked", booked: true }, false)).toBe(" (booked)");
    expect(chipBookingSuffix({ state: "running", booked: false }, false)).toBe(" (running)");
    expect(chipBookingSuffix({ state: "complete", booked: false }, false)).toBe(" (done)");
    expect(chipBookingSuffix({ state: "booked", booked: true }, true)).toBe(" (done)");
    expect(chipBookingSuffix({ state: null, booked: false }, false)).toBe("");
    expect(chipBookingSuffix({ state: null, booked: false }, true)).toBe("");
  });
  it("an old cached chip with only the booked flag still reads booked", () => {
    expect(chipBookingSuffix({ booked: true }, false)).toBe(" (booked)");
    expect(chipBookingSuffix({ booked: false }, false)).toBe("");
  });
});

describe("completeFinishedJobBookings", () => {
  const b = (id: string, jobId: string | null, status: Booking["status"]) => ({ id, jobId, status }) as Booking;
  it("completes an open booking of a finished job and leaves the rest alone", () => {
    const out = completeFinishedJobBookings([b("1", "j1", "booked"), b("2", "j1", "running"), b("3", "j2", "booked"), b("4", null, "booked"), b("5", "j1", "complete")],
      [{ id: "j1", finishedAt: "2026-10-14T10:00:00Z" }, { id: "j2", finishedAt: "" }]);
    expect(out.map((x) => x.status)).toEqual(["complete", "complete", "booked", "booked", "complete"]);
  });
  it("returns the same list when no job is finished", () => {
    const list = [b("1", "j1", "booked")];
    expect(completeFinishedJobBookings(list, [{ id: "j1" }])).toBe(list);
  });
});
