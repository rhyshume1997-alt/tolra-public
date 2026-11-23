/**
 * Release 170 (supabase/release/170_worksheet_custom.release.sql, phase 170 after 167): jobs.worksheet_custom and the trigger
 * jobs_worksheet_custom_lock on public.jobs, for the worksheet builder's per-job custom fields. The DB proof, below PostgREST.
 *
 * Inputs: the disposable Supabase stack (TEST_DATABASE_URL, isolation-checked); the post-144 fixture installs 145..170. Every statement runs as
 * PostgREST would run it: its own transaction, role authenticated (or service_role) with the person's JWT claims, so the real triggers, RLS and
 * definer functions answer. Jobs and the sign-off records are made by the database owner (an exempt path). Companies are synthetic (slug t-<run>-...)
 * and removed afterwards by destroySyntheticWorld. Release, repeat install, rollback and re-release run inside transactions that are always rolled back.
 * Proves: every job gets {} and nothing else about a job changes; admin, office and workshop fill in the custom fields of an unsigned job; a primary
 * sign-off on the job's CURRENT revision locks the custom values for every browser role at the database (42501, hint signed_off_custom_locked) while
 * writing the same value back is allowed; a newer revision (the worksheet edited since the sign-off) unlocks it; the owner and the service role are exempt;
 * another company's person cannot reach the job; a custom value never raises worksheet_version, withdraws a passed inspection or touches the sign-off;
 * an array, an oversize value and NULL are refused; the trigger function cannot be called from the browser; verify, release preflight, repeat install,
 * rollback (refuses while a job holds a value, drops exactly the four objects otherwise) and re-release.
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
const slug = (label: string) => `t-${runId}-p170-${label}-${++seq}`;
const email = (label: string) => `${label}-${++seq}.${runId}@${EMAIL_DOMAIN}`;
const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const RELEASE = "supabase/release/170_worksheet_custom.release.sql";
const ROLLBACK = "supabase/release/170_worksheet_custom.rollback.sql";
const VERIFY = "supabase/verify/worksheet_custom_170.sql";
const PREFLIGHT = "supabase/verify/release_preflight.sql";
const MARKER = "post-144 marker 170 worksheet_custom";
const FN = "public.jobs_worksheet_custom_lock()";
const FN_MD5 = "a7d2d5df942ae0fc369d15d7bd7ee21c";
const T0 = "2026-10-01T08:00:00Z";
const T1 = "2026-10-02T08:00:00Z";
const VALUES = JSON.stringify({ v: 1, ticks: { "customTick-a1b2c3": true }, texts: { "customText-d4e5f6": "Batch B-778" } });
const OTHER = JSON.stringify({ v: 1, ticks: { "customTick-a1b2c3": false }, texts: { "customText-d4e5f6": "Batch B-779" } });

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
/** A release or rollback file without its own BEGIN / COMMIT, to run inside a test transaction that is rolled back. */
function body(file: string) {
  const s = read(file);
  expect(s.match(/^BEGIN;$/gm), file).toHaveLength(1);
  expect(s.match(/^COMMIT;$/gm), file).toHaveLength(1);
  return s.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
}
async function preflightRows() {
  return (await q(read(PREFLIGHT))) as { check: string; value: string }[];
}
async function verifyRows(db?: PoolClient) {
  const rows = db ? (await db.query(read(VERIFY))).rows : await q(read(VERIFY));
  return rows as { check_name: string; ok: boolean }[];
}
/** The four objects 170 adds, and the function's whitespace-stripped body fingerprint. */
const state170 = async (db: PoolClient) => (await db.query(`select
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = 'worksheet_custom') as col,
  exists (select 1 from pg_constraint where conrelid = 'public.jobs'::regclass and conname = 'jobs_worksheet_custom_shape') as con,
  (select md5(regexp_replace(prosrc, '\\s', '', 'g')) from pg_proc where oid = to_regprocedure('${FN}')) as fn,
  exists (select 1 from pg_trigger where tgrelid = 'public.jobs'::regclass and tgname = 'jobs_worksheet_custom_lock') as trg`)).rows[0] as { col: boolean; con: boolean; fn: string | null; trg: boolean };

