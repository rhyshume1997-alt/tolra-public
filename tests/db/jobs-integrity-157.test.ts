/**
 * Release 157 (supabase/release/157_jobs_integrity_guard.release.sql, phase 157 after 156): the trigger jobs_zzz_integrity_guard on public.jobs.
 * The DB proof, below PostgREST: every refusal is paired with the authorised path that must still work.
 *
 * Inputs: the disposable Supabase stack (TEST_DATABASE_URL, isolation-checked); the post-144 fixture installs 145..157. Every statement runs as
 * PostgREST would run it: its own transaction, role authenticated (or service_role) with the person's JWT claims, so the real triggers, RLS and
 * definer functions answer. Jobs are made by the database owner (an exempt path, as the importer is). Companies are synthetic (slug t-<run>-...)
 * and removed afterwards by destroySyntheticWorld. Release, rollback and re-release run inside transactions that are always rolled back.
 * Proves: C1 a recorded start (and who started it) is never changed or cleared by editing the job, and a job's FIRST start is set only inside start_machine_run (Play, the bench
 * Start; re-created by 157 with 049's body plus two tolra.job_start statements) or finish_job, never by editing the job (hint start_via_rpc; the marker does not leak out of the
 * function, and names one job only); C6 a browser INSERT of a job with a start or finish time is refused for every role while every real creating path (create_job, direct insert
 * without them, convert_sales_order, import_company_data) still works and the service role and the owner are unaffected; C4 a finish time is set only by finish_job;
 * C3 a workshop-only user cannot change customer or job number; C2/P1 a workshop-only user cannot withdraw a passed inspection (Complete,
 * despatched or invoiced job) unless record_job_inspection, fail_job_inspection, rework or reopen names the job; admin and office are unchanged on a
 * job that has not gone out; C5 (PM ruling 15 Nov 2026) office and admin, like the workshop, cannot withdraw the passed inspection of a despatched or
 * invoiced job by editing it (hint released_pass_kept), including a person whose Invoices section is hidden (the guard is SECURITY DEFINER so its lookup
 * is not filtered by row-level security), with no document number in the message, company-scoped lookups, and the authorised corrections (failed
 * inspection, replacement rework) still working; drawing-revision behaviour; another company and the service role; release, repeat install, verify,
 * rollback (which also puts 049's start_machine_run back byte for byte), re-release.
 * Not proved here: PostgREST's own error mapping, the browser screens, hosted PostgreSQL 17.
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
const slug = (label: string) => `t-${runId}-p157-${label}-${++seq}`;
const email = (label: string) => `${label}-${++seq}.${runId}@${EMAIL_DOMAIN}`;
const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const RELEASE = "supabase/release/157_jobs_integrity_guard.release.sql";
const ROLLBACK = "supabase/release/157_jobs_integrity_guard.rollback.sql";
const VERIFY = "supabase/verify/jobs_integrity_guard_157.sql";
const PREFLIGHT = "supabase/verify/release_preflight.sql";
const MARKER = "post-144 marker 157 jobs_integrity_guard";
const CRITERIA = "Drawing rev A: bore 25.00 +0.02/-0, length 60.00 +/-0.1";
const T0 = "2026-10-01T08:00:00Z";
const T1 = "2026-10-02T08:00:00Z";
const SMR = "public.start_machine_run(uuid,uuid[],uuid,timestamptz,boolean,text,jsonb,boolean)";
const SMR_049_MD5 = "2147348075e8d7d38639bd11c9da0c30";
const SMR_157_MD5 = "e5a66b0a8b183e1f6a51927bca89953e";
const MARK_ON = "PERFORM set_config('tolra.job_start', p_job::text, TRUE);";
const MARK_OFF = "PERFORM set_config('tolra.job_start', '', TRUE);";
const FIRST_START = "UPDATE public.jobs SET started_at = v_at WHERE id = p_job;";

let pool: Pool;
type Row = Record<string, unknown>;
type Person = { id: string; role: "admin" | "office" | "workshop" };
type Err = { code?: string; hint?: string; message: string };
type Outcome = { ok: true; rows: Row[]; count: number } | { ok: false; e: Err };
const claims = (sub: string) => ({ sub, role: "authenticated", aal: "aal2", email: `${sub.slice(0, 8)}@example.test` });

async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await pool.connect();
  try { return (await db.query(sql, params)).rows as T[]; } finally { db.release(); }
}
async function asUser(db: PoolClient, sub: string) {
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claims(sub)), sub]);
}
/** One statement as PostgREST runs it: its own transaction as `sub` (the database owner when null, the service role when "service"), committed on success. */
async function run(sub: string | "service" | null, sql: string, params: unknown[] = []): Promise<Outcome> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    if (sub === "service") await db.query("set local role service_role");
    else if (sub) await asUser(db, sub);
    const r = await db.query(sql, params);
    await db.query("commit");
    return { ok: true, rows: r.rows as Row[], count: r.rowCount ?? 0 };
  } catch (x) {
    await db.query("rollback").catch(() => undefined);
    const e = x as Err;
    return { ok: false, e: { code: e.code, hint: e.hint, message: e.message } };
  } finally { db.release(); }
}
const refused = (o: Outcome) => (o.ok ? "allowed" : `${o.e.code}/${o.e.hint ?? "-"}`);
const allowed = (o: Outcome) => (o.ok ? "allowed" : `${o.e.code}/${o.e.hint ?? "-"}: ${o.e.message}`);
async function rolledBack<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try { await db.query("begin"); return await fn(db); } finally { await db.query("rollback").catch(() => undefined); db.release(); }
}
/** One statement as `sub` inside an open (rolled-back) transaction, kept apart from the rest by a savepoint; role and claims are reset after it. */
async function tryIn(db: PoolClient, sub: string, sql: string, params: unknown[] = []): Promise<Outcome> {
  await db.query("savepoint t");
  try {
    await asUser(db, sub);
    const r = await db.query(sql, params);
    await db.query("reset role");
    await db.query("release savepoint t");
    return { ok: true, rows: r.rows as Row[], count: r.rowCount ?? 0 };
  } catch (x) {
    await db.query("rollback to savepoint t");
    await db.query("reset role");
    const e = x as Err;
    return { ok: false, e: { code: e.code, hint: e.hint, message: e.message } };
  }
}
/** A release or rollback file without its own BEGIN / COMMIT, to run inside a test transaction. */
function body(file: string) {
  const s = read(file);
  expect(s.match(/^BEGIN;$/gm), file).toHaveLength(1);
  expect(s.match(/^COMMIT;$/gm), file).toHaveLength(1);
  return s.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
}
async function preflightRows(db?: PoolClient) {
  const rows = db ? (await db.query(read(PREFLIGHT))).rows : await q(read(PREFLIGHT));
  return rows as { check: string; value: string }[];
}
async function verifyRows(db?: PoolClient) {
  const rows = db ? (await db.query(read(VERIFY))).rows : await q(read(VERIFY));
  return rows as { check_name: string; ok: boolean }[];
}
const state157 = async (db: PoolClient) => (await db.query(`select
  (select oid from pg_proc where oid = to_regprocedure('public.jobs_integrity_guard()')) as fn,
  (select oid from pg_trigger where tgrelid = 'public.jobs'::regclass and tgname = 'jobs_zzz_integrity_guard') as trg`)).rows[0] as { fn: number | null; trg: number | null };

/** start_machine_run as installed: its body (exact and whitespace-stripped md5), definer flag, settings, grants and argument list. */
const smrState = async (db: PoolClient) => (await db.query(`select p.prosrc as src, md5(regexp_replace(p.prosrc, '\\s', '', 'g')) as sum, p.prosecdef as definer, p.proconfig::text as cfg, coalesce(p.proacl::text, '') as acl,
  pg_get_function_arguments(p.oid) as args, (select count(*)::int from pg_proc x where x.pronamespace = 'public'::regnamespace and x.proname = 'start_machine_run') as n from pg_proc p where p.oid = to_regprocedure('${SMR}')`)).rows[0] as
  { src: string; sum: string; definer: boolean; cfg: string; acl: string; args: string; n: number };
/** 049's function body exactly as the migration CI installs it has it (between AS $$ and $$;), to prove the rollback restores it verbatim. */
function body049() {
  const sql = read("supabase/migrations/049_paused_machine_ack.sql");
  const from = sql.indexOf("CREATE OR REPLACE FUNCTION public.start_machine_run(");
  const open = sql.indexOf("AS $$\n", from) + "AS $$".length;
  const close = sql.indexOf("\n$$;", open);
  return sql.slice(open, close + 1);
}

