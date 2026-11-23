/**
 * Release 165 (supabase/release/165_owner_issues.release.sql): Raise an issue for every signed-in user and the platform owner's issues
 * inbox. The DB proof, below PostgREST, one `it` per case.
 *
 * Inputs: the disposable stack (TEST_DATABASE_URL, isolation-checked); the post-144 fixture installs 145..165. Synthetic companies (slug
 * t-<run>-...) and people, forged claims as PostgREST sets them (no Auth API); each call is one transaction. The release stays installed when
 * this file ends (the CI schema marker after the DB suite expects it).
 * Proves: installed and verified (11 rows true), preflight marker "applied"; the company switch is off by default and raise_issue refuses
 * (42501, issues_off) until 'issues:on' is in the company's hidden_nav; every role (admin, office, workshop, viewer) raises once it is on;
 * company and person come from the session, status starts 'new'; bad text/page/urgent refused 22023; support sessions and anon refused;
 * 21st issue in an hour refused; a company reads only its own issues (never another's) and can insert, update or delete nothing directly;
 * no browser role can read issue_owner_notes; platform_list_issues / platform_update_issue refuse a company admin even at aal2 and a platform
 * owner on a first-step-only (aal1) token (42501, mfa_required), and work for the owner at aal2: all companies, filters (company, status,
 * urgent, bad status 22023), notes and PR link saved and listed, close stamps closed_at, reopen clears it, bad status/PR link 22023, missing
 * issue P0002; owner notes and PR link never reach the company's own read; the second apply refuses and changes nothing; rollback refuses
 * while issues exist, runs only with the accepted setting and removes only 165's objects (fingerprint of everything else unchanged), and the
 * release can be applied again.
 * Not proved here: PostgREST's own error mapping, hosted grants (service_role there comes from Supabase's default privileges).
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
const RELEASE = "supabase/release/165_owner_issues.release.sql";
const ROLLBACK = "supabase/release/165_owner_issues.rollback.sql";
const VERIFY = "supabase/verify/owner_issues_165.sql";
const FNS = ["public.raise_issue(text,text,boolean)", "public.platform_list_issues(uuid,text,boolean,integer)", "public.platform_update_issue(uuid,text,text,text)"];

let pool: Pool;
type Row = Record<string, unknown>;
type Person = { id: string; email: string; session: string };
type Outcome<T = unknown> = { ok: true; value: T } | { ok: false; code?: string; hint?: string; message: string };
const orgs: string[] = [];
const people: Person[] = [];
let A: { org: string; admin: Person; office: Person; workshop: Person; viewer: Person; support: Person };
let B: { org: string; admin: Person };
let owner: Person;

async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await pool.connect();
  try { return (await db.query(sql, params)).rows as T[]; }
  catch (error) {
    // A release or rollback file opens its own transaction; when its guard refuses, the connection must not go back to the pool aborted.
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally { db.release(); }
}
async function makeOrg(label: string, issuesOn: boolean) {
  const id = randomUUID();
  seq += 1;
  await q("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [id, `165 ${label} ${runId}`, `${SYNTHETIC_SLUG_PREFIX}${runId}-165-${label}-${seq}`]);
  orgs.push(id);
  if (issuesOn) await setSwitch(id, true);
  return id;
}
/** The company switch, written without the onboarding/nav guards (this proof is about raise_issue, not those guards). */
async function setSwitch(org: string, on: boolean) {
  const db = await pool.connect();
  try {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    await db.query(`insert into public.organization_settings (organization_id, hidden_nav) values ($1, $2::text[])
                    on conflict (organization_id) do update set hidden_nav = excluded.hidden_nav`, [org, on ? ["issues:on"] : []]);
    await db.query("commit");
  } catch (error) { await db.query("rollback").catch(() => undefined); throw error; } finally { db.release(); }
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
/** A Tolra support login chosen into the company (read-only: never elevated). Never an ordinary member. */
async function makeSupport(org: string, name: string): Promise<Person> {
  seq += 1;
  const p = { id: randomUUID(), email: `${name}-${seq}.${runId}@example.test`, session: randomUUID() };
  const grant = randomUUID();
  await q("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await q(`insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, 'Tolra Support', 'admin', $3, true, false)`, [p.id, p.email, org]);
  await q("insert into security_audit.platform_admins (user_id) values ($1)", [p.id]);
  await q(`insert into public.organization_members (user_id, organization_id, role, active, support, expires_at, support_grant) values ($1, $2, 'admin', true, true, now() + interval '2 hours', $3)`, [p.id, org, grant]);
  await q("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await q("insert into security_audit.session_company (session_id, user_id, organization_id, grant_id) values ($1, $2, $3, $4)", [p.session, p.id, org, grant]);
  people.push(p);
  return p;
}
/** A platform owner outside any company (no session company): the person who uses /platform/issues. */
async function makeOwner(org: string): Promise<Person> {
  seq += 1;
  const p = { id: randomUUID(), email: `owner-${seq}.${runId}@example.test`, session: randomUUID() };
  await q("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await q(`insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, 'Platform Owner', 'admin', $3, true, false)`, [p.id, p.email, org]);
  await q("insert into security_audit.platform_admins (user_id) values ($1)", [p.id]);
  await q("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  people.push(p);
  return p;
}
/** One API request: its own transaction, as role authenticated (the person's claims) or anon, as PostgREST runs it. */
async function as<T>(p: Person | "anon", fn: (db: PoolClient) => Promise<T>, aal: "aal1" | "aal2" = "aal2"): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    if (p === "anon") {
      await db.query("set local role anon");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    } else {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal, email: p.email, session_id: p.session }), p.id]);
    }
    const result = await fn(db);
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}
async function call<T = Row[]>(p: Person | "anon", sql: string, params: unknown[] = [], aal: "aal1" | "aal2" = "aal2"): Promise<Outcome<T>> {
  try {
    return { ok: true, value: (await as(p, async (db) => (await db.query(sql, params)).rows, aal)) as T };
  } catch (e) {
    const err = e as { code?: string; hint?: string; message: string };
    return { ok: false, code: err.code, hint: err.hint, message: err.message };
  }
}
const raise = (p: Person | "anon", page: string, body: string, urgent: boolean | null = false) => call<{ id: string }[]>(p, "select public.raise_issue($1, $2, $3) as id", [page, body, urgent]);
const list = (p: Person, args: { org?: string | null; status?: string | null; urgent?: boolean | null } = {}, aal: "aal1" | "aal2" = "aal2") =>
  call<Row[]>(p, "select * from public.platform_list_issues($1, $2, $3)", [args.org ?? null, args.status ?? null, args.urgent ?? null], aal);
