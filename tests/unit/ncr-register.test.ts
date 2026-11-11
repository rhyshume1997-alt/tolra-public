import { describe, expect, it } from "vitest";

import {
  buildNcrRows, daysBetween, defaultRange, filterNcrRows, ncrCsv, summariseNcrRows,
  type NcrSources, type RawInspection, type RawProblem, type RawRework,
} from "@/lib/jobs/ncr-register";

const NOW = "2026-10-20T12:00:00Z";
const rework = (o: Partial<RawRework> & { id: string }): RawRework => ({
  job_id: "j1", inspection_id: null, status: "open", reason: "Burr", instructions: "Deburr", affects_all: true, quantity_affected: null,
  quantity_scrapped: 0, quantity_remade: 0, raised_at: "2026-10-10T09:00:00Z", closed_at: null, closed_how: null, follow_up_of: null, ...o,
});
const insp = (o: Partial<RawInspection> & { id: string }): RawInspection => ({
  job_id: "j1", result: "fail", concession_reason: null, measured_notes: "Out of tolerance", inspector_name: "Sam", inspected_at: "2026-10-10T09:00:00Z", ...o,
});
const problem = (o: Partial<RawProblem> & { id: string }): RawProblem => ({
  job_id: "j1", reason: "material", note: "Wrong bar", status: "open", reported_at: "2026-10-12T09:00:00Z", resolved_at: null, resolution_note: null, ...o,
});
const src = (o: Partial<NcrSources>): NcrSources => ({ reworks: [], inspections: [], problems: [], entries: [], entryValues: [], jobs: [{ id: "j1", job_no: "J-0101", customer: "Acme" }], ...o });

describe("type mapping", () => {
  it("maps rework, inspection-linked rework, concession, problem and a fail with no rework", () => {
    const rows = buildNcrRows(src({
      reworks: [rework({ id: "r1" }), rework({ id: "r2", inspection_id: "i1" })],
      inspections: [insp({ id: "i1" }), insp({ id: "i2", result: "concession", concession_reason: "Cosmetic" }), insp({ id: "i3" }), insp({ id: "i4", result: "pass" })],
      problems: [problem({ id: "p1" })],
    }), NOW);
    const type = (key: string) => rows.find((r) => r.key === key)?.type;
    expect(type("rework:r1")).toBe("Rework");
    expect(type("rework:r2")).toBe("Inspection fail");
    expect(type("concession:i2")).toBe("Concession");
    expect(type("problem:p1")).toBe("Problem");
    expect(type("fail:i3")).toBe("Inspection fail (no rework)");
    expect(rows.find((r) => r.key === "fail:i1")).toBeUndefined();
    expect(rows.some((r) => r.key.endsWith(":i4"))).toBe(false);
    expect(rows).toHaveLength(5);
  });
  it("labels the record by job number, type and date, with no invented number", () => {
    const [row] = buildNcrRows(src({ reworks: [rework({ id: "r1" })] }), NOW);
    expect(row.record).toBe("J-0101 Rework 2026-10-10");
    expect(row.customer).toBe("Acme");
  });
});

describe("open and closed rules", () => {
  it("rework is open until closed; problem open until resolved; concession always closed", () => {
    const rows = buildNcrRows(src({
      reworks: [rework({ id: "a", status: "in_progress" }), rework({ id: "b", status: "finished" }), rework({ id: "c", status: "closed", closed_at: "2026-10-14T09:00:00Z", closed_how: "passed" })],
      inspections: [insp({ id: "k", result: "concession", concession_reason: "ok" })],
      problems: [problem({ id: "o" }), problem({ id: "s", status: "resolved", resolved_at: "2026-10-13T09:00:00Z", resolution_note: "Fixed" })],
    }), NOW);
    const open = (key: string) => rows.find((r) => r.key === key)!.open;
    expect([open("rework:a"), open("rework:b"), open("rework:c")]).toEqual([true, true, false]);
    expect([open("concession:k"), open("problem:o"), open("problem:s")]).toEqual([false, true, false]);
    expect(rows.find((r) => r.key === "rework:c")!.closedHow).toBe("Passed re-inspection");
  });
});

