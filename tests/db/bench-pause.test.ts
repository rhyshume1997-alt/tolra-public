/**
 * Pause for bench jobs (migration 046), through the real API path (Supabase Auth + PostgREST, signed-in synthetic users):
 *
 *   * a Start that names no machine opens the job's bench run (machine_runs, machine_id NULL); Pause ends it ('paused'); Start again opens
 *     a new one (resume); Finish ends any open run ('finished'); bench_runs_state() shows Running / Paused per unfinished job;
 *   * ONE OPEN BENCH RUN PER JOB and no overlapping bench runs, held by the table (unique partial index, exclusion constraint) whatever
 *     writes, and two Starts racing from two connections leave exactly one open bench run;
 *   * a job started some other way (no bench run ever) or holding a machine opens no bench run;
 *   * each keyed operation (Start, Pause) replayed after later operations returns its first answer and changes nothing; a key reused for
 *     another operation kind or another job is refused (client_op_reused);
 *   * device times that would overlap the job's bench history use the server time, keep the device time on the row, answer and audit
 *     MACHINE_RUN_TIME_CONFLICT;
 *   * company isolation and roles (another company's job refused, viewer and anon refused, nothing read across companies); RLS and grants
 *     on machine_runs unchanged (read only for the API; bench_run_open internal);
 *   * machine time and machines in use stay machine-only; the verify scripts (046 and 044) are clean with bench runs present;
 *   * BENCH -> MACHINE (reviewers' NO-GO): a Start on a machine ends the job's open bench run in the same transaction ('to_machine', at the
 *     machine run's start, audited BENCH_TO_MACHINE), so the job never has an open bench run and an open machine run at once; machine ->
 *     bench is refused while a machine run is open; racing Starts from two connections (both orders) end the same way; offline replays
 *     answer their first result and never reopen the bench; device-time conflicts on the move; bench_runs_state reports the job's actual
 *     work; no bench time after the move (interval union); the table refuses bench time beside the job's machine time.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let betaJob: string;
let n = 0;

const start = (client: SupabaseClient, job: string, over: { p_machines?: string[]; p_client_op_id?: string | null; p_started_at?: string | null } = {}) =>
  client.rpc("start_machine_run", { p_job: job, p_machines: [], p_client_op_id: null, p_started_at: null, p_override: false, p_reason: null, ...over });
const pause = (client: SupabaseClient, job: string, over: { p_client_op_id?: string | null; p_ended_at?: string | null; p_machines?: string[] | null } = {}) =>
  client.rpc("pause_machine_run", { p_job: job, p_machines: null, p_client_op_id: null, p_ended_at: null, ...over });
const finish = (client: SupabaseClient, job: string, op: string | null = null, at: string | null = null) => client.rpc("finish_job", { p_job: job, p_client_op_id: op, p_finished_at: at });
const runs = async (job: string) => (await adminClient().from("machine_runs")
  .select("id, machine_id, operator_id, booking_id, started_at, ended_at, end_reason, ended_by, client_op_id, device_started_at, device_ended_at")
  .eq("job_id", job).order("started_at").order("created_at")).data!;
const jobRow = async (job: string) => (await adminClient().from("jobs").select("started_at, started_by, finished_at").eq("id", job).single()).data!;
const audit = (job: string, action: string) => withDb((db) => db.query("select metadata from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = $2 order by created_at", [job, action]));
const state = async (client: SupabaseClient, job: string) => {
  const { data, error } = await client.rpc("bench_runs_state");
  if (error) throw new Error(error.message);
  return (data as { job_id: string }[]).filter((r) => r.job_id === job);
};
const machineAt = (name: string) => adminClient().from("machines").insert({ organization_id: world.tenants.alpha.id, name: `${name} ${world.runId} ${++n}`, active: true }).select("id").single().then((r) => r.data!.id as string);
const openRuns = async (job: string) => (await runs(job)).filter((r) => r.ended_at === null).map((r) => r.machine_id);
const ms = (v: string | null) => (v === null ? null : new Date(v).getTime());
const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const iso = (v: string | null) => (v === null ? null : new Date(v).toISOString());

/** A bench job of the alpha company (no machine planned), made on the board by the admin. */
async function newJob() {
  n += 1;
  const { data, error } = await as.admin.rpc("create_job", { p_customer: "Bench Co", p_description: `Bench job ${n}`, p_internal: false, p_related: null, p_required: null, p_machines: [], p_clash_override: false, p_clashes: [], p_override_reason: null });
  if (error) throw new Error(error.message);
  return { id: data.job_id as string, no: data.job_no as string };
}

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
  as.workshop2 = await signedInClient(world.tenants.alpha.users.workshop);
  betaJob = (await adminClient().from("jobs").insert({ organization_id: world.tenants.beta.id, job_no: `J-BPB-${world.runId}`, customer: "Beta customer" }).select("id").single()).data!.id;
  await adminClient().from("user_profiles").update({ full_name: "Dave Operator" }).eq("id", world.tenants.alpha.users.workshop.id);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("Start, Pause, Start, Finish on a bench job", () => {
  it.each(["workshop", "office", "admin"])("%s: Start opens a bench run, Pause ends it, Start reopens a new one (start time kept), Finish ends it; the board's state follows; audited", async (role) => {
    const job = await newJob();
    const me = world.tenants.alpha.users[role as "admin"].id;
    const first = await start(as[role], job.id);
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ job_id: job.id, runs: [], job_start_stamped: true, bench_run: { already: false }, bench_skipped: null, time_conflicts: [], replayed: false });
    const started = (await jobRow(job.id)).started_at;
    expect(started).not.toBeNull();
    expect((await jobRow(job.id)).started_by).toBe(me);
    let rows = await runs(job.id);
    expect(rows.map((r) => [r.machine_id, r.booking_id, r.operator_id, r.ended_at])).toEqual([[null, null, me, null]]);
    expect(rows[0].id).toBe(first.data.bench_run.run_id);
    expect(await state(as.viewer, job.id)).toEqual([expect.objectContaining({ run_id: rows[0].id, is_open: true, end_reason: null, operator_id: me })]);
    // Start again while it runs: the run stands, no second run, no new audit row.
    const again = await start(as[role], job.id);
    expect(again.data).toMatchObject({ job_start_stamped: false, bench_run: { run_id: rows[0].id, already: true } });
    expect(await runs(job.id)).toHaveLength(1);

    // Pause: the bench run ends 'paused', the job stays started; the board shows Paused.
    const paused = await pause(as[role], job.id);
    expect(paused.error).toBeNull();
    expect(paused.data.ended).toEqual([expect.objectContaining({ run_id: rows[0].id, machine_id: null, booking_id: null, end_reason: "paused", booking: null, time_conflict: false })]);
    rows = await runs(job.id);
    expect(rows.map((r) => [r.end_reason, r.ended_by])).toEqual([["paused", me]]);
    expect((await jobRow(job.id)).started_at).toBe(started);
    expect(await state(as.workshop, job.id)).toEqual([expect.objectContaining({ run_id: rows[0].id, is_open: false, end_reason: "paused" })]);
    // A plain finish is still allowed now (no open run), but we finish through finish_job below after resuming.

    // Start again: a NEW bench run (resume); the job's start time is never replaced.
    const resumed = await start(as[role], job.id);
    expect(resumed.error).toBeNull();
    expect(resumed.data).toMatchObject({ job_start_stamped: false, bench_run: { already: false }, bench_skipped: null });
    rows = await runs(job.id);
    expect(rows.map((r) => [r.machine_id, r.end_reason])).toEqual([[null, "paused"], [null, null]]);
    expect(new Date(rows[1].started_at).getTime()).toBeGreaterThanOrEqual(new Date(rows[0].ended_at!).getTime());
    expect((await jobRow(job.id)).started_at).toBe(started);
    expect(await state(as.viewer, job.id)).toEqual([expect.objectContaining({ run_id: rows[1].id, is_open: true })]);

    // The plain jobs update can't finish it while the bench run is open (044's guard): finish_job does, in the lock order.
    const plain = await as[role].from("jobs").update({ finished_at: new Date().toISOString() }).eq("id", job.id).select("id");
    expect(plain.error?.hint).toBe("finish_via_rpc");
    const done = await finish(as[role], job.id);
    expect(done.error).toBeNull();
    expect(done.data).toMatchObject({ changed: true, ended: [expect.objectContaining({ run_id: rows[1].id, machine_id: null, end_reason: "finished" })] });
    rows = await runs(job.id);
    expect(rows.map((r) => r.end_reason)).toEqual(["paused", "finished"]);
    expect(await state(as.viewer, job.id)).toEqual([]); // a finished job is no longer on the bench list
    // A finished job can't be started again (bench or machine).
    expect((await start(as[role], job.id)).error?.hint).toBe("job_finished");
    expect(await runs(job.id)).toHaveLength(2);

    expect((await audit(job.id, "START_MACHINE_RUN")).rows.map((r) => [r.metadata.job_start_stamped, r.metadata.bench_run?.already])).toEqual([[true, false], [false, false]]);
    expect((await audit(job.id, "PAUSE_MACHINE_RUN")).rows).toHaveLength(1);
    expect((await audit(job.id, "FINISH_ENDS_MACHINE_RUNS")).rows).toHaveLength(1);
  });

  it("opens no bench run for a job started some other way (never on the bench) or holding a machine; a Pause naming a machine leaves the bench run open", async () => {
    // Started by the board's plain update (as before 046, or a bulk Start): no bench history, so a machine-less Start changes nothing.
    const legacy = await newJob();
    expect((await as.workshop.from("jobs").update({ started_at: ago(1) }).eq("id", legacy.id).select("id")).data).toHaveLength(1);
    const kept = await start(as.workshop, legacy.id);
    expect(kept.error).toBeNull();
    expect(kept.data).toMatchObject({ job_start_stamped: false, bench_run: null, bench_skipped: "started_without_bench" });
    expect(await runs(legacy.id)).toEqual([]);
    expect((await audit(legacy.id, "START_MACHINE_RUN")).rows).toEqual([]);

    // A bench job paused, then put on a machine: a machine-less Start doesn't open a bench run beside the machine.
    const mill = (await adminClient().from("machines").insert({ organization_id: world.tenants.alpha.id, name: `BP Mill ${world.runId}`, active: true }).select("id").single()).data!.id as string;
    const job = await newJob();
    expect((await start(as.workshop, job.id)).error).toBeNull();
    expect((await pause(as.workshop, job.id)).error).toBeNull();
    expect((await start(as.workshop, job.id, { p_machines: [mill] })).error).toBeNull();
    const onMachine = await start(as.workshop, job.id);
    expect(onMachine.data).toMatchObject({ bench_run: null, bench_skipped: "on_machine" });
    expect((await runs(job.id)).filter((r) => r.ended_at === null).map((r) => r.machine_id)).toEqual([mill]);
    expect((await pause(as.workshop, job.id)).error).toBeNull();
    // Back on the bench; a Pause that names the mill leaves the bench run open; a plain Pause ends it.
    expect((await start(as.workshop, job.id)).data).toMatchObject({ bench_run: { already: false } });
    expect((await pause(as.workshop, job.id, { p_machines: [mill] })).data.ended).toEqual([]);
    expect((await runs(job.id)).filter((r) => r.ended_at === null).map((r) => r.machine_id)).toEqual([null]);
    expect((await pause(as.workshop, job.id)).data.ended).toEqual([expect.objectContaining({ machine_id: null, end_reason: "paused" })]);
  });
});