// ---- Synthetic companies, people and jobs --------------------------------------------------------------------------------------------
async function makeCompany() {
  const o = randomUUID();
  await q("insert into organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [o, `Synthetic p170 ${o.slice(0, 8)}`, slug("co")]);
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
let Y: { o: string; admin: Person };

/** A job made by the database owner (an exempt path, as the importer is). */
async function job(over: { stage?: string; started_at?: string | null; finished_at?: string | null; inspected_at?: string | null } = {}, org = X.o): Promise<string> {
  const v = { stage: "machining", started_at: null, finished_at: null, inspected_at: null, ...over };
  return (await q<{ id: string }>(
    `insert into jobs (organization_id, job_no, customer, stage, started_at, finished_at, inspected_at, inspected_by, started_by, quantity_required, description, checklist)
     values ($1, $2, 'Custom Co', $3, $4, $5, $6, case when $6::timestamptz is null then null else 'Inspector' end, case when $4::timestamptz is null then null else $7::uuid end, 10, 'Brackets', '{"sizes_checked": true}'::jsonb) returning id`,
    [org, `J170-${runId}-${++seq}`, v.stage, v.started_at, v.finished_at, v.inspected_at, X?.workshop?.id ?? null]))[0].id;
}
const complete = () => job({ stage: "complete", started_at: T0, finished_at: T1, inspected_at: T1 });
const row = async (id: string) => (await q("select * from jobs where id = $1", [id]))[0];
const withoutCustom = (r: Row) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "worksheet_custom").map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]));
/** A primary sign-off on the job's CURRENT revision (written by the owner: nobody signs through the API except sign_off_job). */
async function signOff(id: string, over: { version?: number; org?: string } = {}) {
  const j = await row(id);
  await q(`insert into job_signoffs (organization_id, job_id, worksheet_version, snapshot, snapshot_sha256, record_sha256, initials, signer_name, signed_on, signature_kind, signature_data, signed_by, kind)
           values ($1, $2, $3, '{}'::jsonb, repeat('a', 64), repeat('b', 64), 'RH', 'Rita Hale', current_date, 'typed', 'Rita Hale', $4, 'primary')`,
    [over.org ?? X.o, id, over.version ?? j.worksheet_version, X.admin.id]);
}
const setCustom = (sub: string | "service" | null, id: string, value: string) => run(sub, "update jobs set worksheet_custom = $2::jsonb where id = $1", [id, value]);
const people = (): Person[] => [X.workshop, X.office, X.admin];