describe("dates and days", () => {
  it("date range is inclusive at both boundaries on the local date", () => {
    const rows = buildNcrRows(src({ reworks: [
      rework({ id: "in1", raised_at: "2026-10-01T00:30:00Z" }), rework({ id: "in2", raised_at: "2026-10-10T22:59:00Z" }),
      rework({ id: "out1", raised_at: "2026-09-30T22:59:00Z" }), rework({ id: "out2", raised_at: "2026-10-10T23:30:00Z" }),
    ] }), NOW);
    const keys = filterNcrRows(rows, { from: "2026-10-01", to: "2026-10-10", type: "all", status: "all" }).map((r) => r.key).sort();
    expect(keys).toEqual(["rework:in1", "rework:in2"]);
  });
  it("default range is the last 90 days to today", () => {
    expect(defaultRange(NOW)).toEqual({ from: "2026-07-22", to: "2026-10-20" });
  });
  it("days between whole calendar days, never negative", () => {
    expect(daysBetween("2026-10-10", "2026-10-14")).toBe(4);
    expect(daysBetween("2026-10-14", "2026-10-10")).toBe(0);
  });
  it("days open: open counts to today, closed to its close date; average over closed only", () => {
    const rows = buildNcrRows(src({
      reworks: [rework({ id: "o" }), rework({ id: "c1", status: "closed", closed_at: "2026-10-14T09:00:00Z", closed_how: "passed" }), rework({ id: "c2", status: "closed", closed_at: "2026-10-17T09:00:00Z", closed_how: "concession" })],
    }), NOW);
    expect(rows.find((r) => r.key === "rework:o")!.daysOpen).toBe(10);
    const s = summariseNcrRows(rows);
    expect(s.averageDaysToClose).toBe(5.5);
    expect(summariseNcrRows(rows.filter((r) => r.open)).averageDaysToClose).toBeNull();
  });
});

describe("filters and summary", () => {
  const rows = buildNcrRows(src({
    reworks: [rework({ id: "a", quantity_scrapped: 2 }), rework({ id: "b", status: "closed", closed_at: "2026-10-11T09:00:00Z", closed_how: "passed", quantity_scrapped: 1 })],
    inspections: [insp({ id: "k", result: "concession", concession_reason: "ok" })], problems: [problem({ id: "p" })],
  }), NOW);
  it("counts, scrapped and status/type filters", () => {
    const s = summariseNcrRows(rows);
    expect([s.total, s.open, s.closed, s.quantityScrapped]).toEqual([4, 2, 2, 3]);
    expect(s.byType.Rework).toBe(2);
    expect(s.byType.Concession).toBe(1);
    expect(filterNcrRows(rows, { from: "", to: "", type: "all", status: "open" })).toHaveLength(2);
    expect(filterNcrRows(rows, { from: "", to: "", type: "all", status: "closed" })).toHaveLength(2);
    expect(filterNcrRows(rows, { from: "", to: "", type: "Problem", status: "all" })).toHaveLength(1);
  });
  it("sums rework hours and material cost per NCR in pence-safe arithmetic", () => {
    const withCost = buildNcrRows(src({
      reworks: [rework({ id: "r1" })],
      entries: [{ id: "e1", rework_id: "r1", kind: "hours", hours: "1.5" }, { id: "e2", rework_id: "r1", kind: "hours", hours: 0.25 }, { id: "e3", rework_id: "r1", kind: "material", hours: null }, { id: "e4", rework_id: "r1", kind: "material", hours: null }, { id: "e5", rework_id: "zz", kind: "hours", hours: 9 }],
      entryValues: [{ entry_id: "e3", material_cost: 0.1 }, { entry_id: "e4", material_cost: "0.2" }],
    }), NOW);
    expect(withCost[0].hours).toBe(1.75);
    expect(withCost[0].materialCost).toBe(0.3);
    expect(summariseNcrRows(withCost).materialCost).toBe(0.3);
  });
});

describe("CSV", () => {
  it("quotes commas, quotes and line breaks, and guards formulas", () => {
    const rows = buildNcrRows(src({ reworks: [rework({ id: "r1", reason: '=HYPERLINK("x")', instructions: "Skim, then\nre-check \"fine\"" }), rework({ id: "r2", reason: "@cmd", instructions: "+1" })] }), NOW);
    const csv = ncrCsv(rows);
    expect(csv).toContain("'=HYPERLINK(");
    expect(csv).toContain("'@cmd");
    expect(csv).toContain("'+1");
    expect(csv).toContain('"Skim, then\nre-check ""fine"""');
    expect(csv.split("\r\n")[0]).toContain("Record,Job,Customer,Type,Raised");
  });
});