describe("one open bench run per job", () => {
  it("two Starts racing from two connections (two people, and one person on two devices) leave exactly one open bench run", async () => {
    for (const pair of [["workshop", "office"], ["workshop", "workshop2"]]) {
      const job = await newJob();
      const results = await Promise.all(pair.map((who) => start(as[who], job.id, { p_client_op_id: randomUUID() })));
      expect(results.map((r) => r.error)).toEqual([null, null]);
      expect(results.map((r) => r.data.bench_run.already).sort()).toEqual([false, true]);
      expect((await runs(job.id)).filter((r) => r.ended_at === null)).toHaveLength(1);
      expect((await pause(as.workshop, job.id)).error).toBeNull();
      // And racing resumes of the paused job.
      const resumes = await Promise.all(pair.map((who) => start(as[who], job.id)));
      expect(resumes.map((r) => r.error)).toEqual([null, null]);
      expect((await runs(job.id)).filter((r) => r.ended_at === null)).toHaveLength(1);
      expect((await runs(job.id))).toHaveLength(2);
      expect((await pause(as.workshop, job.id)).error).toBeNull();
    }
  });

  it("the table refuses a second open bench run, an overlapping bench run, and a bench run with a booking or an override, whoever writes (the owner, past every grant)", async () => {
    const job = await newJob();
    expect((await start(as.workshop, job.id)).error).toBeNull();
    const [open] = await runs(job.id);
    const other = await newJob();
    const booking = (await adminClient().from("machine_bookings").select("id").eq("organization_id", world.tenants.alpha.id).limit(1).maybeSingle()).data?.id ?? null;
    const codes = await withDb(async (db) => {
      const attempt = (text: string, params: unknown[]) => db.query(text, params).then(() => "ok", (e: { code?: string }) => e.code);
      const org = world.tenants.alpha.id;
      return [
        // a second open bench run on the same job
        await attempt("insert into public.machine_runs (organization_id, job_id, machine_id, started_at) values ($1, $2, null, now())", [org, job.id]),
        // a closed bench run overlapping the open one
        await attempt("insert into public.machine_runs (organization_id, job_id, machine_id, started_at, ended_at, end_reason) values ($1, $2, null, $3, $4, 'paused')", [org, job.id, ago(0.5), new Date(Date.now() + 60_000).toISOString()]),
        // an override on a bench run, and a release reason: not a bench run's shape
        await attempt("insert into public.machine_runs (organization_id, job_id, machine_id, started_at, override_of) values ($1, $2, null, now(), $3)", [org, other.id, open.id]),
        await attempt("insert into public.machine_runs (organization_id, job_id, machine_id, started_at, ended_at, end_reason) values ($1, $2, null, $3, $4, 'admin_released')", [org, other.id, ago(3), ago(2)]),
        ...(booking ? [await attempt("insert into public.machine_runs (organization_id, job_id, machine_id, booking_id, started_at) values ($1, $2, null, $3, now())", [org, other.id, booking])] : []),
        // two jobs may each have one open bench run (only per job)
        await attempt("insert into public.machine_runs (organization_id, job_id, machine_id, started_at, ended_at, end_reason) values ($1, $2, null, $3, $4, 'paused')", [org, other.id, ago(3), ago(2)]),
      ];
    });
    // A second open bench run meets both guards (an open run overlaps any other open one); whichever fires first refuses it.
    expect(["23505", "23P01"]).toContain(codes[0]);
    expect(codes.slice(1)).toEqual(["23P01", "23514", "23514", ...(booking ? ["23514"] : []), "ok"]);
    // The unique index holds on its own: with the exclusion constraint dropped inside a transaction (rolled back), still refused.
    const alone = await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("alter table public.machine_runs drop constraint machine_runs_bench_no_overlap");
        return await db.query("insert into public.machine_runs (organization_id, job_id, machine_id, started_at) values ($1, $2, null, now())", [world.tenants.alpha.id, job.id]).then(() => "ok", (e: { code?: string }) => e.code);
      } finally {
        await db.query("rollback");
      }
    });
    expect(alone).toBe("23505");
    expect((await runs(job.id)).filter((r) => r.ended_at === null)).toHaveLength(1);
    expect((await pause(as.workshop, job.id)).error).toBeNull();
  });
});

