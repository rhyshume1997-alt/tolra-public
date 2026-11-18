/**
 * PR7: the REAL lib/portal server functions (PR1: requestPortalSignin, verifyPortalSignin, resolvePortalSession, listPortalQuotes,
 * listPortalJobs, endPortalSession) driven against release 154 (customer portal sign-in, after 153) on the disposable database.
 *
 * Inputs: the disposable Supabase stack (TEST_DATABASE_URL, isolation-checked); the post-144 fixture installs 145..154. lib/portal is
 * given a test-only admin client whose rpc() runs each call as PostgREST would for the service role (one transaction, role
 * service_role, named arguments); a random HMAC key made here (never a real secret); a fake Resend provider that captures the e-mail,
 * so the link reference and the code come from the real mail text. Staff set-up (switch ON, invite, revoke) is made through 153/154's
 * own staff functions as a signed-in admin with a fresh code. Companies are synthetic (slug t-<run>-...) and removed afterwards.
 * Proves: request -> e-mail -> verify -> resolve -> quotes / jobs -> sign out; company and customer isolation; platform flag OFF (no
 * database call), company switch OFF, company paused, contact revoked, customer archived, archived documents hidden; idle and absolute
 * expiry (session clocks moved back); 5 wrong codes lock, single use, superseded codes; 154 rolled back (release 154 window fixture):
 * every call fails closed; every refusal has one identical shape; the audit rows carry ids and categories only.
 * Must not change: lib/portal and the 154 release / rollback / verify files (this file only proves them).
 */
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => { throw new Error("the real admin client must not be created in a test"); } }));

import { endPortalSession, listPortalJobs, listPortalQuotes, requestPortalSignin, resolvePortalSession, verifyPortalSignin, type PortalServerDeps } from "@/lib/portal/server";
import type { PortalRefusal, PortalResult } from "@/lib/portal/types";
import { isolatedBackend } from "../support/isolation";
import { EMAIL_DOMAIN, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";
import { preparePost144Fixture } from "../support/post-144-release-fixture";
import { enter154PortalWindow, exit154PortalWindow } from "../support/release-154-portal-window";

const runId = randomBytes(4).toString("hex");
let seq = 0;
const slug = (label: string) => `t-${runId}-pa154-${label}-${++seq}`;
const email = (label: string) => `${label}-${++seq}.${runId}@${EMAIL_DOMAIN}`;
type Row = Record<string, unknown>;
let pool: Pool;

// The server's environment for these tests: platform switch ON, a random 32-byte key made here, a site origin and a (fake) Resend.
const KEY_B64 = randomBytes(32).toString("base64");
const env = { CUSTOMER_PORTAL_ENABLED: "true", PORTAL_SIGNIN_HMAC_KEY: KEY_B64, NEXT_PUBLIC_SITE_URL: "https://portal.example.test", RESEND_API_KEY: "test-only", EMAIL_FROM: "Tolra <portal@example.test>" };

async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await pool.connect();
  try { return (await db.query(sql, params)).rows as T[]; } finally { db.release(); }
}
/** As the owner with ordinary triggers off (replica mode, as destroySyntheticWorld): only to move clocks or pause a company. */
async function replica(sql: string, params: unknown[] = []) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    await db.query(sql, params);
    await db.query("commit");
  } catch (e) { await db.query("rollback").catch(() => undefined); throw e; } finally { db.release(); }
}

