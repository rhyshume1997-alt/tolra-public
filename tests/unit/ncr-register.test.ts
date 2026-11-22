import { describe, expect, it, vi } from "vitest";

import {
  buildNcrRows, concessionInspections, countConcessions, daysBetween, hasPendingReads, pendingReworkReads, splitByClass, groupReworkChains, defaultRange, filterNcrRows, ncrCsv, summariseNcrRows,
  type NcrSources, type RawInspection, type RawProblem, type RawRework,
} from "@/lib/jobs/ncr-register";

const NOW = "2026-10-20T12:00:00Z";
const rework = (o: Partial<RawRework> & { id: string }): RawRework => ({
  job_id: "j1", inspection_id: null, status: "open", reason: "Burr", instructions: "Deburr", affects_all: true, quantity_affected: null,
  quantity_scrapped: 0, quantity_remade: 0, sales_order_line_id: null, raised_at: "2026-10-10T09:00:00Z", closed_at: null, closed_how: null, follow_up_of: null, ...o,
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
    expect(rows.find((r) => r.key === "fail:i3")).toMatchObject({ statusText: "Not linked", open: false, notLinked: true, daysOpen: null });
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

describe("one record per nonconformance", () => {
  const closed = (id: string, o: Partial<RawRework> = {}) => rework({ id, status: "closed", closed_how: "passed", ...o });
  it("folds a replacement chain into its root: one row, summed hours and cost, root scrapped, chain remade", () => {
    const rows = buildNcrRows(src({
      reworks: [
        closed("root", { raised_at: "2026-10-01T09:00:00Z", closed_at: "2026-10-05T09:00:00Z", quantity_scrapped: 4, quantity_remade: 1, quantity_affected: 5 }),
        closed("f1", { follow_up_of: "root", inspection_id: "i9", raised_at: "2026-10-06T09:00:00Z", closed_at: "2026-10-09T09:00:00Z", closed_how: "concession", quantity_scrapped: 3, quantity_remade: 2 }),
      ],
      entries: [{ id: "e1", rework_id: "root", kind: "hours", hours: 1 }, { id: "e2", rework_id: "f1", kind: "hours", hours: 2 }, { id: "e3", rework_id: "f1", kind: "material", hours: null }],
      entryValues: [{ entry_id: "e3", material_cost: 12.5 }],
    }), NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "rework:root", type: "Rework", replacements: 1, scrapped: 4, remade: 3, hours: 3, materialCost: 12.5, open: false, closedHow: "Closed on concession", daysOpen: 8 });
    expect(rows[0].closedDate).toBe("2026-10-09");
    expect(summariseNcrRows(rows).quantityScrapped).toBe(4);
  });
  it("is Open while any link of the chain is not closed", () => {
    const [row] = buildNcrRows(src({ reworks: [closed("root", { closed_at: "2026-10-05T09:00:00Z" }), rework({ id: "f1", follow_up_of: "root", status: "in_progress" })] }), NOW);
    expect(row).toMatchObject({ open: true, closedAt: null, replacements: 1, statusText: "Rework under way" });
  });
  it("folds a multi-step chain, and survives a missing parent or a cycle without duplicates", () => {
    const chain = [rework({ id: "a" }), rework({ id: "b", follow_up_of: "a" }), rework({ id: "c", follow_up_of: "b" })];
    expect(buildNcrRows(src({ reworks: chain }), NOW)).toHaveLength(1);
    expect(buildNcrRows(src({ reworks: [rework({ id: "x", follow_up_of: "gone" })] }), NOW)).toHaveLength(1);
    const cyc = [rework({ id: "p", follow_up_of: "q", raised_at: "2026-10-02T00:00:00Z" }), rework({ id: "q", follow_up_of: "p", raised_at: "2026-10-01T00:00:00Z" }), rework({ id: "t", follow_up_of: "p" })];
    expect([...groupReworkChains(cyc).keys()]).toEqual(["q"]);
    expect(buildNcrRows(src({ reworks: cyc }), NOW)).toHaveLength(1);
  });
  it("attributes a follow-up to a root outside the date range, and the range filters on the root's raised date", () => {
    const rows = buildNcrRows(src({ reworks: [closed("root", { raised_at: "2026-08-01T09:00:00Z", closed_at: "2026-08-02T09:00:00Z" }), closed("f1", { follow_up_of: "root", raised_at: "2026-10-05T09:00:00Z", closed_at: "2026-10-06T09:00:00Z" })] }), NOW);
    expect(filterNcrRows(rows, { from: "2026-10-01", to: "2026-10-31", type: "all", status: "all" })).toHaveLength(0);
    expect(filterNcrRows(rows, { from: "2026-08-01", to: "2026-08-31", type: "all", status: "all" })).toHaveLength(1);
  });
  it("a concession that closed a rework is not a separate record (037 record_job_inspection: same transaction time, same job)", () => {
    const at = "2026-10-12T10:00:00+00:00";
    const rows = buildNcrRows(src({
      reworks: [closed("r1", { closed_at: "2026-10-12T10:00:00Z", closed_how: "concession" })],
      inspections: [insp({ id: "c1", result: "concession", concession_reason: "ok", inspected_at: at }), insp({ id: "c2", result: "concession", concession_reason: "first look", inspected_at: "2026-10-15T10:00:00Z" }), insp({ id: "c3", job_id: "j2", result: "concession", concession_reason: "other job", inspected_at: at })],
    }), NOW);
    expect(rows.map((r) => r.key).sort()).toEqual(["concession:c2", "concession:c3", "rework:r1"]);
  });
});

describe("Not linked", () => {
  it("is outside the open and closed counts, the status filters, days and the average", () => {
    const rows = buildNcrRows(src({ reworks: [rework({ id: "c", status: "closed", closed_at: "2026-10-14T09:00:00Z", closed_how: "passed" })], inspections: [insp({ id: "n" })] }), NOW);
    const s = summariseNcrRows(rows);
    expect([s.total, s.open, s.closed, s.notLinked, s.averageDaysToClose]).toEqual([1, 0, 1, 1, 4]);
    expect(filterNcrRows(rows, { from: "", to: "", type: "all", status: "open" })).toHaveLength(0);
    expect(filterNcrRows(rows, { from: "", to: "", type: "all", status: "closed" })).toHaveLength(1);
    expect(filterNcrRows(rows, { from: "", to: "", type: "all", status: "all" })).toHaveLength(2);
  });
});

describe("clock change (BST ends 2026-10-25)", () => {
  it("counts calendar days across BST to GMT: raised 24 Oct, closed 26 Oct is 2 days", () => {
    const [row] = buildNcrRows(src({ reworks: [rework({ id: "r", status: "closed", raised_at: "2026-10-24T09:00:00Z", closed_at: "2026-10-26T09:00:00Z", closed_how: "passed" })] }), "2026-10-30T12:00:00Z");
    expect(row.daysOpen).toBe(2);
  });
  it("uses the UK local date near midnight either side of the change", () => {
    const [row] = buildNcrRows(src({ reworks: [rework({ id: "r", status: "closed", raised_at: "2026-10-24T23:30:00Z", closed_at: "2026-10-26T00:30:00Z", closed_how: "passed" })] }), "2026-10-30T12:00:00Z");
    expect(row.raisedDate).toBe("2026-10-25");
    expect(row.closedDate).toBe("2026-10-26");
    expect(row.daysOpen).toBe(1);
  });
  it("defaultRange spans the change: 90 days back from 2026-11-02 starts 2026-08-04", () => {
    expect(defaultRange("2026-11-02T12:00:00Z")).toEqual({ from: "2026-08-04", to: "2026-11-02" });
    expect(defaultRange("2026-10-26T00:30:00Z")).toEqual({ from: "2026-07-28", to: "2026-10-26" });
  });
});

describe("PM rules: reinspection, repeated failures, concessions, legacy fails", () => {
  const T1 = "2026-10-05T09:00:00Z";
  const done = (id: string, o: Partial<RawRework> = {}) => rework({ id, status: "closed", closed_how: "passed", closed_at: T1, ...o });

  it("rule 1: a finished rework stays Open until reinspected and accepted", () => {
    const [row] = buildNcrRows(src({ reworks: [rework({ id: "r", status: "finished" })] }), NOW);
    expect(row).toMatchObject({ open: true, statusText: "Reworked: awaiting re-inspection", closedAt: null, closedHow: "" });
    expect(summariseNcrRows([row])).toMatchObject({ open: 1, closed: 0 });
  });
  it("rule 1: a chain whose last closing is superseded is Open; passed or concession closes it", () => {
    const sup = buildNcrRows(src({ reworks: [done("r", { closed_how: "superseded" })] }), NOW)[0];
    expect(sup).toMatchObject({ open: true, statusText: "Failed again", closedAt: null });
    expect(buildNcrRows(src({ reworks: [done("r")] }), NOW)[0].open).toBe(false);
    expect(buildNcrRows(src({ reworks: [done("r", { closed_how: "concession" })] }), NOW)[0].open).toBe(false);
  });
  it("rule 1: a closed link followed by an open link is Open", () => {
    expect(buildNcrRows(src({ reworks: [done("r"), rework({ id: "f", follow_up_of: "r", status: "finished" })] }), NOW)[0].open).toBe(true);
  });

  it("rule 2: a repeated failure continues the superseded rework (same job, instant, line) so only one NCR is open", () => {
    const rows = buildNcrRows(src({
      reworks: [
        done("r1", { status: "closed", closed_how: "superseded", sales_order_line_id: "L1", raised_at: "2026-10-01T09:00:00Z", closed_at: "2026-10-04T09:00:00Z" }),
        rework({ id: "r2", inspection_id: "i2", sales_order_line_id: "L1", raised_at: "2026-10-04T09:00:00Z" }),
      ],
    }), NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "rework:r1", open: true, replacements: 1 });
    expect(summariseNcrRows(rows).open).toBe(1);
  });
  it("rule 2: matches a rework with no line, or a new failure on all lines", () => {
    const base = { status: "closed" as const, closed_how: "superseded" as const, closed_at: "2026-10-04T09:00:00Z" };
    expect(buildNcrRows(src({ reworks: [done("a", { ...base, sales_order_line_id: null }), rework({ id: "b", sales_order_line_id: "L9", raised_at: base.closed_at })] }), NOW)).toHaveLength(1);
    expect(buildNcrRows(src({ reworks: [done("a", { ...base, sales_order_line_id: "L1" }), rework({ id: "b", sales_order_line_id: null, affects_all: true, raised_at: base.closed_at })] }), NOW)).toHaveLength(1);
  });
  it("rule 2: a failure that superseded nothing, or only another line, is a separate NCR", () => {
    const sup = { status: "closed" as const, closed_how: "superseded" as const, closed_at: "2026-10-04T09:00:00Z", sales_order_line_id: "L1" };
    expect(buildNcrRows(src({ reworks: [done("a", { ...sup }), rework({ id: "b", affects_all: false, sales_order_line_id: "L2", raised_at: sup.closed_at })] }), NOW)).toHaveLength(2);
    expect(buildNcrRows(src({ reworks: [done("a", { ...sup }), rework({ id: "b", raised_at: "2026-10-04T09:00:01Z" })] }), NOW)).toHaveLength(2);
    expect(buildNcrRows(src({ reworks: [done("a", { ...sup }), rework({ id: "b", job_id: "j2", raised_at: sup.closed_at })] }), NOW)).toHaveLength(2);
    expect(buildNcrRows(src({ reworks: [done("a", { ...sup, closed_how: "passed" }), rework({ id: "b", raised_at: sup.closed_at })] }), NOW)).toHaveLength(2);
  });
  it("rule 2: a line split joins every new rework to the one superseded rework; one R2 picks the same line, else the earliest", () => {
    const sup = { status: "closed" as const, closed_how: "superseded" as const, closed_at: "2026-10-04T09:00:00Z" };
    const split = buildNcrRows(src({ reworks: [done("a", { ...sup, sales_order_line_id: null }), rework({ id: "b1", sales_order_line_id: "L1", raised_at: sup.closed_at }), rework({ id: "b2", sales_order_line_id: "L2", raised_at: sup.closed_at })] }), NOW);
    expect(split).toHaveLength(1);
    expect(split[0].replacements).toBe(2);
    const chains = groupReworkChains([
      done("early", { ...sup, sales_order_line_id: null, raised_at: "2026-10-01T09:00:00Z" }), done("sameLine", { ...sup, sales_order_line_id: "L1", raised_at: "2026-10-02T09:00:00Z" }),
      rework({ id: "n", affects_all: true, sales_order_line_id: "L1", raised_at: sup.closed_at }),
    ]);
    expect([...chains.keys()].sort()).toEqual(["early", "sameLine"]);
    expect(chains.get("sameLine")!.map((r) => r.id).sort()).toEqual(["n", "sameLine"]);
  });

  it("rule 3: initial concession + a reinspection concession closing two reworks = 2 concession inspections", () => {
    const at = "2026-10-12T10:00:00Z";
    const src2 = src({
      reworks: [done("r1", { closed_at: at, closed_how: "concession" }), done("r2", { closed_at: at, closed_how: "concession", raised_at: "2026-10-11T09:00:00Z" })],
      inspections: [insp({ id: "c0", result: "concession", concession_reason: "first look", inspected_at: "2026-10-15T10:00:00Z" }), insp({ id: "c1", result: "concession", concession_reason: "reinspect", inspected_at: at })],
    });
    const rows = buildNcrRows(src2, NOW);
    expect(rows).toHaveLength(3);
    expect(countConcessions(src2, { from: "", to: "" })).toBe(2);
    expect(rows.find((r) => r.key === "rework:r1")!.closedHow).toBe("Closed on concession");
    expect(rows.find((r) => r.key === "concession:c0")!.closedHow).toBe("Closed on concession");
  });

  it("rule 4: legacy failed inspections are listed apart, in the CSV with a class, and not in confirmed counts", () => {
    const rows = buildNcrRows(src({ reworks: [rework({ id: "r" })], inspections: [insp({ id: "old" })] }), NOW);
    const { confirmed, notLinked } = splitByClass(rows);
    expect(confirmed.map((r) => r.key)).toEqual(["rework:r"]);
    expect(notLinked.map((r) => r.key)).toEqual(["fail:old"]);
    expect(notLinked[0].recordClass).toBe("Not linked");
    const s = summariseNcrRows(rows);
    expect([s.total, s.open, s.closed, s.notLinked]).toEqual([1, 1, 0, 1]);
    const lines = ncrCsv(rows).split("\r\n");
    expect(lines[0]).toContain("Record class,Record");
    expect(lines.filter((l) => l.startsWith("Confirmed NCR,"))).toHaveLength(1);
    expect(lines.filter((l) => l.startsWith("Not linked,"))).toHaveLength(1);
  });
});

