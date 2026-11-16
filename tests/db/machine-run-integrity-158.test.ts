/**
 * Release 158 (supabase/release/158_machine_run_integrity.release.sql, phase 158 after 157): pause_machine_run and finish_job use the server's
 * time whenever another operator has an open machine run or job time session on the job; the device time stays in the audit log. The DB
 * proof, below PostgREST, one `it` per required case.
 *
 * Inputs: the disposable Supabase stack (TEST_DATABASE_URL, isolation-checked); the post-144 fixture installs 145..158. Calls run as
 * PostgREST would: one transaction, role authenticated with a person's JWT claims. Two-session cases hold one transaction open while a
 * second connection runs and read pg_stat_activity to prove the second one waits. Companies are synthetic (slug t-<run>-...) and removed
 * afterwards by destroySyntheticWorld. Release, rollback and re-release run inside transactions that are always rolled back.
 * Proves: a Pause or Finish by one person with a back-dated device time cannot end another operator's run or job time in the past (the run
 * and the sessions end at server time, hours are not zeroed, the device time is kept in the audit log); alone on the job the device time is
 * honoured exactly as before; replays move nothing; concurrent operators leave each run ended once and each session closed once; admin,
 * office and workshop can still Pause and Finish with other people's runs open, the viewer still cannot; another company never influences
 * the decision; no run, session, booking or job time is ever negative; a plain update of the finish time is refused by release 157 (case 5c); release, rollback and re-release restore both bodies exactly.
 * Not proved here: PostgREST's own error mapping, hosted PostgreSQL 17, hosted lock timing, the browser.
 * Must not change: this file proves; it never edits a release, verify or rollback file to make itself pass.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedBackend } from "../support/isolation";
import { EMAIL_DOMAIN, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";

const runId = randomBytes(4).toString("hex");
let seq = 0;
const slug = (label: string) => `t-${runId}-p158-${label}-${++seq}`;
const email = (label: string) => `${label}-${++seq}.${runId}@${EMAIL_DOMAIN}`;
const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const RELEASE = "supabase/release/158_machine_run_integrity.release.sql";
const ROLLBACK = "supabase/release/158_machine_run_integrity.rollback.sql";
const VERIFY = "supabase/verify/machine_run_integrity_158.sql";
const PREFLIGHT = "supabase/verify/release_preflight.sql";
const MARKER = "post-144 marker 158 machine_run_integrity";
const PAUSE_SIG = "public.pause_machine_run(uuid,uuid[],uuid,timestamptz)";
const FINISH_SIG = "public.finish_job(uuid,uuid,timestamptz)";
// The bodies the release replaces (044's pause_machine_run, 061's finish_job) and the bodies it installs (md5 of prosrc, whitespace removed).
const BEFORE_158 = { pause: "2a172ae0576c14095bc1281294789894", finish: "57e2b9a298fa8647a775f8e0a56bbe58" };
const AFTER_158 = { pause: "b00c08c8ee4934428f278fa6beadde1b", finish: "154bb3fff8179ce2f26c1810f054e18f" };
// Functions 158 must not change (checked by equality before and after, not by a stored value).
const UNTOUCHED = ["public.machine_run_end(uuid,timestamptz,text,uuid)", "public.machine_run_client_time(timestamptz)", "public.machine_runs_labour()",
  "public.jobs_finish_labour()", "public.labour_close_all(uuid,uuid,timestamptz,text,uuid)", "public.labour_close(uuid,uuid,timestamptz,text,uuid)",
  "public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text)", "public.record_labour_event(uuid,uuid,text,timestamptz)"];

let pool: Pool;
type Row = Record<string, unknown>;
type Res = { data: Row | null; code?: string; hint?: string; message?: string };
const claims = (sub: string) => ({ sub, role: "authenticated", aal: "aal2", email: `${sub.slice(0, 8)}@example.test` });
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR);

async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await pool.connect();
  try { return (await db.query(sql, params)).rows as T[]; } finally { db.release(); }
}
const serverNow = async () => (await q<{ t: Date }>("select clock_timestamp() as t"))[0].t;
async function asUser(db: PoolClient, sub: string) {
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claims(sub)), sub]);
}
/** fn(named args) inside an open transaction; arrays go as arrays, times as ISO text, typed by the function's own signature. */
async function callIn(db: PoolClient, fn: string, args: Record<string, unknown>): Promise<Row> {
  const names = Object.keys(args);
  const values = names.map((n) => (args[n] instanceof Date ? (args[n] as Date).toISOString() : args[n]));
  return (await db.query(`select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`, values)).rows[0].r as Row;
}
/** One call as PostgREST runs it: one transaction, committed on success. */
async function call(sub: string, fn: string, args: Record<string, unknown>): Promise<Res> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await asUser(db, sub);
    const data = await callIn(db, fn, args);
    await db.query("commit");
    return { data };
  } catch (e) {
    await db.query("rollback").catch(() => undefined);
    const x = e as { code?: string; hint?: string; message: string };
    return { data: null, code: x.code, hint: x.hint, message: x.message };
  } finally { db.release(); }
}
async function rolledBack<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try { await db.query("begin"); return await fn(db); } finally { await db.query("rollback").catch(() => undefined); db.release(); }
}
/** A release or rollback file without its own BEGIN / COMMIT, to run inside a test transaction. */
function body(file: string) {
  const s = read(file);
  expect(s.match(/^BEGIN;$/gm), file).toHaveLength(1);
  expect(s.match(/^COMMIT;$/gm), file).toHaveLength(1);
  return s.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
}
const preflightRows = async (db: PoolClient) => (await db.query(read(PREFLIGHT))).rows as { check: string; value: string }[];
const verifyRows = async (db: PoolClient) => (await db.query(read(VERIFY))).rows as { check_name: string; ok: boolean }[];
const bodies = async (db: PoolClient) => {
  const r = (await db.query(`select
    (select md5(regexp_replace(prosrc, '\\s', '', 'g')) from pg_proc where oid = to_regprocedure('${PAUSE_SIG}')) as pause,
    (select md5(regexp_replace(prosrc, '\\s', '', 'g')) from pg_proc where oid = to_regprocedure('${FINISH_SIG}')) as finish`)).rows[0];
  return r as { pause: string; finish: string };
};
/** Definer flag, search path, owner, grants and language of both functions, and the md5 of everything the release must not change. */
const settings = async (db: PoolClient) => (await db.query(`select
    (select jsonb_agg(jsonb_build_object('sig', p.oid::regprocedure::text, 'definer', p.prosecdef, 'config', p.proconfig, 'acl', p.proacl::text, 'owner', p.proowner::regrole::text,
                                         'vol', p.provolatile, 'ret', p.prorettype::regtype::text, 'lang', p.prolang::text) order by p.oid::regprocedure::text)
       from pg_proc p where p.oid in (to_regprocedure('${PAUSE_SIG}'), to_regprocedure('${FINISH_SIG}'))) as functions,
    (select jsonb_object_agg(s, md5(regexp_replace(p.prosrc, '\\s', '', 'g'))) from unnest($1::text[]) s join pg_proc p on p.oid = to_regprocedure(s)) as untouched`, [UNTOUCHED])).rows[0];

