/**
 * Release 153 (supabase/release/153_document_customer_link.release.sql, phase 153 after 152): jobs and quotes linked to the customer
 * record by id, in a side table. The DB proof of PORTAL-153 v2 (inventory section 9), below PostgREST.
 *
 * Inputs: the disposable Supabase stack (TEST_DATABASE_URL, isolation-checked); the post-144 fixture installs 145..153. Every call runs
 * as PostgREST would: one transaction, role authenticated, the caller's JWT claims (amr carries the TOTP timestamp the fresh-code rule
 * reads). Companies are synthetic (slug t-<run>-...) and removed afterwards by destroySyntheticWorld (replica mode: link and switch rows
 * go with their company).
 * Proves: install (verify file all true, the 17 guard fingerprints read true, nothing person-made yet); the backfill (unverified only,
 * unique matches only, own company only, counted, idempotent); rollback refusals (each blocker on its own) and a successful rollback
 * with its audit trail, the go-live gate reading with 153 absent, re-apply and verify (all in rolled-back transactions); reading rules;
 * verify (roles, fresh code, batches, stale, all or nothing, events); manual link; name override; unlink; ON DELETE RESTRICT and the
 * guard; retire; the audit chain; the portal switch (status, on / off, the switch-on race, its guard and row audit).
 * Fixes of 12 Nov 2026 (PM rulings d, e and the live guard proof): the platform owner's company offboarding (who, second step, fresh code,
 * read-only support refused, every link and the switch row removed with one event and a row audit each, nothing else touched); the
 * rollback refuses while any release 154 (customer portal sign-in) object exists and after any offboarding; the verify file's release-order row; and the 17 guards'
 * full definitions and the triggers that run them, read from this database's catalogue, identical at 152 and with 153 installed.
 * PM merge condition of 12 Nov 2026: 153's own events name documents, customers and links by id, never by name (override, retire,
 * offboarding); the audit readers: office, workshop, viewer, another company's admin and anon read none of 153's audit rows (table, view,
 * Activity, a record's trail); the platform owner reads them only through a support session into the company.
 * PM ruling of 12 Nov 2026 14:55 (sensitive offboarding snapshots to authorised platform administrators only; no shared audit change):
 * the offboarding's removed rows (whole, with the name texts) are only in public.document_customer_offboarding_snapshots, which a
 * platform admin at aal2 reads and no company role (admin included), other company or anon does; the offboarding's DELETEs write no row
 * audit; the shared log gets one marker without rows, names or free text; company admins still read their company's other audit rows
 * (table, view, Activity) as before; the rollback refuses while any snapshot exists and drops the table otherwise.
 * Must not change: this file proves; it never edits a release, verify or guard file to make itself pass.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedBackend } from "../support/isolation";
import { EMAIL_DOMAIN, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";
import { decide } from "../../scripts/release-readiness-gate.mjs";

const runId = randomBytes(4).toString("hex");
let seq = 0;
const slug = (label: string) => `t-${runId}-p153-${label}-${++seq}`;
const email = (label: string) => `${label}-${++seq}.${runId}@${EMAIL_DOMAIN}`;
const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const RELEASE = "supabase/release/153_document_customer_link.release.sql";
const ROLLBACK = "supabase/release/153_document_customer_link.rollback.sql";
const VERIFY = "supabase/verify/document_customer_link_153.sql";
const GUARDS = "supabase/verify/document_customer_link_153_guards.sql";
const PREFLIGHT = "supabase/verify/release_preflight.sql";
const MARKER = "post-144 marker 153 document_customer_link";

let pool: Pool;
type Row = Record<string, unknown>;
type Res = { data: Row | null; code?: string; hint?: string; message?: string };
type Mfa = "fresh" | "stale" | "none";
type Who = { role?: string; claims?: Record<string, unknown> | null };

const nowS = () => Math.floor(Date.now() / 1000);
/** JWT claims: amr carries the authenticator step and its time (fresh: now; stale: 20 minutes ago; none: password only). */
function claims(sub: string, mfa: Mfa = "fresh", extra: Record<string, unknown> = {}) {
  const amr = mfa === "none" ? [{ method: "password", timestamp: nowS() }] : [{ method: "totp", timestamp: mfa === "fresh" ? nowS() : nowS() - 1200 }];
  return { sub, role: "authenticated", aal: mfa === "none" ? "aal1" : "aal2", email: `${sub.slice(0, 8)}@example.test`, amr, ...extra };
}
const as = (sub: string, mfa: Mfa = "fresh"): Who => ({ claims: claims(sub, mfa) });
const anon: Who = { role: "anon", claims: null };

async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await pool.connect();
  try { return (await db.query(sql, params)).rows as T[]; } finally { db.release(); }
}
async function setClaims(db: PoolClient, who: Who) {
  await db.query(`set local role ${who.role ?? "authenticated"}`);
  if (who.claims) await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(who.claims), String(who.claims.sub)]);
}
/** One call as PostgREST runs it: one transaction, committed on success. */
async function call(who: Who, expr: string, params: unknown[] = []): Promise<Res> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await setClaims(db, who);
    const { rows } = await db.query(`select ${expr} as r`, params);
    await db.query("commit");
    return { data: rows[0]?.r as Row };
  } catch (e) {
    await db.query("rollback").catch(() => undefined);
    const x = e as { code?: string; hint?: string; message: string };
    return { data: null, code: x.code, hint: x.hint, message: x.message };
  } finally { db.release(); }
}
/** A read as someone (always rolled back); a refused read returns the error code. */
async function readAs<T = Row>(who: Who, sql: string, params: unknown[] = []): Promise<T[] | string> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await setClaims(db, who);
    return (await db.query(sql, params)).rows as T[];
  } catch (e) {
    return String((e as { code?: string }).code);
  } finally {
    await db.query("rollback").catch(() => undefined);
    db.release();
  }
}
/** As the owner, in a transaction that is always rolled back. */
async function rolledBack<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    return await fn(db);
  } finally {
    await db.query("rollback").catch(() => undefined);
    db.release();
  }
}
/** The owner's statement's error (code and hint), or "ok". */
async function ownerTry(sql: string, params: unknown[] = []) {
  return rolledBack(async (db) => db.query(sql, params).then(() => "ok", (e: { code?: string; hint?: string }) => `${e.code}${e.hint ? `/${e.hint}` : ""}`));
}
/** A release file's body without its own BEGIN; and COMMIT; (exactly one of each), to run inside a test transaction. */
function body(file: string) {
  const s = read(file);
  expect(s.match(/^BEGIN;$/gm), file).toHaveLength(1);
  expect(s.match(/^COMMIT;$/gm), file).toHaveLength(1);
  return s.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
}
const verifyRows = async (db?: PoolClient) => ((db ? await db.query(read(VERIFY)) : { rows: await q(read(VERIFY)) }).rows) as { check_name: string; ok: boolean }[];
type GuardRow = { check_name: string; actual_md5: string; definition_md5: string; triggers: number; triggers_md5: string; ok: boolean };
const guardRows = async (db?: PoolClient) => ((db ? await db.query(read(GUARDS)) : { rows: await q(read(GUARDS)) }).rows) as GuardRow[];
/** The live-catalogue part of the guard rows (definition and triggers), for before / after comparison. */
const guardLive = (rows: GuardRow[]) => rows.map(({ check_name, definition_md5, triggers, triggers_md5 }) => ({ check_name, definition_md5, triggers, triggers_md5 }));
const preflightRows = async (db?: PoolClient) => ((db ? await db.query(read(PREFLIGHT)) : { rows: await q(read(PREFLIGHT)) }).rows) as { check: string; value: string }[];
const gate1a = (rows: Row[]) => decide({ preflight: { status: "ok", rows } }).checks.find((c: { id: string }) => c.id === "1a") as { pass: boolean; detail: string };
async function events(org: string, action: string) {
  return q<{ entity_id: string; actor_user_id: string | null; metadata: Row }>(
    "select entity_id, actor_user_id::text as actor_user_id, metadata from security_audit.audit_log where organization_id = $1 and action = $2 order by created_at", [org, action]);
}
async function rowAudits(org: string, table: string, action: string, ids?: string[]) {
  const rows = await q<{ entity_id: string }>("select entity_id from security_audit.audit_log where organization_id = $1 and entity_table = $2 and action = $3", [org, table, action]);
  return ids ? rows.filter((r) => ids.includes(r.entity_id)).length : rows.length;
}

