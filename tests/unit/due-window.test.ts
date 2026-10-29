/** The Dashboard's "due within 7 days" window (lib/dates dueWindow): UK calendar days, right across both clock changes. */
import { describe, expect, it } from "vitest";

import { dueWindow, fmtDueBy } from "@/lib/dates";

describe("dueWindow", () => {
  it("is today to 7 calendar days on, in UK time", () => {
    expect(dueWindow(new Date("2026-10-29T12:00:00Z"))).toEqual({ today: "2026-10-29", end: "2026-11-05" });
    // 23:30 in summer is still the same UK day (22:30 UTC).
    expect(dueWindow(new Date("2026-07-01T22:30:00Z"))).toEqual({ today: "2026-07-01", end: "2026-07-08" });
    // 00:30 in summer is already the next UK day (23:30 UTC the day before).
    expect(dueWindow(new Date("2026-07-01T23:30:00Z"))).toEqual({ today: "2026-07-02", end: "2026-07-09" });
  });

  it("clocks go forward (Sun 29 Mar 2026): 7 x 24 hours would end a day late", () => {
    // Sat 28 Mar 23:30 GMT. 168 hours on is Sun 5 Apr 00:30 BST; the window ends Sat 4 Apr.
    expect(dueWindow(new Date("2026-03-28T23:30:00Z"))).toEqual({ today: "2026-03-28", end: "2026-04-04" });
    // Sun 29 Mar 00:30 GMT (before the change) and 23:30 BST (after it).
    expect(dueWindow(new Date("2026-03-29T00:30:00Z"))).toEqual({ today: "2026-03-29", end: "2026-04-05" });
    expect(dueWindow(new Date("2026-03-29T22:30:00Z"))).toEqual({ today: "2026-03-29", end: "2026-04-05" });
  });

  it("clocks go back (Sun 25 Oct 2026): 7 x 24 hours would end a day early", () => {
    // Sat 24 Oct 23:30 BST.
    expect(dueWindow(new Date("2026-10-24T22:30:00Z"))).toEqual({ today: "2026-10-24", end: "2026-10-31" });
    // Sun 25 Oct 00:30 BST. 168 hours on is Sat 31 Oct 23:30 GMT; the window ends Sun 1 Nov.
    expect(dueWindow(new Date("2026-10-24T23:30:00Z"))).toEqual({ today: "2026-10-25", end: "2026-11-01" });
    // Sun 25 Oct 23:30 GMT (after the change).
    expect(dueWindow(new Date("2026-10-25T23:30:00Z"))).toEqual({ today: "2026-10-25", end: "2026-11-01" });
  });

  it("the label is the window's end date, whatever the browser's time zone", () => {
    expect(fmtDueBy("2026-11-04")).toBe("Wed 4 Nov");
    expect(fmtDueBy("2026-04-04")).toBe("Sat 4 Apr");
    expect(fmtDueBy(dueWindow(new Date("2026-10-24T23:30:00Z")).end)).toBe("Sun 1 Nov");
  });
});
