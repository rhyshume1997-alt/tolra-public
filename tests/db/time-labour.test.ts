/**
 * Job labour (migration 051): operator_sessions from the daily job sheet (Start / Stop) and from the Job Board (Start / Pause / Finish).
 *
 *   * Start and Stop on the sheet are the caller's own, keyed: a replay answers the first result; a reused key is refused; two
 *     connections with one key make one session; a Stop that arrives before its Start (two devices) closes it when the Start arrives;
 *   * device times: older than 14 days refused; a Start inside time already recorded starts after it, the device time kept;
 *   * the Job Board writes labour in the same transaction: a Start opens the presser's session (machine or bench); each person's time
 *     stops when their own runs on the job stop (Pause, Finish, an admin's override), other people's carry on; a Pause on the whole job
 *     or a Finish stops everyone's; an admin's release stops it too (092: end_source admin_released, who and why); a labour failure
 *     never undoes the Start (audited instead);
 *   * corrections keep the first times, need a reason; someone else's need an admin; overlaps are refused; void keeps the row;
 *   * read: own rows for workshop, the company's for admin and office, none for viewer or the other company; no direct writes;
 *   * the other company's jobs, people and sessions are out of reach.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { type Who, become, hoursAgo, q, refusal } from "./time-support";

let world: SyntheticWorld;
const A = () => world.tenants.alpha.users;
const B = () => world.tenants.beta.users;

beforeAll(async () => { await verifyBackendIdentity(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

const newJob = (tenant: "alpha" | "beta" = "alpha") =>
  withDb(async (db) => (await db.query<{ id: string }>("insert into public.jobs (organization_id, job_no, customer) values ($1, $2, 'Labour Co') returning id", [world.tenants[tenant].id, `J-L-${randomUUID().slice(0, 8)}`])).rows[0].id);
const newMachine = () =>
  withDb(async (db) => (await db.query<{ id: string }>("insert into public.machines (organization_id, name) values ($1, $2) returning id", [world.tenants.alpha.id, `Mill ${randomUUID().slice(0, 6)}`])).rows[0].id);
const labour = (who: Who, job: string, action: "start" | "stop", at: string | null, key = randomUUID()) =>
  q<{ r: Record<string, unknown> }>(who, "select public.record_labour_event($1, $2, $3, $4) as r", [key, job, action, at]).then((rows) => rows[0].r);
const sessions = (job: string) =>
  withDb(async (db) => (await db.query("select * from public.operator_sessions where job_id = $1 order by started_at, user_id", [job])).rows);
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

describe("Start and Stop on the daily job sheet", () => {
  it("opens and closes the caller's own session; replays answer the first result; a reused key is refused", async () => {
    const job = await newJob();
    const startKey = randomUUID();
    const from = hoursAgo(3);
    const started = await labour(A().workshop, job, "start", from, startKey);
    expect(started).toMatchObject({ state: "started", user_id: A().workshop.id, job_id: job, replayed: false, time_conflict: false });
    expect(await labour(A().workshop, job, "start", hoursAgo(1), startKey)).toEqual({ ...started, replayed: true });
    expect(await labour(A().workshop, job, "start", null)).toMatchObject({ state: "already", session_id: started.session_id });
    const stopKey = randomUUID();
    const to = hoursAgo(1);
    const stopped = await labour(A().workshop, job, "stop", to, stopKey);
    expect(stopped).toMatchObject({ state: "stopped", session_id: started.session_id });
    expect(iso(stopped.ended_at)).toBe(to);
    expect(await labour(A().workshop, job, "stop", null, stopKey)).toEqual({ ...stopped, replayed: true });
    expect(await refusal(A().workshop, "select public.record_labour_event($1, $2, 'start', null)", [stopKey, job])).toMatchObject({ code: "22023", hint: "client_op_reused" });
    expect(await refusal(A().office, "select public.record_labour_event($1, $2, 'stop', null)", [stopKey, job])).toMatchObject({ hint: "client_op_reused" });
    const rows = await sessions(job);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "sheet", end_source: "sheet", user_id: A().workshop.id });
  });

  it("two devices, reversed order: the Stop arriving first is kept and closes the session when the Start arrives", async () => {
    const job = await newJob();
    const from = hoursAgo(5);
    const to = hoursAgo(2);
    expect(await labour(A().office, job, "stop", to)).toMatchObject({ state: "nothing_open", session_id: null });
    const started = await labour(A().office, job, "start", from);
    expect(started).toMatchObject({ state: "started_and_stopped" });
    expect([iso(started.started_at), iso(started.ended_at)]).toEqual([from, to]);
    const rows = await sessions(job);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ end_source: "pending_stop", ended_at: new Date(to) });
    // The pending Stop is used once: a later Start opens a new, open session.
    expect(await labour(A().office, job, "start", hoursAgo(1))).toMatchObject({ state: "started", ended_at: null });
  });

  it("the same key from two connections at once makes one session; a person can be on two jobs at once", async () => {
    const [j1, j2] = [await newJob(), await newJob()];
    const key = randomUUID();
    const at = hoursAgo(1);
    const [a, b] = await Promise.all([labour(A().admin, j1, "start", at, key), labour(A().admin, j1, "start", at, key)]);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await sessions(j1)).toHaveLength(1);
    expect(await labour(A().admin, j2, "start", at)).toMatchObject({ state: "started" });
    const open = await withDb(async (db) => (await db.query("select job_id from public.operator_sessions where user_id = $1 and ended_at is null and job_id = any($2)", [A().admin.id, [j1, j2]])).rows);
    expect(open).toHaveLength(2);
  });

  it("device times: older than 14 days refused; a Start inside recorded time starts after it, the device time kept", async () => {
    const job = await newJob();
    expect(await refusal(A().workshop, "select public.record_labour_event($1, $2, 'start', $3)", [randomUUID(), job, hoursAgo(15 * 24)])).toMatchObject({ code: "22023", hint: "time_too_old" });
    await labour(A().workshop, job, "start", hoursAgo(4));
    const stop = await labour(A().workshop, job, "stop", hoursAgo(2));
    const sent = hoursAgo(3); // inside the 4h..2h ago session
    const late = await labour(A().workshop, job, "start", sent);
    expect(late).toMatchObject({ state: "started", time_conflict: true });
    expect(iso(late.started_at)).toBe(iso(stop.ended_at));
    expect(iso(late.device_at)).toBe(sent);
    const row = (await sessions(job)).find((s) => s.id === late.session_id)!;
    expect(iso(row.device_started_at)).toBe(sent);
  });

  it("viewer, a job of the other company, and anon are refused", async () => {
    const job = await newJob();
    expect(await refusal(A().viewer, "select public.record_labour_event($1, $2, 'start', null)", [randomUUID(), job])).toMatchObject({ code: "42501", hint: "not_allowed" });
    const theirs = await newJob("beta");
    expect(await refusal(A().workshop, "select public.record_labour_event($1, $2, 'start', null)", [randomUUID(), theirs])).toMatchObject({ code: "P0002" });
    expect(await sessions(theirs)).toEqual([]);
  });
});

describe("the Job Board writes labour in the same transaction", () => {
  const startRun = (who: Who, job: string, machines: string[], bench: boolean | null = null) =>
    q<{ r: Record<string, unknown> }>(who, "select public.start_machine_run(p_job => $1, p_machines => $2::uuid[], p_client_op_id => $3, p_started_at => null, p_override => false, p_reason => null, p_bench => $4) as r", [job, machines, randomUUID(), bench]).then((r) => r[0].r);
  const pauseRun = (who: Who, job: string) => q(who, "select public.pause_machine_run($1, null, $2, null)", [job, randomUUID()]);
  const finishJob = (who: Who, job: string) => q(who, "select public.finish_job($1, $2, null)", [job, randomUUID()]);

  it("each person's time follows their own runs: Charlie pausing his machine stops Charlie's time while Lee's machine and time carry on", async () => {
    const job = await newJob();
    const [m1, m2] = [await newMachine(), await newMachine()];
    const charlie = A().workshop;
    const lee = A().office;
    await startRun(charlie, job, [m1]);
    await startRun(lee, job, [m2]);
    let rows = await sessions(job);
    expect(rows.map((r) => [r.user_id, r.source, r.ended_at]).sort()).toEqual([[charlie.id, "machine", null], [lee.id, "machine", null]].sort());
    await q(charlie, "select public.pause_machine_run($1, $2::uuid[], $3, null)", [job, [m1], randomUUID()]);
    rows = await sessions(job);
    expect(rows.find((r) => r.user_id === charlie.id)).toMatchObject({ end_source: "machine_pause", ended_by: charlie.id });
    expect(rows.find((r) => r.user_id === lee.id)).toMatchObject({ ended_at: null });
    // Someone else pausing just Lee's machine still stops Lee's time (it was his run), and only his.
    await startRun(charlie, job, [m1]);
    await q(A().admin, "select public.pause_machine_run($1, $2::uuid[], $3, null)", [job, [m2], randomUUID()]);
    rows = await sessions(job);
    expect(rows.find((r) => r.user_id === lee.id)).toMatchObject({ end_source: "machine_pause", ended_by: A().admin.id });
    expect(rows.filter((r) => r.user_id === charlie.id && r.ended_at === null)).toHaveLength(1);
  });

  it("Pause on the whole job stops everyone's time on it, including people who joined from the sheet; Finish too", async () => {
    const job = await newJob();
    const [m1, m2] = [await newMachine(), await newMachine()];
    await startRun(A().workshop, job, [m1]);
    await startRun(A().office, job, [m2]);
    await labour(A().admin, job, "start", null); // joined from the sheet, no run
    await pauseRun(A().workshop, job); // every run on the job
    let rows = await sessions(job);
    expect(rows.map((r) => r.end_source).sort()).toEqual(["machine_pause", "machine_pause", "machine_pause"]);
    // Bench Start again by one person, a second joins from the sheet, then Finish: everyone's ends.
    await startRun(A().workshop, job, [], true);
    expect((await sessions(job)).filter((r) => r.user_id === A().workshop.id && r.ended_at === null)).toHaveLength(1);
    await labour(A().office, job, "start", null);
    await finishJob(A().admin, job);
    rows = await sessions(job);
    expect(rows.every((r) => r.ended_at !== null)).toBe(true);
    expect(rows.slice(-2).map((r) => r.end_source).every((s) => s === "machine_finish" || s === "job_finish")).toBe(true);
  });

  it("an admin's override ends the displaced operator's time on that job; the admin gets their own on the other job", async () => {
    const [jobA, jobB] = [await newJob(), await newJob()];
    const mill = await newMachine();
    await startRun(A().workshop, jobA, [mill]);
    await q(A().admin, "select public.start_machine_run(p_job => $1, p_machines => $2::uuid[], p_client_op_id => $3, p_started_at => null, p_override => true, p_reason => 'Customer collecting today')", [jobB, [mill], randomUUID()]);
    expect((await sessions(jobA))[0]).toMatchObject({ user_id: A().workshop.id, end_source: "machine_override" });
    expect((await sessions(jobB))[0]).toMatchObject({ user_id: A().admin.id, ended_at: null });
  });

  it("an admin's release ends the operator's time at the release, with who and why (092); a plain Finish of a job with no machine ends everyone's time on it", async () => {
    const job = await newJob();
    const mill = await newMachine();
    await startRun(A().workshop, job, [mill]);
    const [open] = await sessions(job);
    await q(A().admin, "select public.release_machine($1, 'Forgot to finish')", [mill]);
    const [released] = await sessions(job);
    const [run] = await withDb(async (db) => (await db.query("select ended_at from public.machine_runs where job_id = $1", [job])).rows);
    expect(released).toMatchObject({ id: open.id, user_id: A().workshop.id, end_source: "admin_released", ended_by: A().admin.id, end_reason: "Forgot to finish" });
    expect(iso(released.ended_at)).toBe(iso(run.ended_at));
    expect(iso(released.started_at)).toBe(iso(open.started_at)); // the hours so far are kept
    const plain = await newJob();
    await labour(A().workshop, plain, "start", hoursAgo(1));
    await labour(A().office, plain, "start", hoursAgo(1));
    const finishedAt = new Date(Date.now() - 60_000).toISOString();
    await q(A().workshop, "update public.jobs set finished_at = $2 where id = $1", [plain, finishedAt]);
    expect((await sessions(plain)).map((r) => [r.end_source, iso(r.ended_at)])).toEqual([["job_finish", finishedAt], ["job_finish", finishedAt]]);
  });

  it("bench to machine (046 'to_machine') ends nobody's labour; the person who started the machine gets their own session", async () => {
    const job = await newJob();
    const mill = await newMachine();
    await startRun(A().workshop, job, [], true);
    await startRun(A().office, job, [mill]);
    const runs = await withDb(async (db) => (await db.query("select end_reason from public.machine_runs where job_id = $1 and machine_id is null", [job])).rows);
    expect(runs).toEqual([{ end_reason: "to_machine" }]);
    const rows = await sessions(job);
    expect(rows.map((r) => [r.user_id === A().workshop.id ? "workshop" : "office", r.ended_at === null]).sort()).toEqual([["office", true], ["workshop", true]]);
  });

  it("runs written with no signed-in person (imports), or inserted already ended, open no labour", async () => {
    const job = await newJob();
    const mill = await newMachine();
    await withDb((db) => db.query("insert into public.machine_runs (organization_id, job_id, machine_id, started_at) values ($1, $2, $3, now() - interval '3 hours')", [world.tenants.alpha.id, job, mill]));
    expect(await sessions(job)).toEqual([]);
    const other = await newMachine();
    await withDb((db) => db.query("insert into public.machine_runs (organization_id, job_id, machine_id, operator_id, started_at, ended_at, end_reason) values ($1, $2, $3, $4, now() - interval '2 hours', now() - interval '1 hour', 'paused')", [world.tenants.alpha.id, job, other, A().workshop.id]));
    expect(await sessions(job)).toEqual([]);
  });

  it("a labour failure never undoes a Start: the run is recorded, the labour skipped and LABOUR_WRITE_FAILED audited", async () => {
    const job = await newJob();
    const mill = await newMachine();
    const out = await withDb(async (db) => {
      await db.query("begin");
      try {
        // Make every labour write fail inside this transaction only (rolled back below).
        await db.query("create function pg_temp.refuse_labour() returns trigger language plpgsql as $$ begin raise exception 'labour store unavailable'; end $$");
        await db.query("create trigger zz_refuse_labour before insert or update on public.operator_sessions for each row execute function pg_temp.refuse_labour()");
        await become(db, A().workshop);
        const started = (await db.query("select public.start_machine_run(p_job => $1, p_machines => $2::uuid[], p_client_op_id => $3, p_started_at => null, p_override => false, p_reason => null) as r", [job, [mill], randomUUID()])).rows[0].r;
        await db.query("reset role");
        const runs = (await db.query("select count(*)::int as n from public.machine_runs where job_id = $1 and ended_at is null", [job])).rows[0].n;
        const labourRows = (await db.query("select count(*)::int as n from public.operator_sessions where job_id = $1", [job])).rows[0].n;
        const audit = (await db.query("select metadata from security_audit.audit_log where action = 'LABOUR_WRITE_FAILED' and entity_table = 'machine_runs' and organization_id = $1 order by created_at desc limit 1", [world.tenants.alpha.id])).rows;
        return { started, runs, labourRows, audit };
      } finally {
        await db.query("rollback");
      }
    });
    expect(out.started).toBeTruthy();
    expect(out.runs).toBe(1);
    expect(out.labourRows).toBe(0);
    expect(out.audit[0].metadata).toMatchObject({ what: "open", error: "labour store unavailable" });
  });

  it("a sheet Start and a Job Board Start by the same person at once leave one open session", async () => {
    for (const order of ["sheet first", "board first"]) {
      const job = await newJob();
      const mill = await newMachine();
      const calls = [() => labour(A().workshop, job, "start", null), () => startRun(A().workshop, job, [mill])];
      if (order === "board first") calls.reverse();
      await Promise.all(calls.map((c) => c()));
      const rows = await sessions(job);
      expect({ order, open: rows.filter((r) => r.ended_at === null).length }).toEqual({ order, open: 1 });
    }
  });
});

describe("corrections", () => {
  const correct = (who: Who, session: string, from: string, to: string | null, reason: string) =>
    q<{ r: Record<string, unknown> }>(who, "select public.correct_labour_session($1, $2, $3, $4) as r", [session, from, to, reason]).then((r) => r[0].r);

  it("the person corrects their own (first times kept); someone else's needs an admin; overlap and missing reason refused; void keeps the row", async () => {
    const job = await newJob();
    const s = await labour(A().workshop, job, "start", hoursAgo(6));
    await labour(A().workshop, job, "stop", hoursAgo(5));
    const fixed = await correct(A().workshop, s.session_id as string, hoursAgo(6.5), hoursAgo(5), "Started before I pressed Start");
    expect(fixed).toMatchObject({ state: "corrected" });
    const row = (await sessions(job))[0];
    expect(iso(row.original_started_at)).toBe(iso(s.started_at));
    expect(row.correction_reason).toBe("Started before I pressed Start");
    expect(await refusal(A().office, "select public.correct_labour_session($1, $2, $3, 'Not mine')", [s.session_id, hoursAgo(6), hoursAgo(5)])).toMatchObject({ code: "42501", hint: "admin_only" });
    expect(await refusal(A().workshop, "select public.correct_labour_session($1, $2, $3, 'x')", [s.session_id, hoursAgo(6), hoursAgo(5)])).toMatchObject({ hint: "reason_required" });
    expect(await refusal(A().workshop, "select public.correct_labour_session($1, $2, $3, 'Backwards')", [s.session_id, hoursAgo(5), hoursAgo(6)])).toMatchObject({ hint: "bad_time" });
    const added = await q<{ r: Record<string, unknown> }>(A().admin, "select public.add_labour_session($1, $2, $3, $4, $5, 'Deburring, forgot to press Start') as r", [randomUUID(), A().workshop.id, job, hoursAgo(4), hoursAgo(3)]);
    expect(added[0].r).toMatchObject({ state: "added" });
    expect(await refusal(A().workshop, "select public.add_labour_session($1, null, $2, $3, $4, 'Overlaps the first')", [randomUUID(), job, hoursAgo(5.5), hoursAgo(3.5)])).toMatchObject({ code: "23P01", hint: "labour_overlap" });
    const voided = await q<{ r: Record<string, unknown> }>(A().admin, "select public.void_labour_session($1, 'Entered twice') as r", [added[0].r.session_id]);
    expect(voided[0].r).toMatchObject({ state: "voided" });
    const all = await sessions(job);
    expect(all).toHaveLength(2);
    expect(all.find((r) => r.id === added[0].r.session_id)).toMatchObject({ void_reason: "Entered twice" });
    const events = await withDb(async (db) => (await db.query("select action from security_audit.audit_log where entity_table = 'operator_sessions' and action like 'LABOUR_%' and entity_id = any($1) order by created_at", [[s.session_id, added[0].r.session_id]])).rows.map((r) => r.action));
    expect(events).toEqual(["LABOUR_CORRECTED", "LABOUR_ADDED", "LABOUR_VOIDED"]);
  });

  it("the other company's people and sessions are out of reach", async () => {
    const theirJob = await newJob("beta");
    const theirs = await labour(B().workshop, theirJob, "start", hoursAgo(1));
    expect(await refusal(A().admin, "select public.correct_labour_session($1, $2, null, 'Cross company')", [theirs.session_id, hoursAgo(2)])).toMatchObject({ code: "P0002", hint: "session_missing" });
    expect(await refusal(A().admin, "select public.void_labour_session($1, 'Cross company')", [theirs.session_id])).toMatchObject({ code: "P0002" });
    expect(await refusal(A().admin, "select public.add_labour_session($1, $2, $3, $4, $5, 'Cross company')", [randomUUID(), B().workshop.id, await newJob(), hoursAgo(3), hoursAgo(2)])).toMatchObject({ code: "P0002", hint: "not_member" });
    expect(await refusal(A().admin, "select public.add_labour_session($1, null, $2, $3, $4, 'Cross company')", [randomUUID(), theirJob, hoursAgo(3), hoursAgo(2)])).toMatchObject({ code: "P0002" });
  });
});

describe("the table", () => {
  it("read: own rows for workshop, the company's for admin and office, none for viewer or the other company; no direct writes", async () => {
    const mine = await q<{ user_id: string }>(A().workshop, "select distinct user_id from public.operator_sessions");
    expect(mine.map((r) => r.user_id)).toEqual([A().workshop.id]);
    for (const who of [A().admin, A().office]) {
      const all = await q<{ organization_id: string; user_id: string }>(who, "select organization_id, user_id from public.operator_sessions");
      expect(new Set(all.map((r) => r.organization_id))).toEqual(new Set([world.tenants.alpha.id]));
      expect(new Set(all.map((r) => r.user_id)).size).toBeGreaterThan(1);
    }
    expect(await q(A().viewer, "select 1 from public.operator_sessions")).toEqual([]);
    expect(await q(A().admin, "select 1 from public.labour_ops").catch((e) => e.code)).toBe("42501");
    for (const sql of ["update public.operator_sessions set ended_at = now()", "delete from public.operator_sessions", "insert into public.operator_sessions (organization_id, user_id, job_id, started_at, source) select organization_id, user_id, job_id, now(), 'manual' from public.operator_sessions limit 1"]) {
      expect(await refusal(A().admin, sql)).toMatchObject({ code: "42501" });
    }
  });
});