describe("Concessions tile counts by inspection date", () => {
  it("a rework raised 2 Oct and conceded 5 Nov counts in a November range, while the record follows its raised date", () => {
    const s = src({ reworks: [rework({ id: "r", status: "closed", closed_how: "concession", raised_at: "2026-10-02T09:00:00Z", closed_at: "2026-11-05T10:00:00Z" })] });
    expect(countConcessions(s, { from: "2026-11-01", to: "2026-11-30" })).toBe(1);
    expect(countConcessions(s, { from: "2026-10-01", to: "2026-10-31" })).toBe(0);
    const rows = buildNcrRows(s, "2026-11-20T12:00:00Z");
    expect(filterNcrRows(rows, { from: "2026-11-01", to: "2026-11-30", type: "all", status: "all" })).toHaveLength(0);
    expect(filterNcrRows(rows, { from: "2026-10-01", to: "2026-10-31", type: "all", status: "all" })).toHaveLength(1);
  });
  it("counts each inspection once, inclusive at the boundaries, whether standalone or closing several reworks", () => {
    const at = "2026-11-30T23:30:00Z";
    const s = src({
      reworks: [rework({ id: "a", status: "closed", closed_how: "concession", closed_at: at }), rework({ id: "b", status: "closed", closed_how: "concession", closed_at: at })],
      inspections: [insp({ id: "c", result: "concession", concession_reason: "x", inspected_at: at }), insp({ id: "d", result: "concession", concession_reason: "y", inspected_at: "2026-11-01T00:30:00Z" })],
    });
    expect(concessionInspections(s)).toHaveLength(2);
    expect(countConcessions(s, { from: "2026-11-01", to: "2026-11-30" })).toBe(2);
    expect(countConcessions(s, { from: "2026-11-02", to: "2026-11-30" })).toBe(1);
  });
});

