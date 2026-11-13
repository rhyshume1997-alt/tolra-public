import { describe, expect, it } from "vitest";

import { wipAgeing, wipBand, type WipJob } from "@/lib/reports/wip-ageing";

const now = new Date("2026-11-11T12:00:00Z");
let n = 0;
const job = (over: Partial<WipJob>): WipJob => ({ id: `j${++n}`, job_no: `J-${n}`, customer: "Acme", is_internal: false, started_at: null, finished_at: null, ...over });
const startedDaysAgo = (days: number) => job({ started_at: new Date(now.getTime() - days * 86_400_000).toISOString() });
const bandOf = (days: number) => wipAgeing([startedDaysAgo(days)], now).rows[0].band;

describe("WIP ageing", () => {
  it("band edges: 7/8, 14/15, 30/31, 60/61", () => {
    expect([0, 7].map(bandOf)).toEqual(["0-7", "0-7"]);
    expect([8, 14].map(bandOf)).toEqual(["8-14", "8-14"]);
    expect([15, 30].map(bandOf)).toEqual(["15-30", "15-30"]);
    expect([31, 60].map(bandOf)).toEqual(["31-60", "31-60"]);
    expect([61, 400].map(bandOf)).toEqual(["61+", "61+"]);
    expect(wipBand(0)).toBe("0-7");
  });
  it("counts per band; finished, internal and not-started jobs are handled apart", () => {
    const r = wipAgeing([
      startedDaysAgo(3), startedDaysAgo(9), startedDaysAgo(9), startedDaysAgo(100),
      job({ started_at: "2026-10-01T09:00:00Z", finished_at: "2026-10-05T09:00:00Z" }),
      job({ started_at: "2026-10-01T09:00:00Z", is_internal: true }),
      job({}),
    ], now);
    expect(r.bands.map((b) => [b.key, b.count])).toEqual([["0-7", 1], ["8-14", 2], ["15-30", 0], ["31-60", 0], ["61+", 1]]);
    expect(r.notStarted).toBe(1);
    expect(r.open).toBe(5);
  });
  it("a reopened job (finished_at cleared) is open again", () => {
    expect(wipAgeing([job({ started_at: "2026-11-01T09:00:00Z", finished_at: null })], now).open).toBe(1);
  });
  it("whole London days: clocks going back (25 Oct 2026) and forward (29 Mar 2026)", () => {
    // 23:30 UTC on 24 Oct is 00:30 BST on 25 Oct in London; on 26 Oct (GMT) that is 1 day, not 0 or 2.
    expect(wipAgeing([job({ started_at: "2026-10-24T23:30:00Z" })], new Date("2026-10-26T12:00:00Z")).rows[0].ageDays).toBe(1);
    // 47 elapsed hours across the spring change is still 2 calendar days.
    expect(wipAgeing([job({ started_at: "2026-03-28T10:00:00Z" })], new Date("2026-03-30T09:00:00Z")).rows[0].ageDays).toBe(2);
  });
  it("late evening UTC in summer is already the next London day", () => {
    expect(wipAgeing([job({ started_at: "2026-06-30T23:30:00Z" })], new Date("2026-07-02T10:00:00Z")).rows[0]).toMatchObject({ startedDate: "2026-07-01", ageDays: 1 });
  });
  it("never a negative age", () => {
    expect(wipAgeing([job({ started_at: "2026-11-12T09:00:00Z" })], now).rows[0].ageDays).toBe(0);
  });
});
