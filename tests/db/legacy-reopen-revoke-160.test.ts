/**
 * Release 160 (supabase/release/160_legacy_reopen_revoke.release.sql, phase 160 after 156): the older reopen function public.reopen_job
 * can no longer be called from the browser (defect J1, P0: a signed-in user could reopen a Complete job by calling it directly, skipping
 * migration 113's reopen request and sign-off). The DB proof, below PostgREST, one `it` per required case (1 to 9).
 *
 * Inputs: the disposable stack (TEST_DATABASE_URL, isolation-checked); the post-144 fixture installs 145..160. Plain SQL with synthetic rows
 * and forged session claims (no Auth API), as 113's own suite does: each call is one transaction, role authenticated (or anon) with the
 * person's claims, as PostgREST runs it. Companies are synthetic (slug t-<run>-...) and removed afterwards. Release, rollback and re-release
 * run inside transactions that are always rolled back.
 * Proves: a direct reopen_job call is refused with 42501 for workshop, office, admin and anon, on a finished-not-inspected job and a Complete
 * job, and changes nothing; 113's preview, tick-box reopen, admin approval and rejection still work and leave their request row and audit
 * record; 081's refusals (not finished, rework, gone out) and who-may-reopen rules are unchanged through the workflow; service_role's and the
 * owner's grants are unchanged; another company cannot preview, record or decide; the catalogue (grants, body md5, no other grant changed);
 * the historical supabase/verify/job_flow_081.sql (unchanged) changes in one row only, api_functions_signed_in_only (true before 160, false after, by design); release, repeat install, refusals, rollback and
 * re-release.
 * Not proved here: PostgREST's own error mapping, hosted grants (service_role there comes from Supabase's default privileges).
 * "service_role unchanged": 160 does not touch its EXECUTE grant (asserted equal across release, rollback and re-release). It cannot reopen a
 * job anyway (auth.uid() is null there, so reopen_job refuses with 'not authorised' 42501), so the proof asserts the grant and that call's
 * refusal is reopen_job's own, not a permission-denied-for-function.
 * Must not change: this file proves; it never edits a release, verify or rollback file to make itself pass.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedBackend, SYNTHETIC_SLUG_PREFIX } from "../support/isolation";
import { verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";

const runId = randomBytes(4).toString("hex");
let seq = 0;
const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const RELEASE = "supabase/release/160_legacy_reopen_revoke.release.sql";
const ROLLBACK = "supabase/release/160_legacy_reopen_revoke.rollback.sql";
const VERIFY = "supabase/verify/legacy_reopen_revoke_160.sql";
const VERIFY_081 = "supabase/verify/job_flow_081.sql";
const PREFLIGHT = "supabase/verify/release_preflight.sql";
const MARKER = "post-144 marker 160 legacy_reopen_revoke";
const BODY_MD5 = "2fca7e7164a55f9f9e0744f8a0c6b50e";
const REASON = "Finished by mistake, still machining";
const REASON_2 = "Customer changed the finish spec";
const REOPEN_JOB = "public.reopen_job(uuid,text)";

let pool: Pool;
type Row = Record<string, unknown>;
type Person = { id: string; email: string; session: string };
type Answer = { ok: true; value: Row | null } | { ok: false; code: string; hint?: string; message?: string };
const orgs: string[] = [];
const people: Person[] = [];

async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await pool.connect();
  try { return (await db.query(sql, params)).rows as T[]; } finally { db.release(); }
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
const failure = async (fn: () => Promise<unknown>) => {
  try { await fn(); } catch (e) { return e as { code?: string; hint?: string; message: string }; }
  throw new Error("expected a refusal, but it succeeded");
};

// ---- Synthetic companies, people, jobs -------------------------------------------------------------------------------------------
async function makeOrg(label: string) {
  const id = randomUUID();
  seq += 1;
  await q("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [id, `160 ${label} ${runId}`, `${SYNTHETIC_SLUG_PREFIX}${runId}-160-${label}-${seq}`]);
  orgs.push(id);
  return id;
}
async function makePerson(org: string, name: string, role: string): Promise<Person> {
  seq += 1;
  const p = { id: randomUUID(), email: `${name}-${seq}.${runId}@example.test`, session: randomUUID() };
  await q("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await q(`insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, $3, $4, $5, true, false)`, [p.id, p.email, `Person ${seq}`, role, org]);
  await q("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, $3, true)", [p.id, org, role]);
  await q("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await q("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
  people.push(p);
  return p;
}
type Kind = "finished" | "complete" | "unfinished" | "rework";
/** A job as the database holds it after the flow's steps: finished (by `by`), Complete (finished and signed off), still in progress, or in rework. */
async function makeJob(org: string, key: string, kind: Kind, by: Person | null) {
  const id = randomUUID();
  const finished = kind !== "unfinished";
  await q(`insert into public.jobs (id, organization_id, job_no, customer, finished_at, finished_by, inspected_at, stage)
           values ($1, $2, $3, 'Customer 160', $4, $5, $6, $7)`,
    [id, org, `J-160${key}-${runId}`, finished ? new Date(Date.now() - 3_600_000).toISOString() : null, finished ? by?.id ?? null : null,
      kind === "complete" ? new Date(Date.now() - 1_800_000).toISOString() : null, kind === "rework" ? "rework" : kind === "complete" ? "complete" : null]);
  return id;
}

