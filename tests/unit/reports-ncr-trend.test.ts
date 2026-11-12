import { describe, expect, it } from "vitest";

import { NCR_CONFIRMED_TYPES, ncrByMonth, type NcrRow } from "@/lib/jobs/ncr-register";
import { londonMonthsEnding } from "@/lib/numbers";
import { ncrTrend } from "@/lib/reports/ncr-trend";

const periods = londonMonthsEnding(new Date("2026-11-11T12:00:00Z"), 3); // Sep, Oct, Nov 2026
const ncr = (over: Partial<NcrRow>): NcrRow => ({ raisedDate: "2026-10-05", type: "Rework", scrapped: null, open: false, notLinked: false, ...over } as NcrRow);

describe("NCR trend", () => {
  const rows = [
    ncr({ type: "Rework", scrapped: 2, open: true }),
    ncr({ type: "Problem" }),
    ncr({ type: "Concession", raisedDate: "2026-11-02", scrapped: 1 }),
    ncr({ type: "Inspection fail (no rework)", notLinked: true, scrapped: 9 }),
    ncr({ raisedDate: "2025-01-01" }), // outside the months
  ];
  const trend = ncrTrend(ncrByMonth(rows, periods), periods);
  it("confirmed by type, scrapped and not linked, month by month", () => {
    const oct = trend.months.find((m) => m.key === "2026-10")!;
    expect(oct).toMatchObject({ confirmed: 2, scrapped: 2, notLinked: 1 });
    expect(oct.byType).toMatchObject({ Rework: 1, Problem: 1, Concession: 0, "Inspection fail": 0 });
    expect(trend.months.find((m) => m.key === "2026-11")).toMatchObject({ confirmed: 1, scrapped: 1, notLinked: 0 });
  });
  it("not linked is never in the confirmed count or the scrapped total", () => {
    expect(trend.total).toMatchObject({ confirmed: 3, scrapped: 3, notLinked: 1 });
  });
  it("every month is present, zeros included, and only confirmed types are listed", () => {
    expect(trend.months.map((m) => m.key)).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(trend.months[0]).toMatchObject({ confirmed: 0, scrapped: 0, notLinked: 0 });
    expect(Object.keys(trend.total.byType)).toEqual([...NCR_CONFIRMED_TYPES]);
  });
  it("has no cost in its output", () => {
    expect(JSON.stringify(trend)).not.toMatch(/cost|material|hours/i);
  });
});