const update = (p: Person, id: string, status: string, notes: string | null, pr: string | null, aal: "aal1" | "aal2" = "aal2") =>
  call<{ r: Row }[]>(p, "select public.platform_update_issue($1, $2, $3, $4) as r", [id, status, notes, pr], aal);
const issueIds = async (org: string) => (await q<{ id: string }>("select id from public.issues where organization_id = $1 order by created_at, id", [org])).map((r) => r.id);
/** md5 over every function in public and security_audit except 165's, with security, config, body and grants. */
async function otherFunctionsFingerprint() {
  return (await q<{ fp: string }>(`select md5(coalesce(string_agg(md5(concat_ws('|', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), p.prosecdef::text, coalesce(p.proconfig::text, ''), md5(p.prosrc), coalesce(p.proacl::text, ''))), '' order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), '')) as fp
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'security_audit') and p.proname not in ('raise_issue', 'platform_list_issues', 'platform_update_issue')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`))[0].fp;
}
const installed = async () => (await q<{ ok: boolean }>("select (to_regclass('public.issues') is not null and to_regclass('public.issue_owner_notes') is not null and bool_and(to_regprocedure(f) is not null)) as ok from unnest($1::text[]) f", [FNS]))[0].ok;
const verifyRows = async () => (await q<{ check_name: string; ok: boolean }>(read(VERIFY)));

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
  pool = new Pool({ connectionString: isolatedBackend().databaseUrl, max: 6 });
  const orgA = await makeOrg("alpha", false); // the switch starts OFF: case 2 proves the default
  const orgB = await makeOrg("beta", true);
  A = { org: orgA, admin: await makePerson(orgA, "a-admin", "admin"), office: await makePerson(orgA, "a-office", "office"),
        workshop: await makePerson(orgA, "a-workshop", "workshop"), viewer: await makePerson(orgA, "a-viewer", "viewer"), support: await makeSupport(orgA, "a-support") };
  B = { org: orgB, admin: await makePerson(orgB, "b-admin", "admin") };
  owner = await makeOwner(orgA);
});

