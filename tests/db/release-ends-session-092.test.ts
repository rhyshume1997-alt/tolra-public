/**
 * Migration 092: an admin's Release machine also ends the job time it stopped (Rhys's walkthrough, Thu 22 Oct, L11). Ruling: it keeps
 * the hours recorded so far, says who ended it and why, and a new Start is needed to resume.
 *
 *   * a workshop Start opens a run and a session; only an admin can release (office and workshop refused, nothing changes);
 *   * the admin's release ends the run and the operator's session at the same instant: end_source 'admin_released', ended_by the admin,
 *     end_reason the admin's reason (trimmed); started_at is unchanged (the hours so far are kept); the setting is cleared after;
 *   * a new Start opens a new session; Pause and Finish end sessions as before, with no end_reason (even with the setting spoofed);
 *   * the job's only run released ends everyone's time on it (a sheet joiner too); with another person's run still open only the
 *     operator's ends; an operator with a second open run on the job keeps their time until that one ends too;
 *   * an admin's correction keeps who and why; an override ends the displaced time 'machine_override' as before.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { type Who, as, hoursAgo, q, refusal } from "./time-support";

let world: SyntheticWorld;
const A = () => world.tenants.alpha.users;

beforeAll(async () => { await verifyBackendIdentity(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

const newJob = () =>
  withDb(async (db) => (await db.query<{ id: string }>("insert into public.jobs (organization_id, job_no, customer) values ($1, $2, 'Release Co') returning id", [world.tenants.alpha.id, `J-R-${randomUUID().slice(0, 8)}`])).rows[0].id);
const newMachine = () =>
  withDb(async (db) => (await db.query<{ id: string }>("insert into public.machines (organization_id, name) values ($1, $2) returning id", [world.tenants.alpha.id, `Mill ${randomUUID().slice(0, 6)}`])).rows[0].id);
const startRun = (who: Who, job: string, machines: string[], at: string | null = null, override = false, reason: string | null = null) =>
  q(who, "select public.start_machine_run(p_job => $1, p_machines => $2::uuid[], p_client_op_id => $3, p_started_at => $4, p_override => $5, p_reason => $6, p_bench => null)", [job, machines, randomUUID(), at, override, reason]);
const release = (who: Who, machine: string, reason: string) => q(who, "select public.release_machine($1, $2)", [machine, reason]);
const sessions = (job: string) =>
  withDb(async (db) => (await db.query("select * from public.operator_sessions where job_id = $1 order by started_at, user_id", [job])).rows);
const runs = (job: string) =>
  withDb(async (db) => (await db.query("select * from public.machine_runs where job_id = $1 order by started_at, machine_id", [job])).rows);
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

describe("an admin's Release machine ends the job time it stopped (092)", () => {
  it("only an admin releases; the run and the session end at the same instant, with who and why; the hours so far are kept", async () => {
    const job = await newJob();
    const mill = await newMachine();
    await startRun(A().workshop, job, [mill], hoursAgo(2));
    const [open] = await sessions(job);
    expect(open).toMatchObject({ user_id: A().workshop.id, source: "machine", ended_at: null });
    for (const who of [A().office, A().workshop]) {
      expect(await refusal(who, "select public.release_machine($1, 'Forgot to finish')", [mill])).toMatchObject({ code: "42501" });
    }
    expect((await sessions(job))[0].ended_at).toBeNull();
    const cleared = await as(A().admin, async (db) => {
      await db.query("select public.release_machine($1, '  Forgot to finish  ')", [mill]);
      return (await db.query<{ v: string | null }>("select current_setting('quoteflow.release_reason', true) as v")).rows[0].v;
    });
    expect(cleared).toBe("");
    const [run] = await runs(job);
    expect(run).toMatchObject({ end_reason: "admin_released", ended_by: A().admin.id });
    const [ended] = await sessions(job);
    expect(ended).toMatchObject({ id: open.id, end_source: "admin_released", ended_by: A().admin.id, end_reason: "Forgot to finish" });
    expect(iso(ended.ended_at)).toBe(iso(run.ended_at));
    expect(iso(ended.started_at)).toBe(iso(open.started_at));
    expect((new Date(ended.ended_at).getTime() - new Date(ended.started_at).getTime()) / 3_600_000).toBeCloseTo(2, 1);
  });

  it("a new Start opens a new session; Pause and Finish end sessions as before, with no reason even when the setting is spoofed", async () => {
    const job = await newJob();
    const mill = await newMachine();
    await startRun(A().workshop, job, [mill]);
    await release(A().admin, mill, "Forgot to finish");
    await startRun(A().workshop, job, [mill]);
    let rows = await sessions(job);
    expect(rows.map((r) => [r.end_source, r.ended_at === null])).toEqual([["admin_released", false], [null, true]]);
    await as(A().workshop, async (db) => {
      await db.query("select set_config('quoteflow.release_reason', 'Spoofed', true)");
      await db.query("select public.pause_machine_run($1, null, $2, null)", [job, randomUUID()]);
    });
    rows = await sessions(job);
    expect(rows[1]).toMatchObject({ end_source: "machine_pause", end_reason: null });
    const other = await newJob();
    await startRun(A().workshop, other, [await newMachine()]);
    await q(A().workshop, "select public.finish_job($1, $2, null)", [other, randomUUID()]);
    const [finished] = await sessions(other);
    expect(["machine_finish", "job_finish"]).toContain(finished.end_source);
    expect(finished.end_reason).toBeNull();
  });

  it("the job's only run released ends everyone's time; another person's open run keeps theirs; an operator's second run keeps theirs", async () => {
    const solo = await newJob();
    const m1 = await newMachine();
    await startRun(A().workshop, solo, [m1]);
    await q(A().office, "select public.record_labour_event($1, $2, 'start', null)", [randomUUID(), solo]);
    await release(A().admin, m1, "Left running overnight");
    expect((await sessions(solo)).map((r) => [r.end_source, r.end_reason])).toEqual([["admin_released", "Left running overnight"], ["admin_released", "Left running overnight"]]);

    const shared = await newJob();
    const [m2, m3] = [await newMachine(), await newMachine()];
    await startRun(A().workshop, shared, [m2]);
    await startRun(A().office, shared, [m3]);
    await release(A().admin, m2, "Wrong machine");
    const byUser = Object.fromEntries((await sessions(shared)).map((r) => [r.user_id, r.end_source]));
    expect(byUser).toEqual({ [A().workshop.id]: "admin_released", [A().office.id]: null });

    const two = await newJob();
    const [m4, m5] = [await newMachine(), await newMachine()];
    await startRun(A().workshop, two, [m4, m5]);
    await release(A().admin, m4, "Tool broke");
    expect((await sessions(two))[0].ended_at).toBeNull();
    await release(A().admin, m5, "Tool broke");
    expect((await sessions(two))[0]).toMatchObject({ end_source: "admin_released", end_reason: "Tool broke" });
  });

  it("an admin's correction keeps who and why; an override still ends the displaced time as machine_override", async () => {
    const job = await newJob();
    const mill = await newMachine();
    await startRun(A().workshop, job, [mill], hoursAgo(2));
    await release(A().admin, mill, "Forgot to finish");
    const [s] = await sessions(job);
    await q(A().admin, "select public.correct_labour_session($1, $2, $3, 'Started a bit later')", [s.id, new Date(new Date(s.started_at).getTime() + 300_000).toISOString(), iso(s.ended_at)]);
    expect((await sessions(job))[0]).toMatchObject({ end_source: "admin_released", end_reason: "Forgot to finish", ended_by: A().admin.id });

    const [jobA, jobB] = [await newJob(), await newJob()];
    const saw = await newMachine();
    await startRun(A().workshop, jobA, [saw]);
    await startRun(A().admin, jobB, [saw], null, true, "Customer collecting today");
    expect((await sessions(jobA))[0]).toMatchObject({ user_id: A().workshop.id, end_source: "machine_override", end_reason: null });
  });
});