// ---- Synthetic companies, people, jobs, machines ----------------------------------------------------------------------------------
async function makeCompany() {
  const o = randomUUID();
  await q("insert into organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [o, `Synthetic p158 ${o.slice(0, 8)}`, slug("co")]);
  return o;
}
async function makePerson(o: string, role: string) {
  const u = randomUUID();
  const e = email(role);
  await q("insert into auth.users (id, email) values ($1, $2)", [u, e]);
  await q("insert into user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, 'Synthetic', $3, $4, true, false)", [u, e, role, o]);
  await q("insert into organization_members (organization_id, user_id, role, active) values ($1, $2, $3, true)", [o, u, role]);
  return u;
}
const makeJob = async (o: string) => (await q<{ id: string }>("insert into jobs (organization_id, job_no, customer) values ($1, $2, 'Integrity Co') returning id", [o, `J-P158-${runId}-${++seq}`]))[0].id;
const makeMachine = async (o: string) => (await q<{ id: string }>("insert into machines (organization_id, name, active) values ($1, $2, true) returning id", [o, `P158 machine ${runId}-${++seq}`]))[0].id;

type Co = { o: string; admin: string; office: string; workshop: string; workshop2: string; workshop3: string; viewer: string };
async function company(): Promise<Co> {
  const o = await makeCompany();
  return { o, admin: await makePerson(o, "admin"), office: await makePerson(o, "office"), workshop: await makePerson(o, "workshop"),
           workshop2: await makePerson(o, "workshop"), workshop3: await makePerson(o, "workshop"), viewer: await makePerson(o, "viewer") };
}

// ---- Actions and reads --------------------------------------------------------------------------------------------------------------
const startRun = (sub: string, job: string, machines: string[], at: Date | null = null, op: string | null = randomUUID()) =>
  call(sub, "start_machine_run", { p_job: job, p_machines: machines, p_client_op_id: op, p_started_at: at, p_override: false, p_reason: null });
const pauseRun = (sub: string, job: string, at: Date | null, machines: string[] | null = null, op: string | null = randomUUID()) =>
  call(sub, "pause_machine_run", { p_job: job, p_machines: machines, p_client_op_id: op, p_ended_at: at });
const finishJob = (sub: string, job: string, at: Date | null, op: string | null = randomUUID()) =>
  call(sub, "finish_job", { p_job: job, p_client_op_id: op, p_finished_at: at });
const sheetStart = (sub: string, job: string, at: Date | null = null) => call(sub, "record_labour_event", { p_client_op_id: randomUUID(), p_job: job, p_action: "start", p_at: at });
async function ok(r: Promise<Res>) { const x = await r; expect(x.data, JSON.stringify(x)).not.toBeNull(); return x.data!; }

type RunRow = { id: string; machine_id: string | null; operator_id: string | null; started_at: Date; ended_at: Date | null; end_reason: string | null; ended_by: string | null; ended_op_id: string | null; device_ended_at: Date | null };
type SessionRow = { id: string; user_id: string; started_at: Date; ended_at: Date | null; end_source: string | null; ended_by: string | null; source: string; device_ended_at: Date | null };
const runsOf = (job: string) => q<RunRow>("select id, machine_id, operator_id, started_at, ended_at, end_reason, ended_by, ended_op_id, device_ended_at from machine_runs where job_id = $1 order by started_at, id", [job]);
const sessionsOf = (job: string) => q<SessionRow>("select id, user_id, started_at, ended_at, end_source, ended_by, source, device_ended_at from operator_sessions where job_id = $1 order by started_at, user_id", [job]);
const jobOf = async (job: string) => (await q<{ started_at: Date | null; finished_at: Date | null }>("select started_at, finished_at from jobs where id = $1", [job]))[0];
const auditOf = (job: string, action: string) => q<{ metadata: Row }>("select metadata from security_audit.audit_log where entity_table = 'jobs' and entity_id = $1 and action = $2 order by created_at", [job, action]);
const iso = (v: unknown) => new Date(v as string | Date).toISOString();
/** Everything an action can change for one job: runs, sessions, job times, operation rows, bookings, audit rows. One comparable value. */
async function fingerprint(job: string) {
  return (await q(`select
    (select coalesce(jsonb_agg(to_jsonb(r) order by r.id), '[]') from machine_runs r where r.job_id = $1) as runs,
    (select coalesce(jsonb_agg(to_jsonb(s) order by s.id), '[]') from operator_sessions s where s.job_id = $1) as sessions,
    (select jsonb_build_array(j.started_at, j.finished_at, j.stage) from jobs j where j.id = $1) as job,
    (select count(*) from machine_run_ops o where o.job_id = $1)::int as ops,
    (select coalesce(jsonb_agg(to_jsonb(b) order by b.id), '[]') from machine_bookings b where b.job_id = $1) as bookings,
    (select count(*) from security_audit.audit_log a where a.entity_id = $1::text and a.entity_table = 'jobs')::int as audit_rows`, [job]))[0];
}
/** Time integrity (case 6): nothing negative anywhere in the job's time, at any moment. */
async function assertIntegrity(job: string) {
  for (const r of await runsOf(job)) if (r.ended_at) expect(r.ended_at.getTime(), `run ${r.id} ends before it starts`).toBeGreaterThanOrEqual(r.started_at.getTime());
  for (const s of await sessionsOf(job)) if (s.ended_at) expect(s.ended_at.getTime(), `session ${s.id} ends before it starts`).toBeGreaterThanOrEqual(s.started_at.getTime());
  const bad = await q("select b.id from machine_bookings b where b.job_id = $1 and (b.hours_done < 0 or b.estimated_hours < 0)", [job]);
  expect(bad, "a booking has negative hours").toEqual([]);
  const neg = await q("select r.id from machine_runs r where r.job_id = $1 and r.ended_at is not null and extract(epoch from (r.ended_at - r.started_at)) < 0", [job]);
  expect(neg).toEqual([]);
  const j = await jobOf(job);
  if (j.finished_at && j.started_at) expect(j.finished_at.getTime(), "job finished before it started").toBeGreaterThanOrEqual(j.started_at.getTime());
}
/** Polls pg_stat_activity until `pid` waits on a lock (proves the second writer is blocked, not finished). */
async function waitsOnLock(pid: number) {
  for (let i = 0; i < 200; i += 1) {
    const [r] = await q<{ w: string | null }>("select wait_event_type as w from pg_stat_activity where pid = $1", [pid]);
    if (r?.w === "Lock") return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
/** A connection with an open transaction as `sub`, and its backend pid. */
async function openTx(sub: string) {
  const db = await pool.connect();
  const pid = (await db.query<{ p: number }>("select pg_backend_pid() as p")).rows[0].p;
  await db.query("begin");
  await asUser(db, sub);
  return { db, pid };
}
const settle = <T>(p: Promise<T>) => p.then((v) => ({ ok: true as const, v }), (e: { code?: string; hint?: string; message: string }) => ({ ok: false as const, e }));

/** A job with a run by `who` on a fresh machine, started `hoursAgo` hours ago (a device time). Returns ids. */
async function jobWithRun(c: Co, who: string, hoursAgo: number, job?: string) {
  const j = job ?? (await makeJob(c.o));
  const m = await makeMachine(c.o);
  await ok(startRun(who, j, [m], ago(hoursAgo)));
  return { job: j, machine: m };
}
const near = (d: Date | null, before: Date, after: Date) => {
  expect(d).not.toBeNull();
  expect(d!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1);
  expect(d!.getTime()).toBeLessThanOrEqual(after.getTime() + 1);
};

describe("release 158: server time when another operator has an open run or job time on the job", () => {
  let A: Co;
  let B: Co;

  beforeAll(async () => {
    await verifyBackendIdentity();
    await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
    pool = new Pool({ connectionString: isolatedBackend().databaseUrl, max: 12 });
    A = await company();
    B = await company();
  });

  afterAll(async () => {
    if (pool) await pool.end();
    await destroySyntheticWorld(runId);
  });

  it.each(["workshop", "office", "admin"] as const)("1. %s pauses ANOTHER operator's run with a back-dated time: the run and that operator's session end at server time, hours are not zeroed, the device time is audited", async (role) => {
    const { job } = await jobWithRun(A, A.workshop2, 6);
    const [run] = await runsOf(job);
    const device = run.started_at; // the exploit: end it at its own start, so 6 hours become 0.00
    const op = randomUUID();
    const t0 = await serverNow();
    const r = await ok(pauseRun(A[role], job, device, null, op));
    const t1 = await serverNow();
    const [after] = await runsOf(job);
    near(after.ended_at, t0, t1);
    expect(after.ended_at!.toISOString()).not.toBe(device.toISOString());
    expect(after.end_reason).toBe("paused");
    expect(after.ended_by).toBe(A[role]);
    expect(after.device_ended_at).toBeNull();
    expect((after.ended_at!.getTime() - after.started_at.getTime()) / HOUR).toBeGreaterThan(5.9);
    expect((r.ended as Row[])).toHaveLength(1);
    expect(iso((r.ended as Row[])[0].ended_at)).toBe(after.ended_at!.toISOString());
    expect(Number((r.ended as Row[])[0].hours)).toBeGreaterThan(5.9);
    const [s] = await sessionsOf(job);
    expect(s.user_id).toBe(A.workshop2);
    expect(s.ended_at!.toISOString()).toBe(after.ended_at!.toISOString());
    expect(s.end_source).toBe("machine_pause");
    expect(s.ended_by).toBe(A[role]);
    // The device time stays in the audit record: PAUSE_MACHINE_RUN (client_ended_at, as before) and the new conflict event.
    const pauseEvent = (await auditOf(job, "PAUSE_MACHINE_RUN"))[0].metadata;
    expect(iso(pauseEvent.client_ended_at)).toBe(device.toISOString());
    expect(iso(pauseEvent.ended_at)).toBe(after.ended_at!.toISOString());
    const conflict = (await auditOf(job, "MACHINE_RUN_TIME_CONFLICT")).map((e) => e.metadata).filter((m) => m.why === "other_operator_open");
    expect(conflict).toHaveLength(1);
    expect(conflict[0]).toMatchObject({ operation: "pause", other_open_runs: 1, other_open_sessions: 1, client_op_id: op });
    expect(iso(conflict[0].client_ended_at)).toBe(device.toISOString());
    expect(iso(conflict[0].used_at)).toBe(after.ended_at!.toISOString());
    await assertIntegrity(job);
  });

  it("2. pause own run, alone on the job: the device time is honoured exactly as before (run and own session), no conflict event", async () => {
    const { job } = await jobWithRun(A, A.workshop, 3);
    const device = ago(1);
    const r = await ok(pauseRun(A.workshop, job, device));
    const [run] = await runsOf(job);
    expect(run.ended_at!.toISOString()).toBe(device.toISOString());
    expect(run.device_ended_at).toBeNull();
    expect(Number((r.ended as Row[])[0].hours)).toBeCloseTo(2, 1);
    const [s] = await sessionsOf(job);
    expect(s.ended_at!.toISOString()).toBe(device.toISOString());
    expect(s.end_source).toBe("machine_pause");
    expect((await auditOf(job, "MACHINE_RUN_TIME_CONFLICT")).filter((e) => e.metadata.why === "other_operator_open")).toEqual([]);
    expect(iso((await auditOf(job, "PAUSE_MACHINE_RUN"))[0].metadata.client_ended_at)).toBe(device.toISOString());
    await assertIntegrity(job);
    // A device time in the future is still now, and one older than 30 days is still refused (unchanged bounds), alone on the job.
    const { job: j2 } = await jobWithRun(A, A.workshop, 1);
    const t0 = await serverNow();
    await ok(pauseRun(A.workshop, j2, new Date(Date.now() + 5 * HOUR)));
    near((await runsOf(j2))[0].ended_at, t0, await serverNow());
    const { job: j3 } = await jobWithRun(A, A.workshop, 1);
    expect(await pauseRun(A.workshop, j3, ago(31 * 24))).toMatchObject({ code: "22023", hint: "time_too_old" });
    expect((await runsOf(j3))[0].ended_at).toBeNull();
  });

  it("3. pause own back-dated run while a colleague has an open sheet-only session (the labour_close_all route): server time, the colleague's session does not close in the past", async () => {
    const { job } = await jobWithRun(A, A.workshop, 4);
    await ok(sheetStart(A.workshop2, job, ago(2)));
    const [colleague] = (await sessionsOf(job)).filter((s) => s.user_id === A.workshop2);
    expect(colleague.source).toBe("sheet");
    const device = ago(3); // after A's own start, before the colleague's start: the old code closed the colleague's session in the past
    const t0 = await serverNow();
    await ok(pauseRun(A.workshop, job, device));
    const t1 = await serverNow();
    const [run] = await runsOf(job);
    near(run.ended_at, t0, t1);
    const sessions = await sessionsOf(job);
    expect(sessions).toHaveLength(2);
    for (const s of sessions) {
      near(s.ended_at, t0, t1);
      expect(s.ended_at!.getTime()).toBeGreaterThan(device.getTime());
      expect(s.end_source).toBe("machine_pause");
    }
    expect(sessions.find((s) => s.user_id === A.workshop2)!.ended_at!.getTime()).toBeGreaterThan(colleague.started_at.getTime());
    const conflict = (await auditOf(job, "MACHINE_RUN_TIME_CONFLICT")).map((e) => e.metadata).filter((m) => m.why === "other_operator_open");
    expect(conflict).toMatchObject([{ operation: "pause", other_open_runs: 0, other_open_sessions: 1 }]);
    expect(iso(conflict[0].client_ended_at)).toBe(device.toISOString());
    await assertIntegrity(job);
  });

  it("4. pause limited to p_machines while another operator has an open run on a DIFFERENT machine of the same job: server time (the approved rule counts every open run of the job); the other run stays open; once alone the device time is honoured", async () => {
    const job = await makeJob(A.o);
    const m1 = await makeMachine(A.o);
    const m2 = await makeMachine(A.o);
    await ok(startRun(A.workshop, job, [m1], ago(5)));
    await ok(startRun(A.workshop2, job, [m2], ago(4)));
    const device = ago(4.5);
    const t0 = await serverNow();
    const r = await ok(pauseRun(A.workshop, job, device, [m1]));
    const t1 = await serverNow();
    expect((r.ended as Row[]).map((e) => e.machine_id)).toEqual([m1]);
    const runs = await runsOf(job);
    const mine = runs.find((x) => x.machine_id === m1)!;
    const theirs = runs.find((x) => x.machine_id === m2)!;
    near(mine.ended_at, t0, t1);
    expect(theirs.ended_at).toBeNull();
    const sessions = await sessionsOf(job);
    expect(sessions.find((s) => s.user_id === A.workshop)!.ended_at!.getTime()).toBe(mine.ended_at!.getTime());
    expect(sessions.find((s) => s.user_id === A.workshop2)!.ended_at).toBeNull();
    // Now the second operator is alone on the job: their own back-dated pause is honoured.
    const device2 = ago(2);
    await ok(pauseRun(A.workshop2, job, device2, [m2]));
    const after = (await runsOf(job)).find((x) => x.machine_id === m2)!;
    expect(after.ended_at!.toISOString()).toBe(device2.toISOString());
    await assertIntegrity(job);
  });

  it.each(["workshop", "office", "admin"] as const)("5a. %s finishes a job with another operator's run and session open and a back-dated time: finished_at, the run and the session carry server time; the device time is audited; a replay moves nothing", async (role) => {
    const { job } = await jobWithRun(A, A.workshop2, 5);
    await ok(sheetStart(A.workshop3, job, ago(2)));
    const [run0] = await runsOf(job);
    const device = new Date(run0.started_at.getTime() + 60_000); // one minute after the run began
    const op = randomUUID();
    const t0 = await serverNow();
    const r = await ok(finishJob(A[role], job, device, op));
    const t1 = await serverNow();
    expect(r.changed).toBe(true);
    const j = await jobOf(job);
    near(j.finished_at, t0, t1);
    expect(iso(r.finished_at)).toBe(j.finished_at!.toISOString());
    const [run] = await runsOf(job);
    expect(run.ended_at!.toISOString()).toBe(j.finished_at!.toISOString());
    expect(run.end_reason).toBe("finished");
    expect(run.ended_op_id).toBe(op);
    for (const s of await sessionsOf(job)) {
      expect(s.ended_at!.toISOString()).toBe(j.finished_at!.toISOString());
      expect(s.end_source).toBe("job_finish"); // jobs_finish_labour closes them in the same statement, before the runs end
    }
    // The device time is kept: FINISH_ENDS_MACHINE_RUNS (client_finished_at, as before) and the conflict event.
    expect(iso((await auditOf(job, "FINISH_ENDS_MACHINE_RUNS"))[0].metadata.client_finished_at)).toBe(device.toISOString());
    const conflict = (await auditOf(job, "MACHINE_RUN_TIME_CONFLICT")).map((e) => e.metadata).filter((m) => m.why === "other_operator_open");
    expect(conflict).toHaveLength(1);
    expect(conflict[0]).toMatchObject({ operation: "finish", other_open_runs: 1, other_open_sessions: 2, client_op_id: op });
    expect(iso(conflict[0].client_finished_at)).toBe(device.toISOString());
    expect(iso(conflict[0].used_at)).toBe(j.finished_at!.toISOString());
    await assertIntegrity(job);
    // Replay of the same op id (and another device time): changed false, the stored finish time, nothing moves.
    const fp = await fingerprint(job);
    const again = await ok(finishJob(A[role], job, ago(4), op));
    expect(again.changed).toBe(false);
    expect(iso(again.finished_at)).toBe(j.finished_at!.toISOString());
    expect(await fingerprint(job)).toEqual(fp);
  });

  it("5b. finish with only a colleague's sheet session open (no run): the session closes at server time and the device time is still audited; alone on the job the device time is honoured", async () => {
    const job = await makeJob(A.o);
    await ok(sheetStart(A.workshop2, job, ago(3)));
    const device = ago(2.5);
    const t0 = await serverNow();
    await ok(finishJob(A.workshop, job, device));
    const t1 = await serverNow();
    const j = await jobOf(job);
    near(j.finished_at, t0, t1);
    const [s] = await sessionsOf(job);
    expect(s.ended_at!.toISOString()).toBe(j.finished_at!.toISOString());
    expect(s.end_source).toBe("job_finish");
    expect(await auditOf(job, "FINISH_ENDS_MACHINE_RUNS")).toEqual([]);
    const conflict = (await auditOf(job, "MACHINE_RUN_TIME_CONFLICT")).map((e) => e.metadata).filter((m) => m.why === "other_operator_open");
    expect(conflict).toHaveLength(1);
    expect(iso(conflict[0].client_finished_at)).toBe(device.toISOString());
    await assertIntegrity(job);

    // Alone: the caller's own run and session, a back-dated finish, honoured as today.
    const { job: solo } = await jobWithRun(A, A.workshop, 4);
    const own = ago(1);
    const r = await ok(finishJob(A.workshop, solo, own));
    expect(r.changed).toBe(true);
    expect((await jobOf(solo)).finished_at!.toISOString()).toBe(own.toISOString());
    expect((await runsOf(solo))[0].ended_at!.toISOString()).toBe(own.toISOString());
    expect((await sessionsOf(solo))[0].ended_at!.toISOString()).toBe(own.toISOString());
    expect((await auditOf(solo, "MACHINE_RUN_TIME_CONFLICT")).filter((e) => e.metadata.why === "other_operator_open")).toEqual([]);
    expect(iso((await auditOf(solo, "FINISH_ENDS_MACHINE_RUNS"))[0].metadata.client_finished_at)).toBe(own.toISOString());
    await assertIntegrity(solo);
    // The existing bounds still hold alone on the job.
    const { job: old } = await jobWithRun(A, A.workshop, 1);
    expect(await finishJob(A.workshop, old, ago(31 * 24))).toMatchObject({ code: "22023", hint: "time_too_old" });
    expect((await jobOf(old)).finished_at).toBeNull();
  });

  it.each(["workshop", "office", "admin"] as const)("5c. regression (release 157 closes the third route): a plain update of the job's finish time by %s, with only a colleague's sheet session open, is refused (42501, finish_via_rpc) and the colleague's session stays open and untouched", async (role) => {
    const job = await makeJob(A.o);
    await ok(sheetStart(A.workshop2, job, ago(3)));
    const before = await sessionsOf(job);
    expect(before).toHaveLength(1);
    expect(before[0].ended_at).toBeNull();
    for (const device of [ago(2.5), ago(3), new Date("2020-01-01T00:00:00Z")]) {
      const db = await pool.connect();
      let refusal: { code?: string; hint?: string } | null = null;
      try {
        await db.query("begin");
        await asUser(db, A[role]);
        await db.query("update jobs set finished_at = $1 where id = $2", [device.toISOString(), job]);
        await db.query("commit");
      } catch (e) {
        refusal = e as { code?: string; hint?: string };
        await db.query("rollback").catch(() => undefined);
      } finally { db.release(); }
      expect(refusal, `${role} ${device.toISOString()}`).not.toBeNull();
      expect(`${refusal!.code}/${refusal!.hint}`).toBe("42501/finish_via_rpc");
    }
    expect((await jobOf(job)).finished_at).toBeNull();
    expect(await sessionsOf(job)).toEqual(before);
    expect(await auditOf(job, "MACHINE_RUN_TIME_CONFLICT")).toEqual([]);
    // The supported route still works and still uses server time while the colleague is on the job.
    const t0 = await serverNow();
    await ok(finishJob(A[role], job, ago(2.5)));
    const t1 = await serverNow();
    near((await jobOf(job)).finished_at, t0, t1);
    const [s] = await sessionsOf(job);
    expect(s.ended_at!.toISOString()).toBe((await jobOf(job)).finished_at!.toISOString());
    await assertIntegrity(job);
  });

  it("6. time integrity: a run or session that started after the effective end, a device time before the run's start, and a job time in the future never give a negative duration, negative hours or a job finished before it started", async () => {
    // (a) A colleague's open run that starts one hour AFTER the server's now (clock skew or owner SQL: the start functions clamp starts to now,
    //     so it cannot arise through the API): ending it keeps ended_at >= started_at (machine_run_end's own rule) and the session never goes negative.
    const job = await makeJob(A.o);
    const m1 = await makeMachine(A.o);
    const m2 = await makeMachine(A.o);
    await ok(startRun(A.workshop, job, [m1], ago(2)));
    await q("insert into machine_runs (organization_id, job_id, machine_id, operator_id, started_at) values ($1, $2, $3, $4, now() + interval '1 hour')", [A.o, job, m2, A.workshop2]);
    await q("insert into operator_sessions (organization_id, user_id, job_id, started_at, source) values ($1, $2, $3, now() + interval '1 hour', 'sheet') on conflict do nothing", [A.o, A.workshop3, job]);
    const t0 = await serverNow();
    const r = await ok(pauseRun(A.workshop, job, ago(1.5)));
    expect(r.ended as Row[]).toHaveLength(2);
    const runs = await runsOf(job);
    const future = runs.find((x) => x.machine_id === m2)!;
    expect(future.ended_at!.getTime()).toBeGreaterThanOrEqual(future.started_at.getTime());
    expect(future.ended_at!.getTime()).toBeGreaterThanOrEqual(t0.getTime());
    expect(future.device_ended_at).not.toBeNull(); // machine_run_end's rule: the time asked for is kept on the row
    expect((r.time_conflicts as Row[]).length).toBeGreaterThanOrEqual(1);
    await assertIntegrity(job);
    // (b) Alone on the job with a device time BEFORE the run's start: machine_run_end's own rule (server time, device time kept) is unchanged.
    const { job: j2 } = await jobWithRun(A, A.workshop, 1);
    const t2 = await serverNow();
    await ok(pauseRun(A.workshop, j2, ago(3)));
    const [run2] = await runsOf(j2);
    near(run2.ended_at, t2, await serverNow());
    expect(run2.device_ended_at).not.toBeNull();
    await assertIntegrity(j2);
    // (c) A finish where the job's own start is later than the device time, alone: finish_job's coalesce fills an empty start with the same time.
    const j3 = await makeJob(A.o);
    const dev = ago(2);
    await ok(finishJob(A.workshop, j3, dev));
    const row = await jobOf(j3);
    expect(row.started_at!.toISOString()).toBe(dev.toISOString());
    expect(row.finished_at!.toISOString()).toBe(dev.toISOString());
    await assertIntegrity(j3);
    // (d) Booking hours: a planned booking mirrors the run's hours, never a negative amount, with server time.
    const j4 = await makeJob(A.o);
    const m4 = await makeMachine(A.o);
    const booking = (await q<{ id: string }>("insert into machine_bookings (organization_id, machine_id, job_id, job_no, description, start_at, estimated_hours, hours_done, status) values ($1, $2, $3, 'J-B', 'b', now() + interval '2 days', 3, 0, 'booked') returning id", [A.o, m4, j4]))[0].id;
    await ok(startRun(A.workshop2, j4, [m4], ago(2)));
    await ok(pauseRun(A.workshop, j4, ago(2)));
    const [b] = await q<{ hours_done: string; status: string }>("select hours_done, status from machine_bookings where id = $1", [booking]);
    expect(Number(b.hours_done)).toBeGreaterThan(1.9);
    expect(Number(b.hours_done)).toBeLessThanOrEqual(2.1);
    await assertIntegrity(j4);
  });

  it("7. offline replay: the same pause op id sent twice returns the stored result and moves nothing; a late replay for a colleague's run records server time and keeps the device time", async () => {
    const { job, machine } = await jobWithRun(A, A.workshop2, 6);
    const op = randomUUID();
    const device = ago(5);
    const first = await ok(pauseRun(A.workshop, job, device, null, op));
    expect(first.replayed).toBe(false);
    const fp = await fingerprint(job);
    const second = await ok(pauseRun(A.workshop, job, ago(5.5), null, op));
    expect(second.replayed).toBe(true);
    expect(second.ended).toEqual(first.ended);
    expect(await fingerprint(job)).toEqual(fp);
    // A later Start on the job: replaying the old Pause again still ends nothing (the new run stays open).
    await ok(startRun(A.workshop3, job, [machine], null));
    const fp2 = await fingerprint(job);
    const third = await ok(pauseRun(A.workshop, job, ago(5), null, op));
    expect(third.replayed).toBe(true);
    expect(await fingerprint(job)).toEqual(fp2);
    expect((await runsOf(job)).filter((x) => x.ended_at === null)).toHaveLength(1);
    // A Pause queued an hour ago and delivered now, for a colleague's run: server (sync) time, the device time in the audit log.
    const { job: late } = await jobWithRun(A, A.workshop2, 2);
    const queued = ago(1);
    const lateOp = randomUUID();
    const t0 = await serverNow();
    await ok(pauseRun(A.workshop, late, queued, null, lateOp));
    const t1 = await serverNow();
    const [run] = await runsOf(late);
    near(run.ended_at, t0, t1);
    expect(run.ended_at!.getTime()).toBeGreaterThan(queued.getTime() + 30 * 60_000);
    expect(iso((await auditOf(late, "PAUSE_MACHINE_RUN"))[0].metadata.client_ended_at)).toBe(queued.toISOString());
    const sessions = await sessionsOf(late);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].ended_at!.toISOString()).toBe(run.ended_at!.toISOString());
    // Replaying that op now (a second delivery) closes nothing twice and moves no time.
    const fp3 = await fingerprint(late);
    expect((await ok(pauseRun(A.workshop, late, queued, null, lateOp))).replayed).toBe(true);
    expect(await fingerprint(late)).toEqual(fp3);
    await assertIntegrity(job);
    await assertIntegrity(late);
  });

  it("8a. two operators pausing the same job at once: the second waits, then ends nothing; each run is ended once and each session closed once", async () => {
    const job = await makeJob(A.o);
    const m1 = await makeMachine(A.o);
    const m2 = await makeMachine(A.o);
    await ok(startRun(A.workshop, job, [m1], ago(3)));
    await ok(startRun(A.workshop2, job, [m2], ago(3)));
    const first = await openTx(A.office);
    try {
      const second = await openTx(A.admin);
      try {
        const op1 = randomUUID();
        const op2 = randomUUID();
        const r1 = await callIn(first.db, "pause_machine_run", { p_job: job, p_machines: null, p_client_op_id: op1, p_ended_at: ago(3) });
        const pending = settle(callIn(second.db, "pause_machine_run", { p_job: job, p_machines: null, p_client_op_id: op2, p_ended_at: ago(3) }));
        expect(await waitsOnLock(second.pid)).toBe(true);
        await first.db.query("commit");
        const r2 = await pending;
        expect(r2.ok).toBe(true);
        expect((r1.ended as Row[])).toHaveLength(2);
        expect(r2.ok && (r2.v.ended as Row[])).toEqual([]);
        await second.db.query("commit");
      } finally { await second.db.query("rollback").catch(() => undefined); second.db.release(); }
    } finally { await first.db.query("rollback").catch(() => undefined); first.db.release(); }
    const runs = await runsOf(job);
    expect(runs.map((x) => x.ended_by)).toEqual([A.office, A.office]);
    expect(new Set(runs.map((x) => x.ended_at!.toISOString())).size).toBe(1);
    const sessions = await sessionsOf(job);
    expect(sessions).toHaveLength(2);
    expect(sessions.every((s) => s.ended_by === A.office && s.ended_at!.toISOString() === runs[0].ended_at!.toISOString())).toBe(true);
    expect((await auditOf(job, "PAUSE_MACHINE_RUN"))).toHaveLength(1);
    await assertIntegrity(job);
  });

  it("8b. two operators finishing the same job at once: one finish, the second reports changed false with the first's time; every run ended once, every session closed once", async () => {
    const { job } = await jobWithRun(A, A.workshop2, 3);
    await ok(sheetStart(A.workshop3, job, ago(1)));
    const first = await openTx(A.office);
    try {
      const second = await openTx(A.admin);
      try {
        const r1 = await callIn(first.db, "finish_job", { p_job: job, p_client_op_id: randomUUID(), p_finished_at: ago(3) });
        const pending = settle(callIn(second.db, "finish_job", { p_job: job, p_client_op_id: randomUUID(), p_finished_at: ago(2) }));
        expect(await waitsOnLock(second.pid)).toBe(true);
        await first.db.query("commit");
        const r2 = await pending;
        expect(r1.changed).toBe(true);
        expect(r2.ok && r2.v.changed).toBe(false);
        expect(r2.ok && iso(r2.v.finished_at)).toBe(iso(r1.finished_at));
        await second.db.query("commit");
      } finally { await second.db.query("rollback").catch(() => undefined); second.db.release(); }
    } finally { await first.db.query("rollback").catch(() => undefined); first.db.release(); }
    const j = await jobOf(job);
    expect((await runsOf(job)).every((x) => x.ended_at!.toISOString() === j.finished_at!.toISOString() && x.end_reason === "finished")).toBe(true);
    expect((await sessionsOf(job)).every((s) => s.ended_at!.toISOString() === j.finished_at!.toISOString())).toBe(true);
    expect(await auditOf(job, "FINISH_ENDS_MACHINE_RUNS")).toHaveLength(1);
    await assertIntegrity(job);
  });

  it("8c. a colleague's Start holding the locks while a back-dated pause (alone so far) waits: the pause sees the colleague's run after the wait and uses server time; the colleague's run is not ended in the past", async () => {
    const job = await makeJob(A.o);
    const m1 = await makeMachine(A.o);
    const m2 = await makeMachine(A.o);
    await ok(startRun(A.workshop, job, [m1], ago(3)));
    const starter = await openTx(A.workshop2);
    try {
      const pauser = await openTx(A.workshop);
      try {
        expect((await callIn(starter.db, "start_machine_run", { p_job: job, p_machines: [m2], p_client_op_id: randomUUID(), p_started_at: null, p_override: false, p_reason: null })).replayed).toBe(false);
        const device = ago(2.9);
        const t0 = await serverNow();
        const pending = settle(callIn(pauser.db, "pause_machine_run", { p_job: job, p_machines: null, p_client_op_id: randomUUID(), p_ended_at: device }));
        expect(await waitsOnLock(pauser.pid)).toBe(true);
        await starter.db.query("commit");
        const r = await pending;
        expect(r.ok).toBe(true);
        await pauser.db.query("commit");
        const runs = await runsOf(job);
        expect(runs).toHaveLength(2);
        for (const x of runs) {
          expect(x.ended_at!.getTime()).toBeGreaterThanOrEqual(t0.getTime() - 1);
          expect(x.ended_at!.getTime()).toBeGreaterThanOrEqual(x.started_at.getTime());
        }
        expect(runs[0].device_ended_at).toBeNull();
        expect(runs[1].device_ended_at).toBeNull(); // a real duration, not machine_run_end's "before the start" fallback
      } finally { await pauser.db.query("rollback").catch(() => undefined); pauser.db.release(); }
    } finally { await starter.db.query("rollback").catch(() => undefined); starter.db.release(); }
    await assertIntegrity(job);
  });

  it("8d. a back-dated pause (alone) holding the locks while a colleague's Start waits: the device time was decided before the Start, the colleague's new run and session stay open and untouched", async () => {
    const job = await makeJob(A.o);
    const m1 = await makeMachine(A.o);
    const m2 = await makeMachine(A.o);
    await ok(startRun(A.workshop, job, [m1], ago(3)));
    const pauser = await openTx(A.workshop);
    try {
      const starter = await openTx(A.workshop2);
      try {
        const device = ago(1);
        await callIn(pauser.db, "pause_machine_run", { p_job: job, p_machines: null, p_client_op_id: randomUUID(), p_ended_at: device });
        const pending = settle(callIn(starter.db, "start_machine_run", { p_job: job, p_machines: [m2], p_client_op_id: randomUUID(), p_started_at: null, p_override: false, p_reason: null }));
        expect(await waitsOnLock(starter.pid)).toBe(true);
        await pauser.db.query("commit");
        expect((await pending).ok).toBe(true);
        await starter.db.query("commit");
        const runs = await runsOf(job);
        const own = runs.find((x) => x.machine_id === m1)!;
        const theirs = runs.find((x) => x.machine_id === m2)!;
        expect(own.ended_at!.toISOString()).toBe(device.toISOString());
        expect(theirs.ended_at).toBeNull();
        const sessions = await sessionsOf(job);
        expect(sessions.find((s) => s.user_id === A.workshop)!.ended_at!.toISOString()).toBe(device.toISOString());
        expect(sessions.find((s) => s.user_id === A.workshop2)!.ended_at).toBeNull();
      } finally { await starter.db.query("rollback").catch(() => undefined); starter.db.release(); }
    } finally { await pauser.db.query("rollback").catch(() => undefined); pauser.db.release(); }
    await assertIntegrity(job);
  });

  it("9. authorised cross-operator management still works for workshop, office and admin (pause and finish, no new refusal); the viewer is still refused and nothing changes", async () => {
    for (const role of ["workshop", "office", "admin"] as const) {
      const { job } = await jobWithRun(A, A.workshop2, 2);
      expect((await pauseRun(A[role], job, null)).data, role).not.toBeNull();
      expect((await runsOf(job))[0].ended_at).not.toBeNull();
      const { job: j2 } = await jobWithRun(A, A.workshop2, 2);
      expect((await finishJob(A[role], j2, ago(1))).data, role).not.toBeNull();
      expect((await jobOf(j2)).finished_at).not.toBeNull();
      // With no time sent at all (the live board's call) the same.
      const { job: j3 } = await jobWithRun(A, A.workshop2, 2);
      expect((await finishJob(A[role], j3, null)).data, role).not.toBeNull();
    }
    const { job } = await jobWithRun(A, A.workshop2, 2);
    const fp = await fingerprint(job);
    expect(await pauseRun(A.viewer, job, ago(1))).toMatchObject({ code: "42501" });
    expect(await finishJob(A.viewer, job, ago(1))).toMatchObject({ code: "42501" });
    expect(await fingerprint(job)).toEqual(fp);
  });

  it("10. tenant isolation: another company's user cannot pause or finish this job, and another company's open runs and sessions never influence the time decision", async () => {
    const { job } = await jobWithRun(A, A.workshop, 3);
    // Company B has open runs and sessions of its own (other operators), on its own jobs.
    const bJob = await makeJob(B.o);
    const bm = await makeMachine(B.o);
    await ok(startRun(B.workshop2, bJob, [bm], ago(5)));
    await ok(sheetStart(B.workshop3, bJob, ago(4)));
    const fp = await fingerprint(job);
    expect(await pauseRun(B.workshop, job, ago(1))).toMatchObject({ code: "P0002" });
    expect(await pauseRun(B.admin, job, null)).toMatchObject({ code: "P0002" });
    expect(await finishJob(B.workshop, job, ago(1))).toMatchObject({ code: "P0002" });
    expect(await finishJob(B.admin, job, null)).toMatchObject({ code: "P0002" });
    expect(await fingerprint(job)).toEqual(fp);
    // A's user is alone on A's job: the device time is honoured although company B has other operators' open time.
    const device = ago(1);
    await ok(pauseRun(A.workshop, job, device));
    expect((await runsOf(job))[0].ended_at!.toISOString()).toBe(device.toISOString());
    const { job: j2 } = await jobWithRun(A, A.workshop, 3);
    const own = ago(2);
    await ok(finishJob(A.workshop, j2, own));
    expect((await jobOf(j2)).finished_at!.toISOString()).toBe(own.toISOString());
    // B's own state is untouched by any of it.
    expect((await runsOf(bJob))[0].ended_at).toBeNull();
    expect((await sessionsOf(bJob)).every((s) => s.ended_at === null)).toBe(true);
    await assertIntegrity(job);
  });

  it("11a. release mechanics: installed (verify rows all true, marker applied, row 61), a repeat install changes nothing, other functions untouched, settings identical", async () => {
    await rolledBack(async (db) => {
      expect(await bodies(db)).toEqual(AFTER_158);
      const v = await verifyRows(db);
      expect(v).toHaveLength(6);
      expect(v.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
      const pre = await preflightRows(db);
      expect(pre.find((r) => r.check === MARKER)?.value).toBe("applied");
      expect(pre.find((r) => r.check.startsWith("158 needs:"))?.value).toBe("158 / 158");
      const s0 = await settings(db);
      expect(s0.untouched).not.toBeNull();
      await db.query(body(RELEASE));
      expect(await bodies(db)).toEqual(AFTER_158);
      expect(await settings(db)).toEqual(s0);
    });
  });

  it("11b. rollback restores both previous bodies verbatim (md5), twice = once, settings and other functions identical; reinstall verifies all true", async () => {
    await rolledBack(async (db) => {
      const s0 = await settings(db);
      await db.query(body(ROLLBACK));
      await db.query(body(ROLLBACK));
      expect(await bodies(db)).toEqual(BEFORE_158);
      const s1 = await settings(db);
      expect(s1.untouched).toEqual(s0.untouched);
      expect(s1.functions).toEqual(s0.functions);
      const pre = await preflightRows(db);
      expect(pre.find((r) => r.check === MARKER)?.value).toBe("not applied");
      expect(pre.find((r) => r.check.startsWith("158 needs:"))?.value).toBe("044 / 061");
      expect((await verifyRows(db)).filter((r) => r.ok !== true)).not.toEqual([]);
      await db.query(body(RELEASE));
      await db.query(body(RELEASE));
      expect(await bodies(db)).toEqual(AFTER_158);
      expect(await settings(db)).toEqual(s0);
      expect((await verifyRows(db)).filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
      expect((await preflightRows(db)).find((r) => r.check === MARKER)?.value).toBe("applied");
    });
  });

  it("11c. the release refuses, changing nothing, when either function is not the body it was written against; the rollback refuses likewise", async () => {
    for (const fn of [PAUSE_SIG, FINISH_SIG]) {
      await rolledBack(async (db) => {
        const src = (await db.query<{ d: string }>(`select pg_get_functiondef(to_regprocedure('${fn}')) as d`)).rows[0].d;
        const edited = src.replace(/\bEND\s*\n\$function\$/, "END /* edited */\n$function$");
        expect(edited).not.toBe(src);
        await db.query(edited);
        const changed = await bodies(db);
        await db.query("savepoint s");
        for (const file of [RELEASE, ROLLBACK]) {
          const e = await db.query(body(file)).then(() => null, (x: { message: string; hint?: string }) => x);
          expect(e, file).not.toBeNull();
          expect(e?.message).toMatch(/neither/);
          await db.query("rollback to savepoint s");
          expect(await bodies(db)).toEqual(changed);
        }
      });
    }
  });

  it("11d. the defect is real without 158: with 044's and 061's bodies back, the back-dated pause and finish zero another operator's hours (this proof can fail)", async () => {
    await rolledBack(async (db) => {
      await db.query(body(ROLLBACK));
      const job = (await db.query<{ id: string }>("insert into jobs (organization_id, job_no, customer) values ($1, $2, 'Old Co') returning id", [A.o, `J-P158-OLD-${runId}-${++seq}`])).rows[0].id;
      const m = (await db.query<{ id: string }>("insert into machines (organization_id, name, active) values ($1, $2, true) returning id", [A.o, `P158 old ${runId}-${++seq}`])).rows[0].id;
      await db.query("savepoint t");
      await asUser(db, A.workshop2);
      await callIn(db, "start_machine_run", { p_job: job, p_machines: [m], p_client_op_id: randomUUID(), p_started_at: ago(6), p_override: false, p_reason: null });
      await db.query("reset role");
      const started = (await db.query<{ s: Date }>("select started_at as s from machine_runs where job_id = $1", [job])).rows[0].s;
      await asUser(db, A.workshop);
      await callIn(db, "pause_machine_run", { p_job: job, p_machines: null, p_client_op_id: randomUUID(), p_ended_at: started });
      await db.query("reset role");
      const run = (await db.query<{ ended_at: Date; started_at: Date }>("select ended_at, started_at from machine_runs where job_id = $1", [job])).rows[0];
      expect(run.ended_at.toISOString()).toBe(run.started_at.toISOString()); // 6 hours became 0.00
      const s = (await db.query<{ ended_at: Date; started_at: Date }>("select ended_at, started_at from operator_sessions where job_id = $1", [job])).rows[0];
      expect(s.ended_at.toISOString()).toBe(s.started_at.toISOString());
      // And finish: a colleague's sheet session closed at a back-dated finish time.
      const job2 = (await db.query<{ id: string }>("insert into jobs (organization_id, job_no, customer) values ($1, $2, 'Old Co') returning id", [A.o, `J-P158-OLD-${runId}-${++seq}`])).rows[0].id;
      await asUser(db, A.workshop2);
      await callIn(db, "record_labour_event", { p_client_op_id: randomUUID(), p_job: job2, p_action: "start", p_at: ago(3) });
      await db.query("reset role");
      const s2 = (await db.query<{ started_at: Date }>("select started_at from operator_sessions where job_id = $1", [job2])).rows[0].started_at;
      await asUser(db, A.workshop);
      await callIn(db, "finish_job", { p_job: job2, p_client_op_id: randomUUID(), p_finished_at: s2 });
      await db.query("reset role");
      const closed = (await db.query<{ ended_at: Date; started_at: Date }>("select ended_at, started_at from operator_sessions where job_id = $1", [job2])).rows[0];
      expect(closed.ended_at.toISOString()).toBe(closed.started_at.toISOString());
      await db.query("rollback to savepoint t");
    });
  });
});
