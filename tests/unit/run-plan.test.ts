import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  plan: { data: [] as unknown[], error: null as unknown },
  runs: { data: [] as unknown[] | null, error: null as unknown },
  planCalls: [] as string[][],
  runCalls: [] as string[][],
  planRanges: [] as number[],
}));
// A thenable query chain: the filters are recorded, `range` pages through the rows once (the second page is empty).
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      let ids: string[] = [];
      const done = () => {
        // The rows belong to j0, so only the chunk holding j0 returns them.
        const only = (r: { data: unknown[] | null; error: unknown }) => (r.error || ids.includes("j0") ? r : { data: [], error: null });
        if (table === "job_machines") { state.planCalls.push(ids); return Promise.resolve(only(state.plan)); }
        return Promise.resolve(only(state.runs));
      };
      chain.select = () => chain;
      chain.in = (_c: string, v: string[]) => { ids = v; return chain; };
      chain.not = () => chain;
      chain.order = () => chain;
      chain.range = (from: number) => {
        if (table === "job_machines") state.planRanges.push(from);
        if (from === 0) { if (table !== "job_machines") state.runCalls.push(ids); return done(); }
        return Promise.resolve({ data: [], error: null });
      };
      return chain;
    },
  },
}));

import { buildRunPlan, loadRunPlan, planBooking, runPlanKey, unbookedRunView } from "@/lib/run-plan";
import { runClock } from "@/lib/machine-schedule";

beforeEach(() => {
  state.plan = { data: [], error: null };
  state.runs = { data: [], error: null };
  state.planCalls = [];
  state.runCalls = [];
  state.planRanges = [];
});

const machine = { hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5] };

describe("buildRunPlan", () => {
  it("sums the plan hours and only ENDED runs, per job and machine", () => {
    const map = buildRunPlan(
      [{ job_id: "j1", machine_id: "m1", estimated_hours: "6.5" }, { job_id: "j1", machine_id: "m2", estimated_hours: 2 }],
      [
        { job_id: "j1", machine_id: "m1", started_at: "2026-10-20T08:00:00Z", ended_at: "2026-10-20T09:30:00Z" },
        { job_id: "j1", machine_id: "m1", started_at: "2026-10-21T08:00:00Z", ended_at: "2026-10-21T08:30:00Z" },
        { job_id: "j1", machine_id: "m1", started_at: "2026-10-22T08:00:00Z", ended_at: null }, // open: never counted here
        { job_id: "j1", machine_id: "m9", started_at: "2026-10-20T08:00:00Z", ended_at: "2026-10-20T09:00:00Z" }, // no plan row for it
        { job_id: "j2", machine_id: "m1", started_at: "2026-10-20T08:00:00Z", ended_at: "2026-10-20T09:00:00Z" }, // another job
      ],
    );
    expect(map.get(runPlanKey("j1", "m1"))).toEqual({ planHours: 6.5, hoursDone: 2 });
    expect(map.get(runPlanKey("j1", "m2"))).toEqual({ planHours: 2, hoursDone: 0 });
    expect(map.size).toBe(2);
  });

  it("ignores a run that ends before it starts", () => {
    const map = buildRunPlan([{ job_id: "j", machine_id: "m", estimated_hours: 1 }], [{ job_id: "j", machine_id: "m", started_at: "2026-10-20T09:00:00Z", ended_at: "2026-10-20T08:00:00Z" }]);
    expect(map.get("j:m")?.hoursDone).toBe(0);
  });
});