// ---- Synthetic companies and jobs ------------------------------------------------------------------------------------------------
async function makeCompany() {
  const o = randomUUID();
  await q("insert into organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [o, `Synthetic p157 ${o.slice(0, 8)}`, slug("co")]);
  return o;
}
async function makePerson(o: string, role: Person["role"]): Promise<Person> {
  const u = randomUUID();
  const e = email(role);
  await q("insert into auth.users (id, email) values ($1, $2)", [u, e]);
  await q("insert into user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, 'Synthetic', $3, $4, true, false)", [u, e, role, o]);
  await q("insert into organization_members (organization_id, user_id, role, active, can_inspect) values ($1, $2, $3, true, true)", [o, u, role]);
  return { id: u, role };
}
let X: { o: string; admin: Person; office: Person; workshop: Person };
/** A machine nobody is running on (a machine can hold one open run). */
const freshMachine = async () => (await q<{ id: string }>("insert into machines (organization_id, name) values ($1, $2) returning id", [X.o, `Mill 157 ${++seq}`]))[0].id;
let Y: { o: string; admin: Person };

type JobOver = { job_no?: string; stage?: string; started_at?: string | null; finished_at?: string | null; inspected_at?: string | null; started_by?: string | null; customer?: string | null };
/** A job made by the database owner (an exempt path, as the importer is). */
async function job(over: JobOver = {}, org = X.o): Promise<string> {
  const v = { stage: "machining", started_at: null, finished_at: null, inspected_at: null, started_by: null, customer: "Integrity Co", ...over };
  return (await q<{ id: string }>(
    `insert into jobs (organization_id, job_no, customer, stage, started_at, finished_at, inspected_at, inspected_by, started_by, quantity_required)
     values ($1, $2, $3, $4, $5, $6, $7, case when $7::timestamptz is null then null else 'Inspector' end, $8, 10) returning id`,
    [org, over.job_no ?? `J157-${runId}-${++seq}`, v.customer, v.stage, v.started_at, v.finished_at, v.inspected_at, v.started_by]))[0].id;
}
const open = (over: JobOver = {}) => job({ started_at: T0, started_by: X.workshop.id, ...over });
const finished = (over: JobOver = {}) => job({ stage: "inspection", started_at: T0, started_by: X.workshop.id, finished_at: T1, ...over });
const complete = (over: JobOver = {}) => job({ stage: "complete", started_at: T0, started_by: X.workshop.id, finished_at: T1, inspected_at: T1, ...over });
const row = async (id: string) => (await q("select * from jobs where id = $1", [id]))[0];
const pick = (r: Row, keys: string[]) => Object.fromEntries(keys.map((k) => [k, r[k] instanceof Date ? (r[k] as Date).toISOString() : r[k]]));
const iso = (s: string) => new Date(s).toISOString();
/** A timestamptz column comes back from pg as a Date: keep its milliseconds (String(date) drops them). */
const isoOf = (v: unknown) => (v instanceof Date ? v : new Date(String(v))).toISOString();
const people = (): Person[] => [X.workshop, X.office, X.admin];
const set = (id: string, assignments: string, params: unknown[] = []): [string, unknown[]] => [`update jobs set ${assignments} where id = $1`, [id, ...params]];
const INSPECT = `select public.inspect_job(p_job => $1, p_result => $2, p_criteria => '${CRITERIA}', p_measured => 'Bore 25.01 mm (bore gauge 0001)',
  p_expected_version => $3, p_disposition => $4, p_failure => $5::jsonb, p_concession_reason => $6) as r`;
const inspectArgs = async (id: string, result: string, concession: string | null = null) => [id, result, (await row(id)).worksheet_version,
  result === "fail" ? "rework" : null, result === "fail" ? JSON.stringify({ reason: "Bore oversize 25.06", instructions: "Sleeve and re-bore" }) : null, concession];
const latestRework = async (id: string) => (await q<{ id: string }>("select id from job_rework where job_id = $1 order by raised_at desc, id desc limit 1", [id]))[0].id;

describe("release 157: jobs integrity guard", () => {
  beforeAll(async () => {
    await verifyBackendIdentity();
    await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
    pool = new Pool({ connectionString: isolatedBackend().databaseUrl, max: 6 });
    const o = await makeCompany();
    X = { o, admin: await makePerson(o, "admin"), office: await makePerson(o, "office"), workshop: await makePerson(o, "workshop") };
    const o2 = await makeCompany();
    Y = { o: o2, admin: await makePerson(o2, "admin") };
  });

  afterAll(async () => {
    if (pool) await pool.end();
    await destroySyntheticWorld(runId);
  });

  it("0. the verify script says true on every row, release preflight says applied, and the trigger is the one the release names", async () => {
    const v = await verifyRows();
    expect(v).toHaveLength(8);
    expect(v.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
    const pre = await preflightRows();
    expect(pre.find((r) => r.check === MARKER)?.value).toBe("applied");
    expect(pre.find((r) => r.check.startsWith("157 needs:"))?.value).toBe("0 / 157 / 157 / 157");
    // One trigger for INSERT and UPDATE: BEFORE (2) + INSERT (4) + UPDATE (16) + ROW (1) = 23.
    expect((await q<{ n: number }>("select tgtype::int as n from pg_trigger where tgrelid = 'public.jobs'::regclass and tgname = 'jobs_zzz_integrity_guard'"))).toEqual([{ n: 23 }]);
    // The BEFORE UPDATE row triggers on jobs fire in byte order of their names: 157's runs after 022, 034 and 083's and before 035's actor stamp.
    const order = (await q<{ n: string }>(`select tgname as n from pg_trigger where tgrelid = 'public.jobs'::regclass and not tgisinternal and tgtype & 19 = 19 order by tgname collate "C"`)).map((r) => r.n);
    const at = (n: string) => order.indexOf(n);
    expect(at("jobs_worksheet_version")).toBeGreaterThan(-1);
    for (const before of ["jobs_worksheet_version", "jobs_worksheet_version_release", "jobs_zz_drawing_revision"]) expect(at(before), before).toBeLessThan(at("jobs_zzz_integrity_guard"));
    expect(at("jobs_zzz_integrity_guard")).toBeLessThan(at("zzz_actor_stamp"));
  });

  // ---- C1: a recorded start is kept --------------------------------------------------------------------------------------------
  it("1a. C1: nobody (workshop, office, admin) can change or clear a recorded start on an open, a finished or a Complete job; the row and the starter are unchanged", async () => {
    const kinds: Array<[string, () => Promise<string>]> = [["open", open], ["finished", finished], ["complete", complete]];
    for (const [kind, make] of kinds) {
      for (const who of people()) {
        const id = await make();
        const before = pick(await row(id), ["started_at", "started_by", "stage", "inspected_at", "worksheet_version"]);
        expect(refused(await run(who.id, ...set(id, "started_at = $2", ["2026-09-30T07:00:00Z"]))), `${kind} ${who.role} change`).toBe("42501/start_kept");
        expect(refused(await run(who.id, ...set(id, "started_at = null"))), `${kind} ${who.role} clear`).toBe("42501/start_kept");
        expect(refused(await run(who.id, ...set(id, "started_at = $2, description = 'x'", ["2026-10-05T07:00:00Z"]))), `${kind} ${who.role} inside a wider update`).toBe("42501/start_kept");
        expect(pick(await row(id), ["started_at", "started_by", "stage", "inspected_at", "worksheet_version"]), `${kind} ${who.role} row`).toEqual(before);
        expect(iso(String((await row(id)).started_at))).toBe(iso(T0));
        expect((await row(id)).started_by).toBe(X.workshop.id);
      }
    }
  });

  it("1b. C1 (first start): a direct first start by editing the job is refused for workshop, office and admin (start_via_rpc) and leaves the row unchanged; the same value written again on a started job is not a change; then it is kept", async () => {
    for (const who of people()) {
      const id = await job({ started_at: null });
      const before = await row(id);
      expect(refused(await run(who.id, ...set(id, "started_at = $2", [T0]))), `${who.role} direct first start`).toBe("42501/start_via_rpc");
      expect(refused(await run(who.id, ...set(id, "started_at = now()"))), `${who.role} direct first start now()`).toBe("42501/start_via_rpc");
      expect(refused(await run(who.id, ...set(id, "started_at = $2, started_by = $3", ["2099-01-01T00:00:00Z", who.id]))), `${who.role} far-future start and starter`).toBe("42501/start_via_rpc");
      expect(refused(await run(who.id, ...set(id, "started_at = $2, description = 'x', stage = 'machining'", ["2001-01-01T00:00:00Z"]))), `${who.role} back-dated start inside a wider update`).toBe("42501/start_via_rpc");
      expect(await row(id), `${who.role} row`).toEqual(before);
      expect((await row(id)).started_at).toBeNull();
      expect((await row(id)).started_by).toBeNull();
    }
    // An update that leaves the empty start empty is untouched; a started job's same value written again is not a change; a different value is kept (start_kept).
    const empty = await job({ started_at: null });
    expect(allowed(await run(X.workshop.id, ...set(empty, "description = 'no start touched', started_at = null")))).toBe("allowed");
    const id = await open();
    expect(allowed(await run(X.office.id, ...set(id, "started_at = started_at, description = 'same start'")))).toBe("allowed");
    expect(refused(await run(X.office.id, ...set(id, "started_at = $2", [T1])))).toBe("42501/start_kept");
    expect((await row(id)).started_by).toBe(X.workshop.id);
    // The message is the Job Board wording.
    const msg = await run(X.workshop.id, ...set(await job({ started_at: null }), "started_at = $2", [T0]));
    expect(msg.ok ? "" : msg.e.message).toMatch(/^Job J157-[0-9a-f]+-\d+: start it from the Job Board \(Play or Start on the bench\); the start time can't be set by editing the job\.$/);
  });

  it("1d. C1: re-setting an already-set start, with a different started_by to hand the start to another user, is refused for office, admin and workshop; the row is unchanged and the original starter is still recorded", async () => {
    for (const who of people()) {
      const id = await open();
      const before = await row(id);
      const handover = await run(who.id, ...set(id, "started_at = $2, started_by = $3", ["2026-10-01T09:00:00Z", X.admin.id]));
      expect(refused(handover), `${who.role} start and starter`).toBe("42501/start_kept");
      expect(refused(await run(who.id, ...set(id, "started_at = $2", [T1]))), `${who.role} start only`).toBe("42501/start_kept");
      expect(await row(id), `${who.role} row`).toEqual(before);
      expect((await row(id)).started_by).toBe(X.workshop.id);
      expect(iso(String((await row(id)).started_at))).toBe(iso(T0));
    }
  });

  it("1c. C1: finish_job on an unstarted job fills both times; start_machine_run still starts an unstarted job", async () => {
    const id = await job({ started_at: null });
    const fin = await run(X.workshop.id, "select public.finish_job($1, null, null) as r", [id]);
    expect(allowed(fin)).toBe("allowed");
    const r = await row(id);
    expect(r.started_at).not.toBeNull();
    expect(r.finished_at).not.toBeNull();
    expect(iso(String(r.started_at))).toBe(iso(String(r.finished_at)));
    expect(r.stage).toBe("inspection");
    expect(r.started_by).toBe(X.workshop.id);
    expect(r.finished_by).toBe(X.workshop.id);

    const unstarted = await job({ started_at: null });
    const start = await run(X.workshop.id, "select public.start_machine_run($1, $2::uuid[], null, null, false, null) as r", [unstarted, [await freshMachine()]]);
    expect(allowed(start)).toBe("allowed");
    const s = await row(unstarted);
    expect(s.started_at).not.toBeNull();
    expect(s.started_by).toBe(X.workshop.id);
    expect(s.finished_at).toBeNull();
  });

  it("1e. C1: start_machine_run still starts an unstarted job on a machine and as a bench Start, the job's start equals the run's start, a bounded past device time is honoured as before, and who started it is recorded", async () => {
    const at = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const onMachine = await job({ started_at: null });
    const m = await freshMachine();
    const a = await run(X.workshop.id, "select public.start_machine_run($1, $2::uuid[], null, $3, false, null) as r", [onMachine, [m], at]);
    expect(allowed(a)).toBe("allowed");
    const aRuns = await q<{ started_at: Date; machine_id: string | null }>("select started_at, machine_id from machine_runs where job_id = $1", [onMachine]);
    expect(aRuns).toHaveLength(1);
    expect(aRuns[0].machine_id).toBe(m);
    expect(isoOf(aRuns[0].started_at)).toBe(iso(at));
    const aRow = await row(onMachine);
    expect(isoOf(aRow.started_at)).toBe(iso(at));
    expect(isoOf(aRow.started_at)).toBe(isoOf(aRuns[0].started_at));
    expect(aRow.started_by).toBe(X.workshop.id);
    expect(aRow.finished_at).toBeNull();

    const bench = await job({ started_at: null });
    const b = await run(X.office.id, "select public.start_machine_run($1, '{}'::uuid[], null, $2, false, null, null, true) as r", [bench, at]);
    expect(allowed(b)).toBe("allowed");
    const bRuns = await q<{ started_at: Date; machine_id: string | null }>("select started_at, machine_id from machine_runs where job_id = $1", [bench]);
    expect(bRuns).toHaveLength(1);
    expect(bRuns[0].machine_id).toBeNull();
    const bRow = await row(bench);
    expect(isoOf(bRow.started_at)).toBe(isoOf(bRuns[0].started_at));
    expect(isoOf(bRow.started_at)).toBe(iso(at));
    expect(bRow.started_by).toBe(X.office.id);

    // No time given: the server's time. A 2001 time is refused and a 2099 time is clamped, as before (start_machine_run's own checks, untouched).
    const now = await job({ started_at: null });
    expect(allowed(await run(X.admin.id, "select public.start_machine_run($1, $2::uuid[], null, null, false, null) as r", [now, [await freshMachine()]]))).toBe("allowed");
    expect((await row(now)).started_at).not.toBeNull();
    const ancient = await job({ started_at: null });
    const old = await run(X.workshop.id, "select public.start_machine_run($1, $2::uuid[], null, '2001-01-01T00:00:00Z', false, null) as r", [ancient, [await freshMachine()]]);
    expect(old.ok).toBe(false);
    expect((await row(ancient)).started_at).toBeNull();
    const future = await job({ started_at: null });
    expect(allowed(await run(X.workshop.id, "select public.start_machine_run($1, $2::uuid[], null, '2099-01-01T00:00:00Z', false, null) as r", [future, [await freshMachine()]]))).toBe("allowed");
    expect(new Date(String((await row(future)).started_at)).getTime()).toBeLessThanOrEqual(Date.now() + 10_000);
    // A job that is already started keeps its start when start_machine_run is called again (it only fills an empty time).
    const again = await run(X.workshop.id, "select public.start_machine_run($1, $2::uuid[], null, null, false, null) as r", [onMachine, [await freshMachine()]]);
    expect(allowed(again)).toBe("allowed");
    expect(isoOf((await row(onMachine)).started_at)).toBe(iso(at));
  });

  it("1f. C1: the start marker does not leak: after start_machine_run returns (same transaction) a direct first start on ANOTHER job and on a third job are refused; the marker is reset, and it names one job only", async () => {
    await rolledBack(async (db) => {
      const a = await job({ started_at: null });
      const b = await job({ started_at: null });
      const c = await job({ started_at: null });
      const started = await tryIn(db, X.workshop.id, "select public.start_machine_run($1, $2::uuid[], null, null, false, null) as r", [a, [await freshMachine()]]);
      expect(allowed(started)).toBe("allowed");
      expect((await db.query("select started_at is not null as s from jobs where id = $1", [a])).rows[0].s).toBe(true);
      // The function put the marker back to empty after its own update.
      expect((await db.query("select current_setting('tolra.job_start', true) as v")).rows[0].v).toBe("");
      for (const who of people()) {
        expect(refused(await tryIn(db, who.id, "update jobs set started_at = now() where id = $1", [b])), `${who.role} job B`).toBe("42501/start_via_rpc");
        expect(refused(await tryIn(db, who.id, "update jobs set started_at = $2 where id = $1", [c, T0])), `${who.role} job C`).toBe("42501/start_via_rpc");
      }
      expect((await db.query("select count(*)::int as n from jobs where id in ($1, $2) and started_at is not null", [b, c])).rows[0].n).toBe(0);
      // The marker names ONE job: while it names B, a direct start on C is still refused and one on B is what the function itself would do.
      await db.query("select set_config('tolra.job_start', $1, true)", [b]);
      expect(refused(await tryIn(db, X.workshop.id, "update jobs set started_at = $2 where id = $1", [c, T0]))).toBe("42501/start_via_rpc");
      expect(allowed(await tryIn(db, X.workshop.id, "update jobs set started_at = $2 where id = $1", [b, T0]))).toBe("allowed");
      for (const value of ["", "off", "on"]) {
        await db.query("select set_config('tolra.job_start', $1, true)", [value]);
        expect(refused(await tryIn(db, X.workshop.id, "update jobs set started_at = $2 where id = $1", [c, T0])), `marker = ${value || "(empty)"}`).toBe("42501/start_via_rpc");
      }
    });
    // A new statement (its own transaction, as PostgREST runs it) after a start_machine_run call: still refused.
    const a2 = await job({ started_at: null });
    const b2 = await job({ started_at: null });
    expect(allowed(await run(X.workshop.id, "select public.start_machine_run($1, $2::uuid[], null, null, false, null) as r", [a2, [await freshMachine()]]))).toBe("allowed");
    expect(refused(await run(X.workshop.id, ...set(b2, "started_at = now()")))).toBe("42501/start_via_rpc");
    expect((await row(b2)).started_at).toBeNull();
  });

  it("1g. C1: the service role and the database owner (the importer's paths) can still set a first start directly; finish_job on an unstarted job still sets both", async () => {
    const svc = await job({ started_at: null });
    expect(allowed(await run("service", ...set(svc, "started_at = $2", ["2026-09-01T08:00:00Z"])))).toBe("allowed");
    expect(isoOf((await row(svc)).started_at)).toBe(iso("2026-09-01T08:00:00Z"));
    const own = await job({ started_at: null });
    expect(allowed(await run(null, ...set(own, "started_at = $2", ["2026-09-02T08:00:00Z"])))).toBe("allowed");
    const fin = await job({ started_at: null });
    expect(allowed(await run(X.office.id, "select public.finish_job($1, null, null) as r", [fin]))).toBe("allowed");
    const r = await row(fin);
    expect(r.started_at).not.toBeNull();
    expect(r.finished_at).not.toBeNull();
  });

  // ---- C4: a finish is set only by finish_job -----------------------------------------------------------------------------------
  it("2a. C4: a direct update that sets finished_at (now, or back-dated) is refused for every browser role; nothing changes", async () => {
    for (const who of people()) {
      for (const value of ["2026-10-03T09:00:00Z", "2020-01-01T00:00:00Z"]) {
        const id = await open();
        expect(refused(await run(who.id, ...set(id, "finished_at = $2", [value]))), `${who.role} ${value}`).toBe("42501/finish_via_rpc");
        expect(refused(await run(who.id, ...set(id, "finished_at = $2, stage = 'inspection'", [value]))), `${who.role} ${value} with a stage move`).toBe("42501/finish_via_rpc");
        const r = await row(id);
        expect(r.finished_at).toBeNull();
        expect(r.stage).toBe("machining");
      }
    }
  });

  it("2b. C4: finish_job still works, with no machine run and with an open run (which it ends); reopen_job still clears the finish; clearing it by editing stays refused by 081", async () => {
    const plain = await open();
    expect(allowed(await run(X.workshop.id, "select public.finish_job($1, null, null) as r", [plain]))).toBe("allowed");
    const p = await row(plain);
    expect(p.finished_at).not.toBeNull();
    expect(p.finished_by).toBe(X.workshop.id);

    const running = await job({ started_at: null });
    expect(allowed(await run(X.workshop.id, "select public.start_machine_run($1, $2::uuid[], null, null, false, null) as r", [running, [await freshMachine()]]))).toBe("allowed");
    expect((await q<{ n: string }>("select count(*) as n from machine_runs where job_id = $1 and ended_at is null", [running]))[0].n).toBe("1");
    expect(allowed(await run(X.workshop.id, "select public.finish_job($1, null, null) as r", [running]))).toBe("allowed");
    expect((await row(running)).finished_at).not.toBeNull();
    expect((await q<{ n: string }>("select count(*) as n from machine_runs where job_id = $1 and ended_at is null", [running]))[0].n).toBe("0");

    // The existing rule for clearing a finish is untouched: editing it away is refused, reopen_job is the way.
    expect(refused(await run(X.workshop.id, ...set(plain, "finished_at = null")))).toBe("42501/reopen_required");
    expect(allowed(await run(X.workshop.id, "select public.reopen_job($1, 'Put back on the machine for a second op') as r", [plain]))).toBe("allowed");
    expect((await row(plain)).finished_at).toBeNull();
    // ... and a finish the owner (an import) writes is unaffected.
    expect(allowed(await run(null, ...set(plain, "finished_at = $2", [T1])))).toBe("allowed");
  });

  it("2c. C4: a plain finished_at update by the workshop on a job with no machine run is refused and changes nothing; finish_job then finishes the same job, and replaying the same client op id changes nothing", async () => {
    const id = await open();
    const before = await row(id);
    expect((await q<{ n: string }>("select count(*) as n from machine_runs where job_id = $1", [id]))[0].n).toBe("0");
    expect(refused(await run(X.workshop.id, ...set(id, "finished_at = $2, stage = 'inspection'", ["2026-10-03T09:00:00Z"])))).toBe("42501/finish_via_rpc");
    expect(await row(id)).toEqual(before);
    const op = randomUUID();
    const first = await run(X.workshop.id, "select public.finish_job($1, $2, null) as r", [id, op]);
    expect(allowed(first)).toBe("allowed");
    const done = (first as { ok: true; rows: Row[] }).rows[0].r as { changed: boolean; finished_at: string };
    expect(done.changed).toBe(true);
    const finishedRow = await row(id);
    expect(finishedRow.finished_at).not.toBeNull();
    expect(iso(done.finished_at)).toBe(isoOf(finishedRow.finished_at));
    expect(finishedRow.stage).toBe("inspection");
    expect(finishedRow.finished_by).toBe(X.workshop.id);
    const replay = await run(X.workshop.id, "select public.finish_job($1, $2, null) as r", [id, op]);
    expect(allowed(replay)).toBe("allowed");
    const again = (replay as { ok: true; rows: Row[] }).rows[0].r as { changed: boolean; finished_at: string };
    expect(again.changed).toBe(false);
    expect(iso(again.finished_at)).toBe(iso(done.finished_at));
    expect(await row(id)).toEqual(finishedRow);
  });

  // ---- C3: customer and job number ----------------------------------------------------------------------------------------------
  it("3a. C3: a workshop-only user cannot change customer or job_no, alone or inside a wider update, on an open, finished or Complete job; admin and office can", async () => {
    for (const make of [open, finished, complete]) {
      const id = await make();
      const before = pick(await row(id), ["customer", "job_no", "description", "stage", "inspected_at", "worksheet_version"]);
      expect(refused(await run(X.workshop.id, ...set(id, "customer = 'Someone Else Ltd'")))).toBe("42501/job_identity_office");
      expect(refused(await run(X.workshop.id, ...set(id, "job_no = 'J-HIJACK-1'")))).toBe("42501/job_identity_office");
      expect(refused(await run(X.workshop.id, ...set(id, "customer = 'Someone Else Ltd', job_no = 'J-HIJACK-2'")))).toBe("42501/job_identity_office");
      expect(refused(await run(X.workshop.id, ...set(id, "description = 'tidied', customer = null")))).toBe("42501/job_identity_office");
      expect(pick(await row(id), ["customer", "job_no", "description", "stage", "inspected_at", "worksheet_version"])).toEqual(before);
    }
    // The same value written again is not a change; the workshop can edit what it always could.
    const id = await open();
    expect(allowed(await run(X.workshop.id, ...set(id, "customer = customer, job_no = job_no, description = 'same customer'")))).toBe("allowed");
    expect((await row(id)).description).toBe("same customer");
    // Admin and office are unchanged, on an open job and on a Complete one (which a worksheet-neutral customer edit leaves alone: customer is not a worksheet field).
    for (const who of [X.office, X.admin]) {
      const open1 = await open();
      expect(allowed(await run(who.id, ...set(open1, "customer = $2, job_no = $3", [`Renamed by ${who.role}`, `J157-${runId}-r-${who.role}`])))).toBe("allowed");
      expect(pick(await row(open1), ["customer", "job_no"])).toEqual({ customer: `Renamed by ${who.role}`, job_no: `J157-${runId}-r-${who.role}` });
    }
  });

  it("3b. C3: job_no can be set empty today by admin and office (report only; 157 does not change it); the workshop is still refused", async () => {
    // job_no is unique per company (jobs_job_no_unique), so one empty number at a time: the admin sets it and puts it back, then the office does.
    const a = await open();
    const w = await open();
    const was = String((await row(a)).job_no);
    expect(allowed(await run(X.admin.id, ...set(a, "job_no = ''")))).toBe("allowed");
    expect((await row(a)).job_no).toBe("");
    expect(allowed(await run(X.admin.id, ...set(a, "job_no = $2", [was])))).toBe("allowed");
    expect(allowed(await run(X.office.id, ...set(a, "job_no = ''")))).toBe("allowed");
    expect((await row(a)).job_no).toBe("");
    expect(refused(await run(X.workshop.id, ...set(w, "job_no = ''")))).toBe("42501/job_identity_office");
  });

  // ---- C2 / P1: a passed inspection ---------------------------------------------------------------------------------------------
  /** A Complete job in the state the test needs: plain, despatched (a despatched delivery note names it) or invoiced (an issued invoice names it). */
  async function completeAs(kind: "complete" | "despatched" | "invoiced") {
    const id = await complete();
    if (kind === "despatched") {
      await q("insert into delivery_notes (organization_id, dn_number, customer, status, job_id, job_ref) values ($1, $2, 'Integrity Co', 'despatched', $3, (select job_no from jobs where id = $3))", [X.o, `DN-157-${runId}-${++seq}`, id]);
    }
    if (kind === "invoiced") {
      await q("insert into invoices (organization_id, invoice_ref, customer, status, total, subtotal, vat, job_id) values ($1, $3, 'Integrity Co', 'sent', 12, 10, 2, $2)", [X.o, id, `INV-157-${runId}-${++seq}`]);
    }
    return id;
  }
  const releaseState = ["stage", "inspected_at", "inspected_by", "worksheet_version", "started_at", "finished_at"];

  it.each(["complete", "despatched", "invoiced"] as const)("4a. C2/P1 (%s job): a workshop worksheet edit, a stage move and a direct inspected_at update are refused; the pass, stage and version are unchanged", async (kind) => {
    const id = await completeAs(kind);
    const before = pick(await row(id), releaseState);
    const wholeBefore = await row(id);
    const recordsBefore = (await q<{ n: string }>("select count(*) as n from job_inspections where job_id = $1", [id]))[0].n;
    expect(before).toMatchObject({ stage: "complete" });
    // On a despatched or invoiced job C5 answers first (for every role), so the workshop sees released_pass_kept there and inspection_kept otherwise.
    const hint = kind === "complete" ? "42501/inspection_kept" : "42501/released_pass_kept";
    expect(refused(await run(X.workshop.id, ...set(id, "improvement_comments = 'Use a sharper insert next time'")))).toBe(hint);
    expect(refused(await run(X.workshop.id, ...set(id, "quantity_required = 12")))).toBe(hint);
    expect(refused(await run(X.workshop.id, ...set(id, "stage = 'inspection'")))).toBe(hint);
    expect(refused(await run(X.workshop.id, ...set(id, "stage = 'machining', improvement_comments = 'x'")))).toBe(hint);
    // inspected_at has its own older lock (034: only Record inspection changes it); either way it is refused and nothing moves.
    expect((await run(X.workshop.id, ...set(id, "inspected_at = null")) as { ok: false; e: Err }).e.code).toBe("42501");
    expect((await run(X.workshop.id, ...set(id, "inspected_at = null, stage = 'inspection'")) as { ok: false; e: Err }).e.code).toBe("42501");
    expect(pick(await row(id), releaseState)).toEqual(before);
    expect(await row(id)).toEqual(wholeBefore);
    expect((await q<{ n: string }>("select count(*) as n from job_inspections where job_id = $1", [id]))[0].n).toBe(recordsBefore);
    expect((await row(id)).improvement_comments).toBeNull();
  });

  it("4b. C2: edits that do not withdraw the pass still work for the workshop on a Complete job (a status move that is not the worksheet)", async () => {
    const id = await complete();
    const before = pick(await row(id), releaseState);
    expect(allowed(await run(X.workshop.id, ...set(id, "status = 'at_risk'")))).toBe("allowed");
    expect(pick(await row(id), releaseState)).toEqual(before);
    expect((await row(id)).status).toBe("at_risk");
  });

  it("4c. C2: a workshop worksheet edit on a job that is not Complete still works (the version counts, nothing is withdrawn: there is nothing to withdraw)", async () => {
    const id = await finished();
    expect(allowed(await run(X.workshop.id, ...set(id, "improvement_comments = 'Use a sharper insert next time'")))).toBe("allowed");
    expect(pick(await row(id), ["stage", "inspected_at", "worksheet_version"])).toEqual({ stage: "inspection", inspected_at: null, worksheet_version: 1 });
    const moving = await open();
    expect(allowed(await run(X.workshop.id, ...set(moving, "stage = 'finishing'")))).toBe("allowed");
    expect((await row(moving)).stage).toBe("finishing");
  });

  it("4d. C2: an office or admin worksheet or quantity edit on a Complete job still withdraws the pass as before; a workshop person on the inspector list then records the new pass", async () => {
    for (const who of [X.office, X.admin]) {
      const id = await complete();
      expect(allowed(await run(who.id, ...set(id, "improvement_comments = 'Use a sharper insert next time'")))).toBe("allowed");
      expect(pick(await row(id), ["stage", "inspected_at", "inspected_by", "worksheet_version"]), who.role).toEqual({ stage: "inspection", inspected_at: null, inspected_by: null, worksheet_version: 1 });
    }
    const id = await complete();
    expect(allowed(await run(X.admin.id, ...set(id, "quantity_required = 12")))).toBe("allowed");
    expect(await row(id)).toMatchObject({ stage: "inspection", inspected_at: null });
    // Re-inspection after the withdrawal: a new record_job_inspection / inspect_job pass by the workshop works.
    const again = await run(X.workshop.id, INSPECT, await inspectArgs(id, "pass"));
    expect(allowed(again)).toBe("allowed");
    expect(await row(id)).toMatchObject({ stage: "complete" });
    expect((await row(id)).inspected_at).not.toBeNull();
  });

  it("4e. C2: a new pass by the workshop (inspect_job) on a finished job works", async () => {
    const one = await finished();
    expect(allowed(await run(X.workshop.id, INSPECT, await inspectArgs(one, "pass")))).toBe("allowed");
    expect(await row(one)).toMatchObject({ stage: "complete" });
    expect((await row(one)).inspected_at).not.toBeNull();
  });

  it("4f. C2: failing the inspection of a Complete job (fail_job_inspection, record_job_inspection fail, inspect_job fail), by the workshop, withdraws the pass through the workflow; rework then finishes and is re-inspected by someone else", async () => {
    // inspect_job fail
    const a = await complete();
    expect(allowed(await run(X.workshop.id, INSPECT, await inspectArgs(a, "fail")))).toBe("allowed");
    expect(await row(a)).toMatchObject({ stage: "rework", inspected_at: null });
    // record_job_inspection fail (the older call)
    const b = await complete();
    expect(allowed(await run(X.workshop.id, "select public.record_job_inspection($1, 'fail', 'Bore 25.08 oversize', null, null, null, $2) as r", [b, (await row(b)).worksheet_version]))).toBe("allowed");
    expect((await row(b)).inspected_at).toBeNull();
    // fail_job_inspection (037)
    const c = await complete();
    expect(allowed(await run(X.workshop.id, "select public.fail_job_inspection($1, 'Bore 25.08', 'Bore oversize', null, 'Re-bore and re-measure', null, null, null, null) as r", [c]))).toBe("allowed");
    expect(await row(c)).toMatchObject({ stage: "rework", inspected_at: null });
    // The rework: the workshop finishes it (finish_job_rework names the job), then inspects it again.
    const rework = await latestRework(c);
    expect(allowed(await run(X.workshop.id, "select public.start_job_rework($1) as r", [rework]))).toBe("allowed");
    expect(allowed(await run(X.workshop.id, "select public.finish_job_rework($1, null, 0) as r", [rework]))).toBe("allowed");
    expect((await row(c)).stage).toBe("inspection");
    // (the person who did the rework can't pass it: someone else, here the office, inspects it)
    expect(allowed(await run(X.office.id, INSPECT, await inspectArgs(c, "pass")))).toBe("allowed");
    expect(await row(c)).toMatchObject({ stage: "complete" });
  });

  it("4g. C2: reopen_job and open_replacement_rework still work on a job that has passed (the office); the workshop still cannot reopen a passed job, and still makes and finishes the replacements", async () => {
    // reopen_job: a Complete job is reopened by the office (not by the workshop: 081's rule, unchanged).
    const id = await complete();
    expect(refused(await run(X.workshop.id, "select public.reopen_job($1, 'Customer asked for a re-check of the bore') as r", [id]))).toBe("42501/reopen_not_allowed");
    expect(await row(id)).toMatchObject({ stage: "complete" });
    expect(allowed(await run(X.office.id, "select public.reopen_job($1, 'Customer asked for a re-check of the bore') as r", [id]))).toBe("allowed");
    expect(await row(id)).toMatchObject({ finished_at: null, inspected_at: null });
    // open_replacement_rework: fail, scrap 2, an admin's concession releases the job, the office opens the replacements, the workshop makes them, the pass releases it again.
    const j = await finished();
    expect(allowed(await run(X.workshop.id, INSPECT, await inspectArgs(j, "fail")))).toBe("allowed");
    const first = await latestRework(j);
    expect(allowed(await run(X.workshop.id, "select public.scrap_job_quantity($1, 2, 'Cracked on re-bore') as r", [first]))).toBe("allowed");
    expect(allowed(await run(X.admin.id, INSPECT, await inspectArgs(j, "concession", "Customer accepted the short quantity")))).toBe("allowed");
    expect(await row(j)).toMatchObject({ stage: "complete" });
    expect(allowed(await run(X.office.id, "select public.open_replacement_rework($1, 'Make 2 off to drawing') as r", [first]))).toBe("allowed");
    expect(await row(j)).toMatchObject({ stage: "rework", inspected_at: null });
    const second = await latestRework(j);
    expect(second).not.toBe(first);
    expect(allowed(await run(X.workshop.id, "select public.start_job_rework($1) as r", [second]))).toBe("allowed");
    expect(allowed(await run(X.workshop.id, "select public.finish_job_rework($1, null, 2) as r", [second]))).toBe("allowed");
    expect((await row(j)).stage).toBe("inspection");
    expect(allowed(await run(X.office.id, INSPECT, await inspectArgs(j, "pass")))).toBe("allowed");
    expect(await row(j)).toMatchObject({ stage: "complete" });
  });

  it("4h. C2: each authorised flag (quoteflow.job_inspection, quoteflow.job_rework, quoteflow.job_reopen) lets the workshop withdraw the pass of THAT job only; another job's id, an empty value or no flag does not", async () => {
    await rolledBack(async (db) => {
      const mine = await complete();
      const other = await complete();
      for (const flag of ["quoteflow.job_inspection", "quoteflow.job_rework", "quoteflow.job_reopen"]) {
        for (const value of [other, "", "off"]) {
          await db.query("select set_config($1, $2, true)", [flag, value]);
          const r = await tryIn(db, X.workshop.id, "update jobs set stage = 'inspection' where id = $1", [mine]);
          expect(refused(r), `${flag} = ${value || "(empty)"}`).toBe("42501/inspection_kept");
        }
        await db.query("select set_config($1, $2, true)", [flag, mine]);
        expect(allowed(await tryIn(db, X.workshop.id, "update jobs set stage = 'inspection' where id = $1", [mine])), `${flag} names this job`).toBe("allowed");
        expect((await db.query("select stage from jobs where id = $1", [mine])).rows[0].stage).toBe("inspection");
        await db.query("update jobs set stage = 'complete' where id = $1", [mine]);
        await db.query("select set_config($1, '', true)", [flag]);
      }
      // The same flags do not unlock customer or job number for the workshop (C3) or a start time (C1).
      await db.query("select set_config('quoteflow.job_inspection', $1, true)", [mine]);
      expect(refused(await tryIn(db, X.workshop.id, "update jobs set customer = 'Else' where id = $1", [mine]))).toBe("42501/job_identity_office");
      expect(refused(await tryIn(db, X.workshop.id, "update jobs set started_at = now() where id = $1", [mine]))).toBe("42501/start_kept");
    });
  });

  // ---- C5: a despatched or invoiced job keeps its passed inspection (every browser role) ----------------------------------------------
  // Helpers: the document rows are written by the database owner (an exempt path); each returns the document number so a test can prove it never leaks.
  const jobNoOf = async (id: string) => String((await row(id)).job_no);
  const noteFor = async (id: string | null, jobNo: string, status: string, org = X.o) => {
    const dn = `DN-157-${runId}-${++seq}`;
    await q("insert into delivery_notes (organization_id, dn_number, customer, status, job_id, job_ref) values ($1, $2, 'Integrity Co', $3, $4, $5)", [org, dn, status, id, jobNo]);
    return dn;
  };
  const invoiceFor = async (id: string, status: string, org = X.o) => {
    const ref = `INV-157-${runId}-${++seq}`;
    await q("insert into invoices (organization_id, invoice_ref, customer, status, total, subtotal, vat, job_id) values ($1, $2, 'Integrity Co', $3, 12, 10, 2, $4)", [org, ref, status, id]);
    return ref;
  };
  const inspectionCount = async (id: string) => (await q<{ n: string }>("select count(*) as n from job_inspections where job_id = $1", [id]))[0].n;
  const hideInvoices = async (role: "office" | "admin") => {
    const p = await makePerson(X.o, role);
    // The app does this through set_member_access (093: p_hidden_sections); the column is what it writes and what section_allowed('invoices') reads.
    await q("update organization_members set hidden_sections = $1 where user_id = $2 and organization_id = $3", [["invoices"], p.id, X.o]);
    return p;
  };
  const FIXED = (jobNo: string) => `Job ${jobNo}: it has been despatched or invoiced, so its passed inspection stands. If something is wrong with it, record a failed inspection or raise rework.`;
  const officeEdits: Array<[string, string]> = [["a worksheet edit", "improvement_comments = 'Use a sharper insert next time'"], ["a quantity edit", "quantity_required = 12"], ["a stage move", "stage = 'inspection'"]];

  it("4i. C5: office and admin cannot withdraw the pass of a job with a despatched, delivered or signed delivery note (linked by job, or by job_ref only) or an issued or paid invoice; the whole row and the inspection records are unchanged", async () => {
    const states: Array<[string, (id: string, no: string) => Promise<string>]> = [
      ["a despatched note linked by job_id", (id, no) => noteFor(id, no, "despatched")],
      ["a delivered note linked by job_id", (id, no) => noteFor(id, no, "delivered")],
      ["a signed note linked by job_id", (id, no) => noteFor(id, no, "signed")],
      ["a despatched note linked only by job_ref (job_id empty)", (_id, no) => noteFor(null, no, "despatched")],
      ["an issued (sent) invoice", (id) => invoiceFor(id, "sent")],
      ["a paid invoice", (id) => invoiceFor(id, "paid")],
    ];
    for (const [label, make] of states) {
      for (const who of [X.office, X.admin]) {
        const id = await complete();
        await make(id, await jobNoOf(id));
        const whole = await row(id);
        const records = await inspectionCount(id);
        for (const [edit, sql] of officeEdits) {
          expect(refused(await run(who.id, ...set(id, sql))), `${who.role}, ${label}, ${edit}`).toBe("42501/released_pass_kept");
        }
        expect(await row(id), `${who.role}, ${label}: row`).toEqual(whole);
        expect(await inspectionCount(id), `${who.role}, ${label}: inspections`).toBe(records);
      }
    }
  });

  it("4j. C5 DEFINER CASE: an office user and an admin whose Invoices section is hidden still cannot withdraw the pass of an invoiced job, cannot read any invoice themselves, and the refusal quotes no invoice or delivery-note number", async () => {
    const hiddenOffice = await hideInvoices("office");
    const hiddenAdmin = await hideInvoices("admin");
    for (const who of [hiddenOffice, hiddenAdmin]) {
      const id = await complete();
      const no = await jobNoOf(id);
      const invoice = await invoiceFor(id, "sent");
      const note = await noteFor(id, no, "despatched");
      // They really cannot see invoices (the RESTRICTIVE "invoices section access" policy), so a lookup running with THEIR rights would find nothing ...
      const mine = await run(who.id, "select id, invoice_ref from invoices where organization_id = $1", [X.o]);
      expect(mine, `${who.role} reads invoices`).toMatchObject({ ok: true, count: 0 });
      expect(await run(who.id, "select id from invoices where job_id = $1", [id])).toMatchObject({ ok: true, count: 0 });
      // ... while a colleague with the section sees the same invoice, and it exists.
      expect((await run(X.office.id, "select invoice_ref from invoices where job_id = $1", [id]) as { ok: true; rows: Row[] }).rows).toEqual([{ invoice_ref: invoice }]);
      // The invoiced-only job (no delivery note) is the one that proves the definer lookup: use a second job with the invoice alone.
      const invoicedOnly = await complete();
      const onlyRef = await invoiceFor(invoicedOnly, "sent");
      const whole = await row(invoicedOnly);
      for (const [edit, sql] of officeEdits) {
        const o = await run(who.id, ...set(invoicedOnly, sql));
        expect(refused(o), `${who.role} hidden invoices, invoice only, ${edit}`).toBe("42501/released_pass_kept");
        const e = (o as { ok: false; e: Err }).e;
        expect(e.message).toBe(FIXED(await jobNoOf(invoicedOnly)));
        expect(e.message).not.toContain(onlyRef);
        expect(e.message).not.toContain("INV-");
        expect(e.message).not.toContain("DN-");
      }
      expect(await row(invoicedOnly), `${who.role} hidden invoices: row`).toEqual(whole);
      // The despatched job (note and invoice both there): refused too, and neither number is in the text.
      const refusal = await run(who.id, ...set(id, officeEdits[0][1]));
      expect(refused(refusal)).toBe("42501/released_pass_kept");
      const text = (refusal as { ok: false; e: Err }).e.message;
      expect(text).toBe(FIXED(no));
      expect(text).not.toContain(invoice);
      expect(text).not.toContain(note);
      expect((await row(id)).inspected_at).not.toBeNull();
      // Not blocked without a document: a hidden-Invoices person still edits a Complete job that has gone nowhere, as before.
      const plain = await complete();
      expect(allowed(await run(who.id, ...set(plain, officeEdits[0][1]))), `${who.role} plain job`).toBe("allowed");
      expect(await row(plain)).toMatchObject({ stage: "inspection", inspected_at: null });
    }
  });

  it("4k. C5 definer rights are narrow: the guard is SECURITY DEFINER with its search_path pinned, no browser role can execute it, and calling it directly is refused", async () => {
    const c = (await q<{ secdef: boolean; cfg: string[]; anon: boolean; authenticated: boolean; pub: boolean; owner: string }>(
      `select p.prosecdef as secdef, p.proconfig as cfg, has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
              coalesce(p.proacl, acldefault('f', p.proowner)) @> array[makeaclitem(0, p.proowner, 'EXECUTE', false)] as pub, pg_get_userbyid(p.proowner) as owner
       from pg_proc p where p.oid = to_regprocedure('public.jobs_integrity_guard()')`))[0];
    expect(c).toMatchObject({ secdef: true, cfg: ["search_path=pg_catalog, public"], anon: false, authenticated: false, pub: false });
    for (const who of [X.office.id, X.admin.id, X.workshop.id]) {
      expect(refused(await run(who, "select public.jobs_integrity_guard()"))).toBe("42501/-");
    }
    expect(refused(await run("service", "select public.jobs_integrity_guard()")), "service_role keeps the platform default (044 precedent) but a trigger function can only be fired by its trigger").not.toBe("allowed");
  });

  it("4l. C5 company boundary: another company's despatched note or invoice naming the same job number does not block an office or admin edit; another company's user still cannot update this job", async () => {
    const mine = async () => complete();
    for (const who of [X.office, X.admin]) {
      const id = await mine();
      const no = await jobNoOf(id);
      // Company B: a despatched note naming this very job number (job_ref equal, no job), its own job with the same number, a note and an invoice on that job.
      await noteFor(null, no, "despatched", Y.o);
      const theirs = await job({ job_no: no, stage: "complete", started_at: T0, finished_at: T1, inspected_at: T1 }, Y.o);
      await noteFor(theirs, no, "despatched", Y.o);
      await invoiceFor(theirs, "sent", Y.o);
      // An invoice of B that points at A's job can't even exist (015's cross-company guard); the database refuses it.
      const cross = await invoiceFor(id, "sent", Y.o).then(() => "inserted", (x: Err) => x.message);
      expect(cross).toContain("cross-organisation");
      expect(allowed(await run(who.id, ...set(id, officeEdits[0][1]))), `${who.role}: B's documents do not block A's job`).toBe("allowed");
      expect(await row(id)).toMatchObject({ stage: "inspection", inspected_at: null, inspected_by: null });
    }
    // The other way round: company A's despatched note naming B's job number does not block B's admin on B's own Complete job.
    const mineA = await mine();
    const noA = await jobNoOf(mineA);
    await noteFor(null, noA, "despatched");
    await invoiceFor(mineA, "sent");
    const b = await job({ job_no: noA, stage: "complete", started_at: T0, finished_at: T1, inspected_at: T1 }, Y.o);
    expect(allowed(await run(Y.admin.id, "update jobs set improvement_comments = 'B edit' where id = $1", [b]))).toBe("allowed");
    expect(await row(b)).toMatchObject({ stage: "inspection", inspected_at: null });
    // A user of company B updates no row of company A's despatched job at all (row security), and the pass stands.
    const despatched = await mine();
    await noteFor(despatched, await jobNoOf(despatched), "despatched");
    const before = await row(despatched);
    expect(await run(Y.admin.id, "update jobs set improvement_comments = 'Taken', stage = 'inspection' where id = $1", [despatched])).toMatchObject({ ok: true, count: 0 });
    expect(await row(despatched)).toEqual(before);
  });

  it("4m. C5 is not over-broad: a Complete job with only a pending or awaiting delivery note, only a draft, void or cancelled invoice, a despatched note of a different job, or nothing is still edited by office and admin, which withdraws the pass as before", async () => {
    const states: Array<[string, (id: string, no: string) => Promise<unknown>]> = [
      ["no document", async () => undefined],
      ["a pending delivery note", (id, no) => noteFor(id, no, "pending")],
      ["an awaiting delivery note linked by job_ref only", (_id, no) => noteFor(null, no, "awaiting")],
      ["a draft invoice", (id) => invoiceFor(id, "draft")],
      ["a void invoice", (id) => invoiceFor(id, "void")],
      ["a cancelled invoice", (id) => invoiceFor(id, "cancelled")],
      ["a despatched note of another job (other job_ref)", async () => noteFor(null, `OTHER-${runId}-${++seq}`, "despatched")],
    ];
    for (const [label, make] of states) {
      for (const who of [X.office, X.admin]) {
        const id = await complete();
        await make(id, await jobNoOf(id));
        expect(allowed(await run(who.id, ...set(id, officeEdits[0][1]))), `${who.role}, ${label}`).toBe("allowed");
        expect(pick(await row(id), ["stage", "inspected_at", "inspected_by", "worksheet_version"]), `${who.role}, ${label}`).toEqual({ stage: "inspection", inspected_at: null, inspected_by: null, worksheet_version: 1 });
      }
    }
  });

  it("4n. C5: a legitimate correction of a despatched or invoiced job still works with its reason recorded (fail_job_inspection, inspect_job fail, open_replacement_rework); reopen_job is still refused with its own hint", async () => {
    // fail_job_inspection by the workshop inspector, on a despatched job.
    const a = await complete();
    await noteFor(a, await jobNoOf(a), "despatched");
    const recordsA = Number(await inspectionCount(a));
    expect(allowed(await run(X.workshop.id, "select public.fail_job_inspection($1, 'Bore 25.08', 'Bore oversize', null, 'Re-bore and re-measure', null, null, null, null) as r", [a]))).toBe("allowed");
    expect(await row(a)).toMatchObject({ stage: "rework", inspected_at: null });
    expect(Number(await inspectionCount(a))).toBe(recordsA + 1);
    expect(await q("select result from job_inspections where job_id = $1 order by inspected_at desc, id desc limit 1", [a])).toEqual([{ result: "fail" }]);
    expect((await q<{ reason: string }>("select reason from job_rework where job_id = $1 order by raised_at desc, id desc limit 1", [a]))[0].reason).toContain("Bore oversize");
    // inspect_job fail on an invoiced job, by the office.
    const b = await complete();
    await invoiceFor(b, "sent");
    expect(allowed(await run(X.office.id, INSPECT, await inspectArgs(b, "fail")))).toBe("allowed");
    expect(await row(b)).toMatchObject({ stage: "rework", inspected_at: null });
    expect((await q<{ reason: string }>("select reason from job_rework where job_id = $1 order by raised_at desc, id desc limit 1", [b]))[0].reason).toContain("Bore oversize 25.06");
    // open_replacement_rework on a despatched job (fail, scrap 2, concession releases it, it goes out, then the office opens the replacements).
    const j = await finished();
    expect(allowed(await run(X.workshop.id, INSPECT, await inspectArgs(j, "fail")))).toBe("allowed");
    const first = await latestRework(j);
    expect(allowed(await run(X.workshop.id, "select public.scrap_job_quantity($1, 2, 'Cracked on re-bore') as r", [first]))).toBe("allowed");
    expect(allowed(await run(X.admin.id, INSPECT, await inspectArgs(j, "concession", "Customer accepted the short quantity")))).toBe("allowed");
    expect(await row(j)).toMatchObject({ stage: "complete" });
    await noteFor(j, await jobNoOf(j), "despatched");
    expect(allowed(await run(X.office.id, "select public.open_replacement_rework($1, 'Make 2 off to drawing') as r", [first]))).toBe("allowed");
    expect(await row(j)).toMatchObject({ stage: "rework", inspected_at: null });
    expect((await q<{ instructions: string }>("select instructions from job_rework where job_id = $1 order by raised_at desc, id desc limit 1", [j]))[0].instructions).toContain("Make 2 off to drawing");
    // reopen_job is still refused, with its existing hint, for a despatched and an invoiced job; the job is unchanged.
    const d = await complete();
    await noteFor(d, await jobNoOf(d), "despatched");
    const e = await complete();
    await invoiceFor(e, "sent");
    for (const [id, hint] of [[d, "22023/already_despatched"], [e, "22023/invoice_issued"]] as const) {
      const before = await row(id);
      expect(refused(await run(X.office.id, "select public.reopen_job($1, 'Customer asked for a re-check of the bore') as r", [id]))).toBe(hint);
      expect(refused(await run(X.admin.id, "select public.reopen_job($1, 'Customer asked for a re-check of the bore') as r", [id]))).toBe(hint);
      expect(await row(id)).toEqual(before);
    }
  });

  it("4o. C5: the workshop alone on a despatched or invoiced job is refused released_pass_kept (C5 answers before C2) for a worksheet edit, a stage move and a stage move with a customer change; a customer-only change is still job_identity_office; a flag naming the job lets the authorised workflow through", async () => {
    for (const make of [async () => { const id = await complete(); await noteFor(id, await jobNoOf(id), "despatched"); return id; }, async () => { const id = await complete(); await invoiceFor(id, "sent"); return id; }]) {
      const id = await make();
      const whole = await row(id);
      expect(refused(await run(X.workshop.id, ...set(id, "improvement_comments = 'x'")))).toBe("42501/released_pass_kept");
      expect(refused(await run(X.workshop.id, ...set(id, "stage = 'inspection'")))).toBe("42501/released_pass_kept");
      expect(refused(await run(X.workshop.id, ...set(id, "stage = 'inspection', customer = 'Else Ltd'")))).toBe("42501/released_pass_kept");
      expect(refused(await run(X.workshop.id, ...set(id, "customer = 'Else Ltd'")))).toBe("42501/job_identity_office");
      expect(await row(id)).toEqual(whole);
      // The authorised workflows name the job: neither C5 nor C2 then applies (fail, rework and reopen record their own reason, and reopen_job has its own refusals).
      await rolledBack(async (db) => {
        for (const [who, flag] of [[X.workshop.id, "quoteflow.job_inspection"], [X.workshop.id, "quoteflow.job_rework"], [X.office.id, "quoteflow.job_reopen"]] as const) {
          await db.query("select set_config($1, $2, true)", [flag, id]);
          expect(allowed(await tryIn(db, who, "update jobs set stage = 'inspection' where id = $1", [id])), `${flag} names this job`).toBe("allowed");
          await db.query("update jobs set stage = 'complete' where id = $1", [id]);
          await db.query("select set_config($1, '', true)", [flag]);
        }
        // Another job's id in the flag is no key.
        await db.query("select set_config('quoteflow.job_inspection', $1, true)", [randomUUID()]);
        expect(refused(await tryIn(db, X.office.id, "update jobs set stage = 'inspection' where id = $1", [id]))).toBe("42501/released_pass_kept");
        expect(refused(await tryIn(db, X.workshop.id, "update jobs set stage = 'inspection' where id = $1", [id]))).toBe("42501/released_pass_kept");
      });
    }
  });

  it("4p. C5: an update by office or admin that does not withdraw the pass (status, specification) still works on a despatched or invoiced Complete job; the pass, stage and version are unchanged", async () => {
    for (const make of [async () => { const id = await complete(); await noteFor(id, await jobNoOf(id), "despatched"); return id; }, async () => { const id = await complete(); await invoiceFor(id, "sent"); return id; }]) {
      for (const who of [X.office, X.admin]) {
        const id = await make();
        const before = pick(await row(id), releaseState);
        expect(allowed(await run(who.id, ...set(id, "status = 'at_risk'"))), `${who.role} status`).toBe("allowed");
        expect(allowed(await run(who.id, ...set(id, "specification = 'Spec note'"))), `${who.role} specification`).toBe("allowed");
        expect(pick(await row(id), releaseState)).toEqual(before);
        expect(await row(id)).toMatchObject({ status: "at_risk", specification: "Spec note" });
      }
    }
  });

  // ---- Drawing revision ---------------------------------------------------------------------------------------------------------
  it("5. drawing revision: a workshop-only caller can never reach job_files_revision_change with a revision (set_job_drawing_revision refuses a Complete job, job_files_guard allows only an admin to attach one); the admin path still re-saves the job and withdraws the pass exactly as before 157", async () => {
    const file = (id: string, name: string, revision: string | null): [string, unknown[]] => ["insert into job_files (organization_id, job_id, kind, ref, revision, file_name, storage_bucket, storage_path) values ($1, $2, 'drawing', 'DWG-157', $5, $3, 'job-drawings', $4)",
      [X.o, id, name, `${X.o}/${id}/${name}`, revision]];
    // Complete job, workshop-only caller: the revision RPC is refused by 083 itself, a drawing with a revision by 034's job_files_guard; the job is untouched.
    const done = await complete();
    const before = pick(await row(done), releaseState);
    expect(refused(await run(X.workshop.id, "select public.set_job_drawing_revision($1, null, 'B', 'Revision B issued by the customer today') as r", [done]))).toBe("22023/job_complete");
    const attach = await run(X.workshop.id, ...file(done, "dwg-b.pdf", "B"));
    expect(attach.ok ? "allowed" : attach.e.message).toBe("Only an admin approves a drawing revision.");
    expect(refused(await run(X.office.id, ...file(done, "dwg-b-office.pdf", "B")))).toBe("42501/-");
    expect((await q<{ n: string }>("select count(*) as n from job_files where job_id = $1", [done]))[0].n).toBe("0");
    expect(pick(await row(done), releaseState)).toEqual(before);
    // A drawing with no revision is not a worksheet change: the workshop attaches it to a Complete job and the pass stays.
    expect(allowed(await run(X.workshop.id, ...file(done, "dwg-plain.pdf", null)))).toBe("allowed");
    expect(pick(await row(done), releaseState)).toEqual(before);
    // The admin's path is unchanged: a revision on a Complete job re-saves it (a worksheet change) and withdraws the pass, as before 157.
    const id = await complete();
    expect(allowed(await run(X.admin.id, ...file(id, "dwg-admin.pdf", "B")))).toBe("allowed");
    expect(pick(await row(id), ["stage", "inspected_at", "inspected_by", "worksheet_version"])).toEqual({ stage: "inspection", inspected_at: null, inspected_by: null, worksheet_version: 1 });
    // On a job that is not Complete the workshop sets the revision through the RPC as before; on a Complete job the admin's call is refused by 083 for everyone (reopen first).
    const live = await finished();
    expect(allowed(await run(X.workshop.id, "select public.set_job_drawing_revision($1, null, 'A', null) as r", [live]))).toBe("allowed");
    expect((await row(live)).drawing_revision).toBe("A");
    const c2 = await complete();
    expect(refused(await run(X.admin.id, "select public.set_job_drawing_revision($1, true, 'C', 'Revision C issued by the customer today') as r", [c2]))).toBe("22023/job_complete");
  });

  // ---- Isolation and exemptions -------------------------------------------------------------------------------------------------
  it("6. another company's admin updates no row of this company's jobs; the service role and the database owner are exempt", async () => {
    const id = await complete();
    const before = pick(await row(id), ["customer", "started_at", "finished_at", "stage", "inspected_at", "worksheet_version"]);
    const theirs = await run(Y.admin.id, `update jobs set started_at = $2, customer = 'Taken', stage = 'inspection' where id = $1`, [id, T1]);
    expect(theirs).toMatchObject({ ok: true, count: 0 });
    expect(pick(await row(id), ["customer", "started_at", "finished_at", "stage", "inspected_at", "worksheet_version"])).toEqual(before);
    // The exempt roles (the importer's path): a start, a finish, a customer and a withdrawn pass, all as before 157.
    const svc = await open();
    expect(allowed(await run("service", ...set(svc, "started_at = $2, finished_at = $3, customer = 'Imported Co', job_no = $4", ["2026-09-01T08:00:00Z", T1, `J157-${runId}-svc-${++seq}`])))).toBe("allowed");
    expect(allowed(await run("service", ...set(id, "stage = 'inspection', inspected_at = null")))).toBe("allowed");
    expect(await row(id)).toMatchObject({ stage: "inspection", inspected_at: null });
    const own = await complete();
    expect(allowed(await run(null, ...set(own, "started_at = null, customer = 'Owner Co', stage = 'inspection', inspected_at = null")))).toBe("allowed");
    expect(await row(own)).toMatchObject({ started_at: null, customer: "Owner Co", stage: "inspection" });
  });

  // ---- C6: INSERT ---------------------------------------------------------------------------------------------------------------
  // Paths that create a job while the request role is authenticated (migrations 033/034/043/058/068/080/135 convert_sales_order, 042 create_job, 076/079/085 import_company_data_run
  // through import_company_data and the SliQ route, direct insert by the owner of the row): none writes started_at or finished_at, so no flag exempts an INSERT. rework (037)
  // creates job_rework rows, not jobs. import_legacy_tenant (supabase/import) runs as the database owner, which the exemption lets through (the owner paths are tested below).
  const insertJob = (org: string, no: string, extra = "", values: unknown[] = []): [string, unknown[]] => [
    `insert into jobs (organization_id, job_no, customer, stage${extra ? ", " + extra.split(" = ")[0] : ""}) values ($1, $2, 'Insert Co', 'machining'${extra ? ", $3" : ""})`, [org, no, ...values]];
  it("10a. C6: a direct browser INSERT of a job with started_at, with finished_at or with both is refused for workshop, office and admin (any value), and creates no row", async () => {
    for (const who of people()) {
      for (const [col, value, hint] of [["started_at", T0, "start_via_rpc"], ["started_at", "2099-01-01T00:00:00Z", "start_via_rpc"], ["finished_at", T1, "finish_via_rpc"], ["finished_at", "2020-01-01T00:00:00Z", "finish_via_rpc"]] as const) {
        const no = `J157-${runId}-ins-${++seq}`;
        expect(refused(await run(who.id, ...insertJob(X.o, no, `${col} = x`, [value]))), `${who.role} ${col} ${value}`).toBe(`42501/${hint}`);
        expect(await q("select id from jobs where job_no = $1", [no])).toEqual([]);
      }
      const both = `J157-${runId}-ins-${++seq}`;
      expect(refused(await run(who.id, `insert into jobs (organization_id, job_no, customer, stage, started_at, finished_at) values ($1, $2, 'Insert Co', 'machining', $3, $4)`, [X.o, both, T0, T1]))).toBe("42501/start_via_rpc");
      expect(await q("select id from jobs where job_no = $1", [both])).toEqual([]);
      // Another company's id does not change that (the trigger answers before row security does).
      expect(refused(await run(who.id, ...insertJob(Y.o, `J157-${runId}-ins-${++seq}`, "started_at = x", [T0])))).toBe("42501/start_via_rpc");
    }
    // The message is the Job Board wording.
    const no = `J157-${runId}-ins-${++seq}`;
    const m1 = await run(X.admin.id, ...insertJob(X.o, no, "started_at = x", [T0]));
    expect(m1.ok ? "" : m1.e.message).toBe(`Job ${no}: a job can't be created with a start time; start it from the Job Board (Play or Start on the bench).`);
    const m2 = await run(X.admin.id, ...insertJob(X.o, no, "finished_at = x", [T0]));
    expect(m2.ok ? "" : m2.e.message).toBe(`Job ${no}: a job can't be created with a finish time; finish it from the Job Board (Finish).`);
  });

  it("10b. C6: every real creating path still works: create_job (admin, office), a direct insert without the times (office, admin), convert_sales_order, import_company_data; the rows come out with no start and no finish", async () => {
    // create_job: the path the New job screen uses.
    for (const who of [X.admin, X.office]) {
      const made = await run(who.id, "select public.create_job($1, 'Made by create_job', false, null, null, '[]'::jsonb, false, '[]'::jsonb, null) as r", [`Create Job Co ${who.role}`]);
      expect(allowed(made)).toBe("allowed");
      const r = (made as { ok: true; rows: Row[] }).rows[0].r as { job_id?: string; id?: string };
      const jid = (r.job_id ?? r.id) as string;
      expect(jid).toBeTruthy();
      expect(pick(await row(jid), ["started_at", "finished_at"])).toEqual({ started_at: null, finished_at: null });
    }
    // A direct insert without the times (a PostgREST insert from the browser) is not touched by the guard.
    for (const who of [X.admin, X.office]) {
      const no = `J157-${runId}-ins-${++seq}`;
      expect(allowed(await run(who.id, ...insertJob(X.o, no)))).toBe("allowed");
      expect(pick((await q("select * from jobs where job_no = $1", [no]))[0], ["started_at", "finished_at"])).toEqual({ started_at: null, finished_at: null });
    }
    // convert_sales_order (135).
    const so = (await q<{ id: string }>("insert into sales_orders (organization_id, so_number, customer_po, customer, total_value, status, order_date) values ($1, $2, $2, 'Convert Co', 480, 'open', '2026-10-09') returning id", [X.o, `PO-157-${runId}-${++seq}`]))[0].id;
    const conv = await run(X.office.id, "select public.convert_sales_order($1) as r", [so]);
    expect(allowed(conv)).toBe("allowed");
    const cj = ((conv as { ok: true; rows: Row[] }).rows[0].r as { job_id: string; created: boolean });
    expect(cj.created).toBe(true);
    expect(pick(await row(cj.job_id), ["started_at", "finished_at"])).toEqual({ started_at: null, finished_at: null });
    // The data import (076/079/085; the SliQ route calls the same function), which sets quoteflow.data_import for its own statements.
    const impNo = `J-IMP-157-${runId}-${++seq}`;
    const imp = await run(X.admin.id, "select public.import_company_data($1::jsonb, false, $2) as r", [JSON.stringify({ jobs: [{ job_no: impNo, customer: "Import Co" }] }), randomUUID()]);
    expect(allowed(imp)).toBe("allowed");
    expect((imp as { ok: true; rows: Row[] }).rows[0].r).toMatchObject({ ok: true });
    expect(pick((await q("select * from jobs where job_no = $1 and organization_id = $2", [impNo, X.o]))[0], ["started_at", "finished_at"])).toEqual({ started_at: null, finished_at: null });
    // Replacement rework (037 open_replacement_rework, finish_job_rework) writes job_rework rows and updates the job; it inserts no job. Tests 4g and 4n run it with 157 installed.
  });

  it("10c. C6: the service role and the database owner still INSERT jobs with start and finish times (the legacy importer's and the platform's paths); the guard changes no row it lets through", async () => {
    const svc = `J157-${runId}-ins-${++seq}`;
    expect(allowed(await run("service", `insert into jobs (organization_id, job_no, customer, stage, started_at, finished_at) values ($1, $2, 'Service Co', 'complete', $3, $4)`, [X.o, svc, T0, T1]))).toBe("allowed");
    expect(pick((await q("select * from jobs where job_no = $1", [svc]))[0], ["started_at", "finished_at"])).toEqual({ started_at: iso(T0), finished_at: iso(T1) });
    const own = `J157-${runId}-ins-${++seq}`;
    expect(allowed(await run(null, `insert into jobs (organization_id, job_no, customer, stage, started_at, finished_at) values ($1, $2, 'Owner Co', 'complete', $3, $4)`, [X.o, own, T0, T1]))).toBe("allowed");
    expect(pick((await q("select * from jobs where job_no = $1", [own]))[0], ["started_at", "finished_at"])).toEqual({ started_at: iso(T0), finished_at: iso(T1) });
    // No session flag lets a browser INSERT carry a time: the import's and the finish's own flags do not (they are for the statements those functions run).
    await rolledBack(async (db) => {
      for (const [flag, value] of [["quoteflow.data_import", X.o], ["tolra.finish_job", "on"], ["tolra.job_start", ""]] as const) {
        await db.query("select set_config($1, $2, true)", [flag, value]);
        const no = `J157-${runId}-ins-${++seq}`;
        expect(refused(await tryIn(db, X.admin.id, ...insertJob(X.o, no, "started_at = x", [T0]))), `${flag}`).toBe("42501/start_via_rpc");
      }
    });
  });

  // ---- Release mechanics --------------------------------------------------------------------------------------------------------
  it("7. release twice = once (nothing changes); rollback twice = once and the four gaps are open again; re-release closes them; verify all true each time", async () => {
    await rolledBack(async (db) => {
      const installed = await state157(db);
      expect(installed.fn).not.toBeNull();
      expect(installed.trg).not.toBeNull();
      await db.query(body(RELEASE));
      expect(await state157(db)).toEqual(installed);
      expect((await verifyRows(db)).filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
      expect((await preflightRows(db)).find((r) => r.check === MARKER)?.value).toBe("applied");
      const smrInstalled = await smrState(db);
      expect(smrInstalled.sum).toBe(SMR_157_MD5);

      await db.query(body(ROLLBACK));
      await db.query(body(ROLLBACK));
      expect(await state157(db)).toEqual({ fn: null, trg: null });
      // 049's start_machine_run is back byte for byte, with the same definer flag, settings, grants and arguments as with 157 in place.
      const smrBack = await smrState(db);
      expect(smrBack.src).toBe(body049());
      expect(smrBack.sum).toBe(SMR_049_MD5);
      expect({ ...smrBack, src: "", sum: "" }).toEqual({ ...smrInstalled, src: "", sum: "" });
      expect((await preflightRows(db)).find((r) => r.check === MARKER)?.value).toBe("not applied");
      expect((await preflightRows(db)).find((r) => r.check.startsWith("157 needs:"))?.value).toBe("0 / absent / absent / 049");
      // With it gone the old behaviour is back: the start can be replaced, the finish set by editing, the pass withdrawn by the workshop, the customer changed.
      const id = await db.query("insert into jobs (organization_id, job_no, customer, stage, started_at, finished_at, inspected_at, inspected_by, quantity_required) values ($1, $2, 'Gone Co', 'complete', $3, $4, $4, 'Inspector', 10) returning id",
        [X.o, `J157-${runId}-rb-${++seq}`, T0, T1]).then((r) => r.rows[0].id as string);
      expect(allowed(await tryIn(db, X.workshop.id, "update jobs set started_at = $2 where id = $1", [id, T1]))).toBe("allowed");
      expect(allowed(await tryIn(db, X.workshop.id, "update jobs set customer = 'Else' where id = $1", [id]))).toBe("allowed");
      expect(allowed(await tryIn(db, X.workshop.id, "update jobs set improvement_comments = 'x' where id = $1", [id]))).toBe("allowed");
      // ... a direct first start by editing the job, and a job created with a start or finish time by a browser, work as before 157; start_machine_run still starts a job.
      const unstarted = await db.query("insert into jobs (organization_id, job_no, customer, stage, quantity_required) values ($1, $2, 'Gone Co', 'machining', 10) returning id", [X.o, `J157-${runId}-rb-${++seq}`]).then((r) => r.rows[0].id as string);
      expect(allowed(await tryIn(db, X.workshop.id, "update jobs set started_at = $2 where id = $1", [unstarted, T0]))).toBe("allowed");
      expect(allowed(await tryIn(db, X.admin.id, "insert into jobs (organization_id, job_no, customer, stage, started_at, finished_at) values ($1, $2, 'Gone Co', 'inspection', $3, $4)", [X.o, `J157-${runId}-rb-${++seq}`, T0, T1]))).toBe("allowed");
      const viaRpc = await db.query("insert into jobs (organization_id, job_no, customer, stage, quantity_required) values ($1, $2, 'Gone Co', 'machining', 10) returning id", [X.o, `J157-${runId}-rb-${++seq}`]).then((r) => r.rows[0].id as string);
      expect(allowed(await tryIn(db, X.workshop.id, "select public.start_machine_run($1, '{}'::uuid[], null, null, false, null, null, true) as r", [viaRpc]))).toBe("allowed");
      expect((await db.query("select started_at is not null as s from jobs where id = $1", [viaRpc])).rows[0].s).toBe(true);
      expect(await db.query("select stage, inspected_at from jobs where id = $1", [id]).then((r) => r.rows[0])).toMatchObject({ stage: "inspection", inspected_at: null });
      const openJob = await db.query("insert into jobs (organization_id, job_no, customer, stage, quantity_required) values ($1, $2, 'Gone Co', 'machining', 10) returning id", [X.o, `J157-${runId}-rb-${++seq}`]).then((r) => r.rows[0].id as string);
      expect(allowed(await tryIn(db, X.workshop.id, "update jobs set finished_at = $2 where id = $1", [openJob, T1]))).toBe("allowed");

      await db.query(body(RELEASE));
      const again = await state157(db);
      expect(again.fn).not.toBeNull();
      expect(again.trg).not.toBeNull();
      const v = await verifyRows(db);
      expect(v).toHaveLength(8);
      expect(v.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
      expect((await preflightRows(db)).find((r) => r.check === MARKER)?.value).toBe("applied");
      expect((await smrState(db)).sum).toBe(SMR_157_MD5);
      const j2 = await db.query("insert into jobs (organization_id, job_no, customer, stage, started_at, quantity_required) values ($1, $2, 'Back Co', 'machining', $3, 10) returning id", [X.o, `J157-${runId}-rb-${++seq}`, T0]).then((r) => r.rows[0].id as string);
      expect(refused(await tryIn(db, X.workshop.id, "update jobs set started_at = $2 where id = $1", [j2, T1]))).toBe("42501/start_kept");
      const j3 = await db.query("insert into jobs (organization_id, job_no, customer, stage, quantity_required) values ($1, $2, 'Back Co', 'machining', 10) returning id", [X.o, `J157-${runId}-rb-${++seq}`]).then((r) => r.rows[0].id as string);
      expect(refused(await tryIn(db, X.workshop.id, "update jobs set started_at = $2 where id = $1", [j3, T1]))).toBe("42501/start_via_rpc");
      expect(refused(await tryIn(db, X.admin.id, "insert into jobs (organization_id, job_no, customer, stage, started_at) values ($1, $2, 'Back Co', 'machining', $3)", [X.o, `J157-${runId}-rb-${++seq}`, T0]))).toBe("42501/start_via_rpc");
      expect(allowed(await tryIn(db, X.workshop.id, "select public.start_machine_run($1, '{}'::uuid[], null, null, false, null, null, true) as r", [j3]))).toBe("allowed");
    });
  });

  it("8. the release refuses, changing nothing, when a name is taken by something that is not 157's or a job lock it relies on is missing; the rollback refuses the same name clash", async () => {
    // A different function already named jobs_integrity_guard.
    await rolledBack(async (db) => {
      await db.query(body(ROLLBACK));
      await db.query("create function public.jobs_integrity_guard() returns trigger language plpgsql as $$ begin return new; end $$");
      await db.query("savepoint s");
      const e = await db.query(body(RELEASE)).then(() => null, (x: Err) => x);
      expect(e?.hint).toBe("jobs_integrity_name_taken");
      expect(e?.message).toContain("is not 157's");
      await db.query("rollback to savepoint s");
      const f = await db.query(body(ROLLBACK)).then(() => null, (x: Err) => x);
      expect(f?.message).toContain("157 rollback: public.jobs_integrity_guard() is not 157's");
    });
    // A different trigger already named jobs_zzz_integrity_guard (a column-limited one that would never see a stage move).
    await rolledBack(async (db) => {
      await db.query(body(ROLLBACK));
      await db.query("create function public.jobs_integrity_guard() returns trigger language plpgsql as $$ begin return new; end $$");
      await db.query("create trigger jobs_zzz_integrity_guard before update of customer on public.jobs for each row execute function public.jobs_integrity_guard()");
      await db.query("savepoint s");
      const e = await db.query(body(RELEASE)).then(() => null, (x: Err) => x);
      expect(e?.hint).toBe("jobs_integrity_name_taken");
      await db.query("rollback to savepoint s");
    });
    // A job lock it relies on is missing, or a workflow no longer names its flag.
    await rolledBack(async (db) => {
      await db.query(body(ROLLBACK));
      await db.query("drop trigger ad_finish_kept on public.jobs");
      const pre = (await preflightRows(db)).find((r) => r.check.startsWith("157 needs:"))?.value;
      expect(pre).toBe("1 / absent / absent / 049");
      await db.query("savepoint s");
      const e = await db.query(body(RELEASE)).then(() => null, (x: Err) => x);
      expect(e?.hint).toBe("jobs_integrity_prerequisite");
      expect(e?.message).toContain("trigger ad_finish_kept");
      await db.query("rollback to savepoint s");
      expect(await state157(db)).toEqual({ fn: null, trg: null });
    });
    await rolledBack(async (db) => {
      await db.query(body(ROLLBACK));
      await db.query("create or replace function public.finish_job(p_job uuid, p_client_op_id uuid, p_finished_at timestamptz) returns jsonb language sql as $$ select '{}'::jsonb $$");
      await db.query("savepoint s");
      const e = await db.query(body(RELEASE)).then(() => null, (x: Err) => x);
      expect(e?.hint).toBe("jobs_integrity_prerequisite");
      expect(e?.message).toContain("function finish_job naming tolra.finish_job");
      await db.query("rollback to savepoint s");
    });
  });

  it("8b. the release refuses, changing nothing, when start_machine_run is neither 049's nor 157's; the rollback refuses the same body while 157 is installed", async () => {
    const foreign = `create or replace function public.start_machine_run(p_job uuid, p_machines uuid[], p_client_op_id uuid, p_started_at timestamptz, p_override boolean, p_reason text, p_paused_ack jsonb default null, p_bench boolean default null)
      returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $$ begin return '{}'::jsonb; end $$`;
    await rolledBack(async (db) => {
      await db.query(body(ROLLBACK));
      await db.query(foreign);
      await db.query("savepoint s");
      const e = await db.query(body(RELEASE)).then(() => null, (x: Err) => x);
      expect(e?.hint).toBe("jobs_integrity_prerequisite");
      expect(e?.message).toContain("start_machine_run is neither 049's nor 157's");
      await db.query("rollback to savepoint s");
      expect(await state157(db)).toEqual({ fn: null, trg: null });
    });
    await rolledBack(async (db) => {
      await db.query(foreign);
      await db.query("savepoint s");
      const f = await db.query(body(ROLLBACK)).then(() => null, (x: Err) => x);
      expect(f?.message).toContain("157 rollback: public.start_machine_run is neither 157's nor 049's");
      await db.query("rollback to savepoint s");
      expect((await state157(db)).trg).not.toBeNull();
    });
    // The release also refuses when a trigger of the old shape (BEFORE UPDATE only, tgtype 19) holds the name.
    await rolledBack(async (db) => {
      await db.query(body(ROLLBACK));
      await db.query("create function public.jobs_integrity_guard() returns trigger language plpgsql as $$ begin return new; end $$");
      await db.query("create trigger jobs_zzz_integrity_guard before update on public.jobs for each row execute function public.jobs_integrity_guard()");
      await db.query("savepoint s");
      const e = await db.query(body(RELEASE)).then(() => null, (x: Err) => x);
      expect(e?.hint).toBe("jobs_integrity_name_taken");
      await db.query("rollback to savepoint s");
    });
  });

  it("9. release and rollback change no other function, trigger, policy or grant: the other triggers, policies and function bodies are identical before and after", async () => {
    const fingerprint = async (db: PoolClient) => (await db.query(`select
      (select md5(coalesce(string_agg(t.tgname || pg_get_triggerdef(t.oid), E'\\n' order by t.tgname), '')) from pg_trigger t where t.tgrelid = 'public.jobs'::regclass and not t.tgisinternal and t.tgname <> 'jobs_zzz_integrity_guard') as triggers,
      (select md5(coalesce(string_agg(p.polname || p.polcmd::text || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), E'\\n' order by p.polname), '')) from pg_policy p where p.polrelid = 'public.jobs'::regclass) as policies,
      (select md5(coalesce(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || coalesce(p.proacl::text, ''), E'\\n' order by p.oid::regprocedure::text), '')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname not in ('jobs_integrity_guard', 'start_machine_run')) as functions,
      (select coalesce(relacl::text, '') from pg_class where oid = 'public.jobs'::regclass) as grants`)).rows[0];
    await rolledBack(async (db) => {
      const start = await fingerprint(db);
      const installed = await smrState(db);
      await db.query(body(ROLLBACK));
      expect(await fingerprint(db)).toEqual(start);
      const original = await smrState(db);
      await db.query(body(RELEASE));
      expect(await fingerprint(db)).toEqual(start);
      const after = await smrState(db);
      // Exactly jobs_integrity_guard added and start_machine_run changed by the two marker lines: nothing else in public differs (above); start_machine_run keeps its
      // signature, definer flag, settings and grants; its body is 049's (the migration's text) plus the two statements around its own update of the job's start time.
      expect(original.src).toBe(body049());
      expect(original.sum).toBe(SMR_049_MD5);
      expect(after.sum).toBe(SMR_157_MD5);
      expect(after.src).toBe(installed.src);
      expect({ ...after, src: "", sum: "" }).toEqual({ ...original, src: "", sum: "" });
      expect(after.n).toBe(1);
      const was = original.src.split("\n");
      const now = after.src.split("\n");
      expect(now).toHaveLength(was.length + 2);
      const at = now.findIndex((l) => l.trim() === FIRST_START);
      expect(at).toBeGreaterThan(0);
      expect(now[at - 1].trim()).toBe(MARK_ON);
      expect(now[at + 1].trim()).toBe(MARK_OFF);
      expect(now.filter((_, i) => i !== at - 1 && i !== at + 1)).toEqual(was);
      expect(now.filter((l) => l.includes("tolra.job_start"))).toHaveLength(2);
      expect(was.filter((l) => l.includes("tolra.job_start"))).toHaveLength(0);
    });
  });
});
