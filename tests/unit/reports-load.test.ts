import { describe, expect, it } from "vitest";

import { loadReports, MACHINE_HOURS_JOB_CAP } from "@/lib/reports/load-reports";

type Q = { table: string; select: string; ops: [string, string, unknown][] };
type Rows = Record<string, unknown>[] | Error;

/** A fake read client: every builder method chains, `.range(from, to)` (and awaiting the builder) answers from `answer`, and each query is recorded. */
function fake(answer: (q: Q) => Rows) {
  const queries: Q[] = [];
  const client = {
    from(table: string) {
      const q: Q = { table, select: "", ops: [] };
      queries.push(q);
      const run = (from = 0, to = Infinity) => {
        const got = answer(q);
        return Promise.resolve(got instanceof Error ? { data: null, error: got } : { data: got.slice(from, to + 1), error: null });
      };
      const b: Record<string, unknown> = {};
      for (const op of ["gte", "lt", "is", "in", "not", "eq"]) b[op] = (col: string, ...rest: unknown[]) => { q.ops.push([op, col, rest]); return b; };
      b.select = (s: string) => { q.select = s; return b; };
      b.order = () => b;
      b.range = (from: number, to: number) => run(from, to);
      b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => run().then(ok, bad);
      return b;
    },
  };
  return { client, queries };
}

const NOW = new Date("2026-11-11T12:00:00Z");
const isFinishedRead = (q: Q) => q.table === "jobs" && q.select.includes("date_required") && q.ops.some(([op, col]) => op === "gte" && col === "finished_at");
const isOpenRead = (q: Q) => q.table === "jobs" && q.select.includes("date_required") && q.ops.some(([op, col]) => op === "is" && col === "finished_at");
const finishedJob = (i: number, internal = false) => ({ id: `job-${i}`, job_no: `J-${i}`, customer: "Acme", is_internal: internal, started_at: "2026-10-01T09:00:00Z", finished_at: "2026-10-05T09:00:00Z", date_required: "2026-10-06", due_date: null });
const base = (q: Q): Rows => (isFinishedRead(q) ? [finishedJob(1)] : isOpenRead(q) ? [] : []);

describe("loadReports", () => {
  it("everything on: four ok cards, 12 months, no truncation", async () => {
    const { client } = fake(base);
    const d = await loadReports(client, { now: NOW });
    expect(d.periods).toHaveLength(12);
    for (const card of [d.onTime, d.wip, d.machines, d.ncr]) expect(card).toMatchObject({ state: "ok", truncated: false });
  });

  it("hidden jobs: every card is a notice and no jobs, plan or NCR table is read", async () => {
    const { client, queries } = fake(base);
    const d = await loadReports(client, { now: NOW, hiddenSections: ["jobs"] });
    for (const card of [d.onTime, d.wip, d.machines, d.ncr]) expect(card).toEqual({ state: "hidden", sections: expect.arrayContaining(["jobs"]) });
    expect(queries).toHaveLength(0);
  });

  it("hidden schedule: only the machine card is a notice", async () => {
    const { client } = fake(base);
    const d = await loadReports(client, { now: NOW, hiddenSections: ["schedule"] });
    expect(d.machines).toEqual({ state: "hidden", sections: ["schedule"] });
    expect([d.onTime.state, d.wip.state, d.ncr.state]).toEqual(["ok", "ok", "ok"]);
  });

  it("hidden delivery notes: on-time still shows, with a note, and delivery notes are not read", async () => {
    const { client, queries } = fake(base);
    const d = await loadReports(client, { now: NOW, hiddenSections: ["delivery-notes"] });
    expect(d.onTime).toMatchObject({ state: "ok", note: expect.stringContaining("Delivery Notes are hidden") });
    expect(queries.some((q) => q.table === "delivery_notes")).toBe(false);
  });

  it("delivery notes unreadable: a note, the card still shows", async () => {
    const { client } = fake((q) => (q.table === "delivery_notes" ? new Error("boom") : base(q)));
    const d = await loadReports(client, { now: NOW });
    expect(d.onTime).toMatchObject({ state: "ok", truncated: false, note: expect.stringContaining("could not be read") });
  });

  it("delivery notes truncated: the on-time card says it may be incomplete", async () => {
    const many = Array.from({ length: 20_000 }, (_, i) => ({ id: `dn-${i}`, job_id: "job-1", despatched_at: "2026-10-04T09:00:00Z" }));
    const { client } = fake((q) => (q.table === "delivery_notes" ? many : base(q)));
    expect((await loadReports(client, { now: NOW })).onTime).toMatchObject({ state: "ok", truncated: true });
  });

  it("a read error is the error state, never zeros, and other cards are unaffected", async () => {
    const { client } = fake((q) => (isFinishedRead(q) ? new Error("boom") : base(q)));
    const d = await loadReports(client, { now: NOW });
    expect(d.onTime).toEqual({ state: "error" });
    expect(d.machines).toEqual({ state: "error" });
    expect(d.wip.state).toBe("ok");
    const open = fake((q) => (isOpenRead(q) ? new Error("boom") : base(q)));
    expect((await loadReports(open.client, { now: NOW })).wip).toEqual({ state: "error" });
  });

  it("machine hours: 500 jobs is not capped, 501 is flagged truncated", async () => {
    const jobs = (n: number) => Array.from({ length: n }, (_, i) => finishedJob(i));
    const exact = fake((q) => (isFinishedRead(q) ? jobs(MACHINE_HOURS_JOB_CAP) : []));
    expect((await loadReports(exact.client, { now: NOW })).machines).toMatchObject({ state: "ok", truncated: false });
    const over = fake((q) => (isFinishedRead(q) ? jobs(MACHINE_HOURS_JOB_CAP + 1) : []));
    expect((await loadReports(over.client, { now: NOW })).machines).toMatchObject({ state: "ok", truncated: true });
  });

  it("machine hours: internal jobs are dropped before the cap and never sent to the plan reads", async () => {
    const jobs = [...Array.from({ length: 3 }, (_, i) => finishedJob(1000 + i, true)), ...Array.from({ length: MACHINE_HOURS_JOB_CAP }, (_, i) => finishedJob(i))];
    const { client, queries } = fake((q) => (isFinishedRead(q) ? jobs : []));
    const d = await loadReports(client, { now: NOW });
    expect(d.machines).toMatchObject({ state: "ok", truncated: false });
    const asked = JSON.stringify(queries.filter((q) => q.table === "job_machines").map((q) => q.ops));
    expect(asked).toContain("job-0");
    expect(asked).not.toContain("job-1000");
  });
});