describe("replay of keyed operations (offline outbox)", () => {
  const snapshot = async (job: string) => ({
    runs: await runs(job),
    starts: (await audit(job, "START_MACHINE_RUN")).rows.length,
    pauses: (await audit(job, "PAUSE_MACHINE_RUN")).rows.length,
    job: await jobRow(job),
  });

  it("each Start and Pause replayed after later operations returns its first answer and changes nothing (also after Finish); a key reused for another kind or job is refused", async () => {
    const job = await newJob();
    const [k1, k2, k3, k4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const s1 = await start(as.workshop, job.id, { p_client_op_id: k1 });
    const p2 = await pause(as.workshop, job.id, { p_client_op_id: k2 });
    const s3 = await start(as.workshop, job.id, { p_client_op_id: k3 });
    for (const r of [s1, p2, s3]) expect(r.error).toBeNull();
    expect(s1.data.bench_run.already).toBe(false);
    expect(p2.data.ended).toHaveLength(1);
    expect(s3.data.bench_run.already).toBe(false);
    expect((await runs(job.id)).map((r) => [r.client_op_id, r.end_reason])).toEqual([[k1, "paused"], [k3, null]]);

    const before = await snapshot(job.id);
    for (const who of ["workshop", "admin"]) {
      // The Pause's replay does not end the run the later Start opened.
      expect((await pause(as[who], job.id, { p_client_op_id: k2 })).data).toEqual({ ...p2.data, replayed: true });
    }
    expect((await start(as.workshop, job.id, { p_client_op_id: k1 })).data).toEqual({ ...s1.data, replayed: true });
    expect((await start(as.workshop, job.id, { p_client_op_id: k3 })).data).toEqual({ ...s3.data, replayed: true });
    // 049 (R3.1): a Start's key is bound to the person who made it; another person's replay is refused and changes nothing.
    for (const k of [k1, k3]) expect((await start(as.admin, job.id, { p_client_op_id: k })).error?.hint).toBe("client_op_reused");
    expect(await snapshot(job.id)).toEqual(before);

    // A key is one operation: a Start's key as a Pause, a Pause's as a Start, either for another job: refused, nothing changes.
    const other = await newJob();
    const refused = [
      await pause(as.workshop, job.id, { p_client_op_id: k1 }),
      await start(as.workshop, job.id, { p_client_op_id: k2 }),
      await start(as.workshop, other.id, { p_client_op_id: k3 }),
      await pause(as.workshop, other.id, { p_client_op_id: k2 }),
    ];
    expect(refused.map((r) => [r.error?.code, r.error?.hint])).toEqual(Array(4).fill(["22023", "client_op_reused"]));
    expect(await snapshot(job.id)).toEqual(before);
    expect(await runs(other.id)).toEqual([]);
    expect((await jobRow(other.id)).started_at).toBeNull();

    // After Finish, every replay still answers its first result (the outbox marks it applied) and reopens nothing.
    const f4 = await finish(as.workshop, job.id, k4);
    expect(f4.data.ended).toEqual([expect.objectContaining({ machine_id: null, end_reason: "finished" })]);
    const finished = await snapshot(job.id);
    expect((await start(as.workshop, job.id, { p_client_op_id: k1 })).data).toEqual({ ...s1.data, replayed: true });
    expect((await pause(as.workshop, job.id, { p_client_op_id: k2 })).data).toEqual({ ...p2.data, replayed: true });
    expect((await start(as.workshop, job.id, { p_client_op_id: k3 })).data).toEqual({ ...s3.data, replayed: true });
    expect(await snapshot(job.id)).toEqual(finished);
    // A NEW Start on the finished job is the real refusal.
    expect((await start(as.workshop, job.id, { p_client_op_id: randomUUID() })).error?.hint).toBe("job_finished");
  });
});

describe("device times that would overlap the job's bench history", () => {
  it("a resume with a time before the last bench run ended, and a Pause before the run started: server time used, device time kept, answered and audited; valid device times kept exactly", async () => {
    const job = await newJob();
    const [t0, t1, tLate, tBad] = [ago(3), ago(2), ago(2.5), ago(4)];
    expect((await start(as.workshop, job.id, { p_client_op_id: randomUUID(), p_started_at: t0 })).data.time_conflicts).toEqual([]);
    expect((await pause(as.workshop, job.id, { p_client_op_id: randomUUID(), p_ended_at: t1 })).data.time_conflicts).toEqual([]);
    let rows = await runs(job.id);
    expect(rows.map((r) => [iso(r.started_at), iso(r.ended_at), r.device_started_at, r.device_ended_at])).toEqual([[t0, t1, null, null]]);
    expect(iso((await jobRow(job.id)).started_at)).toBe(t0);

    // Resumed offline 2.5 h ago, synced now: before the paused run's end (2 h ago). Server time; the device time kept and reported.
    const resumed = await start(as.workshop, job.id, { p_client_op_id: randomUUID(), p_started_at: tLate });
    expect(resumed.error).toBeNull();
    expect(resumed.data.time_conflicts).toEqual([expect.objectContaining({ machine_id: null, bench: true, what: "start", why: "before_last_run_end", run_id: rows[0].id })]);
    expect(iso(resumed.data.time_conflicts[0].device_at)).toBe(tLate);
    expect(iso(resumed.data.time_conflicts[0].run_until)).toBe(t1);
    rows = await runs(job.id);
    expect(iso(rows[1].device_started_at)).toBe(tLate);
    expect(new Date(rows[1].started_at).getTime()).toBeGreaterThanOrEqual(new Date(t1).getTime());
    expect(iso(rows[1].started_at)).toBe(iso(resumed.data.time_conflicts[0].used_at));

    // A Pause with a time before that run started: never written as such.
    const early = await pause(as.workshop, job.id, { p_client_op_id: randomUUID(), p_ended_at: tBad });
    expect(early.error).toBeNull();
    expect(early.data.time_conflicts).toEqual([expect.objectContaining({ run_id: rows[1].id, machine_id: null, what: "end", why: "before_run_start" })]);
    rows = await runs(job.id);
    expect(new Date(rows[1].ended_at!).getTime()).toBeGreaterThanOrEqual(new Date(rows[1].started_at).getTime());
    expect(iso(rows[1].device_ended_at)).toBe(tBad);

    const conflicts = (await audit(job.id, "MACHINE_RUN_TIME_CONFLICT")).rows;
    expect(conflicts.map((r) => r.metadata.operation)).toEqual(["start", "pause"]);
    expect(conflicts[0].metadata).toMatchObject({ actor_user_id: world.tenants.alpha.users.workshop.id, time_conflicts: [expect.objectContaining({ bench: true, why: "before_last_run_end" })] });
    expect((await audit(job.id, "START_MACHINE_RUN")).rows.at(-1)!.metadata.time_conflicts).toHaveLength(1);
    const overlaps = await withDb(async (db) => (await db.query(
      "select a.id from public.machine_runs a join public.machine_runs b on a.job_id = b.job_id and a.id < b.id and a.machine_id is null and b.machine_id is null and tstzrange(a.started_at, a.ended_at, '[)') && tstzrange(b.started_at, b.ended_at, '[)') where a.job_id = $1", [job.id])).rows);
    expect(overlaps).toEqual([]);
  });
});

describe("bench -> machine: a Start on a machine ends the job's bench run", () => {
  const snapshot = async (job: string) => ({
    runs: await runs(job),
    starts: (await audit(job, "START_MACHINE_RUN")).rows.length,
    moves: (await audit(job, "BENCH_TO_MACHINE")).rows.length,
    conflicts: (await audit(job, "MACHINE_RUN_TIME_CONFLICT")).rows.length,
    job: await jobRow(job),
  });
  const stateOf = async (job: string) => (await state(as.viewer, job)).map((r) => (r as unknown as { state: string; on_machine: boolean; is_open: boolean }));

  it("bench Start then machine Start: the bench run ends at the machine run's start ('to_machine'), one audit row, exactly one open run (the machine's); the state says on the machine, never paused; Pause then Start resumes on the bench", async () => {
    const mill = await machineAt("BM Mill");
    const job = await newJob();
    const benchStart = await start(as.workshop, job.id, { p_client_op_id: randomUUID() });
    expect(benchStart.data.bench_run.already).toBe(false);
    expect(await stateOf(job.id)).toEqual([expect.objectContaining({ state: "on_bench", is_open: true, on_machine: false })]);

    const onMachine = await start(as.office, job.id, { p_machines: [mill], p_client_op_id: randomUUID() });
    expect(onMachine.error).toBeNull();
    const rows = await runs(job.id);
    const [bench, machine] = [rows.find((r) => r.machine_id === null)!, rows.find((r) => r.machine_id === mill)!];
    expect(bench.end_reason).toBe("to_machine");
    expect(bench.ended_by).toBe(world.tenants.alpha.users.office.id);
    expect(ms(bench.ended_at)).toBe(ms(machine.started_at));
    expect(machine.ended_at).toBeNull();
    expect(await openRuns(job.id)).toEqual([mill]);
    expect(onMachine.data).toMatchObject({ bench_run: null, bench_ended: { run_id: bench.id, machine_id: null, end_reason: "to_machine", time_conflict: false }, time_conflicts: [] });
    expect(ms(onMachine.data.bench_ended.ended_at)).toBe(ms(machine.started_at));
    const moves = (await audit(job.id, "BENCH_TO_MACHINE")).rows;
    expect(moves).toHaveLength(1);
    expect(moves[0].metadata).toMatchObject({ job_id: job.id, job_no: job.no, bench_run_id: bench.id, machine_ids: [mill], time_conflict: false, actor_user_id: world.tenants.alpha.users.office.id });
    expect(ms(moves[0].metadata.ended_at)).toBe(ms(machine.started_at));
    expect(moves[0].metadata.runs).toEqual([expect.objectContaining({ run_id: machine.id, machine_id: mill })]);
    // Every role sees the job on the machine: not Paused, not on the bench.
    for (const role of ["viewer", "workshop", "office", "admin"]) {
      expect((await state(as[role], job.id)).map((r) => (r as unknown as { state: string }).state)).toEqual(["on_machine"]);
    }
    // A bench Start now is refused (on_machine) and changes nothing.
    const before = await snapshot(job.id);
    expect((await start(as.workshop, job.id, { p_client_op_id: randomUUID() })).data).toMatchObject({ bench_run: null, bench_skipped: "on_machine" });
    expect(await snapshot(job.id)).toEqual(before);

    // Pause ends the machine run: nothing open, Paused (its bench run moved to a machine); Start resumes on the bench after the machine's end.
    expect((await pause(as.workshop, job.id)).error).toBeNull();
    expect(await stateOf(job.id)).toEqual([expect.objectContaining({ state: "paused", is_open: false, on_machine: false })]);
    const resumed = await start(as.workshop, job.id);
    expect(resumed.data).toMatchObject({ bench_run: { already: false }, bench_skipped: null });
    const after = await runs(job.id);
    expect(after.map((r) => [r.machine_id, r.end_reason])).toEqual([[null, "to_machine"], [mill, "paused"], [null, null]]);
    expect(ms(after[2].started_at)!).toBeGreaterThanOrEqual(ms(after[1].ended_at)!);
    expect(await stateOf(job.id)).toEqual([expect.objectContaining({ state: "on_bench" })]);
    expect((await pause(as.workshop, job.id)).error).toBeNull();
  });

  it("machine Start then bench Start: refused (on_machine), nothing changed", async () => {
    const mill = await machineAt("BM Lathe");
    const job = await newJob();
    expect((await start(as.workshop, job.id, { p_machines: [mill] })).error).toBeNull();
    const before = await snapshot(job.id);
    for (const who of ["workshop", "office", "admin"]) {
      const bench = await start(as[who], job.id, { p_client_op_id: randomUUID() });
      expect(bench.error).toBeNull();
      expect(bench.data).toMatchObject({ runs: [], bench_run: null, bench_skipped: "on_machine", bench_ended: null, job_start_stamped: false });
    }
    expect(await snapshot(job.id)).toEqual(before);
    expect(await openRuns(job.id)).toEqual([mill]);
    expect(await state(as.viewer, job.id)).toEqual([]); // never on the bench: no bench row (the board shows the machine run)
    expect((await pause(as.workshop, job.id)).error).toBeNull();
  });

  it("concurrent bench Start and machine Start on one job (two connections, both orders, the second waits on the company lock): the same end state, never an open bench run beside a machine run", async () => {
    const openAs = async (c: SupabaseClient) => {
      const token = (await c.auth.getSession()).data.session!.access_token;
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as { sub: string; session_id: string; aal?: string };
      const db = new Client({ connectionString: isolatedBackend().databaseUrl });
      await db.connect();
      await db.query("begin");
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: claims.sub, role: "authenticated", aud: "authenticated", session_id: claims.session_id, aal: claims.aal ?? "aal1" })]);
      return db;
    };
    const call = (db: Client, job: string, machines: string[]) =>
      db.query<{ r: Record<string, unknown> }>("select public.start_machine_run($1, $2::uuid[], $3, null, false, null) as r", [job, machines, randomUUID()]).then((x) => x.rows[0].r);
    for (const order of ["bench first", "machine first"] as const) {
      const mill = await machineAt("BM Race");
      const job = await newJob();
      const a = await openAs(as.workshop);
      const b = await openAs(as.office);
      try {
        const [firstMachines, secondMachines] = order === "bench first" ? [[], [mill]] : [[mill], []];
        const first = await call(a, job.id, firstMachines);
        let settled = false;
        const second = call(b, job.id, secondMachines).then((r) => { settled = true; return r; }, (err) => { settled = true; throw err; });
        const waiting = await withDb(async (db) => {
          for (let i = 0; i < 200; i += 1) {
            const r = await db.query<{ n: number }>("select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted");
            if (r.rows[0].n > 0) return true;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return false;
        });
        expect(waiting, `${order}: the second Start waits on the company lock`).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(settled, `${order}: still waiting while the first holds its transaction`).toBe(false);
        await a.query("commit");
        const answer = await second;
        await b.query("commit");
        const rows = await runs(job.id);
        // Deterministic end state: exactly one open run, the machine's; no bench time overlaps it.
        expect(await openRuns(job.id), order).toEqual([mill]);
        const machine = rows.find((r) => r.machine_id === mill)!;
        for (const r of rows.filter((x) => x.machine_id === null)) expect(ms(r.ended_at)!, order).toBeLessThanOrEqual(ms(machine.started_at)!);
        if (order === "bench first") {
          expect(first).toMatchObject({ bench_run: { already: false } });
          expect(answer).toMatchObject({ bench_ended: { end_reason: "to_machine" } });
          expect(rows.map((r) => [r.machine_id, r.end_reason])).toEqual([[null, "to_machine"], [mill, null]]);
          expect((await audit(job.id, "BENCH_TO_MACHINE")).rows).toHaveLength(1);
        } else {
          expect(answer).toMatchObject({ bench_run: null, bench_skipped: "on_machine" });
          expect(rows.map((r) => r.machine_id)).toEqual([mill]);
          expect((await audit(job.id, "BENCH_TO_MACHINE")).rows).toHaveLength(0);
        }
        expect((await state(as.viewer, job.id)).map((r) => (r as unknown as { state: string }).state), order).toEqual(order === "bench first" ? ["on_machine"] : []);
      } finally {
        await a.end().catch(() => undefined);
        await b.end().catch(() => undefined);
      }
      expect((await pause(as.workshop, job.id)).error).toBeNull();
    }
  });

  it("offline replay: a bench Start already recorded answers its first result; a bench Start first sent after the machine Start is refused on_machine; a machine Start replayed closes the bench run once; nothing reopens the bench", async () => {
    const mill = await machineAt("BM Replay");
    const job = await newJob();
    const [kBench, kMachine, kLateBench] = [randomUUID(), randomUUID(), randomUUID()];
    const s1 = await start(as.workshop, job.id, { p_client_op_id: kBench });
    const s2 = await start(as.workshop, job.id, { p_machines: [mill], p_client_op_id: kMachine });
    expect(s1.data.bench_run.already).toBe(false);
    expect(s2.data.bench_ended).toMatchObject({ end_reason: "to_machine" });
    const before = await snapshot(job.id);
    expect(before.moves).toBe(1);
    // The recorded bench Start: its stored answer (the bench run it opened), and the bench stays closed.
    expect((await start(as.workshop, job.id, { p_client_op_id: kBench })).data).toEqual({ ...s1.data, replayed: true });
    // The machine Start replayed: its stored answer; the bench run is not ended again, no second audit row.
    expect((await start(as.workshop, job.id, { p_machines: [mill], p_client_op_id: kMachine })).data).toEqual({ ...s2.data, replayed: true });
    // 049 (R3.1): another person's replay of either key is refused and changes nothing.
    expect((await start(as.admin, job.id, { p_client_op_id: kBench })).error?.hint).toBe("client_op_reused");
    expect((await start(as.admin, job.id, { p_machines: [mill], p_client_op_id: kMachine })).error?.hint).toBe("client_op_reused");
    expect(await snapshot(job.id)).toEqual(before);
    // A bench Start queued offline and first sent now (its key never recorded): refused on_machine, nothing changes; its replay the same.
    const late = await start(as.workshop, job.id, { p_client_op_id: kLateBench });
    expect(late.data).toMatchObject({ bench_run: null, bench_skipped: "on_machine", replayed: false });
    const afterLate = await snapshot(job.id);
    expect(afterLate.runs).toEqual(before.runs);
    expect((await start(as.workshop, job.id, { p_client_op_id: kLateBench })).data).toEqual({ ...late.data, replayed: true });
    expect((await snapshot(job.id)).runs).toEqual(before.runs);
    expect(await openRuns(job.id)).toEqual([mill]);
    expect((await pause(as.workshop, job.id)).error).toBeNull();
  });

  it("device time on the move: a valid device time is kept exactly for both; one before the bench run started uses the server time for the bench end and the machine start, keeps the device time, answers and audits it", async () => {
    const [m1, m2] = [await machineAt("BM Time A"), await machineAt("BM Time B")];
    // Valid: bench from 3 h ago, onto the machine 2 h ago (device): both times kept.
    const ok = await newJob();
    const [t0, t1] = [ago(3), ago(2)];
    expect((await start(as.workshop, ok.id, { p_client_op_id: randomUUID(), p_started_at: t0 })).error).toBeNull();
    const moved = await start(as.workshop, ok.id, { p_machines: [m1], p_client_op_id: randomUUID(), p_started_at: t1 });
    expect(moved.data.time_conflicts).toEqual([]);
    let rows = await runs(ok.id);
    expect(rows.map((r) => [r.machine_id, iso(r.started_at), iso(r.ended_at), r.end_reason, r.device_started_at, r.device_ended_at])).toEqual([[null, t0, t1, "to_machine", null, null], [m1, t1, null, null, null, null]]);
    expect((await pause(as.workshop, ok.id)).error).toBeNull();

    // Device time 4 h ago, before the bench run's start (3 h ago): the server time for both, the device time kept on both rows.
    const bad = await newJob();
    const tBad = ago(4);
    expect((await start(as.workshop, bad.id, { p_client_op_id: randomUUID(), p_started_at: t0 })).error).toBeNull();
    const conflicted = await start(as.workshop, bad.id, { p_machines: [m2], p_client_op_id: randomUUID(), p_started_at: tBad });
    expect(conflicted.error).toBeNull();
    rows = await runs(bad.id);
    const [bench, machine] = [rows.find((r) => r.machine_id === null)!, rows.find((r) => r.machine_id === m2)!];
    expect(ms(bench.ended_at)).toBe(ms(machine.started_at));
    expect(ms(bench.ended_at)!).toBeGreaterThanOrEqual(ms(bench.started_at)!);
    expect(ms(machine.started_at)!).toBeGreaterThan(ms(t0)!);
    expect(iso(machine.device_started_at)).toBe(tBad);
    expect(conflicted.data.time_conflicts).toEqual([
      expect.objectContaining({ machine_id: null, bench: true, what: "end", why: "before_run_start", run_id: bench.id }),
      expect.objectContaining({ machine_id: m2, what: "start", why: "before_bench_run_start", run_id: bench.id }),
    ]);
    expect(conflicted.data.time_conflicts.map((c: { device_at: string; used_at: string }) => [iso(c.device_at), ms(c.used_at)])).toEqual([[tBad, ms(machine.started_at)], [tBad, ms(machine.started_at)]]);
    expect((await audit(bad.id, "BENCH_TO_MACHINE")).rows.map((r) => r.metadata.time_conflict)).toEqual([true]);
    expect((await audit(bad.id, "MACHINE_RUN_TIME_CONFLICT")).rows.map((r) => r.metadata.time_conflicts.length)).toEqual([2]);
    expect((await pause(as.workshop, bad.id)).error).toBeNull();

    // A machine Start whose device time is before the end of the job's PAUSED bench run: the machine run starts at the server time.
    const paused = await newJob();
    expect((await start(as.workshop, paused.id, { p_client_op_id: randomUUID(), p_started_at: t0 })).error).toBeNull();
    expect((await pause(as.workshop, paused.id, { p_client_op_id: randomUUID(), p_ended_at: t1 })).error).toBeNull();
    const m3 = await machineAt("BM Time C"); // a machine with no history: only the job's bench time is the floor
    const early = await start(as.workshop, paused.id, { p_machines: [m3], p_client_op_id: randomUUID(), p_started_at: ago(2.5) });
    expect(early.data.bench_ended).toBeNull();
    expect(early.data.time_conflicts).toEqual([expect.objectContaining({ machine_id: m3, what: "start", why: "before_bench_run_end" })]);
    expect(iso(early.data.time_conflicts[0].run_until)).toBe(t1);
    rows = await runs(paused.id);
    expect(ms(rows.find((r) => r.machine_id === m3)!.started_at)!).toBeGreaterThanOrEqual(ms(t1)!);
    expect((await pause(as.workshop, paused.id)).error).toBeNull();
  });

  it("no bench time after the move: the union of the job's bench intervals ends at the machine start; the table refuses bench time beside the job's machine time, whoever writes", async () => {
    const mill = await machineAt("BM Union");
    const job = await newJob();
    expect((await start(as.workshop, job.id, { p_started_at: ago(2) })).error).toBeNull();
    expect((await start(as.workshop, job.id, { p_machines: [mill], p_started_at: ago(1) })).error).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const totals = (await withDb((db) => db.query<{ bench_after: string; bench_total: string; machine_start: string }>(
      `select public.tstz_union_hours(array_agg(tstzrange(greatest(r.started_at, m.started_at), coalesce(r.ended_at, now()), '[)')) filter (where coalesce(r.ended_at, now()) > m.started_at)) as bench_after,
              public.tstz_union_hours(array_agg(tstzrange(r.started_at, coalesce(r.ended_at, now()), '[)'))) as bench_total, m.started_at as machine_start
         from public.machine_runs r join public.machine_runs m on m.job_id = r.job_id and m.machine_id is not null
        where r.job_id = $1 and r.machine_id is null group by m.started_at`, [job.id]))).rows;
    expect(totals).toHaveLength(1);
    expect(Number(totals[0].bench_after)).toBe(0);
    expect(Number(totals[0].bench_total)).toBeCloseTo(1, 1);
    // The table: a bench run inserted beside the open machine run (open, or closed overlapping it) is refused by the exclusion constraint.
    const codes = await withDb(async (db) => {
      const attempt = (text: string, params: unknown[]) => db.query(text, params).then(() => "ok", (e: { code?: string; constraint?: string }) => `${e.code} ${e.constraint ?? ""}`.trim());
      const org = world.tenants.alpha.id;
      return [
        await attempt("insert into public.machine_runs (organization_id, job_id, machine_id, started_at) values ($1, $2, null, now())", [org, job.id]),
        await attempt("insert into public.machine_runs (organization_id, job_id, machine_id, started_at, ended_at, end_reason) values ($1, $2, null, $3, $4, 'paused')", [org, job.id, ago(0.5), ago(0.25)]),
        // 'to_machine' is a bench run's reason only
        await attempt("update public.machine_runs set ended_at = now(), end_reason = 'to_machine' where job_id = $1 and machine_id is not null", [job.id]),
      ];
    });
    expect(codes).toEqual(["23P01 machine_runs_bench_machine_no_overlap", "23P01 machine_runs_bench_machine_no_overlap", "23514 machine_runs_end_reason_check"]);
    expect(await openRuns(job.id)).toEqual([mill]);
    expect((await pause(as.workshop, job.id)).error).toBeNull();
  });
});