afterAll(async () => {
  if (!pool) return;
  try {
    if (!(await installed())) await q(read(RELEASE)); // this file leaves 165 installed, as the fixture and the CI schema marker expect
    const ids = people.map((p) => p.id);
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      await db.query("delete from public.issues where organization_id = any($1)", [orgs]);
      for (const t of ["public.organization_settings", "public.organization_members", "public.user_profiles"]) await db.query(`delete from ${t} where organization_id = any($1)`, [orgs]);
      await db.query("delete from security_audit.session_company where user_id = any($1)", [ids]);
      await db.query("delete from security_audit.platform_admins where user_id = any($1)", [ids]);
      await db.query("delete from public.organizations where id = any($1)", [orgs]);
      await db.query("commit");
      await db.query("delete from auth.users where id = any($1)", [ids]);
    } catch (e) { await db.query("rollback").catch(() => undefined); throw e; } finally { db.release(); }
  } finally {
    await pool.end();
  }
});

describe("release 165: Raise an issue and the owner issues inbox", () => {
  it("1. the release is installed and verified (11 rows true), the preflight marker says applied, and the second apply refuses and changes nothing", async () => {
    expect(await installed()).toBe(true);
    const marker = (await q<{ check: string; value: string }>(read("supabase/verify/release_preflight.sql"))).find((r) => r.check === "post-144 marker 165 owner_issues");
    expect(marker?.value).toBe("applied");
    const rows = await verifyRows();
    expect(rows).toHaveLength(11);
    expect(rows.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
    const before = await otherFunctionsFingerprint();
    await expect(q(read(RELEASE))).rejects.toThrow(/165: .*already exists/);
    expect(await otherFunctionsFingerprint()).toBe(before);
    expect((await verifyRows()).every((r) => r.ok === true)).toBe(true);
  });

  it("2. the company switch is OFF by default: raise_issue is refused (42501, issues_off) for every role and nothing is saved", async () => {
    for (const p of [A.admin, A.office, A.workshop, A.viewer]) expect(await raise(p, "/jobs", "It broke")).toMatchObject({ ok: false, code: "42501", hint: "issues_off" });
    expect(await issueIds(A.org)).toEqual([]);
  });

  it("3. with 'issues:on' every role raises an issue: company and person come from the session, status starts new, urgent is kept", async () => {
    await setSwitch(A.org, true);
    for (const [p, urgent] of [[A.admin, false], [A.office, true], [A.workshop, false], [A.viewer, false]] as const) {
      const r = await raise(p, "/jobs", `Broken for ${p.email}`, urgent);
      expect(r.ok, p.email).toBe(true);
    }
    const rows = await q<{ organization_id: string; user_id: string; status: string; urgent: boolean; closed_at: string | null }>("select organization_id, user_id, status, urgent, closed_at from public.issues where organization_id = $1 order by created_at, id", [A.org]);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.organization_id === A.org && r.status === "new" && r.closed_at === null)).toBe(true);
    expect(new Set(rows.map((r) => r.user_id))).toEqual(new Set([A.admin.id, A.office.id, A.workshop.id, A.viewer.id]));
    expect(rows.filter((r) => r.urgent)).toHaveLength(1);
    expect((await raise(B.admin, "/invoices", "Beta problem", false)).ok).toBe(true);
  });

  it("4. bad input is refused 22023 and saves nothing; support sessions and anon are refused; a stuck button is stopped after 20 in an hour", async () => {
    const before = await issueIds(A.org);
    expect(await raise(A.admin, "/jobs", "   ")).toMatchObject({ ok: false, code: "22023" });
    expect(await raise(A.admin, "/jobs", "x".repeat(2001))).toMatchObject({ ok: false, code: "22023" });
    expect(await raise(A.admin, "   ", "It broke")).toMatchObject({ ok: false, code: "22023" });
    expect(await raise(A.admin, "/".repeat(301), "It broke")).toMatchObject({ ok: false, code: "22023" });
    expect(await raise(A.admin, "/jobs", "It broke", null)).toMatchObject({ ok: false, code: "22023" });
    expect(await raise(A.support, "/jobs", "As support")).toMatchObject({ ok: false, code: "42501" });
    expect(await raise("anon", "/jobs", "As anon")).toMatchObject({ ok: false, code: "42501" });
    expect(await issueIds(A.org)).toEqual(before);
    const spare = await makePerson(A.org, "a-spare", "workshop");
    for (let i = 0; i < 20; i += 1) expect((await raise(spare, "/jobs", `Spam ${i}`)).ok, `issue ${i + 1}`).toBe(true);
    expect(await raise(spare, "/jobs", "One too many")).toMatchObject({ ok: false, code: "22023", hint: "too_many" });
    expect(await raise(A.admin, "/jobs", "A different person is not limited")).toMatchObject({ ok: true });
  });

  it("5. a company reads only its own issues, and can insert, update or delete nothing directly; nobody in a browser reads the owner notes", async () => {
    const mineA = await issueIds(A.org);
    const mineB = await issueIds(B.org);
    const seenA = await call<{ id: string }[]>(A.viewer, "select id from public.issues");
    const seenB = await call<{ id: string }[]>(B.admin, "select id from public.issues");
    expect(seenA.ok && seenA.value.map((r) => r.id).sort()).toEqual([...mineA].sort());
    expect(seenB.ok && seenB.value.map((r) => r.id).sort()).toEqual(mineB.sort());
    expect(await call(A.admin, "select id from public.issues where organization_id = $1", [B.org])).toMatchObject({ ok: true, value: [] });
    expect(await call(A.admin, "insert into public.issues (organization_id, page, body) values ($1, '/x', 'direct')", [A.org])).toMatchObject({ ok: false, code: "42501" });
    expect(await call(A.admin, "update public.issues set status = 'closed' where organization_id = $1", [A.org])).toMatchObject({ ok: false, code: "42501" });
    expect(await call(A.admin, "delete from public.issues where organization_id = $1", [A.org])).toMatchObject({ ok: false, code: "42501" });
    expect(await call(A.admin, "select * from public.issue_owner_notes")).toMatchObject({ ok: false, code: "42501" });
    expect(await call(A.admin, "insert into public.issue_owner_notes (issue_id) values ($1)", [mineA[0]])).toMatchObject({ ok: false, code: "42501" });
    expect(await call("anon", "select id from public.issues")).toMatchObject({ ok: false, code: "42501" });
    expect(await issueIds(A.org)).toEqual(mineA);
  });

  it("6. the owner functions refuse a company admin (even at the second step), a support session, anon and the owner on a first-step-only (aal1) token", async () => {
    const [issue] = await issueIds(A.org);
    expect(await list(A.admin)).toMatchObject({ ok: false, code: "42501" });
    expect(await update(A.admin, issue, "closed", "n", null)).toMatchObject({ ok: false, code: "42501" });
    expect(await list(A.workshop, {}, "aal1")).toMatchObject({ ok: false, code: "42501" });
    const aal1 = await list(owner, {}, "aal1");
    expect(aal1).toMatchObject({ ok: false, code: "42501", hint: "mfa_required" });
    expect(await update(owner, issue, "closed", "n", null, "aal1")).toMatchObject({ ok: false, code: "42501", hint: "mfa_required" });
    expect(await call("anon", "select * from public.platform_list_issues()")).toMatchObject({ ok: false, code: "42501" });
    expect(await call("anon", "select public.platform_update_issue($1, 'closed', '', null)", [issue])).toMatchObject({ ok: false, code: "42501" });
    expect((await q<{ status: string }>("select status from public.issues where id = $1", [issue]))[0].status).toBe("new");
  });

  it("7. the owner lists every company's issues, filters by company, status and urgent, and a bad status is refused 22023", async () => {
    const all = await list(owner);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const mine = all.value.filter((r) => r.organization_id === A.org || r.organization_id === B.org);
    expect(new Set(mine.map((r) => r.organization_id))).toEqual(new Set([A.org, B.org]));
    expect(mine.length).toBe((await issueIds(A.org)).length + (await issueIds(B.org)).length);
    const first = mine.find((r) => r.organization_id === A.org);
    expect(first).toMatchObject({ organization_name: expect.stringContaining(runId), status: "new", owner_notes: "", pr_url: null });
    const onlyB = await list(owner, { org: B.org });
    expect(onlyB.ok && onlyB.value.every((r) => r.organization_id === B.org) && onlyB.value.length).toBe((await issueIds(B.org)).length);
    const urgentA = await list(owner, { org: A.org, urgent: true });
    expect(urgentA.ok && urgentA.value.length).toBe(1);
    const notUrgentA = await list(owner, { org: A.org, urgent: false });
    expect(notUrgentA.ok && notUrgentA.value.every((r) => r.urgent === false)).toBe(true);
    expect(await list(owner, { org: A.org, status: "closed" })).toMatchObject({ ok: true, value: [] });
    expect(await list(owner, { status: "bogus" })).toMatchObject({ ok: false, code: "22023" });
  });

  it("8. the owner sets status, private notes and the PR link; close stamps closed_at; reopening clears it; the company never sees the notes", async () => {
    const [issue] = await issueIds(B.org);
    const fixing = await update(owner, issue, "fixing", "Looks like the invoice list", "https://github.com/example/example/pull/7");
    expect(fixing).toMatchObject({ ok: true });
    expect((await list(owner, { org: B.org })).ok).toBe(true);
    const row = (r: Outcome<Row[]>) => (r.ok ? r.value.find((x) => x.issue_id === issue) : undefined);
    expect(row(await list(owner, { org: B.org }))).toMatchObject({ status: "fixing", owner_notes: "Looks like the invoice list", pr_url: "https://github.com/example/example/pull/7", closed_at: null });
    const closed = await update(owner, issue, "closed", "Fixed in PR 7", "https://github.com/example/example/pull/7");
    expect(closed.ok && closed.value[0].r.closed_at).toBeTruthy();
    const closedRow = row(await list(owner, { org: B.org, status: "closed" }));
    expect(closedRow).toMatchObject({ status: "closed", owner_notes: "Fixed in PR 7" });
    expect(closedRow?.closed_at).toBeTruthy();
    const stamp = closedRow?.closed_at;
    await update(owner, issue, "closed", "Fixed in PR 7 (again)", null);
    expect(row(await list(owner, { org: B.org, status: "closed" }))?.closed_at).toEqual(stamp);
    const reopened = await update(owner, issue, "looking", "", null);
    expect(reopened.ok && reopened.value[0].r.closed_at).toBeNull();
    expect(row(await list(owner, { org: B.org }))).toMatchObject({ status: "looking", owner_notes: "", pr_url: null, closed_at: null });
    const seen = await call<Row[]>(B.admin, "select * from public.issues where id = $1", [issue]);
    expect(seen.ok && Object.keys(seen.value[0]).sort()).toEqual(["body", "closed_at", "created_at", "id", "organization_id", "page", "status", "updated_at", "urgent", "user_id"]);
  });

  it("9. bad updates are refused 22023 and a missing issue P0002, changing nothing", async () => {
    const [issue] = await issueIds(B.org);
    const before = await list(owner, { org: B.org });
    expect(await update(owner, issue, "weird", "", null)).toMatchObject({ ok: false, code: "22023" });
    expect(await update(owner, issue, "new", "x".repeat(4001), null)).toMatchObject({ ok: false, code: "22023" });
    expect(await update(owner, issue, "new", "", "http://not-https.example/pull/1")).toMatchObject({ ok: false, code: "22023" });
    expect(await update(owner, issue, "new", "", "javascript:alert(1)")).toMatchObject({ ok: false, code: "22023" });
    expect(await update(owner, issue, "new", "", "https://has space.example")).toMatchObject({ ok: false, code: "22023" });
    expect(await update(owner, randomUUID(), "new", "", null)).toMatchObject({ ok: false, code: "P0002", hint: "issue_not_found" });
    expect(await list(owner, { org: B.org })).toEqual(before);
  });

  it("10. rollback refuses while issues exist; with the accepted setting it removes only 165's objects (everything else unchanged); the release then applies again", async () => {
    const before = await otherFunctionsFingerprint();
    await expect(q(read(ROLLBACK))).rejects.toThrow(/165 rollback refused/);
    expect(await installed()).toBe(true);
    expect(await otherFunctionsFingerprint()).toBe(before);
    const db = await pool.connect();
    try {
      await db.query("set tolra.x165_accept_deleting_issues = 'yes'");
      await db.query(read(ROLLBACK));
      await db.query("reset tolra.x165_accept_deleting_issues");
    } finally { db.release(); }
    expect((await q<{ n: number }>("select (to_regclass('public.issues') is not null)::int + (to_regclass('public.issue_owner_notes') is not null)::int + (select count(*)::int from pg_proc where proname in ('raise_issue', 'platform_list_issues', 'platform_update_issue') and pronamespace = 'public'::regnamespace) as n"))[0].n).toBe(0);
    expect(await otherFunctionsFingerprint()).toBe(before);
    const marker = (await q<{ check: string; value: string }>(read("supabase/verify/release_preflight.sql"))).find((r) => r.check === "post-144 marker 165 owner_issues");
    expect(marker?.value).not.toBe("applied");
    await q(read(RELEASE));
    expect(await installed()).toBe(true);
    expect((await verifyRows()).every((r) => r.ok === true)).toBe(true);
    // An empty rollback needs no acceptance, and the release applies once more (the file leaves 165 installed).
    await q(read(ROLLBACK));
    expect(await installed()).toBe(false);
    await q(read(RELEASE));
    expect((await verifyRows()).every((r) => r.ok === true)).toBe(true);
  });
});
