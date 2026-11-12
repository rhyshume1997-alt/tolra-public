/**
 * Release 154 (supabase/release/154_customer_portal_signin.release.sql, phase 154 after 153): customer portal sign-in by e-mailed link
 * plus eight-digit code (PM ruling 12 Nov 2026 15:25, option 2a), sessions (30 minutes idle, 8 hours at most) and read-only verified
 * quotes and jobs. The DB proof, below PostgREST.
 *
 * Inputs: the disposable Supabase stack (TEST_DATABASE_URL, isolation-checked); the post-144 fixture installs 145..154. Customer-side
 * calls run as the server would: one transaction, role service_role. Staff calls run as PostgREST would: role authenticated with the
 * caller's JWT claims (amr carries the authenticator time 153's fresh-code rule reads). The server's hashes are made here the way the
 * server will make them: SHA-256 of the reference and of the cookie token, HMAC-SHA256 of the code under a server key. Companies are
 * synthetic (slug t-<run>-...) and removed afterwards by destroySyntheticWorld.
 * Proves: install, rollback and re-apply (rolled back), guard order (153 missing refuses; 153's rollback refuses while 154 exists);
 * callers (customer side service role only, staff side signed-in only); staff invite, list and revoke (admin only, fresh code to invite,
 * support refused, other company refused, portal must be ON); portal OFF refuses every customer call (no switch row and switch OFF) and
 * ends live sessions for good; codes (hashed, single use, 10 minutes, 5 wrong tries then locked, superseded, two verifies at once open one
 * session); rate limits (per e-mail, per session); sessions (idle, absolute, sign out, revoke, archived customer, paused company);
 * company isolation (same customer name in the same and another company, same document numbers); only verified links; permissions;
 * the exact fields returned; the guards (no reuse, no revive, no delete); audit events and the refusal log carry no e-mail, code,
 * reference, token or full hash.
 * Must not change: this file proves; it never edits a release, verify or rollback file to make itself pass.
 */
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedBackend } from "../support/isolation";
import { EMAIL_DOMAIN, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";

const runId = randomBytes(4).toString("hex");
let seq = 0;
const slug = (label: string) => `t-${runId}-p154-${label}-${++seq}`;
const email = (label: string) => `${label}-${++seq}.${runId}@${EMAIL_DOMAIN}`;
const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const RELEASE = "supabase/release/154_customer_portal_signin.release.sql";
const ROLLBACK = "supabase/release/154_customer_portal_signin.rollback.sql";
const VERIFY = "supabase/verify/customer_portal_signin_154.sql";
const VERIFY153 = "supabase/verify/document_customer_link_153.sql";
const ROLLBACK153 = "supabase/release/153_document_customer_link.rollback.sql";
const PREFLIGHT = "supabase/verify/release_preflight.sql";
const MARKER = "post-144 marker 154 customer_portal_signin";

let pool: Pool;
type Row = Record<string, unknown>;
type Res = { data: Row | null; code?: string; hint?: string; message?: string };
type Who = { role?: string; claims?: Record<string, unknown> | null };

const nowS = () => Math.floor(Date.now() / 1000);
function claims(sub: string, mfa: "fresh" | "stale" = "fresh", extra: Record<string, unknown> = {}) {
  return { sub, role: "authenticated", aal: "aal2", email: `${sub.slice(0, 8)}@example.test`,
    amr: [{ method: "totp", timestamp: mfa === "fresh" ? nowS() : nowS() - 1200 }], ...extra };
}
const as = (sub: string, mfa: "fresh" | "stale" = "fresh"): Who => ({ claims: claims(sub, mfa) });
const anon: Who = { role: "anon", claims: null };
const server: Who = { role: "service_role", claims: { role: "service_role" } };

// The server's hashes (the database only ever sees these).
const SERVER_KEY = randomBytes(32);
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (code: string) => createHmac("sha256", SERVER_KEY).update(code, "utf8").digest("hex");
const newRef = () => randomBytes(16).toString("base64url").slice(0, 22);
const newCode = () => String(10_000_000 + Math.floor(Math.random() * 89_999_999));
const newToken = () => randomBytes(32).toString("base64url");

async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await pool.connect();
  try { return (await db.query(sql, params)).rows as T[]; } finally { db.release(); }
}
async function setClaims(db: PoolClient, who: Who) {
  await db.query(`set local role ${who.role ?? "authenticated"}`);
  if (who.claims) await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(who.claims), String(who.claims.sub ?? "")]);
}
/** One call: one transaction, committed on success (as PostgREST and the server's admin client run it). */
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
async function rolledBack<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try { await db.query("begin"); return await fn(db); } finally { await db.query("rollback").catch(() => undefined); db.release(); }
}
/** As the owner with ordinary triggers off (replica mode, as destroySyntheticWorld): only to move clocks or set up documents. */
async function replica(sql: string, params: unknown[] = []) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    await db.query(sql, params);
    await db.query("commit");
  } catch (e) { await db.query("rollback").catch(() => undefined); throw e; } finally { db.release(); }
}
async function ownerTry(sql: string, params: unknown[] = []) {
  return rolledBack(async (db) => db.query(sql, params).then(() => "ok", (e: { code?: string; hint?: string }) => `${e.code}${e.hint ? `/${e.hint}` : ""}`));
}
function body(file: string) {
  const s = read(file);
  expect(s.match(/^BEGIN;$/gm), file).toHaveLength(1);
  expect(s.match(/^COMMIT;$/gm), file).toHaveLength(1);
  return s.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
}
const verifyRows = async (db?: PoolClient, file = VERIFY) =>
  ((db ? await db.query(read(file)) : { rows: await q(read(file)) }).rows) as { check_name: string; ok: boolean }[];