async function makeCompany(o: string = randomUUID()) {
  await q("insert into organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [o, `Synthetic 153 ${o.slice(0, 8)}`, slug("co")]);
  return o;
}
async function makePerson(o: string, role: string, u: string = randomUUID()) {
  const e = email(role);
  await q("insert into auth.users (id, email) values ($1, $2)", [u, e]);
  await q("insert into user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, 'Synthetic', $3, $4, true, false)", [u, e, role, o]);
  await q("insert into organization_members (organization_id, user_id, role, active) values ($1, $2, $3, true)", [o, u, role]);
  return u;
}
const customer = async (o: string, name: string) => (await q<{ id: string }>("insert into customers (organization_id, name) values ($1, $2) returning id", [o, name]))[0].id;
const job = async (o: string, text: string | null, internal = false) =>
  (await q<{ id: string }>("insert into jobs (organization_id, job_no, customer, is_internal) values ($1, $2, $3, $4) returning id", [o, `J-${randomUUID().slice(0, 12)}`, text, internal]))[0].id;
const quote = async (o: string, text: string) =>
  (await q<{ id: string }>("insert into quotes (organization_id, quote_ref, customer) values ($1, $2, $3) returning id", [o, `Q-${randomUUID().slice(0, 12)}`, text]))[0].id;
const linkOf = async (doc: string) => (await q<{ id: string }>("select id from document_customer_links where (job_id = $1 or quote_id = $1) and unlinked_at is null", [doc]))[0]?.id;
const hideSections = (o: string, u: string, sections: string[]) => q("update organization_members set hidden_sections = $1 where user_id = $2 and organization_id = $3", [sections, u, o]);

const orgA = randomUUID();
const orgB = randomUUID();
const P: Record<string, string> = {}; // people
const C: Record<string, string> = {}; // customers
const D: Record<string, string> = {}; // documents
let support = "";
let supportSession = "";
let gateWith153: { pass: boolean; detail: string };

describe("release 153 document customer links", () => {
  beforeAll(async () => {
    await verifyBackendIdentity();
    // 145..153 on this disposable database (153 applied fresh onto 152 where it is not yet), each verify file all true.
    await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
    pool = new Pool({ connectionString: isolatedBackend().databaseUrl, max: 4 });

    await makeCompany(orgA);
    await makeCompany(orgB);
    for (const r of ["admin", "office", "workshop", "viewer"]) P[r] = await makePerson(orgA, r);
    P.adminB = await makePerson(orgB, "admin");
    // A platform owner in a support session for company A (036/066), as the 152 proof builds it.
    support = randomUUID();
    supportSession = randomUUID();
    const grant = randomUUID();
    const se = email("support");
    await q("insert into auth.users (id, email) values ($1, $2)", [support, se]);
    await q("insert into user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, 'Synthetic', 'admin', $3, true, false)", [support, se, orgA]);
    await q("insert into security_audit.platform_admins (user_id) values ($1)", [support]);
    await q("insert into organization_members (organization_id, user_id, role, active, support, expires_at, support_grant) values ($1, $2, 'admin', true, true, now() + interval '1 hour', $3)", [orgA, support, grant]);
    await q("insert into auth.sessions (id, user_id, aal) values ($1, $2, 'aal2')", [supportSession, support]);
    await q("insert into security_audit.session_company (session_id, user_id, organization_id, grant_id) values ($1, $2, $3, $4)", [supportSession, support, orgA, grant]);

    C.acme = await customer(orgA, "Acme Ltd");
    C.twin1 = await customer(orgA, "Twin Co");
    C.twin2 = await customer(orgA, " TWIN CO ");
    C.beta = await customer(orgA, "Beta Works");
    C.target = await customer(orgA, "Override Target Ltd");
    C.acmeB = await customer(orgB, "Acme Ltd");
    D.j1 = await job(orgA, "Acme Ltd");      // unique match
    D.j2 = await job(orgA, " acme ltd ");    // unique match (case and outer spaces aside)
    D.j3 = await job(orgA, "Twin Co");       // ambiguous
    D.j4 = await job(orgA, "Nobody Ltd");    // unmatched
    D.j5 = await job(orgA, "");              // no name
    D.j6 = await job(orgA, "Acme Ltd", true); // internal: never linked, never counted
    D.q1 = await quote(orgA, "Acme Ltd");
    D.q2 = await quote(orgA, "Beta Works");
    D.q3 = await quote(orgA, "Twin Co");
    D.q4 = await quote(orgA, "Typo Acme");
    D.jB = await job(orgB, "Acme Ltd");
  });

  afterAll(async () => {
    if (pool) {
      await q("delete from security_audit.session_company where user_id in (select id from auth.users where email like $1)", [`%.${runId}@${EMAIL_DOMAIN}`]).catch(() => undefined);
      await q("delete from security_audit.platform_admins where user_id in (select id from auth.users where email like $1)", [`%.${runId}@${EMAIL_DOMAIN}`]).catch(() => undefined);
      await pool.end();
    }
    await destroySyntheticWorld(runId);
  });

  it("installed: marker applied, every verify row true, the 17 guard fingerprints read true, and nothing person-made exists yet", async () => {
    expect((await preflightRows()).find((r) => r.check === MARKER)?.value).toBe("applied");
    const v = await verifyRows();
    expect(v).toHaveLength(20);
    expect(v.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
    const g = await guardRows();
    expect(g).toHaveLength(17);
    expect(g.filter((r) => r.ok !== true).map((r) => `${r.check_name} ${r.actual_md5}`)).toEqual([]);
    // Live catalogue: every guard has a definition and runs from at least one trigger outside 153's own tables.
    expect(g.filter((r) => r.definition_md5 === "missing" || r.triggers < 1 || r.triggers_md5 === "none").map((r) => r.check_name)).toEqual([]);
    // The 17 actual md5s, read from this database (inventory section 6 step 1: paste into the A1 PR), with the definition and trigger md5s.
    console.info(`153 guard fingerprints on the local stack (body md5, definition md5, triggers, triggers md5):\n${g.map((r) =>
      `${r.actual_md5}  ${r.definition_md5}  ${r.triggers}  ${r.triggers_md5}  ${r.check_name}`).join("\n")}`);
    // The release-time state still holds database-wide (the rollback proofs below rely on it): backfill rows only, no switch row, no retire.
    const [s] = await q<{ person: number; switches: number; retired: number; offboarded: number; snapshots: number }>(`select
      (select count(*) from document_customer_links where source <> 'backfill' or verified_at is not null or unlinked_at is not null)::int as person,
      (select count(*) from customer_portal_switch)::int as switches,
      (select count(*) from security_audit.audit_log where action = 'DOCUMENT_CUSTOMER_LINKS_RETIRED')::int as retired,
      (select count(*) from security_audit.audit_log where action = 'CUSTOMER_PORTAL_OFFBOARDED')::int as offboarded,
      (select count(*) from document_customer_offboarding_snapshots)::int as snapshots`);
    expect(s).toEqual({ person: 0, switches: 0, retired: 0, offboarded: 0, snapshots: 0 });
    gateWith153 = gate1a(await preflightRows());
  });

  it("backfill: unverified, unique matches of its own company only; ambiguous, unmatched and nameless counted, not inserted; internal jobs skipped; a second run adds nothing", async () => {
    expect((await call(as(P.admin), "public._document_customer_link_backfill($1::uuid)", [orgA])).code).toBe("42501");
    const [a] = await q<{ r: Row }>("select public._document_customer_link_backfill($1::uuid) as r", [orgA]);
    expect(a.r).toEqual({
      jobs: { linked_unverified: 2, ambiguous: 1, unmatched: 1, no_name: 1, already: 0 },
      quotes: { linked_unverified: 2, ambiguous: 1, unmatched: 1, no_name: 0, already: 0 },
    });
    const [b] = await q<{ r: { jobs: Row } }>("select public._document_customer_link_backfill($1::uuid) as r", [orgB]);
    expect(b.r.jobs).toMatchObject({ linked_unverified: 1 });
    const rows = await q<Row>("select organization_id::text as org, doc_kind, coalesce(job_id, quote_id)::text as doc, customer_id::text as customer, source, verified_at, unlinked_at, linked_by, document_customer_text from document_customer_links where organization_id = any($1::uuid[]) order by 1, 2, 3", [[orgA, orgB]]);
    const want = [
      [orgA, "job", D.j1, C.acme, "Acme Ltd"], [orgA, "job", D.j2, C.acme, " acme ltd "],
      [orgA, "quote", D.q1, C.acme, "Acme Ltd"], [orgA, "quote", D.q2, C.beta, "Beta Works"], [orgB, "job", D.jB, C.acmeB, "Acme Ltd"],
    ].map(([org, doc_kind, doc, cust, text]) => ({ org, doc_kind, doc, customer: cust, source: "backfill", verified_at: null, unlinked_at: null, linked_by: null, document_customer_text: text }));
    const key = (r: Row) => `${r.org}|${r.doc_kind}|${r.doc}`;
    const byKey = (x: Row, y: Row) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0);
    expect([...rows].sort(byKey)).toEqual([...want].sort(byKey));
    const ev = await events(orgA, "DOCUMENT_CUSTOMER_LINK_BACKFILL");
    expect(ev).toHaveLength(1);
    expect(ev[0].metadata).toMatchObject({ actor: "release 153", jobs: { linked_unverified: 2 }, quotes: { linked_unverified: 2 } });
    expect(await rowAudits(orgA, "document_customer_links", "INSERT")).toBe(4);
    const [again] = await q<{ r: Row }>("select public._document_customer_link_backfill($1::uuid) as r", [orgA]);
    expect(again.r).toMatchObject({ jobs: { linked_unverified: 0, already: 2 }, quotes: { linked_unverified: 0, already: 2 } });
    expect(await q("select 1 from document_customer_links where organization_id = $1", [orgA])).toHaveLength(4);
    expect(await readAs(as(P.admin), "select * from document_customer_links_verified")).toEqual([]);
    D.l1 = await linkOf(D.j1); D.l2 = await linkOf(D.j2); D.lq1 = await linkOf(D.q1); D.lq2 = await linkOf(D.q2); D.lB = await linkOf(D.jB);
  });

  it("rollback refuses each unsafe state on its own (nothing changed): person link, override, verified, unlinked, a switch row, a retire, an offboarding (event or snapshot), a dependent, any portal-154 object", async () => {
    const rb = body(ROLLBACK);
    const refused = (setup: (db: PoolClient) => Promise<unknown>) => rolledBack(async (db) => {
      await setup(db);
      return db.query(rb).then(() => "ran", (e: Error) => e.message);
    });
    const insertPerson = (src: string, doc: string, cust: string, docText: string, name: string) => async (db: PoolClient) => db.query(
      `insert into document_customer_links (organization_id, doc_kind, quote_id, customer_id, source, document_customer_text, customer_name_at_link,
         linked_by, link_reason, linked_at, verified_by, verify_reason, verified_at)
       select $1, 'quote', $2, $3, $4, $5, $6, $7, 'r', t, $7, 'r', t from (select clock_timestamp() as t) x`, [orgA, doc, cust, src, docText, name, P.admin]);
    expect(await refused(insertPerson("manual", D.q3, C.twin1, "Twin Co", "Twin Co"))).toMatch(/153 rollback: a person has linked, verified or unlinked/);
    expect(await refused(insertPerson("name_override", D.q4, C.acme, "Typo Acme", "Acme Ltd"))).toMatch(/153 rollback: a person has linked, verified or unlinked/);
    expect(await refused((db) => db.query("update document_customer_links set verified_by = $2, verify_reason = 'r', verified_at = now() where id = $1", [D.l1, P.admin])))
      .toMatch(/153 rollback: a person has linked, verified or unlinked/);
    expect(await refused((db) => db.query("update document_customer_links set unlinked_by = $2, unlink_reason = 'r', unlinked_at = now() where id = $1", [D.l1, P.admin])))
      .toMatch(/153 rollback: a person has linked, verified or unlinked/);
    expect(await refused(async (db) => {
      await db.query("select set_config('tolra.customer_portal_switch_write', $1, true)", [orgA]);
      await db.query("insert into customer_portal_switch (organization_id, enabled, changed_by, reason) values ($1, false, $2, 'r')", [orgA, P.admin]);
    })).toMatch(/153 rollback: a company has used the customer portal switch/);
    expect(await refused((db) => db.query("select security_audit.log_named_event($1::uuid, 'DOCUMENT_CUSTOMER_LINKS_RETIRED', 'document_customer_links', $1::uuid::text, '{}'::jsonb)", [orgA])))
      .toMatch(/153 rollback: an admin has retired document links/);
    expect(await refused((db) => db.query("select security_audit.log_named_event($1::uuid, 'CUSTOMER_PORTAL_OFFBOARDED', 'document_customer_links', $1::uuid::text, '{}'::jsonb)", [orgA])))
      .toMatch(/153 rollback: the platform owner has offboarded/);
    // A snapshot row alone (the only copy of an offboarding's removed rows) refuses too: the drop would lose it.
    expect(await refused((db) => db.query(`insert into document_customer_offboarding_snapshots (organization_id, offboarded_by, reason, link_count, link_rows, switch_row)
      values ($1, $2, 'r', 0, '[]'::jsonb, '{}'::jsonb)`, [orgA, support])))
      .toMatch(/153 rollback: the platform owner has offboarded/);
    // PM ruling (e): 154 (customer portal sign-in, PM ruling 12 Nov 15:10) must be rolled back before 153. Each of the objects 154's
    // own guard and marker name, alone, refuses (and the verify row still reads true: 153 is whole).
    const with154 = (setup: string) => refused(async (db) => {
      await db.query(setup);
      expect((await verifyRows(db)).filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
    });
    expect(await with154("create table public.customer_portal_contacts (id uuid)")).toMatch(/153 rollback: release 154 .* is installed and requires 153/);
    expect(await with154("create table public.customer_portal_sessions (id uuid)")).toMatch(/153 rollback: release 154 .* is installed and requires 153/);
    expect(await with154("create function public.portal_session_resolve(text) returns jsonb language sql as $$ select '{}'::jsonb $$"))
      .toMatch(/153 rollback: release 154 .* is installed and requires 153/);
    expect(await refused((db) => db.query("create function public.p153_test_dependent() returns bigint language sql as $$ select count(*) from public.document_customer_links $$")))
      .toMatch(/153 rollback: something outside 153 depends/);
    expect(await q("select 1 from document_customer_links where organization_id = $1", [orgA])).toHaveLength(4);
  });

  it("rollback with only backfill rows: audited removal, every 153 object gone, the gate reads 153 as portal-only, guards true at 152; re-apply verifies (rolled back)", async () => {
    const before = (await q<{ id: string }>("select id::text from document_customer_links where organization_id = $1 order by id", [orgA])).map((r) => r.id);
    await rolledBack(async (db) => {
      const live153 = guardLive(await guardRows(db));
      await db.query(body(ROLLBACK));
      const gone = (await db.query(`select to_regclass('public.document_customer_links') as a, to_regclass('public.document_customer_links_verified') as b,
        to_regclass('public.customer_portal_switch') as c, to_regclass('public.document_customer_offboarding_snapshots') as d,
        (select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace
        and (proname like '%document_customer%' or proname like 'customer_portal%')) as fns`)).rows[0];
      expect(gone).toEqual({ a: null, b: null, c: null, d: null, fns: 0 });
      const ev = (await db.query("select metadata from security_audit.audit_log where organization_id = $1 and action = 'DOCUMENT_CUSTOMER_LINK_ROLLBACK'", [orgA])).rows;
      expect(ev).toHaveLength(1);
      expect(ev[0].metadata).toMatchObject({ removed_unverified_backfill_links: 4, link_ids: before, actor: "release 153 rollback" });
      const del = (await db.query("select entity_id from security_audit.audit_log where organization_id = $1 and entity_table = 'document_customer_links' and action = 'DELETE'", [orgA])).rows;
      expect(del.map((r: { entity_id: string }) => r.entity_id).sort()).toEqual(before);

      // The go-live gate (A5): with 153 absent its row reads portal-only, and check 1a is exactly as it was with 153 installed.
      const pre = await preflightRows(db);
      expect(pre.find((r) => r.check === MARKER)?.value).toBe("not applied (before portal activation only)");
      const without = gate1a(pre);
      expect(without.pass).toBe(gateWith153.pass);
      expect(without.detail).not.toMatch(/153/);
      // Control: the same rows with a plain 'not applied' would block go-live (why the preflight edit is needed).
      const plain = gate1a(pre.map((r) => (r.check === MARKER ? { ...r, value: "not applied" } : r)));
      expect(plain.pass).toBe(false);
      expect(plain.detail).toMatch(/post-144 marker 153/);

      // Section 6 step 1: the 17 guards at 152. Live catalogue: each guard's full definition (with owner and grants) and every trigger that
      // runs it are identical at 152 and with 153 installed.
      const g = await guardRows(db);
      expect(g.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
      expect(guardLive(g)).toEqual(live153);

      // Re-apply: the release's own guard, fingerprint and self-check pass; verify all true; release-time state.
      await db.query(body(RELEASE));
      expect((await preflightRows(db)).find((r) => r.check === MARKER)?.value).toBe("applied");
      const v = await verifyRows(db);
      expect(v.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
      expect(guardLive(await guardRows(db))).toEqual(live153);
      const st = (await db.query(`select
        (select count(*) from document_customer_links where source <> 'backfill' or verified_at is not null or unlinked_at is not null)::int as person,
        (select count(*) from document_customer_links_verified)::int as shown, (select count(*) from customer_portal_switch)::int as switches,
        (select count(*) from document_customer_links where organization_id = $1)::int as a`, [orgA])).rows[0];
      expect(st).toEqual({ person: 0, shown: 0, switches: 0, a: 4 });
    });
    expect((await preflightRows()).find((r) => r.check === MARKER)?.value).toBe("applied");
    expect((await q<{ id: string }>("select id::text from document_customer_links where organization_id = $1 order by id", [orgA])).map((r) => r.id)).toEqual(before);
  });

  it("reading: admin and office of the company, in the sections they may see; never workshop, viewer, another company or anon", async () => {
    const n = async (who: Who) => { const r = await readAs(who, "select id from document_customer_links"); return typeof r === "string" ? r : r.length; };
    expect(await n(as(P.admin))).toBe(4);
    expect(await n(as(P.office))).toBe(4);
    expect(await n(as(P.workshop))).toBe(0);
    expect(await n(as(P.viewer))).toBe(0);
    expect(await n(as(P.adminB))).toBe(1);
    expect(await n(anon)).toBe("42501");
    await hideSections(orgA, P.office, ["quotes"]);
    expect(await n(as(P.office))).toBe(2);
    await hideSections(orgA, P.office, []);
    expect(await readAs(as(P.admin), "select * from customer_portal_switch")).toEqual([]);
    expect(await readAs(as(P.office), "select * from document_customer_links_verified")).toEqual([]);
  });

  it("verify: admin and office with a fresh code; batches 1..200, each once; all or nothing; stale refused; one event per link", async () => {
    const v = (who: Who, ids: string[], reason = "checked against the order") => call(who, "public.verify_document_customer_links($1::uuid[], $2)", [ids, reason]);
    for (const who of [as(P.workshop), as(P.viewer)]) expect(await v(who, [D.l1])).toMatchObject({ code: "42501", hint: "admin_or_office_required" });
    expect((await v({ claims: claims(support, "fresh", { session_id: supportSession }) }, [D.l1])).code).toBe("42501");
    expect((await v(anon, [D.l1])).code).toBe("42501");
    expect((await v({ role: "service_role", claims: { sub: P.admin, role: "service_role" } }, [D.l1])).code).toBe("42501");
    expect(await v(as(P.office, "none"), [D.l1])).toMatchObject({ hint: "mfa_recent_required" });
    expect(await v(as(P.office, "stale"), [D.l1])).toMatchObject({ hint: "mfa_recent_required" });
    expect(await v(as(P.admin), Array.from({ length: 201 }, () => randomUUID()))).toMatchObject({ hint: "invalid_batch" });
    expect(await v(as(P.admin), [D.l1, D.l1])).toMatchObject({ hint: "invalid_batch" });
    expect(await v(as(P.admin), [])).toMatchObject({ hint: "invalid_batch" });
    expect(await v(as(P.admin), [D.l1], " ")).toMatchObject({ hint: "reason_required" });
    expect(await v(as(P.admin), [D.l1, D.lB])).toMatchObject({ hint: "link_not_found" });
    expect((await q("select verified_at from document_customer_links where id = $1", [D.l1]))[0].verified_at).toBeNull();

    expect((await v(as(P.admin), [D.l1])).data).toMatchObject({ verified: 1 });
    expect(await v(as(P.office), [D.lq1, D.l1])).toMatchObject({ hint: "not_pending" });
    expect((await q("select verified_at from document_customer_links where id = $1", [D.lq1]))[0].verified_at).toBeNull();
    expect((await v(as(P.office), [D.lq1])).data).toMatchObject({ verified: 1 });
    const shown = (await readAs<{ document_id: string; source: string }>(as(P.admin), "select document_id::text, source from document_customer_links_verified")) as { document_id: string; source: string }[];
    expect(shown.map((r) => `${r.document_id}|${r.source}`).sort()).toEqual([`${D.j1}|backfill`, `${D.q1}|backfill`].sort());

    // Stale: the document's customer text changed, or the customer was renamed (by the service side), since the backfill.
    await q("update jobs set customer = 'Acme Ltd (old)' where id = $1", [D.j2]);
    expect(await v(as(P.admin), [D.l2])).toMatchObject({ hint: "link_stale" });
    await q("update customers set name = 'Beta Works Group' where id = $1", [C.beta]);
    expect(await v(as(P.office), [D.lq2])).toMatchObject({ hint: "link_stale" });

    const ev = await events(orgA, "DOCUMENT_CUSTOMER_LINK_VERIFIED");
    expect(ev.map((e) => e.entity_id).sort()).toEqual([D.l1, D.lq1].sort());
    expect(ev.map((e) => e.actor_user_id).sort()).toEqual([P.admin, P.office].sort());
    expect(await rowAudits(orgA, "document_customer_links", "UPDATE", [D.l1, D.lq1])).toBe(2);
  });

  it("manual link: admin or office, fresh code, reason, names must match; refused across companies, sections, kinds and internal jobs", async () => {
    C.nobody = await customer(orgA, "Nobody Ltd");
    const link = (who: Who, kind: string, doc: string, cust: string, reason = "customer picked by id") =>
      call(who, "public.link_document_customer($1, $2::uuid, $3::uuid, $4)", [kind, doc, cust, reason]);
    expect(await link(as(P.office, "none"), "job", D.j4, C.nobody)).toMatchObject({ hint: "mfa_recent_required" });
    expect(await link(as(P.office, "stale"), "job", D.j4, C.nobody)).toMatchObject({ hint: "mfa_recent_required" });
    expect(await link(as(P.workshop), "job", D.j4, C.nobody)).toMatchObject({ hint: "admin_or_office_required" });
    expect(await link(as(P.office), "invoice", D.j4, C.nobody)).toMatchObject({ hint: "invalid_kind" });
    expect(await link(as(P.office), "quote", D.q4, C.acme)).toMatchObject({ hint: "customer_mismatch" });
    expect(await link(as(P.office), "job", D.j1, C.acme)).toMatchObject({ hint: "already_linked" });
    expect(await link(as(P.office), "job", D.j6, C.acme)).toMatchObject({ hint: "internal_job" });
    expect(await link(as(P.office), "job", D.jB, C.acme)).toMatchObject({ hint: "document_not_found" });
    expect(await link(as(P.office), "job", D.j5, C.acmeB)).toMatchObject({ hint: "customer_not_found" });
    await hideSections(orgA, P.office, ["quotes"]);
    expect(await link(as(P.office), "quote", D.q3, C.twin1)).toMatchObject({ hint: "document_not_found" });
    await hideSections(orgA, P.office, []);

    const ok = await link(as(P.office), "job", D.j4, C.nobody);
    expect(ok.data).toMatchObject({ doc_kind: "job", document_id: D.j4, customer_id: C.nobody, source: "manual" });
    D.l4 = String(ok.data!.link_id);
    const [row] = await q("select linked_by::text, verified_by::text, verified_at = linked_at as same from document_customer_links where id = $1", [D.l4]);
    expect(row).toEqual({ linked_by: P.office, verified_by: P.office, same: true });
    expect((await readAs<{ id: string }>(as(P.office), "select id::text from document_customer_links_verified where id = $1", [D.l4]))).toHaveLength(1);
    expect((await events(orgA, "DOCUMENT_CUSTOMER_LINKED")).map((e) => e.entity_id)).toEqual([D.l4]);
  });

  it("name override: admin only, identity confirmed, names must differ; its own event; hidden again once the document text changes", async () => {
    const ov = (who: Who, kind: string, doc: string, cust: string, confirmed: boolean | null = true) =>
      call(who, "public.link_document_customer_name_override($1, $2::uuid, $3::uuid, $4, $5)", [kind, doc, cust, "typo on the sent quote; customer confirmed by phone", confirmed]);
    expect(await ov(as(P.office), "quote", D.q4, C.target)).toMatchObject({ hint: "admin_required" });
    expect(await ov(as(P.admin, "stale"), "quote", D.q4, C.target)).toMatchObject({ hint: "mfa_recent_required" });
    expect(await ov(as(P.admin), "quote", D.q4, C.target, false)).toMatchObject({ hint: "identity_not_confirmed" });
    expect(await ov(as(P.admin), "quote", D.q4, C.target, null)).toMatchObject({ hint: "identity_not_confirmed" });
    expect(await ov(as(P.admin), "quote", D.q3, C.twin1)).toMatchObject({ hint: "names_match" });
    expect(await ov(as(P.admin), "job", D.j5, C.target)).toMatchObject({ hint: "no_customer_text" });

    const ok = await ov(as(P.admin), "quote", D.q4, C.target);
    expect(ok.data).toMatchObject({ source: "name_override", document_id: D.q4, customer_id: C.target });
    D.lq4 = String(ok.data!.link_id);
    const ev = await events(orgA, "DOCUMENT_CUSTOMER_LINKED_NAME_OVERRIDE");
    expect(ev).toHaveLength(1);
    expect(ev[0].metadata).toMatchObject({ doc_kind: "quote", document_id: D.q4, customer_id: C.target, identity_confirmed: true, actor: P.admin });
    // PM merge condition (12 Nov): the event names the document, customer and link by id, never by name; the name texts stay in the link
    // row's own row-audit INSERT (the shared log_row_change records whole rows).
    expect(ev[0].entity_id).toBe(D.lq4);
    expect(ev[0].metadata).not.toHaveProperty("document_customer_text");
    expect(ev[0].metadata).not.toHaveProperty("customer_name");
    expect(JSON.stringify(ev[0].metadata)).not.toMatch(/Typo Acme|Override Target/);
    const [ins] = await q<{ new_data: Row }>("select new_data from security_audit.audit_log where organization_id = $1 and entity_table = 'document_customer_links' and action = 'INSERT' and entity_id = $2", [orgA, D.lq4]);
    expect(ins.new_data).toMatchObject({ document_customer_text: "Typo Acme", customer_name_at_link: "Override Target Ltd" });
    const shown = async () => (await readAs<{ id: string }>(as(P.admin), "select id::text from document_customer_links_verified where id = $1", [D.lq4])) as { id: string }[];
    expect(await shown()).toHaveLength(1);
    await q("update quotes set customer = 'Typo Acme Ltd' where id = $1", [D.q4]);
    expect(await shown()).toHaveLength(0);
  });

  it("unlink: admin or office, once, with a reason; the row stays as history; no other change is possible", async () => {
    const un = (who: Who, kind: string, doc: string) => call(who, "public.unlink_document_customer($1, $2::uuid, $3)", [kind, doc, "wrong customer"]);
    expect(await un(as(P.viewer), "job", D.j2)).toMatchObject({ hint: "admin_or_office_required" });
    expect(await un(as(P.office, "none"), "job", D.j2)).toMatchObject({ hint: "mfa_recent_required" });
    expect((await un(as(P.office), "job", D.j2)).data).toMatchObject({ link_id: D.l2 });
    expect(await un(as(P.office), "job", D.j2)).toMatchObject({ hint: "not_linked" });
    const [row] = await q("select unlinked_by::text, unlink_reason, unlinked_at is not null as gone from document_customer_links where id = $1", [D.l2]);
    expect(row).toEqual({ unlinked_by: P.office, unlink_reason: "wrong customer", gone: true });
    expect((await events(orgA, "DOCUMENT_CUSTOMER_UNLINKED"))[0].metadata).toMatchObject({ was_source: "backfill", was_verified: false });
    expect(await ownerTry("update document_customer_links set unlinked_at = now() where id = $1", [D.l2])).toBe("42501/link_immutable");
    expect(await ownerTry("update document_customer_links set customer_id = $2 where id = $1", [D.l1, C.nobody])).toBe("42501/link_immutable");
    expect(await ownerTry("insert into document_customer_links (organization_id, doc_kind, job_id, customer_id, source, document_customer_text, customer_name_at_link, verified_by, verify_reason, verified_at) values ($1, 'job', $2, $3, 'backfill', 'Twin Co', 'Twin Co', $4, 'r', now())", [orgA, D.j3, C.twin1, P.admin])).toBe("42501/link_immutable");
  });

  it("delete: a job, quote or customer with any link history is refused (23503), rows unchanged; raw link deletes are refused, the owner too", async () => {
    const count = async () => (await q("select 1 from document_customer_links where organization_id = $1", [orgA])).length;
    const n = await count();
    expect(await ownerTry("delete from jobs where id = $1", [D.j1])).toBe("23503");      // verified link
    expect(await ownerTry("delete from quotes where id = $1", [D.q2])).toBe("23503");    // unverified backfill link
    expect(await ownerTry("delete from jobs where id = $1", [D.j2])).toBe("23503");      // unlinked history only
    expect(await ownerTry("delete from customers where id = $1", [C.target])).toBe("23503"); // override link; no document names it
    expect(await readAs(as(P.admin), "delete from public.jobs where id = $1", [D.j1])).toBe("23503"); // through the API: admin's own delete
    expect(await count()).toBe(n);
    expect(await ownerTry("delete from document_customer_links where id = $1", [D.l1])).toBe("42501/link_immutable");
    // The removal flag names another document: still refused.
    expect(await rolledBack(async (db) => {
      await db.query("select set_config('tolra.document_customer_link_removal', 'retire:job:' || $1::text, true)", [D.j2]);
      return db.query("delete from document_customer_links where id = $1", [D.l1]).then(() => "ok", (e: { code?: string; hint?: string }) => `${e.code}/${e.hint}`);
    })).toBe("42501/link_immutable");
    expect(await ownerTry("truncate document_customer_links")).toBe("42501/link_immutable");
    expect(await count()).toBe(n);
  });

  it("retire: admin only, fresh code, reason; snapshot of exactly the removed rows; each removal audited; then the document or customer can go", async () => {
    const rt = (who: Who, kind: string, id: string) => call(who, "public.retire_document_customer_links($1, $2::uuid, $3)", [kind, id, "job cancelled; record retention reviewed"]);
    expect(await rt(as(P.office), "job", D.j2)).toMatchObject({ hint: "admin_required" });
    expect(await rt(as(P.admin, "stale"), "job", D.j2)).toMatchObject({ hint: "mfa_recent_required" });
    expect(await rt(as(P.admin), "invoice", D.j2)).toMatchObject({ hint: "invalid_kind" });
    expect(await rt(as(P.admin), "job", D.j3)).toMatchObject({ hint: "not_linked" });
    expect(await rt(as(P.adminB), "job", D.j2)).toMatchObject({ hint: "not_linked" });

    expect((await rt(as(P.admin), "job", D.j2)).data).toMatchObject({ retired: 1, target_kind: "job", target_id: D.j2 });
    const ev = await events(orgA, "DOCUMENT_CUSTOMER_LINKS_RETIRED");
    expect(ev).toHaveLength(1);
    const rows = ev[0].metadata.rows as Row[];
    expect(rows.map((r) => r.id)).toEqual([D.l2]);
    expect(rows[0]).toMatchObject({ job_id: D.j2, customer_id: C.acme, unlink_reason: "wrong customer", source: "backfill" });
    // Ids, stamps and reasons, not the name texts (PM merge condition, 12 Nov); the row's own row-audit DELETE keeps its full content.
    expect(rows[0]).not.toHaveProperty("document_customer_text");
    expect(rows[0]).not.toHaveProperty("customer_name_at_link");
    const [del] = await q<{ old_data: Row }>("select old_data from security_audit.audit_log where organization_id = $1 and entity_table = 'document_customer_links' and action = 'DELETE' and entity_id = $2", [orgA, D.l2]);
    expect(del.old_data).toMatchObject({ id: D.l2, document_customer_text: " acme ltd ", customer_name_at_link: "Acme Ltd" });
    expect(ev[0].metadata).toMatchObject({ count: 1, actor: P.admin });
    expect(await rowAudits(orgA, "document_customer_links", "DELETE", [D.l2])).toBe(1);
    expect(await q("select 1 from document_customer_links where id = $1", [D.l2])).toHaveLength(0);
    await q("delete from jobs where id = $1", [D.j2]);

    expect((await rt(as(P.admin), "customer", C.target)).data).toMatchObject({ retired: 1 });
    expect(await rowAudits(orgA, "document_customer_links", "DELETE", [D.lq4])).toBe(1);
    await q("delete from customers where id = $1", [C.target]);

    // 077: company A's audit chain still verifies (links and hashes) after the link, verify, unlink, override and retire rows.
    const [chain] = await rolledBack(async (db) => {
      await db.query("set local timezone to 'UTC'");
      return (await db.query(`
        with r as (select a.*, lag(a.hash) over (partition by a.organization_id order by a.created_at) as expected_previous
                   from security_audit.audit_log a where a.organization_id = $1)
        select count(*)::int as total, count(*) filter (where previous_hash is distinct from expected_previous)::int as broken_links,
               count(*) filter (where hash is distinct from encode(extensions.digest(
                 coalesce(previous_hash, '') || coalesce(organization_id::text, '') || coalesce(actor_user_id::text, '') || action || entity_table ||
                 coalesce(entity_id, '') || coalesce(old_data::text, '') || coalesce(new_data::text, '') || coalesce(metadata::text, '') || created_at::text,
                 'sha256'), 'hex'))::int as bad_hashes
        from r`, [orgA])).rows;
    });
    expect(chain).toMatchObject({ broken_links: 0, bad_hashes: 0 });
    expect(chain.total).toBeGreaterThan(10);
  });

  it("portal switch: admin only; ON needs a fresh code, OFF never waits; two switch-ons at once log one change; only the setting writes it; audited", async () => {
    const set = (who: Who, on: boolean | null, reason = "portal pilot") => call(who, "public.customer_portal_set_enabled($1, $2)", [on, reason]);
    expect(await call(as(P.office), "public.customer_portal_status()")).toMatchObject({ hint: "admin_required" });
    expect((await call({ claims: claims(support, "fresh", { session_id: supportSession }) }, "public.customer_portal_status()")).code).toBe("42501");
    expect((await call(as(P.admin, "none"), "public.customer_portal_status()")).data).toEqual({ enabled: false, changed_at: null });
    expect(await set(as(P.office), true)).toMatchObject({ hint: "admin_required" });
    expect(await set(as(P.admin, "none"), true)).toMatchObject({ hint: "mfa_recent_required" });
    expect(await set(as(P.admin), null)).toMatchObject({ hint: "invalid_enabled" });
    expect(await set(as(P.admin), true, "")).toMatchObject({ hint: "reason_required" });
    expect((await set(as(P.admin, "none"), false)).data).toEqual({ enabled: false, changed_at: null });
    expect(await q("select 1 from customer_portal_switch where organization_id = $1", [orgA])).toHaveLength(0);

    // Two switch-ons at once: the second waits on the row the first inserted, then sees it on and logs nothing.
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      for (const db of [a, b]) { await db.query("begin"); await setClaims(db, as(P.admin)); }
      const first = (await a.query("select public.customer_portal_set_enabled(true, 'race one') as r")).rows[0].r;
      const second = b.query("select public.customer_portal_set_enabled(true, 'race two') as r");
      await new Promise((r) => setTimeout(r, 300));
      await a.query("commit");
      const late = (await second).rows[0].r;
      await b.query("commit");
      expect(first.changed_at).not.toBeNull();
      expect(late).toMatchObject({ enabled: true, changed_at: null });
    } finally {
      await a.query("rollback").catch(() => undefined);
      await b.query("rollback").catch(() => undefined);
      a.release();
      b.release();
    }
    expect((await events(orgA, "CUSTOMER_PORTAL_SWITCH_CHANGED")).map((e) => e.metadata)).toEqual([expect.objectContaining({ enabled: true, was: false, reason: "race one" })]);
    expect((await call(as(P.admin, "none"), "public.customer_portal_status()")).data).toMatchObject({ enabled: true });
    expect((await set(as(P.admin, "none"), false, "pilot paused")).data).toMatchObject({ enabled: false });
    expect(await events(orgA, "CUSTOMER_PORTAL_SWITCH_CHANGED")).toHaveLength(2);

    expect(await ownerTry("update customer_portal_switch set enabled = true where organization_id = $1", [orgA])).toBe("42501/switch_immutable");
    expect(await ownerTry("delete from customer_portal_switch where organization_id = $1", [orgA])).toBe("42501/switch_immutable");
    expect(await ownerTry("truncate customer_portal_switch")).toBe("42501/switch_immutable");
    expect(await ownerTry("insert into customer_portal_switch (organization_id, enabled, changed_by, reason) values ($1, true, $2, 'r')", [orgB, P.adminB])).toBe("42501/switch_immutable");
    expect(await rowAudits(orgA, "customer_portal_switch", "INSERT")).toBe(1);
    expect(await rowAudits(orgA, "customer_portal_switch", "UPDATE")).toBeGreaterThanOrEqual(2);
    expect((await readAs<Row>(as(P.office), "select * from customer_portal_switch"))).toEqual([]);

    // Every verify row stays true after people linked, verified, unlinked, retired and switched.
    expect((await verifyRows()).filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
  });
  it("offboarding (PM ruling d; snapshot ruling 12 Nov 14:55): platform owner only, second step, fresh code, never read-only support; every link and the switch row of one company removed into one platform-only snapshot, one non-sensitive marker, no row audit; nothing else touched", async () => {
    const off = (who: Who, org: string, reason = "company offboarded at its request") =>
      call(who, "public.platform_offboard_document_customer_links($1::uuid, $2)", [org, reason]);
    const owner = (mfa: Mfa = "fresh", extra: Record<string, unknown> = {}) => ({ claims: claims(support, mfa, extra) });
    expect(await off(as(P.admin), orgA)).toMatchObject({ code: "42501", hint: "platform_required" });
    expect(await off(anon, orgA)).toMatchObject({ code: "42501" });
    expect(await off(owner("none"), orgA)).toMatchObject({ code: "42501", hint: "mfa_required" });
    expect(await off(owner("stale"), orgA)).toMatchObject({ code: "42501", hint: "mfa_recent_required" });
    expect(await off(owner("fresh", { session_id: supportSession }), orgA)).toMatchObject({ code: "42501", hint: "support_read_only" });
    expect(await off(owner(), randomUUID())).toMatchObject({ hint: "company_not_found" });
    expect(await off(owner(), orgA, "")).toMatchObject({ hint: "reason_required" });
    expect(await events(orgA, "CUSTOMER_PORTAL_OFFBOARDED")).toHaveLength(0);

    const linksA = (await q<{ id: string }>("select id::text from document_customer_links where organization_id = $1 order by id", [orgA])).map((r) => r.id);
    const [sw] = await q<{ id: string }>("select id::text from customer_portal_switch where organization_id = $1", [orgA]);
    expect(linksA.length).toBeGreaterThan(0);
    expect(sw).toBeTruthy();
    const linksB = (await q<{ id: string }>("select id::text from document_customer_links where organization_id = $1 order by id", [orgB])).map((r) => r.id);
    const kept = async () => (await q<{ jobs: number; quotes: number; customers: number; audit: number }>(`select
      (select count(*) from jobs where organization_id = $1)::int as jobs, (select count(*) from quotes where organization_id = $1)::int as quotes,
      (select count(*) from customers where organization_id = $1)::int as customers,
      (select count(*) from security_audit.audit_log where organization_id = $1)::int as audit`, [orgA]))[0];
    const was = await kept();
    // The flags are the only way in, and only for the company they name: a flag naming company B removes nothing of company A, the owner too.
    const flagged = (setting: string, sql: string) => rolledBack(async (db) => {
      await db.query("select set_config($1, 'offboard:' || $2::text, true)", [setting, orgB]);
      return db.query(sql, [orgA]).then(() => "ok", (e: { code?: string; hint?: string }) => `${e.code}/${e.hint}`);
    });
    expect(await flagged("tolra.document_customer_link_removal", "delete from document_customer_links where organization_id = $1")).toBe("42501/link_immutable");
    expect(await flagged("tolra.customer_portal_switch_write", "delete from customer_portal_switch where organization_id = $1")).toBe("42501/switch_immutable");

    // The rows exactly as they are just before the removal (whole, with the two name texts), in the function's order.
    const linksFull = (await q<{ r: Row }>("select to_jsonb(l) as r from document_customer_links l where organization_id = $1 order by linked_at, id", [orgA])).map((x) => x.r);
    const [swFull] = await q<{ r: Row }>("select to_jsonb(s) as r from customer_portal_switch s where organization_id = $1", [orgA]);
    const res = await off(owner(), orgA);
    expect(res.data).toEqual({ removed_links: linksA.length, removed_switch: true, organization_id: orgA, snapshot_id: expect.any(String) });
    const snapshotId = String(res.data?.snapshot_id);
    // The sensitive snapshot (PM ruling, 12 Nov 14:55): exactly the removed rows and the switch row, whole, in the platform-only table.
    const snaps = await q<{ id: string; organization_id: string; offboarded_by: string; reason: string; link_count: number; link_rows: Row[]; switch_row: Row }>(
      "select id::text, organization_id::text, offboarded_by::text, reason, link_count, link_rows, switch_row from document_customer_offboarding_snapshots where organization_id = $1", [orgA]);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ id: snapshotId, organization_id: orgA, offboarded_by: support, reason: "company offboarded at its request", link_count: linksA.length });
    expect(snaps[0].link_rows).toEqual(linksFull);
    expect(snaps[0].link_rows.map((r) => String(r.id)).sort()).toEqual(linksA);
    expect(snaps[0].link_rows.every((r) => typeof r.document_customer_text === "string" && typeof r.customer_name_at_link === "string")).toBe(true);
    expect(snaps[0].switch_row).toEqual(swFull.r);
    expect(snaps[0].switch_row).toMatchObject({ id: sw.id, organization_id: orgA });
    // The shared audit log gets only the non-sensitive marker: no rows, no switch row, no free-text reason, no name.
    const ev = await events(orgA, "CUSTOMER_PORTAL_OFFBOARDED");
    expect(ev).toHaveLength(1);
    expect(ev[0].actor_user_id).toBe(support);
    expect(ev[0].metadata).toEqual({ source: "write_audit", snapshot_id: snapshotId, count: linksA.length, switch_removed: true, reason_category: "company_offboarding", actor: support });
    // The offboarding's DELETEs write no row audit (the removed rows are only in the snapshot); retire's still do (retire case above).
    expect(await rowAudits(orgA, "document_customer_links", "DELETE", linksA)).toBe(0);
    expect(await rowAudits(orgA, "customer_portal_switch", "DELETE", [sw.id])).toBe(0);
    // The snapshot is a record: no change, removal or emptying, the owner too.
    expect(await ownerTry("update document_customer_offboarding_snapshots set reason = 'changed' where id = $1", [snapshotId])).toBe("42501/snapshot_immutable");
    expect(await ownerTry("delete from document_customer_offboarding_snapshots where id = $1", [snapshotId])).toBe("42501/snapshot_immutable");
    expect(await ownerTry("truncate document_customer_offboarding_snapshots")).toBe("42501/snapshot_immutable");
    // 153 holds nothing of company A any more, so it no longer stands in the way of removing the company; company B is untouched;
    // no job, quote, customer or audit row of A was removed (the audit log only grew).
    expect(await q("select 1 from document_customer_links where organization_id = $1 union all select 1 from customer_portal_switch where organization_id = $1", [orgA])).toHaveLength(0);
    expect((await q<{ id: string }>("select id::text from document_customer_links where organization_id = $1 order by id", [orgB])).map((r) => r.id)).toEqual(linksB);
    const now = await kept();
    expect({ jobs: now.jobs, quotes: now.quotes, customers: now.customers }).toEqual({ jobs: was.jobs, quotes: was.quotes, customers: was.customers });
    expect(now.audit).toBe(was.audit + 1); // the marker only
    // Nothing left: refused, nothing written.
    expect(await off(owner(), orgA)).toMatchObject({ hint: "nothing_to_offboard" });
    expect(await events(orgA, "CUSTOMER_PORTAL_OFFBOARDED")).toHaveLength(1);
    expect(await q("select 1 from document_customer_offboarding_snapshots where organization_id = $1", [orgA])).toHaveLength(1);
    expect((await verifyRows()).filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
  });

  it("audit readers (PM merge condition, 12 Nov): office, workshop, viewer, another company's admin and anon read none of 153's audit rows; the platform owner reads them only through a support session; no 153 event names a customer", async () => {
    // Company A's 153 audit rows (row audits of both tables and the named events), read as the owner.
    const ids153 = (await q<{ id: string }>(`select id::text from security_audit.audit_log where organization_id = $1
      and (entity_table in ('document_customer_links', 'customer_portal_switch') or action like 'DOCUMENT_CUSTOMER%' or action like 'CUSTOMER_PORTAL%')`, [orgA])).map((r) => r.id);
    const offboarded = (await events(orgA, "CUSTOMER_PORTAL_OFFBOARDED"));
    expect(offboarded).toHaveLength(1);
    const [offId] = (await q<{ id: string }>("select id::text from security_audit.audit_log where organization_id = $1 and action = 'CUSTOMER_PORTAL_OFFBOARDED'", [orgA])).map((r) => r.id);
    // Link DELETE row audits exist (retire's); the offboarding wrote none, so the switch row's removal has no row audit.
    expect(await rowAudits(orgA, "document_customer_links", "DELETE")).toBeGreaterThan(0);
    expect(await rowAudits(orgA, "customer_portal_switch", "DELETE")).toBe(0);
    expect(ids153.length).toBeGreaterThan(5);
    const direct = (who: Who) => readAs<{ id: string }>(who, "select id::text from security_audit.audit_log where id = any($1::uuid[])", [ids153]);
    const view = (who: Who) => readAs<{ id: string }>(who, "select id::text from public.audit_log_view where id = any($1::uuid[])", [ids153]);
    const activity = (who: Who) => readAs<{ id: string }>(who, "select id::text from public.org_activity(p_limit => 500) where id = any($1::uuid[])", [ids153]);
    const recordTrail = (who: Who, table: string, id: string) =>
      readAs<{ entity_table: string }>(who, "select entity_table from public.record_activity($1, $2::uuid, 500)", [table, id]);

    // Routine company access: office, workshop, viewer of the same company; the admin of another company.
    for (const who of [P.office, P.workshop, P.viewer, P.adminB]) {
      expect(await direct(as(who))).toEqual([]);
      expect(await view(as(who))).toEqual([]);
    }
    for (const who of [P.office, P.workshop, P.viewer]) expect(await activity(as(who))).toBe("42501");
    expect(await activity(as(P.adminB))).toEqual([]);
    // Company A's admin: every one of these rows exactly as before (the shared policy, audit_log_view and Activity are unchanged; no
    // regression), the non-sensitive offboarding marker included.
    expect(((await direct(as(P.admin))) as { id: string }[]).map((r) => r.id).sort()).toEqual([...ids153].sort());
    expect(((await view(as(P.admin))) as { id: string }[]).map((r) => r.id).sort()).toEqual([...ids153].sort());
    expect(((await activity(as(P.admin))) as { id: string }[]).map((r) => r.id)).toContain(offId);
    // A record's own trail never lists a 153 table, for anyone who may open it.
    for (const who of [P.admin, P.office, P.workshop, P.viewer]) {
      for (const [table, id] of [["jobs", D.j1], ["quotes", D.q1], ["quotes", D.q4]] as const) {
        const trail = await recordTrail(as(who), table, id);
        if (Array.isArray(trail)) expect(trail.filter((r) => ["document_customer_links", "customer_portal_switch"].includes(r.entity_table))).toEqual([]);
        else expect(trail).toBe("42501");
      }
    }
    // Not signed in: no privilege at all.
    expect(await direct(anon)).toBe("42501");
    expect(await view(anon)).toBe("42501");
    expect(await activity(anon)).toBe("42501");

    // The platform owner: nothing without choosing the company (no support session on the token), and nothing at aal1; the whole set
    // through a support session into company A (036: aal2, the entry is logged in org_entry_log).
    expect(await direct({ claims: claims(support, "fresh") })).toEqual([]);
    expect(await direct({ claims: claims(support, "none", { session_id: supportSession }) })).toEqual([]);
    const viaSupport = { claims: claims(support, "fresh", { session_id: supportSession }) };
    expect(((await direct(viaSupport)) as { id: string }[]).map((r) => r.id).sort()).toEqual([...ids153].sort());
    expect(((await view(viaSupport)) as { id: string }[]).map((r) => r.id).sort()).toEqual([...ids153].sort());
    expect(((await activity(viaSupport)) as { id: string }[]).map((r) => r.id)).toContain(offId);

    // No 153 named event, in either company, carries a customer's name or a document's customer text (stable ids only).
    const named = await q<{ action: string; metadata: Row }>(`select action, metadata from security_audit.audit_log
      where organization_id = any($1::uuid[]) and (action like 'DOCUMENT_CUSTOMER%' or action like 'CUSTOMER_PORTAL%')`, [[orgA, orgB]]);
    expect(named.length).toBeGreaterThan(5);
    const names = (await q<{ name: string }>("select name from customers where organization_id = any($1::uuid[]) union select customer from jobs where organization_id = any($1::uuid[]) and btrim(coalesce(customer, '')) <> '' union select customer from quotes where organization_id = any($1::uuid[]) and btrim(customer) <> ''", [[orgA, orgB]])).map((r) => r.name.trim().toLowerCase());
    for (const e of named) {
      const text = JSON.stringify(e.metadata).toLowerCase();
      expect(names.filter((n) => text.includes(n)), e.action).toEqual([]);
      expect(text, e.action).not.toMatch(/document_customer_text|customer_name/);
    }
  });

  it("offboarding snapshot readers (PM ruling, 12 Nov 14:55): only a platform admin at aal2 reads it; company A's admin, office, workshop, viewer, another company's admin, the platform admin at aal1 and anon read none; no API role writes it", async () => {
    const [mine] = await q<{ id: string }>("select id::text from document_customer_offboarding_snapshots where organization_id = $1", [orgA]);
    expect(mine).toBeTruthy();
    const snap = (who: Who) => readAs<{ id: string }>(who, "select id::text from public.document_customer_offboarding_snapshots");
    const ids = async (who: Who) => { const r = await snap(who); return typeof r === "string" ? r : r.map((x) => x.id); };
    // The platform admin at aal2: with or without a support session.
    expect(await ids({ claims: claims(support, "fresh") })).toContain(mine.id);
    expect(await ids({ claims: claims(support, "fresh", { session_id: supportSession }) })).toContain(mine.id);
    // The platform admin without the second step: nothing.
    expect(await ids({ claims: claims(support, "none") })).toEqual([]);
    // Every company role (the company's own admin included) and another company's admin: nothing. Not signed in: no privilege.
    for (const who of [P.admin, P.office, P.workshop, P.viewer, P.adminB]) expect(await ids(as(who))).toEqual([]);
    expect(await ids(anon)).toBe("42501");
    // No API role writes it, the platform admin included (only the offboarding function does).
    for (const who of [{ claims: claims(support, "fresh") }, as(P.admin), anon]) {
      expect(await readAs(who, "insert into public.document_customer_offboarding_snapshots (organization_id, offboarded_by, reason, link_count, link_rows, switch_row) values ($1::uuid, $1::uuid, 'r', 0, '[]'::jsonb, '{}'::jsonb)", [orgA])).toBe("42501");
      expect(await readAs(who, "update public.document_customer_offboarding_snapshots set reason = 'x'")).toBe("42501");
      expect(await readAs(who, "delete from public.document_customer_offboarding_snapshots")).toBe("42501");
    }
    expect(await q("select 1 from document_customer_offboarding_snapshots where id = $1 and reason = 'company offboarded at its request'", [mine.id])).toHaveLength(1);
  });
});