describe("release 170: jobs.worksheet_custom and its sign-off guard", () => {
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

  it("0. verify says true on every row, release preflight says applied, and the objects are the ones the release names", async () => {
    const v = await verifyRows();
    expect(v).toHaveLength(8);
    expect(v.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
    const pre = await preflightRows();
    expect(pre.find((r) => r.check === MARKER)?.value).toBe("applied");
    expect(pre.find((r) => r.check.startsWith("170 needs:"))?.value).toBe("true / 170");
    const s = await q<{ col: string; def: string | null; nullable: string; type: string }>(`select 'x' as col, column_default as def, is_nullable as nullable, data_type as type from information_schema.columns where table_schema = 'public' and table_name = 'jobs' and column_name = 'worksheet_custom'`);
    expect(s).toEqual([{ col: "x", def: "'{}'::jsonb", nullable: "NO", type: "jsonb" }]);
    expect((await q<{ md5: string }>(`select md5(regexp_replace(prosrc, '\\s', '', 'g')) as md5 from pg_proc where oid = to_regprocedure('${FN}')`))[0].md5).toBe(FN_MD5);
    // Not callable from the browser (a trigger function), and the grants name no browser role.
    expect(await q<{ a: boolean; b: boolean; c: boolean }>(`select has_function_privilege('authenticated', '${FN}', 'EXECUTE') as a, has_function_privilege('anon', '${FN}', 'EXECUTE') as b, has_function_privilege('public', '${FN}', 'EXECUTE') as c`)).toEqual([{ a: false, b: false, c: false }]);
    const direct = await run(X.admin.id, `select ${FN.replace("()", "")}()`);
    expect(refused(direct)).toBe("42501/-");
  });

  it("1. a job made through any path has {}, and filling in the custom fields changes nothing else about it, not even worksheet_version", async () => {
    const id = await job();
    expect((await row(id)).worksheet_custom).toEqual({});
    for (const p of people()) {
      const before = withoutCustom(await row(id));
      expect(allowed(await setCustom(p.id, id, VALUES))).toBe("allowed");
      const after = await row(id);
      expect(after.worksheet_custom).toEqual(JSON.parse(VALUES));
      expect(withoutCustom(after)).toEqual(before);
      expect(allowed(await setCustom("service", id, "{}"))).toBe("allowed");
    }
  });

  it("2. a custom value never raises the revision, withdraws a passed inspection or changes the checklist", async () => {
    const id = await complete();
    const before = await row(id);
    // Admin and office edit a Complete job that has not gone out (a workshop user cannot, and is not asked to here: 157 C2 is proved in its own file).
    for (const p of [X.office, X.admin]) {
      expect(allowed(await setCustom(p.id, id, p.role === "admin" ? VALUES : OTHER))).toBe("allowed");
      const after = await row(id);
      expect(after.worksheet_version).toBe(before.worksheet_version);
      expect(after.stage).toBe("complete");
      expect(after.inspected_at).toEqual(before.inspected_at);
      expect(after.checklist).toEqual({ sizes_checked: true });
    }
  });

  it("3. a primary sign-off on the current revision locks the custom values for every browser role, at the database", async () => {
    const id = await job({ stage: "inspection", started_at: T0, finished_at: T1 });
    expect(allowed(await setCustom(X.workshop.id, id, VALUES))).toBe("allowed");
    await signOff(id);
    const before = await row(id);
    for (const p of people()) expect(refused(await setCustom(p.id, id, OTHER)), p.role).toBe("42501/signed_off_custom_locked");
    expect(refused(await run(X.admin.id, "update jobs set worksheet_custom = '{}'::jsonb where id = $1", [id]))).toBe("42501/signed_off_custom_locked");
    expect((await row(id)).worksheet_custom).toEqual(JSON.parse(VALUES));
    expect(await row(id)).toEqual(before);
    // Writing the same value back is not a change.
    for (const p of people()) expect(allowed(await setCustom(p.id, id, VALUES)), p.role).toBe("allowed");
    // The message names the job and says why, and nothing else.
    const o = await setCustom(X.office.id, id, OTHER);
    expect(!o.ok && o.e.message).toMatch(/signed off, so its custom fields cannot be changed/);
  });

  it("4. the owner and the service role are exempt (importer, support and the SQL editor still work); a sign-off of another revision does not lock", async () => {
    const id = await job({ stage: "inspection", started_at: T0, finished_at: T1 });
    await signOff(id);
    expect(allowed(await setCustom(null, id, OTHER))).toBe("allowed");
    expect(allowed(await setCustom("service", id, VALUES))).toBe("allowed");
    // A sign-off recorded against an older revision does not lock the current one.
    const j2 = await job({ stage: "inspection", started_at: T0, finished_at: T1 });
    await q("update jobs set description = 'Changed once' where id = $1", [j2]);
    const v = (await row(j2)).worksheet_version as number;
    expect(v).toBeGreaterThan(0);
    await signOff(j2, { version: v - 1 });
    for (const p of people()) expect(allowed(await setCustom(p.id, j2, p.role === "admin" ? VALUES : OTHER)), p.role).toBe("allowed");
  });

  it("5. editing the worksheet after the sign-off (a newer revision) unlocks the custom values, and signing again locks them again", async () => {
    const id = await job({ stage: "inspection", started_at: T0, finished_at: T1 });
    await signOff(id);
    expect(refused(await setCustom(X.admin.id, id, VALUES))).toBe("42501/signed_off_custom_locked");
    expect(allowed(await run(X.admin.id, "update jobs set description = 'Revised' where id = $1", [id]))).toBe("allowed");
    const v = (await row(id)).worksheet_version as number;
    expect(allowed(await setCustom(X.workshop.id, id, VALUES))).toBe("allowed");
    expect((await row(id)).worksheet_version).toBe(v);
    await signOff(id);
    expect(refused(await setCustom(X.workshop.id, id, OTHER))).toBe("42501/signed_off_custom_locked");
  });

  it("6. another company's person cannot reach the job, and another company's sign-off locks nothing here", async () => {
    const id = await job();
    const r = await setCustom(Y.admin.id, id, VALUES);
    expect(r.ok && r.count).toBe(0);
    expect((await row(id)).worksheet_custom).toEqual({});
    const yJob = await job({}, Y.o);
    await signOff(yJob, { org: Y.o });
    expect(allowed(await setCustom(X.admin.id, id, VALUES))).toBe("allowed");
  });

  it("7. an array, an oversize value and NULL are refused by the table, whatever the role", async () => {
    const id = await job();
    expect((await setCustom(X.admin.id, id, "[]")).ok).toBe(false);
    expect(refused(await setCustom(X.admin.id, id, "[]"))).toBe("23514/-");
    expect(refused(await setCustom(X.workshop.id, id, JSON.stringify({ t: "x".repeat(21000) })))).toBe("23514/-");
    expect(refused(await run(X.admin.id, "update jobs set worksheet_custom = null where id = $1", [id]))).toBe("23502/-");
    expect(refused(await run(null, "update jobs set worksheet_custom = '\"text\"'::jsonb where id = $1", [id]))).toBe("23514/-");
    expect((await row(id)).worksheet_custom).toEqual({});
  });

  it("8. repeat install changes nothing; rollback refuses while a job holds a value and drops exactly the four objects otherwise; re-release restores them", async () => {
    const held = await job();
    await setCustom("service", held, VALUES);
    await rolledBack(async (db) => {
      const before = await state170(db);
      expect(before).toEqual({ col: true, con: true, fn: FN_MD5, trg: true });
      // Repeat install: INSTALLED, so nothing changes (the self-check compares everything else before and after).
      await db.query(body(RELEASE));
      expect(await state170(db)).toEqual(before);
      expect((await verifyRows(db)).every((r) => r.ok === true)).toBe(true);
      // Rollback refuses while a job holds a custom value, and changes nothing.
      await db.query("savepoint s");
      await expect(db.query(body(ROLLBACK))).rejects.toMatchObject({ message: expect.stringMatching(/job\(s\) hold custom worksheet values/) });
      await db.query("rollback to savepoint s");
      expect(await state170(db)).toEqual(before);
      expect((await db.query("select worksheet_custom from jobs where id = $1", [held])).rows[0].worksheet_custom).toEqual(JSON.parse(VALUES));
      // With no value held, it drops exactly the four objects.
      await db.query("update jobs set worksheet_custom = '{}'::jsonb where worksheet_custom <> '{}'::jsonb");
      await db.query(body(ROLLBACK));
      expect(await state170(db)).toEqual({ col: false, con: false, fn: null, trg: false });
      expect((await db.query("select count(*)::int as n from pg_proc where pronamespace = 'public'::regnamespace and proname = 'jobs_worksheet_custom_lock'")).rows[0].n).toBe(0);
      expect((await db.query("select description, checklist from jobs where id = $1", [held])).rows).toEqual([{ description: "Brackets", checklist: { sizes_checked: true } }]);
      // Rollback again is a no-op; the release puts everything back, and a worksheet save still works in between.
      await db.query(body(ROLLBACK));
      await db.query(body(RELEASE));
      expect(await state170(db)).toEqual(before);
      expect((await verifyRows(db)).every((r) => r.ok === true)).toBe(true);
      expect((await db.query("select count(*)::int as n from jobs where worksheet_custom <> '{}'::jsonb")).rows[0].n).toBe(0);
    });
    // Rolled back: the database is as it was, with the value still held.
    expect((await row(held)).worksheet_custom).toEqual(JSON.parse(VALUES));
    expect(allowed(await setCustom("service", held, "{}"))).toBe("allowed");
  });

  it("9. a drifted function or column makes the release refuse and change nothing", async () => {
    await rolledBack(async (db) => {
      await db.query(`create or replace function ${FN} returns trigger language plpgsql as $$ begin return new; end $$`);
      await db.query("savepoint s");
      await expect(db.query(body(RELEASE))).rejects.toMatchObject({ message: expect.stringMatching(/not exactly 170's/) });
      await db.query("rollback to savepoint s");
      await db.query("savepoint s2");
      await expect(db.query(body(ROLLBACK))).rejects.toMatchObject({ message: expect.stringMatching(/not 170's/) });
      await db.query("rollback to savepoint s2");
    });
    expect((await q<{ md5: string }>(`select md5(regexp_replace(prosrc, '\\s', '', 'g')) as md5 from pg_proc where oid = to_regprocedure('${FN}')`))[0].md5).toBe(FN_MD5);
  });
});