describe("chain read cap", () => {
  const empty = () => ({ children: new Set<string>(), superseded: new Set<string>(), raised: new Set<string>() });
  it("has pending reads for unasked reworks, missing parents and unasked supersedes, and none when all are asked", () => {
    const held = [rework({ id: "a", follow_up_of: "gone" }), rework({ id: "b", status: "closed", closed_how: "superseded", closed_at: "2026-10-04T09:00:00Z" })];
    const asked = empty();
    const p = pendingReworkReads(held, asked);
    expect([p.children.length, p.parents, p.supers.length, p.raised.length]).toEqual([2, ["gone"], 1, 2]);
    expect(hasPendingReads(p)).toBe(true);
    held.forEach((r) => { asked.children.add(r.id); asked.superseded.add(r.id); asked.raised.add(r.id); });
    expect(hasPendingReads(pendingReworkReads([held[1]], asked))).toBe(false);
    expect(hasPendingReads(pendingReworkReads(held, asked))).toBe(true); // the missing parent is still unread
    expect(hasPendingReads(pendingReworkReads([...held, rework({ id: "gone" })], asked))).toBe(true); // the newly read rework is unasked
  });
});

// ---- Added for reports (3b): ncrByMonth and loadNcrRegister's optional client -------------------------------------------------------
import { loadNcrRegister } from "@/lib/jobs/load-ncr-register";
import { ncrByMonth } from "@/lib/jobs/ncr-register";
import { londonMonthsEnding } from "@/lib/numbers";