/** One API request: its own transaction, as role authenticated (the person's claims) or as anon, as PostgREST runs it. */
async function as<T>(p: Person | "anon" | "service_role", fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    if (p === "anon" || p === "service_role") {
      await db.query(`set local role ${p}`);
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: p })]);
    } else {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal: "aal2", email: p.email, session_id: p.session }), p.id]);
    }
    const result = await fn(db);
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally { db.release(); }
}
async function call(p: Person | "anon" | "service_role", text: string, params: unknown[] = []): Promise<Answer> {
  try {
    const value = await as(p, async (db) => (await db.query<{ v: Row | null }>(`select ${text} as v`, params)).rows[0]?.v ?? null);
    return { ok: true, value };
  } catch (error) {
    const e = error as { code?: string; hint?: string; message?: string };
    return { ok: false, code: e.code ?? "error", hint: e.hint, message: e.message };
  }
}
const direct = (p: Person | "anon" | "service_role", job: string, reason = REASON) => call(p, "public.reopen_job($1, $2)", [job, reason]);
const preview = (p: Person, job: string) => call(p, "public.reopen_preview('job', $1)", [job]);
const reopen = (p: Person, job: string, mode: string, reason = REASON) => call(p, "public.reopen_record('job', $1, $2, $3)", [job, reason, mode]);
const decide = (p: Person, request: unknown, decision: string, note: string | null = null) => call(p, "public.decide_reopen_request($1, $2, $3)", [request, decision, note]);
const requestId = (a: Answer) => (a as unknown as { value: { request_id: string } }).value.request_id;

/** The parts of a job a reopen would change, as plain text (timestamps compared as ISO strings), plus the rows a reopen would leave behind. */
async function snap(job: string) {
  const [r] = await q<{ finished_at: Date | null; inspected_at: Date | null; stage: string | null; finished_by: string | null; inspected_by: string | null; events: number; requests: number }>(
    `select j.finished_at, j.inspected_at, j.stage, j.finished_by, j.inspected_by,
            (select count(*) from public.job_flow_events e where e.job_id = j.id)::int as events,
            (select count(*) from public.reopen_requests r where r.record_id = j.id)::int as requests
     from public.jobs j where j.id = $1`, [job]);
  return { ...r, finished_at: r.finished_at?.toISOString() ?? null, inspected_at: r.inspected_at?.toISOString() ?? null };
}
const requestsOf = (job: string) => q<Row>("select * from public.reopen_requests where record_id = $1 order by requested_at", [job]);
async function priv(db: PoolClient, role: string) {
  return (await db.query<{ p: boolean }>("select has_function_privilege($1, to_regprocedure($2), 'EXECUTE') as p", [role, REOPEN_JOB])).rows[0].p;
}
/** The ACL entries as a sorted list (GRANT appends, so the textual order of proacl is not a grant: the set is). */
const acl = async (db: PoolClient) => (await db.query<{ a: string[] | null }>("select array(select e::text from unnest(proacl) e order by 1) as a from pg_proc where oid = to_regprocedure($1)", [REOPEN_JOB])).rows[0].a ?? [];
/** Every other function's owner, grants, body and settings, and the relation grants, policies and triggers: one checksum each. */
async function others(db: PoolClient) {
  return (await db.query<{ kind: string; fp: string }>(`select 'function grants' as kind, md5(coalesce(string_agg(p.oid::regprocedure::text || '=' || coalesce(p.proacl::text, 'default') || '/' || p.proowner::text, E'\\n' order by p.oid::regprocedure::text), '')) as fp
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog', 'information_schema') and p.oid is distinct from to_regprocedure($1)
    union all select 'function bodies', md5(coalesce(string_agg(p.oid::regprocedure::text || '=' || md5(p.prosrc) || p.prosecdef::text || coalesce(p.proconfig::text, ''), E'\\n' order by p.oid::regprocedure::text), ''))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ('pg_catalog', 'information_schema') and p.oid is distinct from to_regprocedure($1)
    union all select 'relation grants', md5(coalesce(string_agg(c.oid::regclass::text || '=' || coalesce(c.relacl::text, 'default'), E'\\n' order by c.oid::regclass::text), ''))
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'
    union all select 'policies', md5(coalesce(string_agg(pol.polrelid::regclass::text || '.' || pol.polname || ':' || pol.polcmd::text || pol.polroles::text, E'\\n' order by pol.polrelid::regclass::text, pol.polname), '')) from pg_policy pol
    union all select 'triggers', md5(coalesce(string_agg(t.tgrelid::regclass::text || '.' || t.tgname || ':' || t.tgenabled::text, E'\\n' order by t.tgrelid::regclass::text, t.tgname), '')) from pg_trigger t where not t.tgisinternal
    order by 1`, [REOPEN_JOB])).rows;
}
const bodyMd5 = async (db: PoolClient) => (await db.query<{ m: string }>("select md5(regexp_replace(prosrc, '\\s', '', 'g')) as m from pg_proc where oid = to_regprocedure($1)", [REOPEN_JOB])).rows[0].m;
async function state(db: PoolClient) {
  return { auth: await priv(db, "authenticated"), anon: await priv(db, "anon"), pub: await priv(db, "public"), service: await priv(db, "service_role"), owner: (await db.query<{ p: boolean }>(
    "select has_function_privilege(proowner, oid, 'EXECUTE') as p from pg_proc where oid = to_regprocedure($1)", [REOPEN_JOB])).rows[0].p, acl: await acl(db), md5: await bodyMd5(db) };
}
async function verifyRows(file: string, db?: PoolClient) {
  const rows = db ? (await db.query(read(file))).rows : await q(read(file));
  return rows as { check_name: string; ok: boolean }[];
}
async function preflight(db: PoolClient) {
  return (await db.query(read(PREFLIGHT))).rows as { check: string; value: string; expected: string }[];
}
const notTrue = (rows: { check_name: string; ok: boolean }[]) => rows.filter((r) => r.ok !== true).map((r) => r.check_name);

