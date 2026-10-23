/**
 * B23 follow-up: Start / Finish entries queued by builds before 044 carry no client key. Their replay must still be exactly-once in
 * effect: a resend after a lost answer (the entry left in flight, then claimed again) neither changes the job twice nor files the
 * entry's own change as someone else's conflict.
 */
import { beforeEach, expect, it, vi } from "vitest";

type Job = { id: string; job_no: string; started_at: string | null; finished_at: string | null };
const db = vi.hoisted(() => ({ jobs: new Map<string, Job>(), writes: [] as string[] }));
const client = vi.hoisted(() => {
  const jobsTable = () => ({
    update: (patch: Partial<Job>) => {
      const filters: Array<(job: Job) => boolean> = [];
      const chain = {
        eq: (col: keyof Job, value: unknown) => { filters.push((job) => job[col] === value); return chain; },
        is: (col: keyof Job, value: null) => { filters.push((job) => job[col] === value); return chain; },
        select: async () => {
          const hit = [...db.jobs.values()].filter((job) => filters.every((f) => f(job)));
          for (const job of hit) { Object.assign(job, patch); db.writes.push(`update ${job.id} ${JSON.stringify(patch)}`); }
          return { data: hit.map((job) => ({ id: job.id })), error: null };
        },
      };
      return chain;
    },
    select: () => ({
      eq: (_col: string, id: string) => ({
        // PostgREST answers timestamptz with an offset, not "Z".
        maybeSingle: async () => { const job = db.jobs.get(id); return { data: job ? { id: job.id, started_at: job.started_at?.replace("Z", "+00:00") ?? null } : null, error: null }; },
      }),
    }),
  });
  return {
    from: (table: string) => { if (table !== "jobs") throw new Error(table); return jobsTable(); },
    // finish_job (061): fills an empty finish time only; a finished job answers changed: false with the time it has.
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== "finish_job") throw new Error(fn);
      const job = db.jobs.get(args.p_job as string)!;
      if (job.finished_at) return { data: { job_id: job.id, finished_at: job.finished_at.replace("Z", "+00:00"), changed: false, ended: [] }, error: null };
      job.finished_at = args.p_finished_at as string;
      job.started_at ??= job.finished_at;
      db.writes.push(`finish ${job.id}`);
      return { data: { job_id: job.id, finished_at: job.finished_at, changed: true, ended: [], time_conflicts: [] }, error: null };
    },
  };
});
vi.mock("@/lib/supabase", () => ({ supabase: client }));
import { executeOutboxOp } from "@/lib/offline/sync";
import { replayOutbox, pendingEntries, conflictEntries, enqueue, type OutboxOp } from "@/lib/offline/outbox";
import { memoryBackend, setOfflineBackend } from "@/lib/offline/store";

const at = "2026-10-09T08:00:00.000Z";
const scope = { userId: "legacy-user", orgId: "legacy-org" };
beforeEach(() => {
  db.jobs.clear();
  db.writes.length = 0;
  db.jobs.set("job-1", { id: "job-1", job_no: "J-1", started_at: null, finished_at: null });
  setOfflineBackend(memoryBackend(new Map()));
});

it("a keyless (pre-044) Start sent again after its answer was lost is applied once, not held as a conflict", async () => {
  const op: OutboxOp = { kind: "start", jobId: "job-1", jobNo: "J-1", at };
  expect(await executeOutboxOp(op)).toEqual({ status: "applied" });
  expect(await executeOutboxOp(op)).toEqual({ status: "applied" });
  expect(db.writes).toHaveLength(1);
  expect(db.jobs.get("job-1")!.started_at).toBe(at);
});

it("a keyless Start still yields to someone else's earlier Start (their time kept, held as a conflict)", async () => {
  db.jobs.get("job-1")!.started_at = "2026-10-09T07:00:00.000Z";
  const outcome = await executeOutboxOp({ kind: "start", jobId: "job-1", jobNo: "J-1", at });
  expect(outcome.status).toBe("conflict");
  expect(db.writes).toHaveLength(0);
  expect(db.jobs.get("job-1")!.started_at).toBe("2026-10-09T07:00:00.000Z");
});

it("a keyless (pre-044) Finish sent again is applied once (finish_job only fills an empty finish time)", async () => {
  const op: OutboxOp = { kind: "finish", jobId: "job-1", jobNo: "J-1", at };
  expect(await executeOutboxOp(op)).toEqual({ status: "applied" });
  expect(await executeOutboxOp(op)).toEqual({ status: "applied" });
  expect(db.writes).toEqual(["finish job-1"]);
});

it("queued tablet data from an older build replays exactly once through the outbox, op unchanged, after a pass that lost its answer", async () => {
  await enqueue(scope, { kind: "start", jobId: "job-1", jobNo: "J-1", at });
  await enqueue(scope, { kind: "finish", jobId: "job-1", jobNo: "J-1", at: "2026-10-09T09:00:00.000Z" });
  // First pass: the Start reaches the server but its answer is lost (the entry stays queued, as after a closed tab).
  await replayOutbox(scope, async (op) => { await executeOutboxOp(op); return { status: "network" }; });
  expect((await pendingEntries(scope)).map((e) => e.op)).toEqual([
    { kind: "start", jobId: "job-1", jobNo: "J-1", at },
    { kind: "finish", jobId: "job-1", jobNo: "J-1", at: "2026-10-09T09:00:00.000Z" },
  ]);
  const result = await replayOutbox(scope, executeOutboxOp);
  expect(result).toMatchObject({ applied: 2, conflicts: 0, rejected: 0, remaining: 0 });
  expect(await conflictEntries(scope)).toEqual([]);
  expect(db.writes.filter((w) => w.startsWith("update"))).toHaveLength(1);
  expect(db.writes.filter((w) => w.startsWith("finish"))).toHaveLength(1);
});