describe("companies, roles and grants", () => {
  it("another company's job is refused both ways; viewer and anon can't Start or Pause; nothing is read across companies", async () => {
    const job = await newJob();
    expect((await start(as.betaAdmin, job.id)).error?.code).toBe("P0002");
    expect((await pause(as.betaAdmin, job.id)).error?.code).toBe("P0002");
    expect((await finish(as.betaAdmin, job.id)).error?.code).toBe("P0002");
    expect((await start(as.admin, betaJob)).error?.code).toBe("P0002");
    expect((await start(as.viewer, job.id)).error?.code).toBe("42501");
    const backend = isolatedBackend();
    const anon = createClient(backend.apiUrl, backend.anonKey, { auth: { persistSession: false } });
    expect((await start(anon, job.id)).error).not.toBeNull();
    expect((await anon.rpc("bench_runs_state")).error).not.toBeNull();
    expect(await runs(job.id)).toEqual([]);
    expect((await jobRow(job.id)).started_at).toBeNull();
    expect(await runs(betaJob)).toEqual([]);

    expect((await start(as.workshop, job.id)).error).toBeNull();
    expect((await pause(as.viewer, job.id)).error?.code).toBe("42501");
    expect((await runs(job.id)).filter((r) => r.ended_at === null)).toHaveLength(1);
    // The other company sees none of it: not the row, not the state.
    expect((await as.betaAdmin.from("machine_runs").select("id").eq("job_id", job.id)).data).toEqual([]);
    expect(await state(as.betaAdmin, job.id)).toEqual([]);
    // Every company role reads its own (viewer included), by display name only.
    for (const role of ["viewer", "workshop", "office", "admin"]) {
      const mine = await state(as[role], job.id);
      expect(mine).toEqual([expect.objectContaining({ is_open: true, operator_name: "Dave Operator" })]);
      expect(JSON.stringify(mine)).not.toContain("@");
    }
    expect((await pause(as.workshop, job.id)).error).toBeNull();
  });

  it("machine_runs stays read-only for the API with bench rows (no insert, update or delete for any role); bench_run_open is internal", async () => {
    const job = await newJob();
    expect((await start(as.workshop, job.id)).error).toBeNull();
    expect((await as.viewer.from("machine_runs").select("id, machine_id").eq("job_id", job.id)).data).toEqual([{ id: expect.any(String), machine_id: null }]);
    for (const role of ["admin", "office", "workshop", "viewer"]) {
      expect((await as[role].from("machine_runs").insert({ organization_id: world.tenants.alpha.id, job_id: job.id, machine_id: null, started_at: new Date().toISOString() })).error?.code).toBe("42501");
      expect((await as[role].from("machine_runs").update({ ended_at: new Date().toISOString(), end_reason: "paused" }).eq("job_id", job.id).select("id")).data ?? []).toEqual([]);
      expect((await as[role].from("machine_runs").delete().eq("job_id", job.id).select("id")).data ?? []).toEqual([]);
      expect((await as[role].rpc("bench_run_open", { p_org: world.tenants.alpha.id, p_job: job.id, p_at: new Date().toISOString(), p_op: null, p_uid: null, p_stamped: true })).error).not.toBeNull();
    }
    expect((await runs(job.id)).map((r) => r.ended_at)).toEqual([null]);
    expect((await pause(as.workshop, job.id)).error).toBeNull();
  });
});