let A: { org: string; admin: Person; admin2: Person; office: Person; w1: Person; w2: Person };
let B: { org: string; admin: Person; office: Person };
const J: Record<string, string> = {};

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
  pool = new Pool({ connectionString: isolatedBackend().databaseUrl, max: 6 });
  const orgA = await makeOrg("alpha");
  const orgB = await makeOrg("beta");
  A = { org: orgA, admin: await makePerson(orgA, "a-admin", "admin"), admin2: await makePerson(orgA, "a-admin2", "admin"), office: await makePerson(orgA, "a-office", "office"),
        w1: await makePerson(orgA, "a-w1", "workshop"), w2: await makePerson(orgA, "a-w2", "workshop") };
  B = { org: orgB, admin: await makePerson(orgB, "b-admin", "admin"), office: await makePerson(orgB, "b-office", "office") };
  // Jobs of company A. Finished by w1 unless named otherwise.
  J.fin = await makeJob(A.org, "fin", "finished", A.w1);        // finished, not inspected (direct-call proof; never reopened)
  J.done = await makeJob(A.org, "done", "complete", A.w1);      // Complete (direct-call proof; never reopened)
  for (const k of ["tick", "wait", "rej", "doneAsk", "doneRej", "invoiced", "preview"]) J[k] = await makeJob(A.org, k, "finished", A.w1);
  J.doneWait = await makeJob(A.org, "doneWait", "complete", A.w1);
  J.other = await makeJob(A.org, "other", "finished", A.w2);    // someone else's Finish
  J.office = await makeJob(A.org, "office", "finished", A.w2);  // someone else's Finish, reopened by the office
  J.doneRule = await makeJob(A.org, "doneRule", "complete", A.w1);
  J.out = await makeJob(A.org, "out", "finished", A.w1);        // gone out on a delivery note
  J.outInv = await makeJob(A.org, "outInv", "finished", A.w1);  // gone out and invoiced
  J.rework = await makeJob(A.org, "rework", "rework", A.w1);
  J.open = await makeJob(A.org, "open", "unfinished", null);
  J.beta = await makeJob(B.org, "beta", "finished", B.admin);
  for (const k of ["invoiced", "outInv"]) {
    await q("insert into public.invoices (organization_id, customer, job_id, invoice_ref, status) values ($1, 'Customer 160', $2, $3, 'issued')", [A.org, J[k], `INV-160${k}-${runId}`]);
  }
  for (const k of ["out", "outInv"]) {
    await q("insert into public.delivery_notes (organization_id, dn_number, status, job_id) values ($1, $2, 'despatched', $3)", [A.org, `DN-160${k}-${runId}`, J[k]]);
  }
});