const holder = vi.hoisted(() => ({ supabase: null as unknown }));
vi.mock("@/lib/supabase", () => ({ get supabase() { return holder.supabase; } }));

describe("ncrByMonth", () => {
  const periods = londonMonthsEnding(new Date("2026-10-20T12:00:00Z"), 3); // Aug, Sep, Oct 2026
  const rowsOf = (s: NcrSources) => buildNcrRows(s, NOW);
  const total = (m: Map<string, import("@/lib/jobs/ncr-register").NcrMonth>) => [...m.values()].reduce((t, x) => ({ confirmed: t.confirmed + x.confirmed, open: t.open + x.open, closed: t.closed + x.closed, scrapped: t.scrapped + x.scrapped, notLinked: t.notLinked + x.notLinked }), { confirmed: 0, open: 0, closed: 0, scrapped: 0, notLinked: 0 });

  it("has every period key with zeros when there are no rows", () => {
    const m = ncrByMonth([], periods);
    expect([...m.keys()]).toEqual(["2026-08", "2026-09", "2026-10"]);
    for (const v of m.values()) expect(v).toMatchObject({ confirmed: 0, open: 0, closed: 0, scrapped: 0, notLinked: 0 });
    expect(ncrByMonth([], []).size).toBe(0);
  });

  it("puts a row in its London raised month across BST and GMT edges", () => {
    const rows = rowsOf(src({ problems: [
      problem({ id: "a", reported_at: "2026-08-31T23:30:00Z" }),  // 00:30 BST on 1 Sep -> September
      problem({ id: "b", reported_at: "2026-09-30T22:59:00Z" }),  // 23:59 BST on 30 Sep -> September
      problem({ id: "c", reported_at: "2026-09-30T23:00:00Z" }),  // 00:00 BST on 1 Oct -> October
      problem({ id: "d", reported_at: "2026-08-31T22:59:00Z" }),  // 23:59 BST on 31 Aug -> August
    ] }));
    const m = ncrByMonth(rows, periods);
    expect([m.get("2026-08")!.confirmed, m.get("2026-09")!.confirmed, m.get("2026-10")!.confirmed]).toEqual([1, 2, 1]);
    const winter = londonMonthsEnding(new Date("2026-12-20T12:00:00Z"), 2); // Nov, Dec (GMT)
    const w = ncrByMonth(rowsOf(src({ problems: [problem({ id: "e", reported_at: "2026-11-30T23:59:00Z" }), problem({ id: "f", reported_at: "2026-12-01T00:00:00Z" })] })), winter);
    expect([w.get("2026-11")!.confirmed, w.get("2026-12")!.confirmed]).toEqual([1, 1]);
  });

  it("keeps not-linked apart, counts scrapped (null as 0), open/closed and types", () => {
    const rows = rowsOf(src({
      reworks: [
        rework({ id: "r1", quantity_scrapped: 3 }),
        rework({ id: "r2", status: "closed", closed_how: "passed", closed_at: "2026-10-11T09:00:00Z", quantity_scrapped: 2, raised_at: "2026-10-09T09:00:00Z" }),
      ],
      inspections: [insp({ id: "i1", inspected_at: "2026-10-05T09:00:00Z" }), insp({ id: "c1", result: "concession", concession_reason: "OK", inspected_at: "2026-09-15T09:00:00Z" })],
      problems: [problem({ id: "p1" })],
    }));
    const oct = ncrByMonth(rows, periods).get("2026-10")!;
    expect(oct).toMatchObject({ confirmed: 3, open: 2, closed: 1, scrapped: 5, notLinked: 1 });
    expect(oct.byType).toMatchObject({ Rework: 2, Problem: 1, Concession: 0 });
    const sep = ncrByMonth(rows, periods).get("2026-09")!;
    expect(sep).toMatchObject({ confirmed: 1, closed: 1, scrapped: 0, notLinked: 0 });
    expect(sep.byType.Concession).toBe(1);
  });

  it("totals over the periods equal summariseNcrRows over the same rows", () => {
    const rows = rowsOf(src({
      reworks: [rework({ id: "r1", quantity_scrapped: 4 }), rework({ id: "r2", raised_at: "2026-09-02T09:00:00Z", status: "closed", closed_how: "passed", closed_at: "2026-09-03T09:00:00Z", quantity_scrapped: 1 })],
      inspections: [insp({ id: "i1" }), insp({ id: "c2", result: "concession", inspected_at: "2026-08-20T09:00:00Z" })],
      problems: [problem({ id: "p1", reported_at: "2026-08-12T09:00:00Z" })],
    }));
    const summary = summariseNcrRows(rows);
    const t = total(ncrByMonth(rows, periods));
    expect(t).toEqual({ confirmed: summary.total, open: summary.open, closed: summary.closed, scrapped: summary.quantityScrapped, notLinked: summary.notLinked });
    const types: Record<string, number> = {};
    for (const v of ncrByMonth(rows, periods).values()) for (const [k, n] of Object.entries(v.byType)) types[k] = (types[k] ?? 0) + n;
    expect(types).toEqual(summary.byType);
  });
});

