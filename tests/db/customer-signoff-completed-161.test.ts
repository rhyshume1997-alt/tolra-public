/**
 * Release 161 (supabase/release/161_customer_signoff_completed.release.sql, phase 161 after 156): a customer's sign-off is accepted only on
 * a RELEASED job (081's public.job_release_state: inspection passed, or an admin's recorded early release still in force), and never for a
 * revision ahead of the job's own. The DB proof, below PostgREST. Fixes the audit finding J3.
 *
 * Inputs: the disposable Supabase stack (TEST_DATABASE_URL, isolation-checked); the post-144 fixture installs 145..161. Calls run as
 * PostgREST would: one transaction, role authenticated, JWT claims of a company member (aal2). Companies are synthetic (slug t-<run>-p161-...)
 * and removed afterwards by destroySyntheticWorld. Release, rollback and re-release run inside transactions that are always rolled back.
 * Proves: cases 1 to 10 of the brief, one `describe` each: refusals (job_not_released, shown_revision_ahead) write nothing; a passed
 * inspection or a live admin early release is accepted; delivery without a signature and a late signature are still permitted (the phone's
 * clock window is 072's: 30 days before to 1 day after the upload); a lower (historical) or NULL shown revision is accepted; roles, the
 * company switch and one-per-revision are as before; replays answer before the new checks; another company cannot reach the job; only the
 * body of sign_off_job_customer changed, by exactly the two added checks; release, repeat, verify, rollback, refusal on an unexpected body,
 * and re-release.
 * Not proved here: PostgREST's own error mapping, the app's offline queue (browser tests), hosted PostgreSQL 17.
 * Must not change: this file proves; it never edits a release, verify or rollback file, or migration 072, to make itself pass.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CUSTOMER_SIGNOFF_STATEMENT } from "@/lib/job-signoff";

import { isolatedBackend } from "../support/isolation";
import { EMAIL_DOMAIN, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";

const runId = randomBytes(4).toString("hex");
let seq = 0;
const slug = (label: string) => `t-${runId}-p161-${label}-${++seq}`;
const email = (label: string) => `${label}-${++seq}.${runId}@${EMAIL_DOMAIN}`;
const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const RELEASE = "supabase/release/161_customer_signoff_completed.release.sql";
const ROLLBACK = "supabase/release/161_customer_signoff_completed.rollback.sql";
const VERIFY = "supabase/verify/customer_signoff_completed_161.sql";
const PREFLIGHT = "supabase/verify/release_preflight.sql";
const MIGRATION_072 = "supabase/migrations/072_customer_signoff.sql";
const MARKER = "post-144 marker 161 customer_signoff_completed";
const SIG = "public.sign_off_job_customer(uuid,text,text,text,text,text,text,text,timestamptz,uuid,integer,text)";
const MD5_072 = "f3857352acdfa18b4738fc850dde461d";
const MD5_161 = "b8b2a0f43fac263f8b913c2f9f1d8e9f";
const PATH = "M10 10L60 40L120 20L200 80";
const DAY = 86_400_000;
/** The phone's time: an hour ago (072 accepts 30 days before to 1 day after the upload), with milliseconds. */
const AT = new Date(Math.floor((Date.now() - 3_600_000) / 1000) * 1000 + 123).toISOString();

let pool: Pool;
type Row = Record<string, unknown>;
type Role = "admin" | "office" | "workshop" | "viewer";
type Co = { o: string } & Record<Role, string>;
const claims = (sub: string) => ({ sub, role: "authenticated", aal: "aal2", email: `${sub.slice(0, 8)}@example.test` });