afterAll(async () => {
  if (pool) {
    const ids = people.map((p) => p.id);
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      for (const t of ["public.reopen_requests", "public.job_flow_events", "public.delivery_notes", "public.invoices", "public.jobs", "security_audit.audit_log",
        "public.organization_members", "public.user_profiles"]) await db.query(`delete from ${t} where organization_id = any($1)`, [orgs]);
      await db.query("delete from security_audit.session_company where user_id = any($1)", [ids]);
      await db.query("delete from public.organizations where id = any($1)", [orgs]);
      await db.query("commit");
      await db.query("delete from auth.users where id = any($1)", [ids]);
    } catch (e) { await db.query("rollback").catch(() => undefined); throw e; } finally { db.release(); }
    await pool.end();
  }
});

describe("release 160: the older reopen function is closed to the browser; the request and sign-off workflow is not", () => {
  it("1. a direct reopen_job call is refused (42501) for workshop, office, admin and anon, on a finished job and a Complete job, and changes nothing", async () => {
    const before = { fin: await snap(J.fin), done: await snap(J.done) };
    expect(before.fin.finished_at).not.toBeNull();
    expect(before.fin.inspected_at).toBeNull();
    expect(before.done.inspected_at).not.toBeNull();
    const who: [string, Person | "anon"][] = [["workshop", A.w1], ["office", A.office], ["admin", A.admin], ["anon", "anon"]];
    for (const [name, p] of who) {
      for (const key of ["fin", "done"]) {
        const r = await direct(p, J[key]);
        expect(r, `${name} on ${key}`).toMatchObject({ ok: false, code: "42501" });
        expect((r as { message: string }).message, `${name} on ${key}`).toMatch(/permission denied for function reopen_job/);
        expect(await snap(J[key]), `${name} on ${key}`).toEqual(before[key as "fin" | "done"]);
      }
    }
    // Another company's job and a job that does not exist: the grant is checked first, so the answer is the same refusal.
    expect(await direct(A.admin, J.beta)).toMatchObject({ ok: false, code: "42501" });
    expect(await direct(A.office, randomUUID())).toMatchObject({ ok: false, code: "42501" });
    expect(await q("select 1 from public.reopen_requests where record_id = any($1)", [[J.fin, J.done]])).toEqual([]);
  });

  it("2a. the workflow is preserved: reopen_preview answers for a job the caller may reopen", async () => {
    expect(await preview(A.w1, J.preview)).toMatchObject({ ok: true, value: { allowed: true, is_admin: false, issued_invoices: [], record_ref: `J-160preview-${runId}` } });
    expect(await preview(A.office, J.doneRule)).toMatchObject({ ok: true, value: { allowed: true } });
    expect(await preview(A.w1, J.doneRule)).toMatchObject({ ok: true, value: { allowed: false, refusal_hint: "reopen_not_allowed" } });
    expect((await snap(J.preview)).finished_at).not.toBeNull();
    expect((await snap(J.preview)).requests).toBe(0);
  });

  it("2b. the tick box (no admin available) reopens the workshop's own Finish before inspection at once and leaves the request row and the audit record", async () => {
    const done = await reopen(A.w1, J.tick, "tick_box_notify");
    expect(done).toMatchObject({ ok: true, value: { status: "pending", approval_mode: "tick_box_notify", reopened: true } });
    expect((await snap(J.tick)).finished_at).toBeNull();
    const [row] = await requestsOf(J.tick);
    expect(row).toMatchObject({ status: "pending", approval_mode: "tick_box_notify", requested_by: A.w1.id, organization_id: A.org, approved_by: null });
    expect(row.notified_at).not.toBeNull();
    expect(row.reopened_at).not.toBeNull();
    expect(await q("select 1 from public.job_flow_events where job_id = $1 and kind = 'reopen' and reason = $2", [J.tick, REASON])).toHaveLength(1);
    expect(await q("select 1 from security_audit.audit_log where organization_id = $1 and action = 'reopen_requested' and entity_id = $2", [A.org, row.id])).toHaveLength(1);
    // The admin may still decide it afterwards, and a rejection does not undo the reopen.
    expect(await decide(A.admin, row.id, "reject", "Should have asked first")).toMatchObject({ ok: true, value: { status: "rejected", reopen_kept: true } });
    expect((await snap(J.tick)).finished_at).toBeNull();
    expect((await requestsOf(J.tick))[0]).toMatchObject({ status: "rejected", rejected_by: A.admin.id });
  });

  it("2c. the admin-present path: a request waits (nothing reopened), an admin approves with their own session, and the job reopens (finished and Complete jobs)", async () => {
    for (const [key, requester, complete] of [["wait", A.w1, false], ["doneWait", A.office, true]] as const) {
      const before = await snap(J[key]);
      const asked = await reopen(requester, J[key], "admin_present", REASON_2);
      expect(asked, key).toMatchObject({ ok: true, value: { status: "pending", reopened: false } });
      expect(await snap(J[key]), key).toMatchObject({ finished_at: before.finished_at, inspected_at: before.inspected_at, stage: before.stage });
      expect(await decide(A.w1, requestId(asked), "approve"), key).toMatchObject({ ok: false, code: "42501", hint: "reopen_admin_only" });
      expect(await decide(A.office, requestId(asked), "approve"), key).toMatchObject({ ok: false, code: "42501", hint: "reopen_admin_only" });
      expect((await snap(J[key])).finished_at, key).toBe(before.finished_at);
      expect(await decide(A.admin, requestId(asked), "approve"), key).toMatchObject({ ok: true, value: { status: "approved", reopened_now: true } });
      const after = await snap(J[key]);
      expect(after.finished_at, key).toBeNull();
      expect(after.inspected_at, key).toBeNull();
      expect(after.stage, key).not.toBe("complete");
      expect((await requestsOf(J[key]))[0], key).toMatchObject({ status: "approved", approved_by: A.admin.id, requested_by: requester.id });
      expect(await q("select 1 from public.job_flow_events where job_id = $1 and kind = 'reopen'", [J[key]]), key).toHaveLength(1);
      if (complete) expect(before.inspected_at, key).not.toBeNull();
    }
  });

  it("2d. a rejected request does not reopen (finished and Complete jobs)", async () => {
    for (const [key, requester] of [["rej", A.w1], ["doneRej", A.office]] as const) {
      const before = await snap(J[key]);
      const asked = await reopen(requester, J[key], "admin_present", REASON_2);
      expect(asked, key).toMatchObject({ ok: true, value: { status: "pending", reopened: false } });
      expect(await decide(A.admin, requestId(asked), "reject", "Not needed"), key).toMatchObject({ ok: true, value: { status: "rejected" } });
      expect(await snap(J[key]), key).toMatchObject({ finished_at: before.finished_at, inspected_at: before.inspected_at, stage: before.stage, events: before.events });
      expect((await requestsOf(J[key]))[0], key).toMatchObject({ status: "rejected", rejected_by: A.admin.id });
      expect(await decide(A.admin2, requestId(asked), "approve"), key).toMatchObject({ ok: false, hint: "already_decided" });
      expect((await snap(J[key])).finished_at, key).toBe(before.finished_at);
    }
  });

  it("3. 081's refusals are unchanged through the workflow: gone out, rework, not finished; an issued invoice alone is passed by the sign-off as in 113", async () => {
    for (const mode of ["tick_box_notify", "admin_present"]) {
      expect(await reopen(A.w1, J.out, mode), `out ${mode}`).toMatchObject({ ok: false, code: "22023", hint: "already_despatched" });
      expect(await reopen(A.w1, J.outInv, mode), `out and invoiced ${mode}`).toMatchObject({ ok: false, code: "22023", hint: "already_despatched" });
      expect(await reopen(A.w1, J.rework, mode), `rework ${mode}`).toMatchObject({ ok: false, code: "22023", hint: "in_rework" });
      expect(await reopen(A.w1, J.open, mode), `not finished ${mode}`).toMatchObject({ ok: false, code: "22023", hint: "not_finished" });
    }
    expect(await reopen(A.admin, J.out, "admin_present")).toMatchObject({ ok: false, code: "22023", hint: "already_despatched" });
    expect(await preview(A.w1, J.out)).toMatchObject({ ok: true, value: { allowed: false, refusal_hint: "already_despatched" } });
    expect(await preview(A.w1, J.rework)).toMatchObject({ ok: true, value: { allowed: false, refusal_hint: "in_rework" } });
    expect(await preview(A.w1, J.open)).toMatchObject({ ok: true, value: { allowed: false, refusal_hint: "not_finished" } });
    for (const key of ["out", "outInv", "rework", "open"]) {
      const s = await snap(J[key]);
      expect(s.requests, key).toBe(0);
      expect(s.events, key).toBe(0);
    }
    expect((await snap(J.out)).finished_at).not.toBeNull();
    expect((await snap(J.rework)).stage).toBe("rework");
    // 113's own rule (unchanged): an issued invoice is passed only by the sign-off, and the invoice row is left byte for byte as it was. The old
    // direct route that used to answer invoice_issued is now closed at the door, so the only way past the invoice is the sign-off.
    const invoiceBefore = (await q<{ h: string }>("select md5(string_agg(row_to_json(i)::text, '|' order by i.id)) as h from public.invoices i where job_id = $1", [J.invoiced]))[0].h;
    expect(await preview(A.w1, J.invoiced)).toMatchObject({ ok: true, value: { allowed: true, past_issued_invoice: true, issued_invoices: [`INV-160invoiced-${runId}`] } });
    expect(await direct(A.admin, J.invoiced)).toMatchObject({ ok: false, code: "42501" });
    expect(await reopen(A.w1, J.invoiced, "tick_box_notify", "Customer reported a burr, needs rework")).toMatchObject({ ok: true, value: { status: "pending", reopened: true } });
    expect((await snap(J.invoiced)).finished_at).toBeNull();
    expect((await q<{ h: string }>("select md5(string_agg(row_to_json(i)::text, '|' order by i.id)) as h from public.invoices i where job_id = $1", [J.invoiced]))[0].h).toBe(invoiceBefore);
  });

  it("4. who may reopen is unchanged through the workflow: workshop cannot reopen a Complete job or someone else's Finish; the office can", async () => {
    for (const mode of ["tick_box_notify", "admin_present"]) {
      expect(await reopen(A.w1, J.doneRule, mode), `inspected, ${mode}`).toMatchObject({ ok: false, code: "42501", hint: "reopen_not_allowed" });
      expect(await reopen(A.w1, J.other, mode), `someone else's Finish, ${mode}`).toMatchObject({ ok: false, code: "42501", hint: "reopen_not_allowed" });
    }
    for (const key of ["doneRule", "other"]) {
      const s = await snap(J[key]);
      expect(s.finished_at, key).not.toBeNull();
      expect(s.requests, key).toBe(0);
      expect(s.events, key).toBe(0);
    }
    expect((await snap(J.doneRule)).inspected_at).not.toBeNull();
    expect(await preview(A.office, J.other)).toMatchObject({ ok: true, value: { allowed: true } });
    expect(await reopen(A.office, J.office, "admin_present", REASON_2)).toMatchObject({ ok: true, value: { status: "pending", reopened: false } });
    expect(await reopen(A.admin, J.doneRule, "admin_present", REASON_2)).toMatchObject({ ok: true, value: { status: "approved", reopened: true } });
    expect((await snap(J.doneRule)).inspected_at).toBeNull();
  });

  it("5. service_role and the owner are unchanged: their grants stand across release, rollback and re-release; service_role's call is refused by reopen_job itself", async () => {
    const live = await rolledBack(async (db) => ({ service: await priv(db, "service_role"), owner: (await state(db)).owner }));
    expect(live).toEqual({ service: true, owner: true });
    const acrossStates = await rolledBack(async (db) => {
      const a = await state(db);
      await db.query(body(ROLLBACK));
      const b = await state(db);
      await db.query(body(RELEASE));
      const c = await state(db);
      return [a, b, c].map((s) => [s.service, s.owner, s.md5]);
    });
    expect(acrossStates).toEqual([[true, true, BODY_MD5], [true, true, BODY_MD5], [true, true, BODY_MD5]]);
    // service_role has no auth.uid(): reopen_job refuses it by its own check ('not authorised'), not at the door; nothing changes.
    const before = await snap(J.fin);
    const r = await direct("service_role", J.fin);
    expect(r).toMatchObject({ ok: false });
    expect((r as { message: string }).message).not.toMatch(/permission denied for function/);
    expect(await snap(J.fin)).toEqual(before);
  });

  it("6. tenant isolation: a user of company B cannot preview, record or decide a reopen for company A's job or request", async () => {
    const before = await snap(J.fin);
    for (const who of [B.admin, B.office]) {
      expect(await preview(who, J.fin)).toMatchObject({ ok: false });
      for (const mode of ["tick_box_notify", "admin_present"]) expect(await reopen(who, J.fin, mode), mode).toMatchObject({ ok: false });
      expect(await preview(who, J.done)).toMatchObject({ ok: false });
      expect(await reopen(who, J.done, "admin_present")).toMatchObject({ ok: false });
    }
    expect(await snap(J.fin)).toEqual(before);
    // A request waiting in company A: B's admin cannot approve or reject it.
    const asked = await reopen(A.office, J.fin, "admin_present", REASON_2);
    expect(asked).toMatchObject({ ok: true, value: { status: "pending", reopened: false } });
    for (const decision of ["approve", "reject"]) expect(await decide(B.admin, requestId(asked), decision), decision).toMatchObject({ ok: false });
    expect((await requestsOf(J.fin))[0]).toMatchObject({ status: "pending", approved_by: null, rejected_by: null });
    expect(await snap(J.fin)).toMatchObject({ finished_at: before.finished_at, inspected_at: before.inspected_at, stage: before.stage });
    // Company B's own job is not reachable from A either, and B cannot read A's requests.
    expect(await reopen(A.admin, J.beta, "admin_present")).toMatchObject({ ok: false });
    expect(await as(B.admin, async (db) => (await db.query("select 1 from public.reopen_requests where organization_id = $1", [A.org])).rows)).toEqual([]);
  });

  it("7. catalogue: authenticated, anon and PUBLIC cannot execute reopen_job; the body is still 081's; owner and service_role keep it; no other grant changed", async () => {
    const s = await rolledBack((db) => state(db));
    expect(s).toMatchObject({ auth: false, anon: false, pub: false, service: true, owner: true, md5: BODY_MD5 });
    expect(s.acl.filter((e) => /^(authenticated|anon)?=/.test(e))).toEqual([]);
    const states = await rolledBack(async (db) => {
      const after = { acl: await acl(db), others: await others(db) };
      await db.query(body(ROLLBACK));
      const rolled = { acl: await acl(db), others: await others(db) };
      return { after, rolled };
    });
    // 081's grants, exactly: owner, authenticated and service_role (081 revoked PUBLIC and anon).
    expect(states.rolled.acl).toEqual(["authenticated=X/postgres", "postgres=X/postgres", "service_role=X/postgres"]);
    expect(states.after.acl).toEqual(["postgres=X/postgres", "service_role=X/postgres"]);
    expect(states.after.others).toEqual(states.rolled.others);
    // 113's workflow functions are still signed-in only, and the internal helper still has no grant.
    const wf = await q<{ sig: string; auth: boolean; anon: boolean }>(`select s as sig, has_function_privilege('authenticated', to_regprocedure(s), 'EXECUTE') as auth, has_function_privilege('anon', to_regprocedure(s), 'EXECUTE') as anon
      from unnest(array['public.reopen_preview(text,uuid)', 'public.reopen_record(text,uuid,text,text)', 'public.decide_reopen_request(uuid,text,text)', 'public._reopen_job_signed_off(uuid,text)']) s`);
    expect(wf.map((r) => [r.sig, r.auth, r.anon])).toEqual([
      ["public.reopen_preview(text,uuid)", true, false], ["public.reopen_record(text,uuid,text,text)", true, false],
      ["public.decide_reopen_request(uuid,text,text)", true, false], ["public._reopen_job_signed_off(uuid,text)", false, false]]);
    expect((await q("select 1 from pg_proc where oid = to_regprocedure($1) and prosecdef", [REOPEN_JOB]))).toHaveLength(1);
  });

  it("8. the historical supabase/verify/job_flow_081.sql (unchanged) differs before and after 160 in one row only: api_functions_signed_in_only, true before and false after, by design", async () => {
    // Two rows of that file have been false since migration 099 replaced delivery_note_try_draft; they stay false in both states. 160 changes nothing else.
    const ROW = "api_functions_signed_in_only";
    const after = await verifyRows(VERIFY_081);
    expect(after.length).toBeGreaterThan(10);
    expect(after.find((r) => r.check_name === ROW)?.ok).toBe(false);
    expect(notTrue(after).sort()).toEqual([ROW, "delivery_note_try_draft_is_081", "delivery_note_try_draft_only_link_added"]);
    expect(notTrue(await verifyRows(VERIFY))).toEqual([]);
    const pre = await q<{ check: string; value: string }>(read(PREFLIGHT));
    expect(pre.find((r) => r.check === MARKER)).toMatchObject({ value: "applied" });
    expect(pre.find((r) => r.check.startsWith("160 needs"))?.value).toBe("true / 081 / 160");
    await rolledBack(async (db) => {
      await db.query(body(ROLLBACK));
      const before = await verifyRows(VERIFY_081, db);
      expect(before.find((r) => r.check_name === ROW)?.ok).toBe(true);
      expect(notTrue(before).sort()).toEqual(["delivery_note_try_draft_is_081", "delivery_note_try_draft_only_link_added"]);
      // Every other row has the same value in both states.
      const others081 = (rows: { check_name: string; ok: boolean }[]) => rows.filter((r) => r.check_name !== ROW).map((r) => [r.check_name, r.ok]);
      expect(others081(before)).toEqual(others081(after));
      // 160's own verify is not all true while 160 is rolled back (it proves the new behaviour); the marker says not applied.
      expect(notTrue(await verifyRows(VERIFY, db)).length).toBeGreaterThan(0);
      const rows = await preflight(db);
      expect(rows.find((r) => r.check === MARKER)).toMatchObject({ value: "not applied" });
      expect(rows.find((r) => r.check.startsWith("160 needs"))?.value).toBe("true / 081 / 081");
      await db.query(body(RELEASE));
      const again = await verifyRows(VERIFY_081, db);
      expect(again.map((r) => [r.check_name, r.ok])).toEqual(after.map((r) => [r.check_name, r.ok]));
      expect(notTrue(await verifyRows(VERIFY, db))).toEqual([]);
    });
  });

  it("9. release mechanics: install, repeat install changes nothing, verify true, refusals change nothing, rollback restores 081's grants exactly, re-release", async () => {
    await rolledBack(async (db) => {
      const installed = { s: await state(db), o: await others(db) };
      await db.query(body(RELEASE));
      await db.query(body(RELEASE));
      expect({ s: await state(db), o: await others(db) }, "release twice = once").toEqual(installed);
      expect(notTrue(await verifyRows(VERIFY, db))).toEqual([]);
      await db.query(body(ROLLBACK));
      const rolled = { s: await state(db), o: await others(db) };
      expect(rolled.s).toMatchObject({ auth: true, anon: false, pub: false, service: true, owner: true, md5: BODY_MD5, acl: ["authenticated=X/postgres", "postgres=X/postgres", "service_role=X/postgres"] });
      expect(rolled.o, "rollback changes no other grant, body, policy or trigger").toEqual(installed.o);
      await db.query(body(ROLLBACK));
      expect({ s: await state(db), o: await others(db) }, "rollback twice = once").toEqual(rolled);
      await db.query(body(RELEASE));
      expect({ s: await state(db), o: await others(db) }, "re-release").toEqual(installed);
      expect(notTrue(await verifyRows(VERIFY, db))).toEqual([]);
    });
    // A release that is run when the job is not reopened through 113 first: refused, changing nothing.
    const refuses = async (setup: (db: PoolClient) => Promise<void>, text: RegExp, script = RELEASE, start = "rollback") => rolledBack(async (db) => {
      if (start === "rollback") await db.query(body(ROLLBACK));
      await setup(db);
      await db.query("savepoint s");
      const e = await failure(() => db.query(body(script)));
      await db.query("rollback to savepoint s");
      expect(e.message).toMatch(text);
      return state(db);
    });
    // Release 113 missing: reopen_job would be the only way to reopen.
    const no113 = await refuses((db) => db.query("alter table public.reopen_requests rename to reopen_requests_x").then(() => undefined), /160: release 113 \(reopen sign-off\) is missing/);
    expect(no113).toMatchObject({ auth: true, service: true });
    // reopen_job with another body.
    await refuses((db) => db.query("alter function public.reopen_job(uuid, text) rename to reopen_job_x").then(() => db.query(
      "create function public.reopen_job(p_job uuid, p_reason text) returns jsonb language sql security definer set search_path = pg_catalog, public as $$ select '{}'::jsonb $$")).then(() => undefined), /160: public\.reopen_job is not 081's body/);
    // Grants that are neither 081's nor 160's: anon, or PUBLIC.
    await refuses((db) => db.query("grant execute on function public.reopen_job(uuid, text) to anon").then(() => undefined), /160: reopen_job grants are neither 081's/);
    await refuses((db) => db.query("grant execute on function public.reopen_job(uuid, text) to public").then(() => undefined), /160: reopen_job grants are neither 081's/);
    // 113's functions with the wrong grants (anon may run one): refused.
    await refuses((db) => db.query("grant execute on function public.reopen_record(text, uuid, text, text) to anon").then(() => undefined), /is missing, is not 113's definer function owned like reopen_job, or has the wrong grants/);
    // The rollback refuses the same way.
    const e = await rolledBack(async (db) => {
      await db.query("grant execute on function public.reopen_job(uuid, text) to anon");
      return failure(() => db.query(body(ROLLBACK)));
    });
    expect(e.message).toMatch(/160 rollback: reopen_job grants are neither 160's nor 081's/);
    // A refused release leaves the live database as it was.
    expect(await rolledBack((db) => state(db))).toMatchObject({ auth: false, anon: false, pub: false, md5: BODY_MD5 });
  });
});
