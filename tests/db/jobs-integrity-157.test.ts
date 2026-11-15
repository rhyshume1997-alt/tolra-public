/**
 * Release 157 (supabase/release/157_jobs_integrity_guard.release.sql, phase 157 after 156): the trigger jobs_zzz_integrity_guard on public.jobs.
 * The DB proof, below PostgREST: every refusal is paired with the authorised path that must still work.
 *
 * Inputs: the disposable Supabase stack (TEST_DATABASE_URL, isolation-checked); the post-144 fixture installs 145..157. Every statement runs as
 * PostgREST would run it: its own transaction, role authenticated (or service_role) with the person's JWT claims, so the real triggers, RLS and
 * definer functions answer. Jobs are made by the database owner (an exempt path, as the importer is). Companies are synthetic (slug t-<run>-...)
 * and removed afterwards by destroySyntheticWorld. Release, rollback and re-release run inside transactions that are always rolled back.
 * Proves: C1 a recorded start (and who started it) is never changed or cleared by editing the job; C4 a finish time is set only by finish_job;
 * C3 a workshop-only user cannot change customer or job number; C2/P1 a workshop-only user cannot withdraw a passed inspection (Complete,
 * despatched or invoiced job) unless record_job_inspection, fail_job_inspection, rework or reopen names the job; admin and office are unchanged;
 * drawing-revision behaviour; another company and the service role; release, repeat install, verify, rollback, re-release.
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

type JobOver = { stage?: string; started_at?: string | null; finished_at?: string | null; inspected_at?: string | null; started_by?: string | null; customer?: string | null };
/** A job made by the database owner (an exempt path, as the importer is). */
async function job(over: JobOver = {}, org = X.o): Promise<string> {
  const v = { stage: "machining", started_at: null, finished_at: null, inspected_at: null, started_by: null, customer: "Integrity Co", ...over };
  return (await q<{ id: string }>(
    `insert into jobs (organization_id, job_no, customer, stage, started_at, finished_at, inspected_at, inspected_by, started_by, quantity_required)
     values ($1, $2, $3, $4, $5, $6, $7, case when $7::timestamptz is null then null else 'Inspector' end, $8, 10) returning id`,
    [org, `J157-${runId}-${++seq}`, v.customer, v.stage, v.started_at, v.finished_at, v.inspected_at, v.started_by]))[0].id;
}
const open = (over: JobOver = {}) => job({ started_at: T0, started_by: X.workshop.id, ...over });
const finished = (over: JobOver = {}) => job({ stage: "inspection", started_at: T0, started_by: X.workshop.id, finished_at: T1, ...over });
const complete = (over: JobOver = {}) => job({ stage: "complete", started_at: T0, started_by: X.workshop.id, finished_at: T1, inspected_at: T1, ...over });
const row = async (id: string) => (await q("select * from jobs where id = $1", [id]))[0];
const pick = (r: Row, keys: string[]) => Object.fromEntries(keys.map((k) => [k, r[k] instanceof Date ? (r[k] as Date).toISOString() : r[k]]));
const iso = (s: string) => new Date(s).toISOString();
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
    expect(v).toHaveLength(7);
    expect(v.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
    const pre = await preflightRows();
    expect(pre.find((r) => r.check === MARKER)?.value).toBe("applied");
    expect(pre.find((r) => r.check.startsWith("157 needs:"))?.value).toBe("0 / 157 / 157");
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

  it("1b. C1: the first start (from empty) still works and records who started it; the same value written again is not a change; then it is kept", async () => {
    const id = await job({ started_at: null });
    expect(allowed(await run(X.workshop.id, ...set(id, "started_at = $2", [T0])))).toBe("allowed");
    const r = await row(id);
    expect(iso(String(r.started_at))).toBe(iso(T0));
    expect(r.started_by).toBe(X.workshop.id);
    expect(allowed(await run(X.office.id, ...set(id, "started_at = started_at, description = 'same start'")))).toBe("allowed");
    expect(refused(await run(X.office.id, ...set(id, "started_at = $2", [T1])))).toBe("42501/start_kept");
    expect((await row(id)).started_by).toBe(X.workshop.id);
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
    expect(iso(done.finished_at)).toBe(iso(String(finishedRow.finished_at)));
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
    expect(refused(await run(X.workshop.id, ...set(id, "improvement_comments = 'Use a sharper insert next time'")))).toBe("42501/inspection_kept");
    expect(refused(await run(X.workshop.id, ...set(id, "quantity_required = 12")))).toBe("42501/inspection_kept");
    expect(refused(await run(X.workshop.id, ...set(id, "stage = 'inspection'")))).toBe("42501/inspection_kept");
    expect(refused(await run(X.workshop.id, ...set(id, "stage = 'machining', improvement_comments = 'x'")))).toBe("42501/inspection_kept");
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

      await db.query(body(ROLLBACK));
      await db.query(body(ROLLBACK));
      expect(await state157(db)).toEqual({ fn: null, trg: null });
      expect((await preflightRows(db)).find((r) => r.check === MARKER)?.value).toBe("not applied");
      expect((await preflightRows(db)).find((r) => r.check.startsWith("157 needs:"))?.value).toBe("0 / absent / absent");
      // With it gone the old behaviour is back: the start can be replaced, the finish set by editing, the pass withdrawn by the workshop, the customer changed.
      const id = await db.query("insert into jobs (organization_id, job_no, customer, stage, started_at, finished_at, inspected_at, inspected_by, quantity_required) values ($1, $2, 'Gone Co', 'complete', $3, $4, $4, 'Inspector', 10) returning id",
        [X.o, `J157-${runId}-rb-${++seq}`, T0, T1]).then((r) => r.rows[0].id as string);
      expect(allowed(await tryIn(db, X.workshop.id, "update jobs set started_at = $2 where id = $1", [id, T1]))).toBe("allowed");
      expect(allowed(await tryIn(db, X.workshop.id, "update jobs set customer = 'Else' where id = $1", [id]))).toBe("allowed");
      expect(allowed(await tryIn(db, X.workshop.id, "update jobs set improvement_comments = 'x' where id = $1", [id]))).toBe("allowed");
      expect(await db.query("select stage, inspected_at from jobs where id = $1", [id]).then((r) => r.rows[0])).toMatchObject({ stage: "inspection", inspected_at: null });
      const openJob = await db.query("insert into jobs (organization_id, job_no, customer, stage, quantity_required) values ($1, $2, 'Gone Co', 'machining', 10) returning id", [X.o, `J157-${runId}-rb-${++seq}`]).then((r) => r.rows[0].id as string);
      expect(allowed(await tryIn(db, X.workshop.id, "update jobs set finished_at = $2 where id = $1", [openJob, T1]))).toBe("allowed");

      await db.query(body(RELEASE));
      const again = await state157(db);
      expect(again.fn).not.toBeNull();
      expect(again.trg).not.toBeNull();
      const v = await verifyRows(db);
      expect(v).toHaveLength(7);
      expect(v.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
      expect((await preflightRows(db)).find((r) => r.check === MARKER)?.value).toBe("applied");
      const j2 = await db.query("insert into jobs (organization_id, job_no, customer, stage, started_at, quantity_required) values ($1, $2, 'Back Co', 'machining', $3, 10) returning id", [X.o, `J157-${runId}-rb-${++seq}`, T0]).then((r) => r.rows[0].id as string);
      expect(refused(await tryIn(db, X.workshop.id, "update jobs set started_at = $2 where id = $1", [j2, T1]))).toBe("42501/start_kept");
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
      expect(pre).toBe("1 / absent / absent");
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

  it("9. release and rollback change no other function, trigger, policy or grant: the other triggers, policies and function bodies are identical before and after", async () => {
    const fingerprint = async (db: PoolClient) => (await db.query(`select
      (select md5(coalesce(string_agg(t.tgname || pg_get_triggerdef(t.oid), E'\\n' order by t.tgname), '')) from pg_trigger t where t.tgrelid = 'public.jobs'::regclass and not t.tgisinternal and t.tgname <> 'jobs_zzz_integrity_guard') as triggers,
      (select md5(coalesce(string_agg(p.polname || p.polcmd::text || coalesce(pg_get_expr(p.polqual, p.polrelid), '') || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), E'\\n' order by p.polname), '')) from pg_policy p where p.polrelid = 'public.jobs'::regclass) as policies,
      (select md5(coalesce(string_agg(p.oid::regprocedure::text || md5(p.prosrc) || coalesce(p.proacl::text, ''), E'\\n' order by p.oid::regprocedure::text), '')) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname <> 'jobs_integrity_guard') as functions,
      (select coalesce(relacl::text, '') from pg_class where oid = 'public.jobs'::regclass) as grants`)).rows[0];
    await rolledBack(async (db) => {
      const start = await fingerprint(db);
      await db.query(body(ROLLBACK));
      expect(await fingerprint(db)).toEqual(start);
      await db.query(body(RELEASE));
      expect(await fingerprint(db)).toEqual(start);
    });
  });
});