const preflight = async (db?: PoolClient) => ((db ? await db.query(read(PREFLIGHT)) : { rows: await q(read(PREFLIGHT)) }).rows) as { check: string; value: string }[];

// Customer-side calls, as the server makes them.
const resetEmailLimit = () => q("delete from auth_rate_limits where bucket in ('portal_request_email', 'portal_request_email_min')");
async function request(addr: string, slots = 1) {
  const pairs = Array.from({ length: slots }, () => ({ ref: newRef(), code: newCode() }));
  const r = await call(server, "public.portal_signin_request($1, $2::text[], $3::text[])", [addr, pairs.map((p) => sha(p.ref)), pairs.map((p) => hmac(p.code))]);
  return { r, pairs };
}
const verify = (ref: string, code: string, token: string) =>
  call(server, "public.portal_signin_verify($1, $2, $3)", [sha(ref), hmac(code), sha(token)]);
const resolve = (token: string) => call(server, "public.portal_session_resolve($1)", [sha(token)]);
const quotes = (token: string) => call(server, "public.portal_quotes($1)", [sha(token)]);
const jobs = (token: string) => call(server, "public.portal_jobs($1)", [sha(token)]);
const signOut = (token: string) => call(server, "public.portal_session_end($1)", [sha(token)]);
/** A fresh e-mailed code for the address, then sign in with it: returns the session token. */
async function signIn(addr: string) {
  await resetEmailLimit();
  const { r, pairs } = await request(addr);
  expect(r.data).toMatchObject({ ok: true });
  expect((r.data?.sends as unknown[]).length).toBe(1);
  const token = newToken();
  expect((await verify(pairs[0].ref, pairs[0].code, token)).data).toMatchObject({ ok: true });
  return token;
}
const sessionOf = async (token: string) => (await q<Row>("select end_reason, ended_at from customer_portal_sessions where token_hash = $1", [sha(token)]))[0];

