import { describe, expect, it } from "vitest";
import { dayTotals, settingsFromRow, type AttendanceEvent } from "@/lib/time-sheet";
import { paidDay, paidWeek, paidHoursExplanation } from "@/lib/working-hours";

const events: AttendanceEvent[] = [
  { id: "in", user_id: "fake", action: "in", at: "2026-11-02T08:00:00Z", received_at: "2026-11-02T08:00:00Z" },
  { id: "out", user_id: "fake", action: "out", at: "2026-11-02T16:00:00Z", received_at: "2026-11-02T16:00:00Z" },
];

describe("one company break rule for planned and clocked hours", () => {
  for (const breaksPaid of [false, true]) {
    it(`agrees for planned day, week and real clock records with paid breaks ${breaksPaid}`, () => {
      const settings = settingsFromRow({ breaks_paid: breaksPaid, lunch_minutes: 20, break_minutes: 10, break_min_day_hours: 5 });
      const planned = paidDay("08:00", "16:00", settings)!;
      const actual = dayTotals({ date: "2026-11-02", events, labour: [], settings, bankHolidays: new Map(), now: Date.parse("2026-11-03T00:00:00Z") });
      expect(planned.paid).toBe(breaksPaid ? 480 : 450);
      expect(actual.paid).toBe(planned.paid);
      expect(paidWeek([{ start: "08:00", end: "16:00" }], settings).paid).toBe(planned.paid);
      expect(paidHoursExplanation(settings)).toContain(breaksPaid ? "Breaks are paid" : "Breaks are unpaid");
      if (breaksPaid) expect(paidHoursExplanation(settings)).not.toContain("minus breaks");
    });
  }
  it("keeps missing-row JNR defaults unpaid and never carries another company's paid setting", () => {
    const companyA = settingsFromRow({ breaks_paid: true });
    const companyB = settingsFromRow(null);
    expect(paidDay("08:00", "16:00", companyA)?.paid).toBe(480);
    expect(companyB.breaksPaid).toBe(false);
    expect(paidDay("08:00", "16:00", companyB)?.paid).toBe(435);
  });
});
