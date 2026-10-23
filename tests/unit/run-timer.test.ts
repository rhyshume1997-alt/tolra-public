import { describe, expect, it } from "vitest";
import { planBooking } from "@/lib/run-plan";
import { formatHoursClock, hoursLeft, hoursLeftSigned, liveLeftText, runClock, runTimerText } from "@/lib/machine-schedule";

const START = "2026-10-21T08:00:00Z";
const at = (minutesAfterStart: number) => new Date(new Date(START).getTime() + minutesAfterStart * 60_000);
const booking = (estimatedHours: number, hoursDone = 0, status: "booked" | "running" | "complete" = "running") => ({ estimatedHours, hoursDone, status });

describe("hoursLeft (shared with the Machine Schedule)", () => {
  it("is unchanged without a live run, and floors at zero", () => {
    expect(hoursLeft(booking(6, 1))).toBe(5);
    expect(hoursLeft(booking(2, 3))).toBe(0);
    expect(hoursLeft(booking(6, 1, "complete"))).toBe(0);
  });
  it("takes this run's time off, and the signed form goes negative past the estimate", () => {
    expect(hoursLeft(booking(6, 1), 1.5)).toBe(3.5);
    expect(hoursLeftSigned(booking(2, 1), 1.5)).toBe(-0.5);
    expect(hoursLeft(booking(2, 1), 1.5)).toBe(0);
  });
});

describe("runClock", () => {
  it("elapsed counts from the run's started_at, whole minutes", () => {
    expect(runClock(START, booking(6), at(85))?.elapsedMinutes).toBe(85);
    expect(runClock(START, booking(6), new Date(at(0).getTime() + 59_999))?.elapsedMinutes).toBe(0);
  });
  it("left = estimate - hours done - this run so far", () => {
    // 6 h booked, 1 h done on earlier runs, this run 1 h 25 m: 3 h 35 m left.
    expect(runClock(START, booking(6, 1), at(85))).toEqual({ elapsedMinutes: 85, leftMinutes: 215 });
  });
  it("ticks down one minute per minute", () => {
    const a = runClock(START, booking(2), at(30))!.leftMinutes!;
    const b = runClock(START, booking(2), at(31))!.leftMinutes!;
    expect(a - b).toBe(1);
  });
  it("goes negative (over) once past the estimate", () => {
    expect(runClock(START, booking(1), at(80))?.leftMinutes).toBe(-20);
  });
  it("no booking, a complete booking, or no estimate: elapsed only", () => {
    expect(runClock(START, null, at(10))).toEqual({ elapsedMinutes: 10, leftMinutes: null });
    expect(runClock(START, undefined, at(10))?.leftMinutes).toBeNull();
    expect(runClock(START, booking(0), at(10))?.leftMinutes).toBeNull();
    expect(runClock(START, booking(6, 6, "complete"), at(10))?.leftMinutes).toBeNull();
  });
  it("a start in the future (clock skew) is zero elapsed, never negative; a bad start shows nothing", () => {
    expect(runClock(START, booking(2), at(-5))).toEqual({ elapsedMinutes: 0, leftMinutes: 120 });
    expect(runClock("not a date", booking(2), at(5))).toBeNull();
  });
  it("paused: the run's time is in hoursDone and there is no open run, so the stored figure is fixed and the same at any time", () => {
    // 6 h booked, 2.5 h done (the paused run included): 3.5 h left now, and still 3.5 h an hour later (nothing ticks without a run).
    expect(hoursLeft(booking(6, 2.5, "booked"))).toBe(3.5);
    expect(formatHoursClock(hoursLeft(booking(6, 2.5, "booked")))).toBe("3:30");
  });
});

describe("on-screen words", () => {
  it("left, over and elapsed as h:mm", () => {
    expect(liveLeftText(215)).toBe("3:35 left");
    expect(liveLeftText(0)).toBe("0:00 left");
    expect(liveLeftText(-20)).toBe("0:20 over");
    expect(liveLeftText(-125)).toBe("2:05 over");
  });
  it("the Job Board line", () => {
    expect(runTimerText({ elapsedMinutes: 85, leftMinutes: 215 })).toBe("running for 1:25, 3:35 left");
    expect(runTimerText({ elapsedMinutes: 260, leftMinutes: -20 })).toBe("running for 4:20, 0:20 over");
    expect(runTimerText({ elapsedMinutes: 5, leftMinutes: null })).toBe("running for 0:05");
  });
  it("the Schedule's Hours left and the Board's left are the same words for the same moment", () => {
    const clock = runClock(START, booking(3, 0.5), at(45))!;
    expect(runTimerText(clock)).toBe(`running for 0:45, ${liveLeftText(clock.leftMinutes!)}`);
    expect(liveLeftText(clock.leftMinutes!)).toBe("1:45 left");
  });
});

describe("formatHoursClock", () => {
  it("hours as h:mm", () => {
    expect(formatHoursClock(6)).toBe("6:00");
    expect(formatHoursClock(2.5)).toBe("2:30");
    expect(formatHoursClock(0.25)).toBe("0:15");
  });
});

describe("a run with no booking (plan hours stand in)", () => {
  it("shows left from the plan hours, and only elapsed when none are planned", () => {
    expect(runTimerText(runClock(START, planBooking({ planHours: 4, hoursDone: 0 }), at(85))!)).toBe("running for 1:25, 2:35 left");
    expect(runTimerText(runClock(START, planBooking(undefined), at(85))!)).toBe("running for 1:25");
    expect(runTimerText(runClock(START, planBooking({ planHours: 0, hoursDone: 0 }), at(85))!)).toBe("running for 1:25");
  });
  it("paused and resumed: the earlier runs' hours are taken off", () => {
    // 4 h planned, 1 h run before the Pause, this run 1:25: 1:35 left.
    expect(runTimerText(runClock(START, planBooking({ planHours: 4, hoursDone: 1 }), at(85))!)).toBe("running for 1:25, 1:35 left");
  });
});
