/**
 * Jobs: planned vs actual, the loader and the panel's figures (lib/jobs/load-planned-vs-actual.ts, components/jobs/planned-vs-actual-panel.tsx).
 * Regression for the silent cut-off: lists longer than the API's 1,000-row page are read in full, and reaching the safety cap is shown
 * ("may be incomplete"), never silent. Also the unplanned machine time line. The client is a fake that serves pages of at most 1,000 rows.
 * Must not change: the panel stays read-only; only `.range()` reads (and the single jobs row) are served by the fake.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: null, isSupabaseConfigured: false }));
vi.mock("@/lib/use-user", () => ({ useUser: () => ({ activeRole: "admin" }) }));
vi.mock("@/lib/org-settings", () => ({ useOrgSettings: () => ({ hiddenNav: [] }) }));

import { BENCH_HEADING, INCOMPLETE_TEXT, PlannedVsActualTable, unplannedInTotalText } from "@/components/jobs/planned-vs-actual-panel";
import { MAX_LIST_ROWS } from "@/lib/fetch-all";
import { loadPlannedVsActual } from "@/lib/jobs/load-planned-vs-actual";

const NOW = new Date("2026-01-01T12:00:00Z");
const SERVER_CAP = 1_000;
const SIX_MIN = 6 * 60_000;

type Row = Record<string, unknown>;

/** A fake read client: each table holds rows; a list read is only answered through `.range()`, capped at 1,000 rows like the API. */
function fakeClient(tables: Record<string, Row[]>) {
  const ranges: Record<string, number> = {};
  const client = {
    from(table: string) {
      const rows = tables[table] ?? [];
      const builder = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        range: async (from: number, to: number) => {
          ranges[table] = (ranges[table] ?? 0) + 1;
          return { data: rows.slice(from, Math.min(to + 1, from + SERVER_CAP)), error: null };
        },
      };
      return builder;
    },
  };
  return { client, ranges };
}

const runs = (count: number, machineId: string | null) =>
  Array.from({ length: count }, (_, i) => {
    const start = Date.UTC(2025, 0, 1) + i * SIX_MIN;
    return { id: `run-${machineId ?? "bench"}-${i}`, machine_id: machineId, started_at: new Date(start).toISOString(), ended_at: new Date(start + SIX_MIN).toISOString() };
  });

const base = (extra: Record<string, Row[]> = {}) => ({
  jobs: [{ finished_at: null }],
  job_machines: [{ id: "jm1", machine_id: "m1", estimated_hours: 100, booking_id: null, position: 0 }],
  machine_bookings: [],
  machines: [{ id: "m1", name: "Mill" }, { id: "m3", name: "Saw" }],
  operator_sessions: [],
  ...extra,
});

describe("loadPlannedVsActual paging", () => {
  it("counts every run and session past the 1,000-row page (2,500 runs, 1,500 sessions)", async () => {
    const sessions = runs(1_500, null).map(({ id, started_at, ended_at }) => ({ id: `s-${id}`, started_at, ended_at, voided_at: null }));
    const { client, ranges } = fakeClient(base({ machine_runs: runs(2_500, "m1"), operator_sessions: sessions }));
    const r = await loadPlannedVsActual(client, "job-1", NOW);
    // 2,500 runs of 6 minutes = 250 h (a single unpaged read would have stopped at 1,000 runs = 100 h).
    expect(r.steps[0]).toMatchObject({ label: "Mill", plannedHours: 100, actualHours: 250, status: "over" });
    expect(r.machineActualHours).toBe(250);
    expect(r.labourActualHours).toBe(150);
    expect(r.truncated).toBe(false);
    expect(ranges.machine_runs).toBeGreaterThanOrEqual(3);
    expect(ranges.operator_sessions).toBeGreaterThanOrEqual(2);
  });

  it("keeps two runs with identical times as two runs (rows are told apart by id)", async () => {
    const twin = { machine_id: "m1", started_at: "2025-01-01T00:00:00.000Z", ended_at: "2025-01-01T01:00:00.000Z" };
    const { client } = fakeClient(base({ machine_runs: [{ id: "a", ...twin }, { id: "b", ...twin }] }));
    expect((await loadPlannedVsActual(client, "job-1", NOW)).machineActualHours).toBe(2);
  });

  it("flags truncated when a list reaches the safety cap", async () => {
    const { client } = fakeClient(base({ machine_runs: runs(MAX_LIST_ROWS + 5, "m1") }));
    const r = await loadPlannedVsActual(client, "job-1", NOW);
    expect(r.truncated).toBe(true);
  });

  it("throws when a list can't be read, so the panel shows its muted line", async () => {
    const { client } = fakeClient(base({ machine_runs: [] }));
    const failing = { from: (table: string) => {
      if (table !== "operator_sessions") return client.from(table);
      const b = { select: () => b, eq: () => b, order: () => b, range: async () => ({ data: null, error: new Error("boom") }) };
      return b;
    } };
    await expect(loadPlannedVsActual(failing, "job-1", NOW)).rejects.toThrow("boom");
  });
});