// The synthetic world.
async function makeCompany(o: string = randomUUID()) {
  await q("insert into organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [o, `Synthetic 154 ${o.slice(0, 8)}`, slug("co")]);
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
async function job(o: string, text: string, no: string, extra: { internal?: boolean; started?: boolean; finished?: boolean; inspected?: boolean } = {}) {
  return (await q<{ id: string }>(`insert into jobs (organization_id, job_no, customer, is_internal, customer_po, due_date, started_at, finished_at, inspected_at, description, overrun_reasons)
    values ($1, $2, $3, $4, 'PO-1', '2026-12-01', $5, $6, $7, 'secret description', 'secret overrun') returning id`,
    [o, no, text, extra.internal ?? false, extra.started ? new Date() : null, extra.finished ? new Date() : null, extra.inspected ? new Date() : null]))[0].id;
}
async function quote(o: string, text: string, ref: string, status = "sent") {
  const id = randomUUID();
  await replica(`insert into quotes (id, organization_id, quote_ref, customer, status, sent_at, total_value, valid_until, customer_po, internal_notes, version)
    values ($1, $2, $3, $4, $5, case when $5 = 'draft' then null else now() end, 1234.50, '2026-12-31', 'PO-Q', 'secret internal note', 1)`, [id, o, ref, text, status]);
  return id;
}
const link = async (admin: string, kind: "job" | "quote", doc: string, cust: string) => {
  const r = await call(as(admin), "public.link_document_customer($1, $2, $3, 'checked by phone')", [kind, doc, cust]);
  expect(r.code, r.message).toBeUndefined();
};
const portalOn = async (admin: string, on: boolean) => {
  const r = await call(as(admin), "public.customer_portal_set_enabled($1, 'portal pilot')", [on]);
  expect(r.code, r.message).toBeUndefined();
};
const invite = (who: Who, cust: string, addr: string, perms: string[] = ["quotes", "jobs"], name = "Pat Buyer") =>
  call(who, "public.portal_contact_invite($1, $2, $3, $4::text[], 'customer asked for portal access')", [cust, addr, name, perms]);

const orgA = randomUUID();
const orgB = randomUUID();
const orgOff = randomUUID();
const P: Record<string, string> = {};
const C: Record<string, string> = {};
const D: Record<string, string> = {};
const E: Record<string, string> = {}; // contact e-mails
const K: Record<string, string> = {}; // contact ids
let support = "";
let supportSession = "";

describe("release 154 customer portal sign-in", () => {
  beforeAll(async () => {
    await verifyBackendIdentity();
    await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
    pool = new Pool({ connectionString: isolatedBackend().databaseUrl, max: 6 });
    await makeCompany(orgA);
    await makeCompany(orgB);
    await makeCompany(orgOff);
    for (const r of ["admin", "office"]) P[r] = await makePerson(orgA, r);
    P.adminB = await makePerson(orgB, "admin");
    P.adminOff = await makePerson(orgOff, "admin");
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

    // Company A: two customers with the SAME name, one other customer; company B: the same name and the same document numbers.
    C.acme1 = await customer(orgA, "Acme Ltd");
    C.acme2 = await customer(orgA, "Acme Ltd");
    C.rename = await customer(orgA, "Rename Me Ltd");
    C.acmeB = await customer(orgB, "Acme Ltd");
    C.off = await customer(orgOff, "Acme Ltd");
    D.q1 = await quote(orgA, "Acme Ltd", "Q-1001");          // verified, sent: shown to acme1
    D.q2 = await quote(orgA, "Acme Ltd", "Q-1002", "accepted"); // verified: shown to acme1
    D.qDraft = await quote(orgA, "Acme Ltd", "Q-1003", "draft");  // verified but a draft: never shown
    D.qOther = await quote(orgA, "Acme Ltd", "Q-2001");      // verified to acme2: never shown to acme1
    D.qBackfill = await quote(orgA, "Acme Ltd", "Q-1004");   // unverified backfill: never shown
    D.qUnlinked = await quote(orgA, "Acme Ltd", "Q-1005");   // linked then unlinked: never shown
    D.qRenamed = await quote(orgA, "Rename Me Ltd", "Q-3001"); // linked, then the customer renamed: never shown
    D.qB = await quote(orgB, "Acme Ltd", "Q-1001");          // company B, same number: never shown to A
    D.j1 = await job(orgA, "Acme Ltd", "J-1001", { started: true });
    D.j2 = await job(orgA, "Acme Ltd", "J-1002", { started: true, finished: true, inspected: true });
    D.j3 = await job(orgA, "Acme Ltd", "J-1003");
    D.jB = await job(orgB, "Acme Ltd", "J-1001", { started: true });
    for (const d of ["q1", "q2", "qDraft", "qUnlinked"]) await link(P.admin, "quote", D[d], C.acme1);
    await link(P.admin, "quote", D.qOther, C.acme2);
    await link(P.admin, "quote", D.qRenamed, C.rename);
    for (const d of ["j1", "j2", "j3"]) await link(P.admin, "job", D[d], C.acme1);
    await link(P.adminB, "quote", D.qB, C.acmeB);
    await link(P.adminB, "job", D.jB, C.acmeB);
    await q(`insert into document_customer_links (organization_id, doc_kind, quote_id, customer_id, source, document_customer_text, customer_name_at_link)
             values ($1, 'quote', $2, $3, 'backfill', 'Acme Ltd', 'Acme Ltd')`, [orgA, D.qBackfill, C.acme1]);
    expect((await call(as(P.admin), "public.unlink_document_customer('quote', $1, 'wrong customer')", [D.qUnlinked])).code).toBeUndefined();
    await q("update customers set name = 'Renamed Ltd' where id = $1", [C.rename]);
    E.a1 = email("buyer-a1");
    E.a2 = email("buyer-a2");
    E.b = email("buyer-b");
    E.quotesOnly = email("buyer-quotes");
    E.off = email("buyer-off");
  });

  afterAll(async () => {
    if (pool) {
      await q("delete from security_audit.session_company where user_id in (select id from auth.users where email like $1)", [`%.${runId}@${EMAIL_DOMAIN}`]).catch(() => undefined);
      await q("delete from security_audit.platform_admins where user_id in (select id from auth.users where email like $1)", [`%.${runId}@${EMAIL_DOMAIN}`]).catch(() => undefined);
      await resetEmailLimit().catch(() => undefined);
      await pool.end();
    }
    await destroySyntheticWorld(runId);
  });

  it("installed: marker applied, every 154 verify row true, 153 verify still all true; rollback and re-apply verify (rolled back); guard order", async () => {
    expect((await preflight()).find((r) => r.check === MARKER)?.value).toBe("applied");
    const v = await verifyRows();
    expect(v).toHaveLength(14);
    expect(v.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
    expect((await verifyRows(undefined, VERIFY153)).filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
    // 153's rollback refuses while 154 is installed (154 is rolled back first).
    expect(await rolledBack(async (db) => db.query(body(ROLLBACK153)).then(() => "ran", (e: Error) => e.message)))
      .toMatch(/153 rollback: release 154 \(customer portal sign-in\) is installed and requires 153/);
    // No contact exists yet on this disposable database (every proof removes its synthetic companies), so the rollback may run.
    expect(await q("select 1 from customer_portal_contacts")).toHaveLength(0);
    {
      await rolledBack(async (db) => {
        await db.query(body(ROLLBACK));
        const gone = (await db.query(`select to_regclass('public.customer_portal_contacts') as a, to_regclass('public.customer_portal_signin_codes') as b,
          to_regclass('public.customer_portal_sessions') as c, to_regclass('security_audit.customer_portal_refusals') as d,
          (select count(*)::int from pg_proc where proname like 'portal\\_%' or proname like '\\_portal\\_%') as fns`)).rows[0];
        expect(gone).toEqual({ a: null, b: null, c: null, d: null, fns: 0 });
        expect((await preflight(db)).find((r) => r.check === MARKER)?.value).toBe("not applied (before portal activation only)");
        expect((await verifyRows(db, VERIFY153)).filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
        // Without 153's switch, 154's own guard refuses.
        await db.query("savepoint s");
        await db.query("alter table public.customer_portal_switch rename to customer_portal_switch_x");
        expect(await db.query(body(RELEASE)).then(() => "ran", (e: Error) => e.message))
          .toMatch(/154: required release 153 \(document customer links\) is missing; stop and check release preflight/);
        await db.query("rollback to savepoint s");
        await db.query(body(RELEASE));
        expect((await preflight(db)).find((r) => r.check === MARKER)?.value).toBe("applied");
        expect((await verifyRows(db)).filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
        // A second apply refuses.
        await db.query("savepoint t");
        expect(await db.query(body(RELEASE)).then(() => "ran", (e: Error) => e.message)).toMatch(/154: the customer portal sign-in already exists/);
        await db.query("rollback to savepoint t");
      });
    }
    expect((await preflight()).find((r) => r.check === MARKER)?.value).toBe("applied");
  });

  it("callers: customer-side functions only for the service role; staff functions only for signed-in users", async () => {
    const t = sha(newToken());
    for (const who of [anon, as(P.admin)]) {
      for (const expr of ["public.portal_session_resolve($1)", "public.portal_quotes($1)", "public.portal_jobs($1)", "public.portal_session_end($1)"]) {
        expect((await call(who, expr, [t])).code).toBe("42501");
      }
      expect((await call(who, "public.portal_signin_request('x@example.test', ARRAY[$1], ARRAY[$1])", [t])).code).toBe("42501");
      expect((await call(who, "public.portal_signin_verify($1, $1, $1)", [t])).code).toBe("42501");
    }
    expect((await call(server, "public.portal_contact_invite($1, 'x@example.test', 'X', ARRAY['quotes'], 'r')", [C.acme1])).code).toBe("42501");
    expect((await call(server, "public.portal_contacts_list($1)", [C.acme1])).code).toBe("42501");
    expect((await call(server, "public.portal_contact_revoke($1, 'r')", [randomUUID()])).code).toBe("42501");
    expect((await call(anon, "public.portal_contacts_list($1)", [C.acme1])).code).toBe("42501");
    for (const sql of ["select * from customer_portal_contacts", "select * from customer_portal_signin_codes", "select * from customer_portal_sessions",
                       "select * from security_audit.customer_portal_refusals"]) {
      for (const who of [anon, as(P.admin), server]) {
        const r = await rolledBack(async (db) => { await setClaims(db, who); return db.query(sql).then(() => "read", (e: { code?: string }) => String(e.code)); });
        expect(r, `${sql} as ${who.role ?? "authenticated"}`).toBe("42501");
      }
    }
  });

  it("portal OFF (no switch row): invite refused, and with a contact present no code is sent, verify and every read refuse portal_off", async () => {
    expect(await invite(as(P.adminOff), C.off, E.off)).toMatchObject({ code: "55000", hint: "portal_off" });
    // A contact invited while ON, then the company switched OFF (the row says off).
    await portalOn(P.adminOff, true);
    expect((await invite(as(P.adminOff), C.off, E.off)).code).toBeUndefined();
    const token = await signIn(E.off);
    // A code issued while ON, not yet used.
    await resetEmailLimit();
    const { pairs } = await request(E.off);
    await portalOn(P.adminOff, false);
    expect(await invite(as(P.adminOff), C.off, email("late"))).toMatchObject({ code: "55000", hint: "portal_off" });
    await resetEmailLimit();
    const req = await request(E.off);
    expect(req.r.data).toMatchObject({ ok: true, sends: [] });
    expect((await verify(pairs[0].ref, pairs[0].code, newToken())).data).toMatchObject({ ok: false, reason: "portal_off" });
    expect((await resolve(token)).data).toMatchObject({ ok: false, reason: "portal_off" });
    expect(await sessionOf(token)).toMatchObject({ end_reason: "portal_off" });
    for (const f of [resolve, quotes, jobs]) expect((await f(token)).data).toMatchObject({ ok: false, reason: "not_signed_in" });
    // Switching ON again does not revive the session; the unused code still works only once the switch is ON.
    await portalOn(P.adminOff, true);
    expect((await resolve(token)).data).toMatchObject({ ok: false, reason: "not_signed_in" });
    expect(await sessionOf(token)).toMatchObject({ end_reason: "portal_off" });
    const refusals = await q<{ step: string; reason: string }>("select step, reason from security_audit.customer_portal_refusals where organization_id = $1 and reason = 'portal_off' order by id", [orgOff]);
    expect(refusals.map((r) => r.step)).toEqual(["request", "verify", "session"]);
    await portalOn(P.adminOff, false);
  });

  it("staff: admin only, a fresh code to invite, never support, read-only or another company; list shows no hash; validation", async () => {
    await portalOn(P.admin, true);
    await portalOn(P.adminB, true);
    expect(await invite(as(P.office), C.acme1, E.a1)).toMatchObject({ code: "42501", hint: "admin_required" });
    expect(await invite(as(P.admin, "stale"), C.acme1, E.a1)).toMatchObject({ code: "42501", hint: "mfa_recent_required" });
    expect((await invite({ claims: claims(support, "fresh", { session_id: supportSession }) }, C.acme1, E.a1)).code).toBe("42501");
    expect(await invite(as(P.adminB), C.acme1, E.a1)).toMatchObject({ code: "P0002", hint: "customer_not_found" });
    expect(await invite(as(P.admin), C.acme1, "not-an-email")).toMatchObject({ hint: "invalid_email" });
    expect(await invite(as(P.admin), C.acme1, E.a1, ["invoices"])).toMatchObject({ hint: "invalid_permissions" });
    expect(await invite(as(P.admin), C.acme1, E.a1, [])).toMatchObject({ hint: "invalid_permissions" });
    expect(await invite(as(P.admin), C.acme1, E.a1, ["quotes"], " ")).toMatchObject({ hint: "invalid_name" });
    const a1 = await invite(as(P.admin), C.acme1, ` ${E.a1.toUpperCase()} `);
    expect(a1.code, a1.message).toBeUndefined();
    K.a1 = String(a1.data?.contact_id);
    expect(a1.data).toMatchObject({ customer_id: C.acme1, permissions: ["jobs", "quotes"] });
    expect(await invite(as(P.admin), C.acme1, E.a1)).toMatchObject({ code: "55000", hint: "already_invited" });
    K.a2 = String((await invite(as(P.admin), C.acme2, E.a2)).data?.contact_id);
    K.quotesOnly = String((await invite(as(P.admin), C.acme1, E.quotesOnly, ["quotes"])).data?.contact_id);
    K.b = String((await invite(as(P.adminB), C.acmeB, E.b)).data?.contact_id);
    const list = await call(as(P.admin, "stale"), "public.portal_contacts_list($1)", [C.acme1]);
    expect(list.code).toBeUndefined();
    expect((list.data as unknown as Row[]).map((r) => r.email).sort()).toEqual([E.a1.toLowerCase(), E.quotesOnly.toLowerCase()].sort());
    expect(Object.keys((list.data as unknown as Row[])[0]).sort()).toEqual(["contact_id", "display_name", "email", "invited_at", "invited_by", "live_sessions", "permissions", "revoked_at"]);
    expect((await call(as(P.adminB), "public.portal_contacts_list($1)", [C.acme1])).hint).toBe("customer_not_found");
    expect((await call(as(P.office), "public.portal_contacts_list($1)", [C.acme1])).hint).toBe("admin_required");
    expect((await call(as(P.adminB), "public.portal_contact_revoke($1, 'r')", [K.a1])).hint).toBe("contact_not_found");
  });

  it("codes: hashed, wrong code counts and the fifth locks it, expired, used once, superseded; two verifies at once open one session", async () => {
    // Only hashes are stored.
    await resetEmailLimit();
    const { r, pairs } = await request(E.a1);
    expect(r.data).toMatchObject({ ok: true, sends: [{ slot: 1, company_name: expect.any(String), customer_name: "Acme Ltd" }] });
    const [row] = await q<Row>("select ref_hash, code_hash, expires_at - created_at = interval '10 minutes' as ten from customer_portal_signin_codes where contact_id = $1 and code_hash is not null", [K.a1]);
    expect(row).toEqual({ ref_hash: sha(pairs[0].ref), code_hash: hmac(pairs[0].code), ten: true });
    expect(JSON.stringify(await q("select * from customer_portal_signin_codes where contact_id = $1", [K.a1]))).not.toContain(pairs[0].code);
    // Four wrong codes count down; the fifth locks; the right code then fails.
    for (let i = 1; i <= 4; i++) expect((await verify(pairs[0].ref, "00000000", newToken())).data).toMatchObject({ ok: false, reason: "wrong_code", attempts_left: 5 - i });
    expect((await verify(pairs[0].ref, "00000000", newToken())).data).toMatchObject({ ok: false, reason: "locked" });
    expect((await verify(pairs[0].ref, pairs[0].code, newToken())).data).toMatchObject({ ok: false, reason: "locked" });
    // Expired (clock moved back as the owner), unknown reference, superseded by a newer code.
    await resetEmailLimit();
    const old = await request(E.a1);
    await replica("update customer_portal_signin_codes set created_at = now() - interval '11 minutes', expires_at = now() - interval '1 minute' where ref_hash = $1", [sha(old.pairs[0].ref)]);
    expect((await verify(old.pairs[0].ref, old.pairs[0].code, newToken())).data).toMatchObject({ ok: false, reason: "code_expired" });
    expect((await verify(newRef(), "12345678", newToken())).data).toMatchObject({ ok: false, reason: "invalid" });
    await resetEmailLimit();
    const first = await request(E.a1);
    await resetEmailLimit();
    const second = await request(E.a1);
    expect((await verify(first.pairs[0].ref, first.pairs[0].code, newToken())).data).toMatchObject({ ok: false, reason: "code_superseded" });
    expect(await q("select 1 from customer_portal_signin_codes where contact_id = $1 and code_hash is not null", [K.a1])).toHaveLength(1);
    // Two verifies of the same right code at once: exactly one session.
    const [x, y] = await Promise.all([verify(second.pairs[0].ref, second.pairs[0].code, newToken()), verify(second.pairs[0].ref, second.pairs[0].code, newToken())]);
    expect([x.data?.ok, y.data?.ok].sort()).toEqual([false, true]);
    expect([x.data?.reason, y.data?.reason].filter(Boolean)).toEqual(["code_used"]);
    expect(await q("select 1 from customer_portal_sessions s join customer_portal_signin_codes c on c.id = s.code_id where c.ref_hash = $1", [sha(second.pairs[0].ref)])).toHaveLength(1);
    // A used or locked code can never be made live again, and nothing is deleted (the owner too).
    expect(await ownerTry("update customer_portal_signin_codes set code_hash = $2, used_at = null where ref_hash = $1", [sha(second.pairs[0].ref), hmac("1")])).toBe("42501/code_immutable");
    expect(await ownerTry("update customer_portal_signin_codes set attempts = 0 where ref_hash = $1", [sha(pairs[0].ref)])).toBe("42501/code_immutable");
    expect(await ownerTry("delete from customer_portal_signin_codes where contact_id = $1", [K.a1])).toBe("42501/code_immutable");
    expect(await ownerTry("truncate customer_portal_signin_codes cascade")).toBe("42501/portal_record");
  });

  it("rate limits: 1 sign-in e-mail a minute and 3 a quarter of an hour per e-mail (contact or not); 120 calls a minute per session", async () => {
    await resetEmailLimit();
    expect((await request(E.a1)).r.data).toMatchObject({ ok: true });
    expect((await request(E.a1)).r.data).toMatchObject({ ok: false, reason: "rate_limited" });
    await q("delete from auth_rate_limits where bucket = 'portal_request_email_min'");
    // Every request counts, refused ones too (the existing limiter's rule): the third in the quarter hour is the last one allowed.
    await q("delete from auth_rate_limits where bucket = 'portal_request_email_min'");
    expect((await request(E.a1)).r.data).toMatchObject({ ok: true });
    await q("delete from auth_rate_limits where bucket = 'portal_request_email_min'");
    expect((await request(E.a1)).r.data).toMatchObject({ ok: false, reason: "rate_limited" });
    const stranger = email("nobody");
    await resetEmailLimit();
    expect((await request(stranger)).r.data).toMatchObject({ ok: true, sends: [] });
    expect((await request(stranger)).r.data).toMatchObject({ ok: false, reason: "rate_limited" });
    const token = await signIn(E.a1);
    const key = sha(`portal_read:${sha(token)}`);
    await q("insert into auth_rate_limits (bucket, key_hash) select 'portal_read', $1 from generate_series(1, 120)", [key]);
    expect((await quotes(token)).data).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(await sessionOf(token)).toMatchObject({ ended_at: null });
    await q("delete from auth_rate_limits where bucket = 'portal_read' and key_hash = $1", [key]);
    expect((await quotes(token)).data).toMatchObject({ ok: true });
  });

  it("isolation and documents: own customer and company only, verified links only, sent/accepted/rejected quotes only, exact fields, permissions", async () => {
    const t1 = await signIn(E.a1);
    const s = await resolve(t1);
    expect(s.data).toMatchObject({ ok: true, session: { contact_id: K.a1, customer_name: "Acme Ltd", permissions: ["jobs", "quotes"] } });
    expect(Object.keys(s.data?.session as Row).sort()).toEqual(["absolute_expires_at", "company_name", "contact_id", "customer_name", "display_name", "idle_expires_at", "permissions"]);
    const qs = (await quotes(t1)).data?.quotes as Row[];
    expect(qs.map((r) => r.quote_ref).sort()).toEqual(["Q-1001", "Q-1002"]);
    for (const r of qs) expect(Object.keys(r).sort()).toEqual(["customer_po", "quote_ref", "sent_at", "status", "total_value", "valid_until"]);
    expect(JSON.stringify(qs)).not.toMatch(/secret|internal/);
    const js = (await jobs(t1)).data?.jobs as Row[];
    expect(js.map((r) => [r.job_no, r.stage])).toEqual([["J-1001", "in_progress"], ["J-1002", "complete"], ["J-1003", "not_started"]]);
    for (const r of js) expect(Object.keys(r).sort()).toEqual(["customer_po", "due_date", "job_no", "stage"]);
    expect(JSON.stringify(js)).not.toMatch(/secret/);
    // The other "Acme Ltd" of the same company sees only its own quote; company B's "Acme Ltd" sees only B's Q-1001 / J-1001.
    const t2 = await signIn(E.a2);
    expect(((await quotes(t2)).data?.quotes as Row[]).map((r) => r.quote_ref)).toEqual(["Q-2001"]);
    expect((await jobs(t2)).data?.jobs).toEqual([]);
    const tb = await signIn(E.b);
    expect(((await quotes(tb)).data?.quotes as Row[]).map((r) => r.quote_ref)).toEqual(["Q-1001"]);
    expect(((await jobs(tb)).data?.jobs as Row[]).map((r) => r.job_no)).toEqual(["J-1001"]);
    // A quotes-only contact gets no jobs.
    const tq = await signIn(E.quotesOnly);
    expect((await jobs(tq)).data).toMatchObject({ ok: false, reason: "no_permission" });
    expect(((await quotes(tq)).data?.quotes as Row[]).length).toBe(2);
    // One e-mail that is a contact of two customers gets one slot per customer, never both in one session.
    K.a1second = String((await invite(as(P.admin), C.acme2, E.a1)).data?.contact_id);
    await resetEmailLimit();
    const two = await request(E.a1, 3);
    expect((two.r.data?.sends as Row[]).map((r) => r.slot)).toEqual([1, 2]);
    expect(await q("select 1 from customer_portal_signin_codes where ref_hash = $1", [sha(two.pairs[2].ref)])).toHaveLength(0);
    // The session's company and customer come from the contact row: nothing the server sends can choose them.
    expect(await ownerTry("update customer_portal_sessions set customer_id = $2 where token_hash = $1", [sha(t1), C.acme2])).toBe("42501/session_immutable");
    expect(await ownerTry("update customer_portal_sessions set organization_id = $2 where token_hash = $1", [sha(t1), orgB])).toMatch(/^(42501\/session_immutable|23514)$/);
  });

  it("sessions: idle 30 minutes, 8 hours absolute, sign out; an ended session is never revived or deleted", async () => {
    const idle = await signIn(E.a1);
    await replica("update customer_portal_sessions set created_at = now() - interval '40 minutes', absolute_expires_at = now() - interval '40 minutes' + interval '8 hours', last_seen_at = now() - interval '31 minutes' where token_hash = $1", [sha(idle)]);
    expect((await quotes(idle)).data).toMatchObject({ ok: false, reason: "session_idle" });
    expect(await sessionOf(idle)).toMatchObject({ end_reason: "idle" });
    const fresh = await signIn(E.a1);
    await replica("update customer_portal_sessions set created_at = now() - interval '29 minutes', absolute_expires_at = now() - interval '29 minutes' + interval '8 hours', last_seen_at = now() - interval '29 minutes' where token_hash = $1", [sha(fresh)]);
    expect((await resolve(fresh)).data).toMatchObject({ ok: true });
    const abs = await signIn(E.a1);
    await replica("update customer_portal_sessions set created_at = now() - interval '8 hours 1 minute', absolute_expires_at = now() - interval '1 minute', last_seen_at = now() - interval '1 minute' where token_hash = $1", [sha(abs)]);
    expect((await resolve(abs)).data).toMatchObject({ ok: false, reason: "session_expired" });
    expect(await sessionOf(abs)).toMatchObject({ end_reason: "absolute" });
    expect((await signOut(fresh)).data).toEqual({ ok: true });
    expect(await sessionOf(fresh)).toMatchObject({ end_reason: "signed_out" });
    expect((await resolve(fresh)).data).toMatchObject({ ok: false, reason: "not_signed_in" });
    expect((await signOut(fresh)).data).toEqual({ ok: true });
    expect(await ownerTry("update customer_portal_sessions set ended_at = null, end_reason = null where token_hash = $1", [sha(fresh)])).toBe("42501/session_immutable");
    expect(await ownerTry("delete from customer_portal_sessions where token_hash = $1", [sha(fresh)])).toBe("42501/session_immutable");
    expect((await resolve(newToken())).data).toMatchObject({ ok: false, reason: "not_signed_in" });
    expect((await resolve("not-a-hash")).data).toMatchObject({ ok: false, reason: "not_signed_in" });
  });

  it("revoke, archived customer and paused company end access at the next call; revoked contacts get no code", async () => {
    // Customer archived.
    const tArch = await signIn(E.a2);
    await q("insert into record_archive_state (organization_id, record_table, record_id, state, set_by) values ($1, 'customers', $2, 'archived', $3)", [orgA, C.acme2, P.admin]);
    expect((await quotes(tArch)).data).toMatchObject({ ok: false, reason: "customer_archived" });
    expect(await sessionOf(tArch)).toMatchObject({ end_reason: "customer_archived" });
    await resetEmailLimit();
    expect((await request(E.a2)).r.data).toMatchObject({ ok: true, sends: [] });
    expect(await invite(as(P.admin), C.acme2, email("late2"))).toMatchObject({ hint: "customer_archived" });
    await q("delete from record_archive_state where record_table = 'customers' and record_id = $1", [C.acme2]);
    // Company paused.
    const tB = await signIn(E.b);
    await replica("update organizations set status = 'paused' where id = $1", [orgB]);
    expect((await resolve(tB)).data).toMatchObject({ ok: false, reason: "company_inactive" });
    expect(await sessionOf(tB)).toMatchObject({ end_reason: "company_inactive" });
    await resetEmailLimit();
    expect((await request(E.b)).r.data).toMatchObject({ ok: true, sends: [] });
    await replica("update organizations set status = 'active' where id = $1", [orgB]);
    // Revoke: ends live sessions and burns the live code at once.
    const tRev = await signIn(E.quotesOnly);
    await resetEmailLimit();
    const pending = await request(E.quotesOnly);
    expect(await call(as(P.office), "public.portal_contact_revoke($1, 'left the customer')", [K.quotesOnly])).toMatchObject({ hint: "admin_required" });
    const [{ live }] = await q<{ live: number }>("select count(*)::int as live from customer_portal_sessions where contact_id = $1 and ended_at is null", [K.quotesOnly]);
    expect(live).toBeGreaterThanOrEqual(1);
    const rv = await call(as(P.admin, "stale"), "public.portal_contact_revoke($1, 'left the customer')", [K.quotesOnly]);
    expect(rv.code, rv.message).toBeUndefined();
    expect(rv.data).toMatchObject({ contact_id: K.quotesOnly, ended_sessions: live });
    expect(await q("select 1 from customer_portal_sessions where contact_id = $1 and ended_at is null", [K.quotesOnly])).toHaveLength(0);
    expect(await sessionOf(tRev)).toMatchObject({ end_reason: "revoked" });
    expect((await quotes(tRev)).data).toMatchObject({ ok: false, reason: "not_signed_in" });
    expect((await verify(pending.pairs[0].ref, pending.pairs[0].code, newToken())).data).toMatchObject({ ok: false, reason: "revoked" });
    await resetEmailLimit();
    expect((await request(E.quotesOnly)).r.data).toMatchObject({ ok: true, sends: [] });
    expect((await call(as(P.admin), "public.portal_contact_revoke($1, 'again')", [K.quotesOnly])).hint).toBe("already_revoked");
    expect(await ownerTry("update customer_portal_contacts set revoked_at = null, revoked_by = null, revoke_reason = null where id = $1", [K.quotesOnly])).toBe("42501/contact_immutable");
    expect(await ownerTry("delete from customer_portal_contacts where id = $1", [K.quotesOnly])).toBe("42501/contact_immutable");
    // A revoked contact can be invited again as a new row.
    expect((await invite(as(P.admin), C.acme1, E.quotesOnly, ["quotes"])).code).toBeUndefined();
    expect((await verifyRows()).filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
  });

  it("audit: named events by id only (no e-mail, code, reference, token or hash); contact row audit; refusal log keeps 16 hex characters only", async () => {
    const ev = await q<{ action: string; metadata: Row }>("select action, metadata from security_audit.audit_log where organization_id = any($1::uuid[]) and action like 'CUSTOMER_PORTAL_%' order by created_at", [[orgA, orgB, orgOff]]);
    const actions = new Set(ev.map((e) => e.action));
    for (const a of ["CUSTOMER_PORTAL_CONTACT_INVITED", "CUSTOMER_PORTAL_CONTACT_REVOKED", "CUSTOMER_PORTAL_SIGNIN_CODE_SENT", "CUSTOMER_PORTAL_SIGNED_IN",
                     "CUSTOMER_PORTAL_SESSION_ENDED", "CUSTOMER_PORTAL_DOCUMENTS_VIEWED"]) expect(actions.has(a), a).toBe(true);
    const text = JSON.stringify(ev);
    for (const e of Object.values(E)) expect(text.toLowerCase()).not.toContain(e.toLowerCase());
    expect(text).not.toMatch(/[0-9a-f]{64}/);
    const ended = ev.filter((e) => e.action === "CUSTOMER_PORTAL_SESSION_ENDED").map((e) => e.metadata.end_reason);
    for (const r of ["portal_off", "idle", "absolute", "signed_out", "revoked", "customer_archived", "company_inactive"]) expect(ended, r).toContain(r);
    // No code or session row is ever row-audited (they hold hashes).
    expect(await q("select 1 from security_audit.audit_log where entity_table in ('customer_portal_signin_codes', 'customer_portal_sessions') and action in ('INSERT', 'UPDATE', 'DELETE')")).toHaveLength(0);
    expect((await q("select 1 from security_audit.audit_log where entity_table = 'customer_portal_contacts' and action = 'INSERT' and organization_id = $1", [orgA])).length).toBeGreaterThanOrEqual(4);
    const refusals = await q<Row>("select step, reason, subject_hash16, organization_id from security_audit.customer_portal_refusals where organization_id = any($1::uuid[])", [[orgA, orgB, orgOff]]);
    expect(new Set(refusals.map((r) => r.reason))).toEqual(new Set(["portal_off", "wrong_code", "locked", "code_expired", "code_superseded", "code_used",
      "rate_limited", "no_permission", "session_idle", "session_expired", "session_ended", "customer_archived", "company_inactive", "revoked"]));
    for (const r of refusals) expect(r.subject_hash16 === null || /^[0-9a-f]{16}$/.test(String(r.subject_hash16))).toBe(true);
    // 077: each company's audit chain still verifies (links and hashes), the same query as 153's proof.
    for (const o of [orgA, orgB, orgOff]) {
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
          from r`, [o])).rows;
      });
      expect(chain, o).toMatchObject({ broken_links: 0, bad_hashes: 0 });
      expect(chain.total).toBeGreaterThan(3);
    }
  });

  it("rollback refuses while any portal contact exists (nothing changed)", async () => {
    expect(await rolledBack(async (db) => db.query(body(ROLLBACK)).then(() => "ran", (e: Error) => e.message)))
      .toMatch(/154 rollback: portal contacts exist/);
    expect((await preflight()).find((r) => r.check === MARKER)?.value).toBe("applied");
    expect((await verifyRows()).filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
  });
});