// The admin client lib/portal is given: rpc(fn, args) as PostgREST runs it for the service role key.
const rpcCalls: string[] = [];
const admin = {
  rpc: async (fn: string, args: Record<string, unknown>) => {
    rpcCalls.push(fn);
    if (!/^portal_[a-z_]+$/.test(fn) || !Object.keys(args).every((k) => /^p_[a-z_]+$/.test(k))) throw new Error(`unexpected rpc ${fn}`);
    const keys = Object.keys(args);
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("set local role service_role");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      const { rows } = await db.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as r`, keys.map((k) => args[k]));
      await db.query("commit");
      return { data: rows[0]?.r ?? null, error: null };
    } catch (e) {
      await db.query("rollback").catch(() => undefined);
      const x = e as { code?: string; message?: string };
      return { data: null, error: { code: x.code, message: x.message } };
    } finally { db.release(); }
  },
};

// Captured mail and after() tasks.
type Mail = { to: string[]; text: string };
const outbox: Mail[] = [];
const tasks: Array<() => Promise<void>> = [];
const send = async (m: Mail) => { outbox.push({ to: m.to, text: m.text }); return { outcome: "accepted" }; };
const deps: PortalServerDeps = {
  admin: admin as never, env, schedule: (t) => { tasks.push(t); },
  mail: { providers: { resend: () => ({ name: "resend", send }) as never } },
};
const depsOff: PortalServerDeps = { ...deps, env: { ...env, CUSTOMER_PORTAL_ENABLED: "false" } };

// Every refusal any lib/portal call returns in this file (checked for one identical shape at the end).
const refusals: PortalRefusal[] = [];
function isRefused<T>(r: PortalResult<T>): PortalRefusal {
  expect(r.ok, JSON.stringify(r)).toBe(false);
  refusals.push(r as PortalRefusal);
  return r as PortalRefusal;
}
/** A database refusal: the one shape to the caller; its category is only in the internal refusal log, found by correlation id. */
async function refusedAs<T>(r: PortalResult<T>, step: string, category: string) {
  const x = isRefused(r);
  expect(await q("select step, reason from security_audit.customer_portal_refusals where correlation_id::text = $1", [x.correlationId])).toEqual([{ step, reason: category }]);
}
const ok = <T>(r: PortalResult<T>): T => { expect(r.ok, JSON.stringify(r)).toBe(true); return (r as { ok: true; data: T }).data; };

const resetEmailLimit = () => q("delete from auth_rate_limits where bucket in ('portal_request_email', 'portal_request_email_min')");
/** "E-mail me a sign-in link" through lib/portal, then the after() tasks run: returns what was mailed (ref and code from the text). */
async function mailed(addr: string) {
  await resetEmailLimit();
  outbox.length = 0;
  tasks.length = 0;
  expect(await requestPortalSignin(addr, deps)).toBeUndefined();
  for (const t of tasks.splice(0)) await t();
  return outbox.splice(0).map((m) => {
    const ref = /\/portal\/code\/([A-Za-z0-9_-]{22})\n/.exec(m.text)?.[1];
    const code = /Your code: (\d{4}) (\d{4})/.exec(m.text);
    expect(ref && code, m.text).toBeTruthy();
    return { to: m.to, text: m.text, ref: String(ref), code: `${code?.[1]} ${code?.[2]}` };
  });
}
async function signIn(addr: string) {
  const [m, ...more] = await mailed(addr);
  expect(more).toHaveLength(0);
  return ok(await verifyPortalSignin({ ref: m.ref, code: m.code }, deps)).token;
}
const quoteRefs = async (t: string) => ok(await listPortalQuotes(t, deps)).map((x) => x.quoteRef).sort();
const jobNos = async (t: string) => ok(await listPortalJobs(t, deps)).map((x) => x.jobNo).sort();
const wrongCode = (code: string) => String((Number(code.replace(" ", "")) + 1) % 100_000_000).padStart(8, "0");

// The synthetic world (the same shape as 154's own proof).
const nowS = () => Math.floor(Date.now() / 1000);
async function asAdmin(sub: string, expr: string, params: unknown[] = []) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("set local role authenticated");
    const claims = { sub, role: "authenticated", aal: "aal2", email: `${sub.slice(0, 8)}@example.test`, amr: [{ method: "totp", timestamp: nowS() }] };
    await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claims), sub]);
    const { rows } = await db.query(`select ${expr} as r`, params);
    await db.query("commit");
    return rows[0]?.r as Row;
  } catch (e) { await db.query("rollback").catch(() => undefined); throw e; } finally { db.release(); }
}
async function makeCompany(o: string, name: string) {
  await q("insert into organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [o, name, slug("co")]);
}
async function makeAdmin(o: string) {
  const u = randomUUID();
  const e = email("admin");
  await q("insert into auth.users (id, email) values ($1, $2)", [u, e]);
  await q("insert into user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, 'Synthetic', 'admin', $3, true, false)", [u, e, o]);
  await q("insert into organization_members (organization_id, user_id, role, active) values ($1, $2, 'admin', true)", [o, u]);
  return u;
}
const customer = async (o: string, name: string) => (await q<{ id: string }>("insert into customers (organization_id, name) values ($1, $2) returning id", [o, name]))[0].id;
async function job(o: string, no: string, extra: { started?: boolean; done?: boolean } = {}) {
  return (await q<{ id: string }>(`insert into jobs (organization_id, job_no, customer, is_internal, customer_po, due_date, started_at, finished_at, inspected_at, description)
    values ($1, $2, 'Acme Ltd', false, 'PO-J', '2026-12-01', $3, $4, $4, 'secret description') returning id`,
    [o, no, extra.started ? new Date() : null, extra.done ? new Date() : null]))[0].id;
}
async function quote(o: string, ref: string, status = "sent") {
  const id = randomUUID();
  await replica(`insert into quotes (id, organization_id, quote_ref, customer, status, sent_at, total_value, valid_until, customer_po, internal_notes, version)
    values ($1, $2, $3, 'Acme Ltd', $4, case when $4 = 'draft' then null else now() end, 1234.50, '2026-12-31', 'PO-Q', 'secret internal note', 1)`, [id, o, ref, status]);
  return id;
}
const link = (adm: string, kind: "job" | "quote", doc: string, cust: string) => asAdmin(adm, "public.link_document_customer($1, $2, $3, 'checked by phone')", [kind, doc, cust]);
const portalSwitch = (adm: string, on: boolean) => asAdmin(adm, "public.customer_portal_set_enabled($1, 'portal pilot')", [on]);
// Free text staff type: markers that must never reach an audit row.
const NAME_MARK = `NAME-MARK-${runId}`;
const REASON_MARK = `REASON-MARK-${runId}`;
const invite = async (adm: string, cust: string, addr: string, perms = ["quotes", "jobs"]) =>
  String((await asAdmin(adm, "public.portal_contact_invite($1, $2, $3, $4::text[], $5)", [cust, addr, `Pat Buyer ${NAME_MARK}`, perms, `asked for access ${REASON_MARK}`])).contact_id);

const orgA = randomUUID();
const orgB = randomUUID();
const A: Record<string, string> = {}; // admins
const C: Record<string, string> = {}; // customers
const D: Record<string, string> = {}; // documents
const E: Record<string, string> = {}; // contact e-mails
const K: Record<string, string> = {}; // contact ids
const secrets: string[] = []; // every ref, code and token handed out in this file (none may reach an audit row)

describe("PR7 lib/portal against release 154 (real functions, local database)", () => {
  beforeAll(async () => {
    await verifyBackendIdentity();
    await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
    pool = new Pool({ connectionString: isolatedBackend().databaseUrl, max: 6 });
  });

  afterAll(async () => {
    await exit154PortalWindow();
    if (pool) {
      await resetEmailLimit().catch(() => undefined);
      await pool.end();
    }
    await destroySyntheticWorld(runId);
  });

  it("154 not installed (release 154 window: rolled back, then re-released with every verify row true): every call fails closed", async () => {
    expect(await q("select 1 from customer_portal_contacts")).toHaveLength(0);
    await enter154PortalWindow();
    try {
      expect(await q("select to_regprocedure('public.portal_session_resolve(text)') as f")).toEqual([{ f: null }]);
      const token = randomBytes(32).toString("base64url");
      rpcCalls.length = 0;
      outbox.length = 0;
      tasks.length = 0;
      expect(await requestPortalSignin(email("nobody"), deps)).toBeUndefined();
      expect(tasks).toHaveLength(0);
      isRefused(await verifyPortalSignin({ ref: randomBytes(16).toString("base64url"), code: "12345678" }, deps));
      isRefused(await resolvePortalSession(token, deps));
      isRefused(await listPortalQuotes(token, deps));
      isRefused(await listPortalJobs(token, deps));
      expect(await endPortalSession(token, deps)).toBeUndefined();
      // Each call did reach the database and found no function: a refusal, never a throw.
      expect(rpcCalls).toEqual(["portal_signin_request", "portal_signin_verify", "portal_session_resolve", "portal_quotes", "portal_jobs", "portal_session_end"]);
    } finally {
      await exit154PortalWindow();
    }
    expect((await q("select to_regprocedure('public.portal_session_resolve(text)')::text as f"))[0].f).toBe("portal_session_resolve(text)");
  });

  it("set-up: two companies, the same customer name twice in A and once in B, the same document numbers in both; portal ON; contacts invited", async () => {
    await makeCompany(orgA, `Synthetic PA154 A ${runId}`);
    await makeCompany(orgB, `Synthetic PA154 B ${runId}`);
    A.a = await makeAdmin(orgA);
    A.b = await makeAdmin(orgB);
    C.acme1 = await customer(orgA, "Acme Ltd");
    C.acme2 = await customer(orgA, "Acme Ltd");
    C.acmeB = await customer(orgB, "Acme Ltd");
    D.q1 = await quote(orgA, "Q-1001");
    D.q2 = await quote(orgA, "Q-1002", "accepted");
    D.qDraft = await quote(orgA, "Q-1003", "draft");
    D.qOther = await quote(orgA, "Q-2001");
    D.qB = await quote(orgB, "Q-1001");
    D.j1 = await job(orgA, "J-1001", { started: true });
    D.j2 = await job(orgA, "J-1002", { started: true, done: true });
    D.jB = await job(orgB, "J-1001", { started: true });
    for (const d of ["q1", "q2", "qDraft"]) await link(A.a, "quote", D[d], C.acme1);
    await link(A.a, "quote", D.qOther, C.acme2);
    for (const d of ["j1", "j2"]) await link(A.a, "job", D[d], C.acme1);
    await link(A.b, "quote", D.qB, C.acmeB);
    await link(A.b, "job", D.jB, C.acmeB);
    await portalSwitch(A.a, true);
    await portalSwitch(A.b, true);
    for (const k of ["a1", "a2", "b", "rev", "arch", "pause"]) E[k] = email(`buyer-${k}`);
    K.a1 = await invite(A.a, C.acme1, E.a1);
    K.a2 = await invite(A.a, C.acme2, E.a2);
    K.b = await invite(A.b, C.acmeB, E.b);
    K.rev = await invite(A.a, C.acme1, E.rev, ["quotes"]);
    K.arch = await invite(A.a, C.acme2, E.arch);
    K.pause = await invite(A.b, C.acmeB, E.pause);
    expect(Object.values(K).every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
  });

  it("request -> e-mail -> verify -> resolve -> quotes / jobs -> sign out, all through lib/portal", async () => {
    const [m, ...more] = await mailed(E.a1);
    expect(more).toHaveLength(0);
    expect(m.to).toEqual([E.a1.toLowerCase()]);
    expect(m.text).toContain(`https://portal.example.test/portal/code/${m.ref}\n`);
    expect(m.text).toContain("(Acme Ltd)");
    // Only hashes reached the database.
    const [row] = await q<Row>("select ref_hash, code_hash from customer_portal_signin_codes where contact_id = $1 and code_hash is not null", [K.a1]);
    expect(JSON.stringify(row)).not.toContain(m.ref);
    expect(JSON.stringify(row)).not.toContain(m.code.replace(" ", ""));
    // The code typed as the e-mail shows it ("1234 5678") is accepted.
    const signin = ok(await verifyPortalSignin({ ref: m.ref, code: m.code }, deps));
    secrets.push(m.ref, m.code.replace(" ", ""), signin.token);
    expect(signin.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(signin.session).toMatchObject({ contactId: K.a1, customerName: "Acme Ltd", companyName: `Synthetic PA154 A ${runId}`, permissions: ["jobs", "quotes"] });
    expect(Object.keys(signin.session).sort()).toEqual(["absoluteExpiresAt", "companyName", "contactId", "customerName", "displayName", "idleExpiresAt", "permissions"]);
    const s = ok(await resolvePortalSession(signin.token, deps));
    expect(s.contactId).toBe(K.a1);
    expect(Date.parse(s.absoluteExpiresAt) - Date.parse(s.idleExpiresAt)).toBeGreaterThan(7 * 3600_000);
    const qs = ok(await listPortalQuotes(signin.token, deps));
    expect(qs.map((x) => x.quoteRef).sort()).toEqual(["Q-1001", "Q-1002"]); // the draft never
    expect(qs.find((x) => x.quoteRef === "Q-1001")).toMatchObject({ status: "sent", customerPo: "PO-Q", totalValue: 1234.5, validUntil: expect.stringMatching(/^2026-12-31/) });
    for (const x of qs) expect(Object.keys(x).sort()).toEqual(["customerPo", "quoteRef", "sentAt", "status", "totalValue", "validUntil"]);
    expect(JSON.stringify(qs)).not.toMatch(/secret/);
    const js = ok(await listPortalJobs(signin.token, deps));
    expect(js.map((x) => [x.jobNo, x.stage])).toEqual([["J-1001", "in_progress"], ["J-1002", "complete"]]);
    for (const x of js) expect(Object.keys(x).sort()).toEqual(["customerPo", "dueDate", "jobNo", "stage"]);
    expect(JSON.stringify(js)).not.toMatch(/secret/);
    // Sign out: silent, and the token is dead.
    expect(await endPortalSession(signin.token, deps)).toBeUndefined();
    expect(await q("select end_reason from customer_portal_sessions where token_hash = encode(extensions.digest($1, 'sha256'), 'hex')", [signin.token])).toEqual([{ end_reason: "signed_out" }]);
    await refusedAs(await resolvePortalSession(signin.token, deps), "session", "session_ended");
    // An address that is no contact: the same void, nothing mailed.
    expect(await mailed(email("stranger"))).toEqual([]);
  });

  it("isolation: own customer and own company only (same customer name in the same and another company, same document numbers)", async () => {
    const t1 = await signIn(E.a1);
    const t2 = await signIn(E.a2);
    const tb = await signIn(E.b);
    secrets.push(t1, t2, tb);
    expect(await quoteRefs(t1)).toEqual(["Q-1001", "Q-1002"]);
    expect(await jobNos(t1)).toEqual(["J-1001", "J-1002"]);
    expect(await quoteRefs(t2)).toEqual(["Q-2001"]);
    expect(await jobNos(t2)).toEqual([]);
    expect(await quoteRefs(tb)).toEqual(["Q-1001"]);
    expect(await jobNos(tb)).toEqual(["J-1001"]);
    expect(ok(await resolvePortalSession(tb, deps))).toMatchObject({ contactId: K.b, companyName: `Synthetic PA154 B ${runId}` });
    // Company B's Q-1001 is B's own row, not A's.
    const [bRow] = await q<{ n: number }>("select count(*)::int as n from quotes where organization_id = $1 and quote_ref = 'Q-1001'", [orgB]);
    expect(bRow.n).toBe(1);
    // A quotes-only contact gets no jobs (the one refusal).
    const tr = await signIn(E.rev);
    secrets.push(tr);
    expect(await quoteRefs(tr)).toEqual(["Q-1001", "Q-1002"]);
    await refusedAs(await listPortalJobs(tr, deps), "read", "no_permission");
  });

  it("5 wrong codes lock the code; a code works once; a newer code supersedes the older one", async () => {
    // Four wrong codes count; the fifth locks; the right code then fails.
    const [m] = await mailed(E.a1);
    for (let i = 1; i <= 4; i++) {
      await refusedAs(await verifyPortalSignin({ ref: m.ref, code: wrongCode(m.code) }, deps), "verify", "wrong_code");
      expect(await q("select attempts from customer_portal_signin_codes where contact_id = $1 and used_at is null and code_hash is not null", [K.a1])).toEqual([{ attempts: i }]);
    }
    await refusedAs(await verifyPortalSignin({ ref: m.ref, code: wrongCode(m.code) }, deps), "verify", "locked");
    await refusedAs(await verifyPortalSignin({ ref: m.ref, code: m.code }, deps), "verify", "locked");
    // Single use.
    const [u] = await mailed(E.a1);
    const first = ok(await verifyPortalSignin({ ref: u.ref, code: u.code }, deps));
    secrets.push(first.token, u.ref, u.code.replace(" ", ""));
    await refusedAs(await verifyPortalSignin({ ref: u.ref, code: u.code }, deps), "verify", "code_used");
    // Superseded: the older e-mail's code no longer works; the newer one does.
    const [older] = await mailed(E.a1);
    const [newer] = await mailed(E.a1);
    await refusedAs(await verifyPortalSignin({ ref: older.ref, code: older.code }, deps), "verify", "code_superseded");
    secrets.push(ok(await verifyPortalSignin({ ref: newer.ref, code: newer.code }, deps)).token);
    // A code is bound to its own reference: the right code under another live reference is wrong.
    const [x] = await mailed(E.a2);
    const [y] = await mailed(E.b);
    await refusedAs(await verifyPortalSignin({ ref: y.ref, code: x.code }, deps), "verify", "wrong_code");
    // Malformed input never reaches the database (a fresh correlation id, nothing logged in the refusal table).
    rpcCalls.length = 0;
    for (const bad of [{ ref: "short", code: x.code }, { ref: x.ref, code: "1234567" }, { ref: x.ref, code: 12345678 }, { ref: null, code: null }]) {
      const r = isRefused(await verifyPortalSignin(bad, deps));
      expect(await q("select 1 from security_audit.customer_portal_refusals where correlation_id::text = $1", [r.correlationId])).toHaveLength(0);
    }
    expect(rpcCalls).toEqual([]);
  });

  it("idle 30 minutes and absolute 8 hours (session clocks moved back)", async () => {
    const idle = await signIn(E.a1);
    secrets.push(idle);
    const h = "encode(extensions.digest($1, 'sha256'), 'hex')";
    await replica(`update customer_portal_sessions set created_at = now() - interval '40 minutes', absolute_expires_at = now() - interval '40 minutes' + interval '8 hours', last_seen_at = now() - interval '31 minutes' where token_hash = ${h}`, [idle]);
    await refusedAs(await listPortalQuotes(idle, deps), "read", "session_idle");
    await refusedAs(await resolvePortalSession(idle, deps), "session", "session_ended");
    // 29 minutes idle still works, and the call restarts the idle clock.
    const fresh = await signIn(E.a1);
    secrets.push(fresh);
    await replica(`update customer_portal_sessions set created_at = now() - interval '29 minutes', absolute_expires_at = now() - interval '29 minutes' + interval '8 hours', last_seen_at = now() - interval '29 minutes' where token_hash = ${h}`, [fresh]);
    const s = ok(await resolvePortalSession(fresh, deps));
    expect(Date.parse(s.idleExpiresAt) - Date.now()).toBeGreaterThan(25 * 60_000);
    // Past the absolute limit, even when recently active.
    const abs = await signIn(E.a1);
    secrets.push(abs);
    await replica(`update customer_portal_sessions set created_at = now() - interval '8 hours 1 minute', absolute_expires_at = now() - interval '1 minute', last_seen_at = now() - interval '1 minute' where token_hash = ${h}`, [abs]);
    await refusedAs(await resolvePortalSession(abs, deps), "session", "session_expired");
    await refusedAs(await listPortalJobs(abs, deps), "read", "session_ended");
    expect(await q(`select end_reason from customer_portal_sessions where token_hash in (${h}, encode(extensions.digest($2, 'sha256'), 'hex')) order by end_reason`, [idle, abs]))
      .toEqual([{ end_reason: "absolute" }, { end_reason: "idle" }]);
  });

  it("platform flag OFF: every call refuses and nothing touches the database", async () => {
    const t = await signIn(E.a1);
    secrets.push(t);
    rpcCalls.length = 0;
    tasks.length = 0;
    expect(await requestPortalSignin(E.a1, depsOff)).toBeUndefined();
    const [m] = [{ ref: randomBytes(16).toString("base64url"), code: "12345678" }];
    isRefused(await verifyPortalSignin(m, depsOff));
    isRefused(await resolvePortalSession(t, depsOff));
    isRefused(await listPortalQuotes(t, depsOff));
    isRefused(await listPortalJobs(t, depsOff));
    expect(await endPortalSession(t, depsOff)).toBeUndefined();
    // No key: the same.
    const noKey = { ...deps, env: { ...env, PORTAL_SIGNIN_HMAC_KEY: undefined } };
    expect(await requestPortalSignin(E.a1, noKey)).toBeUndefined();
    isRefused(await verifyPortalSignin(m, noKey));
    expect(rpcCalls).toEqual([]);
    expect(tasks).toHaveLength(0);
    // The session itself was untouched: ON again, it still works.
    expect(ok(await resolvePortalSession(t, deps)).contactId).toBe(K.a1);
  });

  it("company switch OFF: no code is mailed, a pending code and a live session are refused; ON again does not revive the session", async () => {
    const t = await signIn(E.a2);
    secrets.push(t);
    const [pending] = await mailed(E.a2);
    await portalSwitch(A.a, false);
    expect(await mailed(E.a2)).toEqual([]);
    await refusedAs(await verifyPortalSignin({ ref: pending.ref, code: pending.code }, deps), "verify", "portal_off");
    await refusedAs(await resolvePortalSession(t, deps), "session", "portal_off");
    await portalSwitch(A.a, true);
    await refusedAs(await listPortalQuotes(t, deps), "read", "session_ended");
    expect(await q("select end_reason from customer_portal_sessions where token_hash = encode(extensions.digest($1, 'sha256'), 'hex')", [t])).toEqual([{ end_reason: "portal_off" }]);
  });

  it("company paused, contact revoked, customer archived: refused at the next call, and no code is mailed", async () => {
    // Company paused.
    const tp = await signIn(E.pause);
    secrets.push(tp);
    await replica("update organizations set status = 'paused' where id = $1", [orgB]);
    await refusedAs(await listPortalQuotes(tp, deps), "read", "company_inactive");
    expect(await mailed(E.pause)).toEqual([]);
    await replica("update organizations set status = 'active' where id = $1", [orgB]);
    await refusedAs(await resolvePortalSession(tp, deps), "session", "session_ended");
    // Contact revoked: live session and the pending code both refused; no new code.
    const tr = await signIn(E.rev);
    secrets.push(tr);
    const [pending] = await mailed(E.rev);
    const rv = await asAdmin(A.a, "public.portal_contact_revoke($1, $2)", [K.rev, `left the customer ${REASON_MARK}`]);
    expect(rv).toMatchObject({ contact_id: K.rev });
    await refusedAs(await listPortalQuotes(tr, deps), "read", "session_ended");
    await refusedAs(await verifyPortalSignin({ ref: pending.ref, code: pending.code }, deps), "verify", "revoked");
    expect(await mailed(E.rev)).toEqual([]);
    // Customer archived.
    const ta = await signIn(E.arch);
    secrets.push(ta);
    await q("insert into record_archive_state (organization_id, record_table, record_id, state, set_by) values ($1, 'customers', $2, 'archived', $3)", [orgA, C.acme2, A.a]);
    await refusedAs(await resolvePortalSession(ta, deps), "session", "customer_archived");
    expect(await mailed(E.arch)).toEqual([]);
    expect(await mailed(E.a2)).toEqual([]); // the other contact of the same archived customer too
    await q("delete from record_archive_state where record_table = 'customers' and record_id = $1", [C.acme2]);
    await refusedAs(await listPortalJobs(ta, deps), "read", "session_ended");
  });

  it("archived documents are hidden (links still live); unarchived, shown again", async () => {
    const t = await signIn(E.a1);
    secrets.push(t);
    expect(await quoteRefs(t)).toEqual(["Q-1001", "Q-1002"]);
    expect(await jobNos(t)).toEqual(["J-1001", "J-1002"]);
    await q("insert into record_archive_state (organization_id, record_table, record_id, state, set_by) values ($1, 'quotes', $2, 'archived', $4), ($1, 'jobs', $3, 'archived', $4)", [orgA, D.q1, D.j2, A.a]);
    expect(await quoteRefs(t)).toEqual(["Q-1002"]);
    expect(await jobNos(t)).toEqual(["J-1001"]);
    await q("delete from record_archive_state where record_table in ('quotes', 'jobs') and record_id = any($1::uuid[])", [[D.q1, D.j2]]);
    expect(await quoteRefs(t)).toEqual(["Q-1001", "Q-1002"]);
    expect(await jobNos(t)).toEqual(["J-1001", "J-1002"]);
  });

  it("one identical refusal shape for every refusal (database, flag off, no key, malformed, 154 missing)", async () => {
    // Bad tokens of every kind, too.
    for (const t of [undefined, null, "", "x", 42, randomBytes(32).toString("base64url")]) isRefused(await resolvePortalSession(t, deps));
    expect(refusals.length).toBeGreaterThan(40);
    const shapes = new Set(refusals.map((r) => JSON.stringify({ ...r, correlationId: "<id>" })));
    expect([...shapes]).toEqual([JSON.stringify({ ok: false, reason: "refused", correlationId: "<id>" })]);
    for (const r of refusals) {
      expect(Object.keys(r).sort()).toEqual(["correlationId", "ok", "reason"]);
      expect(r.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
    expect(new Set(refusals.map((r) => r.correlationId)).size).toBe(refusals.length);
  });

  it("audit rows carry ids and categories only: no e-mail, name, IP, code, reference, token, hash or free-text reason", async () => {
    const rows = await q<Row>(`select action, entity_table, entity_id, old_data, new_data, metadata from security_audit.audit_log
      where organization_id = any($1::uuid[]) and (action like 'CUSTOMER_PORTAL_%' or entity_table like 'customer_portal_%') order by created_at`, [[orgA, orgB]]);
    const actions = new Set(rows.map((r) => r.action));
    for (const a of ["CUSTOMER_PORTAL_CONTACT_INVITED", "CUSTOMER_PORTAL_CONTACT_REVOKED", "CUSTOMER_PORTAL_SIGNIN_CODE_SENT", "CUSTOMER_PORTAL_SIGNED_IN",
                     "CUSTOMER_PORTAL_SESSION_ENDED", "CUSTOMER_PORTAL_DOCUMENTS_VIEWED"]) expect(actions.has(a), a).toBe(true);
    const text = JSON.stringify(rows).toLowerCase();
    for (const e of Object.values(E)) expect(text, "e-mail").not.toContain(e.toLowerCase());
    for (const mark of [NAME_MARK, REASON_MARK, "pat buyer", "asked for access", "left the customer"]) expect(text, mark).not.toContain(mark.toLowerCase());
    expect(secrets.length).toBeGreaterThan(15);
    for (const s of secrets) expect(text, "ref / code / token").not.toContain(s.toLowerCase());
    expect(text).not.toMatch(/[0-9a-f]{64}/); // no full hash
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/); // no IPv4 address
    // Every value in the portal's own events is an id (uuid), a fixed category, a count, a boolean or a time: nothing typed by a person.
    const own = rows.filter((r) => String(r.action).startsWith("CUSTOMER_PORTAL_") && r.action !== "CUSTOMER_PORTAL_SWITCH_CHANGED");
    expect(own.length).toBeGreaterThan(20);
    const leaf = (v: unknown): unknown[] => (v && typeof v === "object" ? Object.values(v).flatMap(leaf) : [v]);
    for (const r of own) {
      expect(r.metadata === null || (r.metadata as Row).reason === undefined, String(r.action)).toBe(true);
      for (const v of leaf([r.entity_id, r.old_data, r.new_data, r.metadata])) {
        const ok = v === null || typeof v === "number" || typeof v === "boolean"
          || (typeof v === "string" && (/^[0-9a-f-]{36}$/.test(v) || /^[a-z_]{1,40}$/.test(v) || /^\d{4}-\d{2}-\d{2}[T ][\d:.+Z-]+$/.test(v)));
        expect(ok, `${String(r.action)}: ${JSON.stringify(v)}`).toBe(true);
      }
    }
    // The refusal log too: step and category, a 16-hex subject at most, never an e-mail, code, ref or token.
    const log = await q<Row>("select step, reason, subject_hash16 from security_audit.customer_portal_refusals where organization_id = any($1::uuid[])", [[orgA, orgB]]);
    expect(log.length).toBeGreaterThan(10);
    for (const r of log) expect(r.subject_hash16 === null || /^[0-9a-f]{16}$/.test(String(r.subject_hash16))).toBe(true);
    const logText = JSON.stringify(log).toLowerCase();
    for (const s of [...secrets, ...Object.values(E)]) expect(logText).not.toContain(s.toLowerCase());
  });
});