describe("loadRunPlan", () => {
  it("reads in chunks of 100 jobs, de-duplicated, and maps the rows", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `j${i}`);
    state.plan = { data: [{ id: "p1", job_id: "j0", machine_id: "m1", estimated_hours: 4 }], error: null };
    state.runs = { data: [{ id: "r1", job_id: "j0", machine_id: "m1", started_at: "2026-10-20T08:00:00Z", ended_at: "2026-10-20T09:00:00Z" }], error: null };
    const map = await loadRunPlan([...ids, "j0"]);
    expect(state.planCalls.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(state.runCalls.map((c) => c.length)).toEqual([100, 100, 50]);
    expect(map?.get("j0:m1")).toEqual({ planHours: 4, hoursDone: 1 });
  });

  it("pages the plan read like the runs (PostgREST's 1000-row cap): it asks for the next page until one is empty", async () => {
    state.plan = { data: [{ id: "p1", job_id: "j0", machine_id: "m1", estimated_hours: 4 }], error: null };
    await loadRunPlan(["j0"]);
    expect(state.planRanges).toEqual([0, 1]);
  });

  it("no jobs: nothing to read", async () => {
    expect((await loadRunPlan([]))?.size).toBe(0);
    expect(state.planCalls).toEqual([]);
  });

  it("a failed read of the plan or of the runs gives null (elapsed only)", async () => {
    state.plan = { data: [], error: { message: "denied" } };
    expect(await loadRunPlan(["j1"])).toBeNull();
    state.plan = { data: [], error: null };
    state.runs = { data: null, error: { message: "denied" } };
    expect(await loadRunPlan(["j1"])).toBeNull();
  });
});

describe("an unbooked run's clock", () => {
  const START = "2026-10-21T08:00:00Z"; // a Wednesday
  const at = (minutes: number) => new Date(new Date(START).getTime() + minutes * 60_000);

  it("plan hours give the same live left as a booking would (6:30 planned, 1:25 running: 5:05 left)", () => {
    const view = unbookedRunView(START, { planHours: 6.5, hoursDone: 0 }, machine, at(85));
    expect(view.clock).toEqual({ elapsedMinutes: 85, leftMinutes: 305 });
    expect(view.clock).toEqual(runClock(START, { estimatedHours: 6.5, hoursDone: 0, status: "booked" }, at(85)));
    expect(view.planHours).toBe(6.5);
    expect(view.finish).not.toBeNull();
    expect(view.finish!.getTime()).toBeGreaterThan(at(85).getTime());
  });

  it("a Resume subtracts the earlier runs' hours", () => {
    // 6 h planned, 2 h done on earlier runs, this run 1 h: 3 h left.
    expect(unbookedRunView(START, { planHours: 6, hoursDone: 2 }, machine, at(60)).clock?.leftMinutes).toBe(180);
  });

  it("past the plan hours: over, and no finish time", () => {
    const view = unbookedRunView(START, { planHours: 1, hoursDone: 0 }, machine, at(80));
    expect(view.clock?.leftMinutes).toBe(-20);
    expect(view.finish).toBeNull();
  });

  it("no plan hours (no row, 0 hours, or a failed read): elapsed only, nothing invented", () => {
    for (const plan of [undefined, null, { planHours: 0, hoursDone: 0 }]) {
      const view = unbookedRunView(START, plan, machine, at(85));
      expect(view).toEqual({ clock: { elapsedMinutes: 85, leftMinutes: null }, planHours: null, finish: null });
    }
    expect(planBooking(undefined)).toBeNull();
  });

  it("a machine with no hours settings: the plan's hours run on the clock, finish is start + hours left", () => {
    for (const unset of [{ hoursPerDay: 0, workingDays: [1, 2, 3, 4, 5] }, { hoursPerDay: 8, workingDays: [] as number[] }]) {
      const view = unbookedRunView(START, { planHours: 6, hoursDone: 0 }, unset, at(60));
      expect(view.clock?.leftMinutes).toBe(300);
      expect(view.finish?.getTime()).toBe(at(60).getTime() + 300 * 60_000);
    }
  });

  it("no machine to count working hours on: left is shown, no finish", () => {
    const view = unbookedRunView(START, { planHours: 6, hoursDone: 0 }, undefined, at(30));
    expect(view.clock?.leftMinutes).toBe(330);
    expect(view.finish).toBeNull();
  });
});