describe("loadNcrRegister client", () => {
  /** Empty tables; records which client was asked. */
  const emptyClient = (used: string[], tag: string) => ({
    from: (table: string) => {
      used.push(`${tag}:${table}`);
      const q: Record<string, unknown> = {};
      for (const m of ["select", "gte", "lt", "eq", "in", "order", "range"]) q[m] = () => q;
      q.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok, bad);
      return q;
    },
  });

  it("uses the client given and not the singleton", async () => {
    const used: string[] = [];
    holder.supabase = emptyClient(used, "singleton");
    const load = await loadNcrRegister({ from: "2026-10-01", to: "2026-10-31" }, emptyClient(used, "given"));
    expect(load).toMatchObject({ ok: true, truncated: false });
    expect(used.length).toBeGreaterThan(0);
    expect(used.every((u) => u.startsWith("given:"))).toBe(true);
  });

  it("uses the browser singleton when no client is given, and is not ok when there is none", async () => {
    const used: string[] = [];
    holder.supabase = emptyClient(used, "singleton");
    expect(await loadNcrRegister({ from: "2026-10-01", to: "2026-10-31" })).toMatchObject({ ok: true });
    expect(used.every((u) => u.startsWith("singleton:"))).toBe(true);
    expect(used.length).toBeGreaterThan(0);
    holder.supabase = null;
    expect(await loadNcrRegister({ from: "2026-10-01", to: "2026-10-31" })).toEqual({ ok: false });
  });
});