async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await pool.connect();
  try { return (await db.query(sql, params)).rows as T[]; } finally { db.release(); }
}
async function asUser(db: PoolClient, sub: string) {
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claims(sub)), sub]);
}
/** One statement as a signed-in member, as PostgREST runs it: one transaction, committed on success. Resolves with the rows or the refusal. */
async function run(sub: string, sql: string, params: unknown[] = []): Promise<{ rows: Row[]; code?: string; hint?: string; message?: string }> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await asUser(db, sub);
    const rows = (await db.query(sql, params)).rows as Row[];
    await db.query("commit");
    return { rows };
  } catch (e) {
    await db.query("rollback").catch(() => undefined);
    const x = e as { code?: string; hint?: string; message: string };
    return { rows: [], code: x.code, hint: x.hint, message: x.message };
  } finally { db.release(); }
}
/** The same, expecting success (the refusal is thrown so a broken set-up shows its own message). */
async function ok(sub: string, sql: string, params: unknown[] = []): Promise<Row[]> {
  const r = await run(sub, sql, params);
  if (r.code !== undefined || r.message !== undefined) throw new Error(`unexpected refusal ${r.code} ${r.hint}: ${r.message}`);
  return r.rows;
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
async function preflightRows(db?: PoolClient) {
  const rows = db ? (await db.query(read(PREFLIGHT))).rows : await q(read(PREFLIGHT));
  return rows as { check: string; value: string }[];
}
async function verifyRows(db?: PoolClient) {
  const rows = db ? (await db.query(read(VERIFY))).rows : await q(read(VERIFY));
  return rows as { check_name: string; ok: boolean }[];
}
const bodyMd5 = async (db?: PoolClient) => {
  const sql = `select md5(regexp_replace(prosrc, '\\s', '', 'g')) as v from pg_proc where oid = to_regprocedure('${SIG}')`;
  return ((db ? (await db.query(sql)).rows : await q(sql))[0] as { v: string }).v;
};
/** Everything 161 must not touch (and the function's own settings apart from its body), as one comparable object. */
const FINGERPRINT = `select
  (select md5(coalesce(string_agg(p.oid::regprocedure::text || '|' || p.prosrc || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '-') || '|' || coalesce(p.proacl::text, '-')
                                  || '|' || pg_get_userbyid(p.proowner), E'\\n' order by p.oid::regprocedure::text), ''))
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'security_audit') and p.oid <> to_regprocedure('${SIG}')) as others,
  (select md5(pg_get_function_arguments(p.oid) || '|' || pg_get_function_result(p.oid) || '|' || p.prosecdef::text || '|' || p.provolatile::text || '|' || coalesce(p.proconfig::text, '-')
              || '|' || coalesce(p.proacl::text, '-') || '|' || pg_get_userbyid(p.proowner)) from pg_proc p where p.oid = to_regprocedure('${SIG}')) as target,
  (select md5(coalesce(string_agg(c.oid::regclass::text || '|' || o.polname || '|' || o.polcmd::text || '|' || coalesce(pg_get_expr(o.polqual, o.polrelid), '-') || '|' || coalesce(pg_get_expr(o.polwithcheck, o.polrelid), '-'),
                                  E'\\n' order by c.oid::regclass::text, o.polname), ''))
     from pg_policy o join pg_class c on c.oid = o.polrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'security_audit')) as policies,
  (select md5(coalesce(string_agg(pg_get_triggerdef(t.oid), E'\\n' order by c.oid::regclass::text, t.tgname), ''))
     from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ('public', 'security_audit')) as triggers`;
const fingerprint = async (db?: PoolClient) => ((db ? (await db.query(FINGERPRINT)).rows : await q(FINGERPRINT))[0]) as Record<string, string>;

// ---- Synthetic companies, jobs and flow steps (081's real paths) -----------------------------------------------------------------
async function makeCompany(signoffOn: boolean): Promise<Co> {
  const o = randomUUID();
  await q("insert into organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [o, `Synthetic p161 ${o.slice(0, 8)}`, slug("co")]);
  const co = { o } as Co;
  for (const role of ["admin", "office", "workshop", "viewer"] as const) {
    const u = randomUUID();
    const e = email(role);
    await q("insert into auth.users (id, email) values ($1, $2)", [u, e]);
    await q("insert into user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, 'Synthetic', $3, $4, true, false)", [u, e, role, o]);
    await q("insert into organization_members (organization_id, user_id, role, active, can_inspect) values ($1, $2, $3, true, $4)", [o, u, role, role === "office" || role === "workshop"]);
    co[role] = u;
  }
  await q("insert into organization_settings (organization_id, customer_signoff_enabled) values ($1, $2) on conflict (organization_id) do update set customer_signoff_enabled = excluded.customer_signoff_enabled", [o, signoffOn]);
  return co;
}
/** A confirmed sales order with one line, converted to its job by the office. */
async function orderJob(c: Co) {
  seq += 1;
  const so = (await q<{ id: string }>("insert into public.sales_orders (organization_id, so_number, customer, status, total_value, vat_enabled, vat_pct, vat_exempt) values ($1, $2, 'Sign Co', 'confirmed', 120, true, 20, false) returning id",
    [c.o, `SO-S-${runId}-${seq}`]))[0];
  const made = (await ok(c.office, "select public.convert_sales_order($1) as r", [so.id]))[0].r as { job_id: string; job_no: string };
  await ok(c.office, "select public.ensure_sales_order_lines($1)", [so.id]);
  const line = (await q<{ id: string }>("select id from public.sales_order_lines where sales_order_id = $1 order by position limit 1", [so.id]))[0];
  return { orderId: so.id, jobId: made.job_id, jobNo: made.job_no, lineId: line.id };
}
type J = Awaited<ReturnType<typeof orderJob>>;
const finish = (c: Co, j: J) => ok(c.workshop, "select public.finish_job($1, $2, now()) as r", [j.jobId, randomUUID()]);
const inspectArgs = async (j: J, result: string, extra: Row = {}) => {
  const v = (await q<{ worksheet_version: number }>("select worksheet_version from public.jobs where id = $1", [j.jobId]))[0].worksheet_version;
  return [j.jobId, result, "Drawing ACL-7 rev C: bore 25.00 +0.02/-0", "Bore 25.01 mm, 25.01 mm (bore gauge 0001)", v, null, extra.disposition ?? null, extra.failure ? JSON.stringify(extra.failure) : null, null, null];
};
const INSPECT_SQL = `select public.inspect_job(p_job => $1, p_result => $2, p_criteria => $3, p_measured => $4, p_expected_version => $5,
  p_override_reason => $6, p_disposition => $7, p_failure => $8::jsonb, p_client_op_id => $9::uuid, p_concession_reason => $10) as r`;
const pass = async (c: Co, j: J) => ok(c.office, INSPECT_SQL, await inspectArgs(j, "pass"));
const failToRework = async (c: Co, j: J) => ok(c.office, INSPECT_SQL, await inspectArgs(j, "fail", { disposition: "rework", failure: { reason: "Bore oversize 25.06", instructions: "Sleeve and re-bore" } }));
const releaseEarly = (c: Co, j: J, reason = "Customer collecting today, inspection on return") => ok(c.admin, "select public.release_job_early($1, $2) as r", [j.jobId, reason]);
const reopen = (c: Co, j: J, reason = "Wrong material: back to the bench") => ok(c.office, "select public.reopen_job($1, $2) as r", [j.jobId, reason]);
/** A changed drawing number raises the worksheet revision (022) and withdraws a pass or an early release made on the old one. */
const revise = (c: Co, j: J, drawing: string) => ok(c.office, "update public.jobs set drawing_no = $2 where id = $1 returning worksheet_version", [j.jobId, drawing]);

type Mode = "in_progress" | "finished" | "rework" | "inspected" | "early" | "reopened_after_early" | "put_back_after_early";
/** A job in the named state, reached only through the real functions. */
async function jobIn(c: Co, mode: Mode): Promise<J> {
  const j = await orderJob(c);
  if (mode === "in_progress") return j;
  await finish(c, j);
  if (mode === "finished") return j;
  if (mode === "rework") { await failToRework(c, j); return j; }
  if (mode === "inspected") { await pass(c, j); return j; }
  await releaseEarly(c, j);
  if (mode === "early") return j;
  if (mode === "reopened_after_early") { await reopen(c, j); await finish(c, j); return j; }
  await failToRework(c, j); // put_back voids the early release
  return j;
}

const OP = () => randomUUID();
/** The customer's signature. Every argument can be overridden; the key is new each time unless given. */
const sign = (sub: string, jobId: string, over: Row = {}) => {
  const a: Row = {
    p_job_id: jobId, p_signer_name: "Jane Smith", p_signer_position: "Site Manager", p_signer_company: null, p_statement: CUSTOMER_SIGNOFF_STATEMENT, p_comment: null,
    p_signature_kind: "drawn", p_signature_data: PATH, p_device_signed_at: AT, p_client_op_id: OP(), p_shown_version: null, p_shown_snapshot_sha256: null, ...over,
  };
  const names = Object.keys(a);
  return run(sub, `select public.sign_off_job_customer(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`, names.map((n) => a[n]));
};
const signed = async (sub: string, jobId: string, over: Row = {}) => {
  const r = await sign(sub, jobId, over);
  if (r.code !== undefined) throw new Error(`sign-off refused ${r.code} ${r.hint}: ${r.message}`);
  return r.rows[0].r as Row;
};
const signoffRows = (jobId: string) => q("select * from public.job_signoffs where job_id = $1 order by created_at", [jobId]);
const auditRows = (jobId: string) => q("select id from security_audit.audit_log where action = 'JOB_CUSTOMER_SIGN_OFF' and entity_id = $1", [jobId]);
const jobRowMd5 = async (jobId: string) => (await q<{ v: string }>("select md5(to_jsonb(j)::text) as v from public.jobs j where j.id = $1", [jobId]))[0].v;
/** A refusal that wrote nothing: the code, the hint, the plain message, no job_signoffs row and no audit row. */
async function expectRefused(r: { code?: string; hint?: string; message?: string }, jobId: string, code: string, hint: string | undefined, message?: RegExp) {
  expect({ code: r.code, hint: r.hint }, r.message).toEqual({ code, hint });
  if (message) expect(r.message).toMatch(message);
  expect(await signoffRows(jobId)).toHaveLength(0);
  expect(await auditRows(jobId)).toHaveLength(0);
}
const NOT_RELEASED = /has not been released\. The customer can sign once the job has passed inspection or an admin has released it early\./;

let A: Co;
let B: Co;
let C: Co;

describe("release 161: a customer's sign-off only on a released job", () => {
  beforeAll(async () => {
    await verifyBackendIdentity();
    await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
    pool = new Pool({ connectionString: isolatedBackend().databaseUrl, max: 8 });
    A = await makeCompany(true);
    B = await makeCompany(true);
    C = await makeCompany(false);
  });

  afterAll(async () => {
    if (pool) await pool.end();
    await destroySyntheticWorld(runId);
  });

  describe("1. refused, and nothing is written", () => {
    it.each<[string, Mode]>([
      ["a job in progress", "in_progress"],
      ["a job finished but not inspected", "finished"],
      ["a job back in rework after a failed inspection", "rework"],
      ["a job whose admin early release was voided by a later reopen", "reopened_after_early"],
      ["a job whose admin early release was voided by a later put-back (failed inspection)", "put_back_after_early"],
    ])("%s: 22023 / job_not_released, no job_signoffs row, no audit row", async (_label, mode) => {
      const j = await jobIn(A, mode);
      for (const role of ["admin", "office", "workshop"] as const) await expectRefused(await sign(A[role], j.jobId), j.jobId, "22023", "job_not_released", NOT_RELEASED);
      // The same refusal says the job number, and the job itself is untouched by a refusal.
      const again = await sign(A.office, j.jobId);
      expect(again.message).toContain(j.jobNo);
    });

    it("an early release made on an older worksheet revision no longer counts (stale): refused until released again", async () => {
      const j = await jobIn(A, "early");
      expect((await signoffRows(j.jobId))).toHaveLength(0);
      expect((await revise(A, j, `DWG-${runId}-B`))[0].worksheet_version).toBe(1);
      await expectRefused(await sign(A.office, j.jobId), j.jobId, "22023", "job_not_released", NOT_RELEASED);
      await releaseEarly(A, j, "Released again on the new revision");
      expect((await signed(A.office, j.jobId)).worksheet_version).toBe(1);
    });

    it("a finish time alone does not count; the rule is job_release_state's: it says not released for every one of these", async () => {
      for (const mode of ["in_progress", "finished", "rework", "reopened_after_early", "put_back_after_early"] as const) {
        const j = await jobIn(A, mode);
        const r = (await ok(A.office, "select released from public.job_release_state($1)", [j.jobId]))[0];
        expect(r.released, mode).toBe(false);
      }
    });
  });

  describe("2. accepted when released", () => {
    it("a job released by passing inspection (Complete): the record keeps the revision, the capturer, and writes nothing on the job", async () => {
      const j = await jobIn(A, "inspected");
      expect((await q<{ stage: string }>("select stage from public.jobs where id = $1", [j.jobId]))[0].stage).toBe("complete");
      const before = await jobRowMd5(j.jobId);
      const done = await signed(A.workshop, j.jobId, { p_signer_company: " Acme Ltd ", p_shown_version: 0 });
      expect(done).toMatchObject({ worksheet_version: 0, kind: "customer", replayed: false });
      const rows = await signoffRows(j.jobId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "customer", worksheet_version: 0, shown_worksheet_version: 0, signed_by: A.workshop, signer_name: "Jane Smith", signer_company: "Acme Ltd", organization_id: A.o });
      expect(await auditRows(j.jobId)).toHaveLength(1);
      expect(await jobRowMd5(j.jobId)).toBe(before);
    });

    it("a job with a recorded, live admin early release is accepted although it was never inspected", async () => {
      const j = await jobIn(A, "early");
      const job = (await q<{ inspected_at: unknown; stage: string }>("select inspected_at, stage from public.jobs where id = $1", [j.jobId]))[0];
      expect(job.inspected_at).toBeNull();
      expect((await ok(A.office, "select released from public.job_release_state($1)", [j.jobId]))[0].released).toBe(true);
      expect(await signed(A.office, j.jobId)).toMatchObject({ worksheet_version: 0, kind: "customer", replayed: false });
      expect(await signoffRows(j.jobId)).toHaveLength(1);
      expect(await auditRows(j.jobId)).toHaveLength(1);
    });

    it("an early release by anyone but an admin is not possible, so it cannot make a job signable", async () => {
      const j = await jobIn(A, "finished");
      expect((await run(A.office, "select public.release_job_early($1, $2)", [j.jobId, "Customer collecting today, inspection on return"])).hint).toBe("early_release_admin_only");
      await expectRefused(await sign(A.office, j.jobId), j.jobId, "22023", "job_not_released");
    });
  });

  describe("3. delivery without a customer signature is still permitted", () => {
    it("on a released job a delivery note is created, despatched and marked signed with no customer sign-off; a customer sign-off is still accepted afterwards", async () => {
      const j = await jobIn(A, "inspected");
      const lines = JSON.stringify([{ line_id: j.lineId, quantity: 1 }]);
      const dn = (await ok(A.workshop, "select public.create_delivery_note($1, $2, current_date, current_date, null, null, $3::jsonb) as r", [j.orderId, j.jobId, lines]))[0].r as { id: string };
      await ok(A.office, "update public.delivery_notes set status = 'despatched' where id = $1 returning id", [dn.id]);
      await ok(A.office, "update public.delivery_notes set status = 'signed' where id = $1 returning id", [dn.id]);
      expect((await q<{ status: string }>("select status from public.delivery_notes where id = $1", [dn.id]))[0].status).toBe("signed");
      // The delivery note's "signed" never touched job_signoffs.
      expect(await signoffRows(j.jobId)).toHaveLength(0);
      expect(await signed(A.admin, j.jobId)).toMatchObject({ kind: "customer", replayed: false });
      expect(await signoffRows(j.jobId)).toHaveLength(1);
    });
  });

  describe("4. a late signature on a released job", () => {
    it("is accepted after despatch, within 072's phone-clock window (30 days before to 1 day after the upload); outside it is refused as before", async () => {
      const j = await jobIn(A, "inspected");
      const lines = JSON.stringify([{ line_id: j.lineId, quantity: 1 }]);
      const dn = (await ok(A.workshop, "select public.create_delivery_note($1, $2, current_date, current_date, null, null, $3::jsonb) as r", [j.orderId, j.jobId, lines]))[0].r as { id: string };
      await ok(A.office, "update public.delivery_notes set status = 'despatched' where id = $1 returning id", [dn.id]);
      // 31 days old: the existing window refuses it (22023 / device_time_out_of_range); nothing is written.
      const tooOld = await sign(A.office, j.jobId, { p_device_signed_at: new Date(Date.now() - 31 * DAY).toISOString() });
      await expectRefused(tooOld, j.jobId, "22023", "device_time_out_of_range");
      // 29 days old: a signature captured long after the job was released and despatched is accepted.
      const late = new Date(Date.now() - 29 * DAY).toISOString();
      expect(await signed(A.office, j.jobId, { p_device_signed_at: late })).toMatchObject({ kind: "customer", replayed: false });
      const [row] = await signoffRows(j.jobId);
      expect((row.device_signed_at as Date).toISOString()).toBe(late);
    });
  });

  describe("5. the revision the customer was shown", () => {
    it("ahead of the job's revision is refused (22023 / shown_revision_ahead, nothing written); equal is accepted; lower (historical) is accepted and stored; NULL is accepted", async () => {
      // A job on revision 1 (a drawing change after its first inspection, then inspected again).
      const mk = async () => {
        const j = await jobIn(A, "inspected");
        expect((await revise(A, j, `DWG-${runId}-${++seq}`))[0].worksheet_version).toBe(1);
        await ok(A.office, INSPECT_SQL, await inspectArgs(j, "pass"));
        return j;
      };
      const ahead = await mk();
      for (const shown of [2, 3, 999]) await expectRefused(await sign(A.office, ahead.jobId, { p_shown_version: shown }), ahead.jobId, "22023", "shown_revision_ahead", /ahead of the job's current revision/);
      expect(await signed(A.office, ahead.jobId, { p_shown_version: 1 })).toMatchObject({ worksheet_version: 1 });
      expect((await signoffRows(ahead.jobId))[0]).toMatchObject({ worksheet_version: 1, shown_worksheet_version: 1 });

      const historical = await mk();
      expect(await signed(A.office, historical.jobId, { p_shown_version: 0 })).toMatchObject({ worksheet_version: 1 });
      expect((await signoffRows(historical.jobId))[0]).toMatchObject({ worksheet_version: 1, shown_worksheet_version: 0 });

      const none = await mk();
      expect(await signed(A.office, none.jobId, { p_shown_version: null })).toMatchObject({ worksheet_version: 1 });
      expect((await signoffRows(none.jobId))[0]).toMatchObject({ worksheet_version: 1, shown_worksheet_version: null });
    });

    it("a made-up revision on a released job at revision 0 is refused too (the original finding), and the existing input check (negative) is unchanged", async () => {
      const j = await jobIn(A, "inspected");
      await expectRefused(await sign(A.office, j.jobId, { p_shown_version: 1 }), j.jobId, "22023", "shown_revision_ahead");
      const negative = await sign(A.office, j.jobId, { p_shown_version: -1 });
      expect(negative.code).toBe("22023");
      expect(negative.message).toMatch(/revision shown when the customer signed is not valid/);
      expect(await signoffRows(j.jobId)).toHaveLength(0);
    });
  });

  describe("6. roles, the company setting and one signature per revision", () => {
    it("admin, office and workshop are accepted on a released job; a viewer is refused 42501 as before", async () => {
      for (const role of ["admin", "office", "workshop"] as const) {
        const j = await jobIn(A, "inspected");
        expect(await signed(A[role], j.jobId), role).toMatchObject({ kind: "customer" });
        expect((await signoffRows(j.jobId))[0].signed_by).toBe(A[role]);
      }
      const j = await jobIn(A, "inspected");
      await expectRefused(await sign(A.viewer, j.jobId), j.jobId, "42501", undefined);
    });

    it("the company setting off is still refused (42501 / customer_signoff_off) on a released job", async () => {
      const j = await jobIn(C, "inspected");
      await expectRefused(await sign(C.office, j.jobId), j.jobId, "42501", "customer_signoff_off");
      // On an unreleased job of the same company the release refusal comes first (it sits before the company switch).
      const k = await jobIn(C, "finished");
      await expectRefused(await sign(C.office, k.jobId), k.jobId, "22023", "job_not_released");
    });

    it("a second customer sign-off on the same revision is still refused (23505 / already_signed); a new revision may be signed again", async () => {
      const j = await jobIn(A, "inspected");
      expect(await signed(A.office, j.jobId)).toMatchObject({ worksheet_version: 0 });
      const second = await sign(A.office, j.jobId);
      expect({ code: second.code, hint: second.hint }).toEqual({ code: "23505", hint: "already_signed" });
      expect(await signoffRows(j.jobId)).toHaveLength(1);
      expect(await auditRows(j.jobId)).toHaveLength(1);
      await revise(A, j, `DWG-${runId}-${++seq}`);
      await ok(A.office, INSPECT_SQL, await inspectArgs(j, "pass"));
      expect(await signed(A.office, j.jobId)).toMatchObject({ worksheet_version: 1 });
      expect(await signoffRows(j.jobId)).toHaveLength(2);
    });
  });

  describe("7. replay safety (the replay branch answers before the new checks)", () => {
    it("the same key sent twice returns the first answer with replayed, and adds nothing", async () => {
      const j = await jobIn(A, "inspected");
      const key = OP();
      const first = await signed(A.office, j.jobId, { p_client_op_id: key });
      const second = await signed(A.office, j.jobId, { p_client_op_id: key });
      expect(first.replayed).toBe(false);
      expect(second).toEqual({ ...first, replayed: true });
      expect(await signoffRows(j.jobId)).toHaveLength(1);
      expect(await auditRows(j.jobId)).toHaveLength(1);
    });

    it("a signature recorded before the job was reopened still returns its original answer after the reopen; a new key is refused; other content under the key is client_op_reused", async () => {
      const j = await jobIn(A, "inspected");
      const key = OP();
      const first = await signed(A.office, j.jobId, { p_client_op_id: key });
      await reopen(A, j, "Customer found a fault: back to the bench");
      expect((await ok(A.office, "select released from public.job_release_state($1)", [j.jobId]))[0].released).toBe(false);
      expect(await signed(A.office, j.jobId, { p_client_op_id: key })).toEqual({ ...first, replayed: true });
      const other = await sign(A.office, j.jobId, { p_client_op_id: key, p_signer_name: "Someone Else" });
      expect({ code: other.code, hint: other.hint }).toEqual({ code: "22023", hint: "client_op_reused" });
      const fresh = await sign(A.office, j.jobId);
      expect({ code: fresh.code, hint: fresh.hint }).toEqual({ code: "22023", hint: "job_not_released" });
      expect(await signoffRows(j.jobId)).toHaveLength(1);
      expect(await auditRows(j.jobId)).toHaveLength(1);
    });

    it("the key with other content is refused client_op_reused, also on a released job, and also when the shown revision is the difference", async () => {
      const j = await jobIn(A, "inspected");
      const key = OP();
      await signed(A.office, j.jobId, { p_client_op_id: key });
      for (const over of [{ p_signer_name: "Someone Else" }, { p_shown_version: 0 }, { p_comment: "Changed" }]) {
        const r = await sign(A.office, j.jobId, { p_client_op_id: key, ...over });
        expect({ code: r.code, hint: r.hint }, JSON.stringify(over)).toEqual({ code: "22023", hint: "client_op_reused" });
      }
      expect(await signoffRows(j.jobId)).toHaveLength(1);
    });

    it("a signature refused with job_not_released and retried with the SAME key after the job is released succeeds once", async () => {
      const j = await jobIn(A, "finished");
      const key = OP();
      await expectRefused(await sign(A.office, j.jobId, { p_client_op_id: key }), j.jobId, "22023", "job_not_released");
      await pass(A, j);
      const retry = await signed(A.office, j.jobId, { p_client_op_id: key });
      expect(retry).toMatchObject({ kind: "customer", replayed: false });
      expect(await signed(A.office, j.jobId, { p_client_op_id: key })).toEqual({ ...retry, replayed: true });
      expect(await signoffRows(j.jobId)).toHaveLength(1);
      expect(await auditRows(j.jobId)).toHaveLength(1);
    });
  });

  describe("8. tenant isolation", () => {
    it("a user of company B gets P0002 for company A's job (released or not); B's released jobs never change A's decision", async () => {
      const aReleased = await jobIn(A, "inspected");
      const aUnreleased = await jobIn(A, "finished");
      const bReleased = await jobIn(B, "inspected");
      for (const j of [aReleased, aUnreleased]) {
        const r = await sign(B.admin, j.jobId);
        expect({ code: r.code }, `${j.jobNo}`).toEqual({ code: "P0002" });
        expect((await run(B.admin, "select released from public.job_release_state($1)", [j.jobId])).code).toBe("P0002");
      }
      expect(await signoffRows(aReleased.jobId)).toHaveLength(0);
      // A's unreleased job stays refused while B has released jobs; B's own released job signs in B only.
      await expectRefused(await sign(A.office, aUnreleased.jobId), aUnreleased.jobId, "22023", "job_not_released");
      expect(await signed(B.admin, bReleased.jobId)).toMatchObject({ kind: "customer" });
      expect((await signoffRows(bReleased.jobId))[0].organization_id).toBe(B.o);
      expect(await signed(A.office, aReleased.jobId)).toMatchObject({ kind: "customer" });
    });
  });

  describe("9. the catalogue: only the body of sign_off_job_customer changed, by exactly the two added checks", () => {
    /** 072's function body as the frozen migration text has it (between its AS $$ and $$;). */
    function body072() {
      const s = read(MIGRATION_072);
      const start = s.indexOf("CREATE OR REPLACE FUNCTION public.sign_off_job_customer(");
      const open = s.indexOf("AS $$", start) + "AS $$".length;
      return s.slice(open, s.indexOf("$$;", open));
    }

    it("the installed body is 072's text with one contiguous block of two checks added after the replay and before the phone's clock window", async () => {
      const frozen = body072();
      expect((await q<{ v: string }>("select md5(regexp_replace($1::text, '\\s', '', 'g')) as v", [frozen]))[0].v).toBe(MD5_072);
      const installed = (await q<{ prosrc: string }>(`select prosrc from pg_proc where oid = to_regprocedure('${SIG}')`))[0].prosrc;
      const lines = installed.split("\n");
      const from = lines.findIndex((l) => l.startsWith("  -- 161:"));
      const to = lines.findIndex((l) => l.startsWith("  -- The phone's clock"));
      expect(from).toBeGreaterThan(0);
      expect(to).toBeGreaterThan(from);
      const block = lines.slice(from, to).join("\n");
      expect(lines.slice(0, from).concat(lines.slice(to)).join("\n")).toBe(frozen);
      // The block is two checks and nothing else: the release rule (asked of job_release_state) and the revision.
      expect(block.match(/RAISE EXCEPTION/g)).toHaveLength(2);
      expect(block.match(/^  IF /gm)).toHaveLength(2);
      expect(block).toContain("job_release_state(p_job_id)");
      expect(block).toContain("HINT = 'job_not_released'");
      expect(block).toContain("p_shown_version > v_job.worksheet_version");
      expect(block).toContain("HINT = 'shown_revision_ahead'");
      expect(block).not.toMatch(/\b(INSERT|UPDATE|DELETE|LOCK|FOR UPDATE)\b/);
      // After the role check and the replay branch, before the phone's clock, the company switch and one-per-revision.
      expect(installed.indexOf("not authorised")).toBeLessThan(installed.indexOf("-- 161:"));
      expect(installed.indexOf("client_op_reused")).toBeLessThan(installed.indexOf("-- 161:"));
      expect(installed.indexOf("-- 161:")).toBeLessThan(installed.indexOf("device_time_out_of_range", installed.indexOf("-- 161:")));
      expect(installed.indexOf("-- 161:")).toBeLessThan(installed.indexOf("customer_signoff_off"));
      expect(installed.indexOf("-- 161:")).toBeLessThan(installed.indexOf("already_signed"));
      expect(await bodyMd5()).toBe(MD5_161);
    });

    it("everything else is as 072 had it: definer, search_path, TimeZone, grants, signature and owner; no other function, policy or trigger differs", async () => {
      const meta = (await q<Row>(`select p.prosecdef, p.proconfig, p.proacl::text as acl, pg_get_function_arguments(p.oid) as args, pg_get_function_result(p.oid) as result,
          pg_get_userbyid(p.proowner) as owner, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x
        from pg_proc p where p.oid = to_regprocedure('${SIG}')`))[0];
      expect(meta).toMatchObject({ prosecdef: true, proconfig: ["search_path=pg_catalog, public, security_audit, extensions", "TimeZone=UTC"], anon_x: false, auth_x: true, result: "jsonb" });
      expect(meta.args).toBe("p_job_id uuid, p_signer_name text, p_signer_position text, p_signer_company text, p_statement text, p_comment text, p_signature_kind text, p_signature_data text, p_device_signed_at timestamp with time zone, p_client_op_id uuid, p_shown_version integer DEFAULT NULL::integer, p_shown_snapshot_sha256 text DEFAULT NULL::text");
      expect(String(meta.acl)).not.toMatch(/(^|,|\{)=X/); // no PUBLIC grant
      expect((await q("select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'sign_off_job_customer'"))).toHaveLength(1);
      // Rolled back to 072 and forward again inside one transaction: the fingerprint of everything but the body is identical in both states.
      const states = await rolledBack(async (db) => {
        const at161 = await fingerprint(db);
        await db.query(body(ROLLBACK));
        const at072 = await fingerprint(db);
        return { at161, at072, md5: await bodyMd5(db) };
      });
      expect(states.md5).toBe(MD5_072);
      expect(states.at072).toEqual(states.at161);
    });

    it("job_release_state and job_early_release_active are 081's and untouched by 161", async () => {
      const state = async (db?: PoolClient) => {
        const sql = `select p.oid::regprocedure::text as sig, md5(p.prosrc) as src, p.prosecdef, p.proconfig, p.proacl::text as acl from pg_proc p
          where p.proname in ('job_release_state', 'job_early_release_active') order by 1`;
        return (db ? (await db.query(sql)).rows : await q(sql)) as Row[];
      };
      const now = await state();
      expect(now).toHaveLength(2);
      expect(await rolledBack(async (db) => { await db.query(body(ROLLBACK)); return state(db); })).toEqual(now);
    });
  });

  describe("10. release mechanics", () => {
    it("the proof starts from the installed release: marker applied, verify rows all true, row 60 says 161", async () => {
      expect(await bodyMd5()).toBe(MD5_161);
      expect((await verifyRows()).filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
      const pf = await preflightRows();
      expect(pf.find((r) => r.check === MARKER)?.value).toBe("applied");
      expect(pf.find((r) => r.check.startsWith("161 needs"))?.value).toBe("present / present / 161");
    });

    it("installing again changes nothing: the body, the fingerprint and the verify rows stay the same", async () => {
      await rolledBack(async (db) => {
        const before = await fingerprint(db);
        await db.query(body(RELEASE));
        await db.query(body(RELEASE));
        expect(await fingerprint(db)).toEqual(before);
        expect(await bodyMd5(db)).toBe(MD5_161);
        expect((await verifyRows(db)).filter((r) => r.ok !== true)).toEqual([]);
      });
    });

    it("rollback restores 072's body (md5 and text), verify and the marker say 161 is out, a second rollback is a no-op, and the release puts 161 back", async () => {
      await rolledBack(async (db) => {
        await db.query(body(ROLLBACK));
        expect(await bodyMd5(db)).toBe(MD5_072);
        const installed = (await db.query(`select prosrc from pg_proc where oid = to_regprocedure('${SIG}')`)).rows[0].prosrc as string;
        expect(installed).not.toContain("job_not_released");
        expect((await verifyRows(db)).filter((r) => r.ok !== true).length).toBeGreaterThan(0);
        const pf = await preflightRows(db);
        expect(pf.find((r) => r.check === MARKER)?.value).toBe("not applied");
        expect(pf.find((r) => r.check.startsWith("161 needs"))?.value).toBe("present / present / 072");
        const once = await fingerprint(db);
        await db.query(body(ROLLBACK));
        expect(await fingerprint(db)).toEqual(once);
        await db.query(body(RELEASE));
        expect(await bodyMd5(db)).toBe(MD5_161);
        expect((await verifyRows(db)).filter((r) => r.ok !== true)).toEqual([]);
        expect((await preflightRows(db)).find((r) => r.check === MARKER)?.value).toBe("applied");
      });
    });

    it("after rollback a customer sign-off on an unfinished job is accepted again (the defect is open), and after the release it is refused again", async () => {
      const j = await jobIn(A, "in_progress");
      const before = await signoffRows(j.jobId);
      expect(before).toHaveLength(0);
      // Run as the app would, inside a transaction that is rolled back so nothing is kept.
      const db = await pool.connect();
      try {
        await db.query("begin");
        await db.query(body(ROLLBACK));
        await asUser(db, A.office);
        const r = (await db.query("select public.sign_off_job_customer(p_job_id => $1, p_signer_name => 'Jane Smith', p_signer_position => null, p_signer_company => null, p_statement => $2, p_comment => null, p_signature_kind => 'typed', p_signature_data => 'Jane Smith', p_device_signed_at => $3, p_client_op_id => $4, p_shown_version => 7) as r",
          [j.jobId, CUSTOMER_SIGNOFF_STATEMENT, AT, OP()])).rows[0].r as Row;
        expect(r).toMatchObject({ kind: "customer", worksheet_version: 0 });
      } finally { await db.query("rollback").catch(() => undefined); db.release(); }
      await expectRefused(await sign(A.office, j.jobId, { p_shown_version: 7 }), j.jobId, "22023", "job_not_released");
    });

    it("the rollback refuses an unexpected body and the release refuses it too; both change nothing", async () => {
      await rolledBack(async (db) => {
        await db.query(`create or replace function public.sign_off_job_customer(p_job_id uuid, p_signer_name text, p_signer_position text, p_signer_company text, p_statement text, p_comment text,
            p_signature_kind text, p_signature_data text, p_device_signed_at timestamptz, p_client_op_id uuid, p_shown_version integer default null, p_shown_snapshot_sha256 text default null)
          returns jsonb language plpgsql security definer set search_path = pg_catalog, public as $f$ begin return null::jsonb; end $f$`);
        const odd = await bodyMd5(db);
        expect(odd).not.toBe(MD5_072);
        expect(odd).not.toBe(MD5_161);
        await db.query("savepoint s1");
        await expect(db.query(body(ROLLBACK))).rejects.toThrow(/neither 161's nor 072's; stop and compare it first/);
        await db.query("rollback to savepoint s1");
        await db.query("savepoint s2");
        await expect(db.query(body(RELEASE))).rejects.toThrow(/neither 072's nor 161's; stop and compare it first/);
        await db.query("rollback to savepoint s2");
        expect(await bodyMd5(db)).toBe(odd);
      });
    });

    it("the release refuses while 081's release rule is missing, and changes nothing", async () => {
      await rolledBack(async (db) => {
        await db.query(body(ROLLBACK));
        await db.query("drop function public.job_early_release_active(uuid)");
        await db.query("savepoint s1");
        await expect(db.query(body(RELEASE))).rejects.toThrow(/161: required release 081/);
        await db.query("rollback to savepoint s1");
        expect(await bodyMd5(db)).toBe(MD5_072);
        expect((await preflightRows(db)).find((r) => r.check.startsWith("161 needs"))?.value).toBe("present / missing / 072");
      });
    });
  });
});