describe("machine time stays machine-only", () => {
  it("machines_in_use and machine_time ignore bench runs", async () => {
    const job = await newJob();
    expect((await start(as.workshop, job.id, { p_started_at: ago(1) })).error).toBeNull();
    const live = (await as.office.rpc("machines_in_use")).data as { job_id: string }[];
    expect(live.filter((r) => r.job_id === job.id)).toEqual([]);
    const time = (await as.office.rpc("machine_time", { p_from: ago(2), p_to: new Date(Date.now() + 60_000).toISOString() })).data as { machine_id: string | null }[];
    expect(time.filter((r) => r.machine_id === null)).toEqual([]);
    expect((await pause(as.workshop, job.id)).error).toBeNull();
  });
});

describe("verify scripts", () => {
  it("046's verify is clean and 044's stays clean with several bench runs open", async () => {
    const [a, b] = [await newJob(), await newJob()];
    for (const job of [a, b]) expect((await start(as.workshop, job.id)).error).toBeNull();
    for (const [file, min] of [["bench_pause.sql", 12], ["machine_runs.sql", 13]] as const) {
      const text = readFileSync(path.join(__dirname, "../../supabase/verify", file), "utf8");
      const rows = (await withDb((db) => db.query<{ n: number; check_name: string; value: string; expected: string }>(text))).rows;
      const facts = rows.filter((r) => r.expected === "true");
      expect(facts.length, file).toBe(min);
      expect(facts.filter((r) => r.value !== "true"), file).toEqual([]);
    }
    for (const job of [a, b]) expect((await pause(as.workshop, job.id)).error).toBeNull();
  });
});
