/**
 * A split day on a clock-change day, in the UK time zone (BST starts Sun 29 Mar 2026 at 01:00 GMT: 01:00 to 01:59 doesn't exist; it ends
 * Sun 25 Oct 2026). The form builds every time with new Date(y, m, d, hh, mm) in the browser's own zone, so a time that doesn't exist is
 * refused with a readable message; the database can't know the zone and doesn't check this.
 */
process.env.TZ = "Europe/London";

import { describe, expect, it } from "vitest";

import { localMoment, planSegments, validateDayPlan } from "@/lib/machine-schedule";

describe("clock changes in Europe/London", () => {
  it("runs in the UK zone", () => {
    expect(new Date(2026, 6, 1, 12, 0).getTimezoneOffset()).toBe(-60);
    expect(new Date(2026, 0, 1, 12, 0).getTimezoneOffset()).toBe(0);
  });

  it("01:30 on 29 March 2026 doesn't exist and is refused, as a start or as an end", () => {
    expect(localMoment("2026-03-29", "01:30")).toBeNull();
    expect(localMoment("2026-03-29", "02:00")).not.toBeNull();
    const start = validateDayPlan([{ date: "2026-03-29", start: "01:30", end: "09:30" }], 8);
    expect(!start.ok && start.message).toBe("The start time 01:30 doesn't exist on Sun 29 Mar: the clocks go forward that night. Pick a time outside the skipped hour.");
    const end = validateDayPlan([{ date: "2026-03-29", start: "00:00", end: "01:30" }], 1.5);
    expect(!end.ok && end.message).toMatch(/The end time 01:30 doesn't exist on Sun 29 Mar/);
    expect(validateDayPlan([{ date: "2026-03-28", start: "01:30", end: "09:30" }], 8).ok).toBe(true);
  });

  it("minutes are wall-clock minutes: 00:00 to 04:00 on 29 March counts 4h though only 3h pass", () => {
    const r = validateDayPlan([{ date: "2026-03-29", start: "00:00", end: "04:00" }], 4);
    expect(r.ok).toBe(true);
    const [seg] = planSegments([{ date: "2026-03-29", start: "00:00", end: "04:00" }]);
    expect(seg.minutes).toBe(240);
    expect((seg.end.getTime() - seg.start.getTime()) / 60000).toBe(180);
  });

  it("the autumn change keeps each day's wall-clock times (25 October 2026)", () => {
    const segs = planSegments([{ date: "2026-10-24", start: "08:00", end: "16:00" }, { date: "2026-10-25", start: "05:00", end: "13:00" }]);
    expect(segs.map((s) => [s.start.getDate(), s.start.getHours(), s.end.getHours()])).toEqual([[24, 8, 16], [25, 5, 13]]);
    expect(validateDayPlan([{ date: "2026-10-25", start: "01:30", end: "09:30" }], 8).ok).toBe(true);
  });
});