describe("PlannedVsActualTable", () => {
  it("shows the 'may be incomplete' note when the cap was hit, and not otherwise", async () => {
    const capped = await loadPlannedVsActual(fakeClient(base({ machine_runs: runs(MAX_LIST_ROWS + 5, "m1") })).client, "job-1", NOW);
    const html = renderToStaticMarkup(createElement(PlannedVsActualTable, { data: capped }));
    expect(html).toContain('data-testid="pva-incomplete"');
    expect(html).toContain(INCOMPLETE_TEXT);
    expect(INCOMPLETE_TEXT).toBe("These figures may be incomplete: this job has too many records to read in full (the limit is 20,000 of each kind), so some may be missing.");
    const full = await loadPlannedVsActual(fakeClient(base({ machine_runs: runs(10, "m1") })).client, "job-1", NOW);
    expect(renderToStaticMarkup(createElement(PlannedVsActualTable, { data: full }))).not.toContain("pva-incomplete");
  });

  it("puts unplanned machine time under its own heading and says the total includes it", async () => {
    const data = await loadPlannedVsActual(fakeClient(base({ machine_runs: [...runs(10, "m1"), ...runs(30, "m3")] })).client, "job-1", NOW);
    expect(data.unplannedActualHours).toBe(3);
    expect(data.machineActualHours).toBe(4);
    expect(data.steps[0]).toMatchObject({ label: "Mill", actualHours: 1, varianceHours: -99 });
    const html = renderToStaticMarkup(createElement(PlannedVsActualTable, { data }));
    expect(html).toContain('data-testid="pva-unplanned"');
    expect(html).toContain("Unplanned machine time (machines not on this job&#x27;s plan; counted in the total, not against any planned machine)");
    expect(html).toContain("Saw (Not on plan)");
    expect(html).toContain(unplannedInTotalText(3));
    expect(unplannedInTotalText(3)).toBe("Total actual includes 3.00 h of unplanned machine time.");
    // The heading comes after the planned machine and before the unplanned one.
    expect(html.indexOf(">Mill<")).toBeLessThan(html.indexOf("pva-unplanned"));
    expect(html.indexOf("pva-unplanned")).toBeLessThan(html.indexOf("Saw (Not on plan)"));
  });

  it("bench row has its own heading and is not under the unplanned heading", async () => {
    const loaded = await loadPlannedVsActual(fakeClient(base({ machine_runs: [...runs(10, "m1"), ...runs(30, "m3")] })).client, "job-1", NOW);
    const data = { ...loaded, steps: [...loaded.steps, { ...loaded.steps[0], key: "bench", label: "Bench", machineId: null, isBench: true, onPlan: false }] };
    const html = renderToStaticMarkup(createElement(PlannedVsActualTable, { data }));
    expect(BENCH_HEADING).toBe("Bench (no machine; not counted in the total)");
    expect(html).toContain('data-testid="pva-bench"');
    expect(html).toContain(BENCH_HEADING);
    // Order: planned, bench heading, bench row, unplanned heading, unplanned row, total.
    const at = (text: string) => html.indexOf(text);
    expect(at(">Mill<")).toBeLessThan(at("pva-bench"));
    expect(at("pva-bench")).toBeLessThan(at(">Bench<"));
    expect(at(">Bench<")).toBeLessThan(at("pva-unplanned"));
    expect(at("pva-unplanned")).toBeLessThan(at("Saw (Not on plan)"));
    expect(at("Saw (Not on plan)")).toBeLessThan(at("Total (machines)"));
  });

  it("no unplanned heading or line when every run is on the plan", async () => {
    const data = await loadPlannedVsActual(fakeClient(base({ machine_runs: runs(10, "m1") })).client, "job-1", NOW);
    const html = renderToStaticMarkup(createElement(PlannedVsActualTable, { data }));
    expect(html).not.toContain("pva-unplanned");
  });
});
