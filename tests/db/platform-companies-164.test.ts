/**
 * Release 164 (supabase/release/164_platform_companies.release.sql): the platform owner's Companies screen, in the database:
 * public.platform_company_overview() (one row per company with its people, jobs, invoices and issued invoices) and
 * public.platform_set_organization_status(p_org, p_status, p_confirm_name, p_reason) (Close an active company, Reopen a closed one).
 * The DB proof, below PostgREST, one `it` per case.
 *
 * Inputs: the disposable stack (TEST_DATABASE_URL, isolation-checked); the post-144 fixture installs 145..164 (164 needs 036 only). Synthetic
 * companies (slug t-<run>-...), people and one platform owner; forged claims as PostgREST sets them (sub, session_id, aal, and amr with the
 * authenticator time the fresh-code rule reads), no Auth API; each call is one transaction. The release stays installed when this file ends.
 * Proves: installed and verified (9 rows true), the preflight marker says applied, applying again changes nothing; the owner's overview has the
 * right counts (active people only, support people not counted, issued invoices separate from drafts and voids) and a company admin, office,
 * workshop, viewer, anon, service_role, an owner without the second step and a deactivated owner are refused; Close needs the second step, a
 * code under 15 minutes old, the exact name and a reason and is refused for the company the owner's session is inside; a closed company's people
 * lose access at once and the owner cannot enter it; Reopen needs the second step and a reason and gives the access back; a paused company is
 * neither closed nor reopened; the audit log records each change once; nothing is deleted (companies, jobs, invoices and people are all still
 * there); two simultaneous closes change the company once; rollback removes the two functions and nothing else and the release can be applied again.
 * Not proved here: PostgREST's own error mapping, the screen (the platform page and its route have their own tests), hosted grants.
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
const RELEASE = "supabase/release/164_platform_companies.release.sql";
const ROLLBACK = "supabase/release/164_platform_companies.rollback.sql";
const VERIFY = "supabase/verify/platform_companies_164.sql";
const OV = "public.platform_company_overview()";
const ST = "public.platform_set_organization_status(uuid,text,text,text)";
const OV_MD5 = "ed9d541cde10b9a815eb8fce4eae238f";
const ST_MD5 = "4e4c0d80bc2b93a1656da5aeaa8eab8e";

let pool: Pool;
type Row = Record<string, unknown>;
type Person = { id: string; email: string; session: string };
type Amr = Array<{ method: string; timestamp: number }>;
type Outcome<T> = { ok: true; value: T } | { ok: false; code?: string; hint?: string; message: string };
const orgs: string[] = [];
const people: Person[] = [];
let A: { org: string; name: string; admin: Person; office: Person; workshop: Person; viewer: Person; inactive: Person; support: Person };
let B: { org: string; name: string; admin: Person };
let HOME: string;
let owner: Person;
/** The owner's session that is inside company A (the "company you are inside" rule). */
let ownerInside: Person;

const nowS = () => Math.floor(Date.now() / 1000);
const fresh = (): Amr => [{ method: "totp", timestamp: nowS() - 60 }];
const stale = (): Amr => [{ method: "totp", timestamp: nowS() - 3600 }];

async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await pool.connect();
  try { return (await db.query(sql, params)).rows as T[]; }
  catch (error) {
    // A release or rollback file opens its own transaction; when its guard refuses, the connection must not go back to the pool aborted.
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally { db.release(); }
}
async function makeOrg(label: string) {
  const id = randomUUID();
  seq += 1;
  const name = `164 ${label} ${runId}`;
  await q("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [id, name, `${SYNTHETIC_SLUG_PREFIX}${runId}-164-${label}-${seq}`]);
  orgs.push(id);
  return { id, name };
}
async function makeUser(org: string, name: string, role: string): Promise<Person> {
  seq += 1;
  const p = { id: randomUUID(), email: `${name}-${seq}.${runId}@example.test`, session: randomUUID() };
  await q("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await q(`insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, $3, $4, $5, true, false)`, [p.id, p.email, `Person ${seq}`, role, org]);
  await q("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  people.push(p);
  return p;
}
async function makeMember(org: string, name: string, role: string): Promise<Person> {
  const p = await makeUser(org, name, role);
  await q("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, $3, true)", [p.id, org, role]);
  await q("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
  return p;
}
/** The platform owner: on the platform list, with a profile (in the home company) and no ordinary membership. */
async function makeOwner(name: string): Promise<Person> {
  const p = await makeUser(HOME, name, "admin");
  await q("insert into security_audit.platform_admins (user_id, note) values ($1, 'synthetic platform owner (164)')", [p.id]);
  return p;
}
/** One API request: its own transaction, as role authenticated (the person's claims) or anon or service_role, as PostgREST runs it. */
async function as<T>(p: Person | "anon" | "service", fn: (db: PoolClient) => Promise<T>, opts: { aal?: "aal1" | "aal2"; amr?: Amr } = {}): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    if (p === "anon" || p === "service") {
      await db.query(`set local role ${p === "anon" ? "anon" : "service_role"}`);
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: p === "anon" ? "anon" : "service_role" })]);
    } else {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal: opts.aal ?? "aal2", email: p.email, session_id: p.session, ...(opts.amr ? { amr: opts.amr } : {}) }), p.id]);
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
type OverviewRow = { organization_id: string; name: string; slug: string; status: string; user_count: string; job_count: string; invoice_count: string; issued_invoice_count: string };
async function overview(p: Person | "anon" | "service", opts: { aal?: "aal1" | "aal2" } = {}): Promise<Outcome<OverviewRow[]>> {
  try {
    return { ok: true, value: await as(p, async (db) => (await db.query("select * from public.platform_company_overview()")).rows as OverviewRow[], opts) };
  } catch (e) {
    const err = e as { code?: string; message: string; hint?: string };
    return { ok: false, code: err.code, hint: err.hint, message: err.message };
  }
}
type StatusAnswer = { organization_id: string; status: string; changed: boolean };
async function setStatus(p: Person | "anon" | "service", org: string, status: string, name: string | null, reason: string | null, opts: { aal?: "aal1" | "aal2"; amr?: Amr } = {}): Promise<Outcome<StatusAnswer>> {
  try {
    const rows = await as(p, async (db) => (await db.query("select public.platform_set_organization_status($1, $2, $3, $4) as r", [org, status, name, reason])).rows, opts);
    return { ok: true, value: rows[0].r as StatusAnswer };
  } catch (e) {
    const err = e as { code?: string; message: string; hint?: string };
    return { ok: false, code: err.code, hint: err.hint, message: err.message };
  }
}
const statusOf = async (org: string) => (await q<{ status: string }>("select status from public.organizations where id = $1", [org]))[0].status;
const auditCount = async (org: string, action: string) => Number((await q<{ n: string }>("select count(*) as n from security_audit.audit_log where organization_id = $1 and action = $2", [org, action]))[0].n);
const companyIdFor = (p: Person) => as(p, async (db) => (await db.query("select public.current_user_organization_id() as o")).rows[0].o as string | null);
/** md5 over every function in public and security_audit except 164's, with security, config, body and grants. */
async function otherFunctionsFingerprint() {
  return (await q<{ fp: string }>(`select md5(coalesce(string_agg(md5(concat_ws('|', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), p.prosecdef::text, coalesce(p.proconfig::text, ''), md5(p.prosrc), coalesce(p.proacl::text, ''))), '' order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), '')) as fp
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'security_audit') and not (n.nspname = 'public' and p.proname in ('platform_company_overview', 'platform_set_organization_status'))
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`))[0].fp;
}
const haveFunctions = async () => (await q<{ ok: boolean }>("select to_regprocedure($1) is not null and to_regprocedure($2) is not null as ok", [OV, ST]))[0].ok;
const verifyRows = async () => q<{ check_name: string; ok: boolean }>(read(VERIFY));
const rowCounts = async (org: string) => (await q<Row>(`select (select count(*) from public.organizations where id = $1)::int as orgs, (select count(*) from public.jobs where organization_id = $1)::int as jobs,
  (select count(*) from public.invoices where organization_id = $1)::int as invoices, (select count(*) from public.organization_members where organization_id = $1)::int as members,
  (select count(*) from public.user_profiles where organization_id = $1)::int as profiles`, [org]))[0];

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
  pool = new Pool({ connectionString: isolatedBackend().databaseUrl, max: 6 });
  const home = await makeOrg("home");
  HOME = home.id;
  const a = await makeOrg("alpha");
  const b = await makeOrg("beta");
  A = {
    org: a.id, name: a.name, admin: await makeMember(a.id, "a-admin", "admin"), office: await makeMember(a.id, "a-office", "office"),
    workshop: await makeMember(a.id, "a-workshop", "workshop"), viewer: await makeMember(a.id, "a-viewer", "viewer"),
    inactive: await makeUser(a.id, "a-inactive", "workshop"), support: await makeUser(a.id, "a-support", "admin"),
  };
  await q("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, 'workshop', false)", [A.inactive.id, A.org]);
  await q("insert into public.organization_members (user_id, organization_id, role, active, support, expires_at, support_grant) values ($1, $2, 'admin', true, true, now() + interval '2 hours', $3)", [A.support.id, A.org, randomUUID()]);
  B = { org: b.id, name: b.name, admin: await makeMember(b.id, "b-admin", "admin") };
  owner = await makeOwner("owner");
  ownerInside = await makeUser(HOME, "owner-inside", "admin");
  await q("insert into security_audit.platform_admins (user_id, note) values ($1, 'synthetic platform owner, inside a company (164)')", [ownerInside.id]);
  await q("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [ownerInside.session, ownerInside.id, A.org]);
  // Company A: two jobs and three invoices (one draft, one issued, one void). Company B has none. Made by the database owner, an exempt path.
  for (const no of ["1", "2"]) await q("insert into jobs (organization_id, job_no, customer, stage, quantity_required) values ($1, $2, 'Count Co', 'material', 5)", [A.org, `J-164-${runId}-${no}`]);
  for (const [i, status] of ["draft", "sent", "void"].entries()) {
    await q("insert into invoices (organization_id, invoice_ref, customer, status, total, subtotal, vat) values ($1, $2, 'Count Co', $3, 12, 10, 2)", [A.org, `INV-164-${runId}-${i}`, status]);
  }
});
afterAll(async () => {
  if (!pool) return;
  try {
    if (!(await haveFunctions())) await q(read(RELEASE)); // this file leaves 164 installed, as the fixture and the CI schema marker expect
    const ids = people.map((p) => p.id);
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      for (const t of ["public.invoices", "public.jobs", "public.organization_members", "public.user_profiles", "security_audit.audit_log", "security_audit.org_entry_log"]) {
        await db.query(`delete from ${t} where organization_id = any($1)`, [orgs]);
      }
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

describe("release 164: the platform owner's Companies screen, in the database", () => {
  it("1. the release is installed and verified (9 rows true), the preflight marker says applied, and applying it again changes nothing", async () => {
    expect(await haveFunctions()).toBe(true);
    const before = await otherFunctionsFingerprint();
    const organizations = await q("select * from public.organizations order by id");
    const marker = (await q<{ check: string; value: string }>(read("supabase/verify/release_preflight.sql"))).find((r) => r.check === "post-144 marker 164 platform_companies");
    expect(marker?.value).toBe("applied");
    const rows = await verifyRows();
    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
    const bodies = await q<{ name: string; md5: string; sec: boolean; cfg: string[] }>(`select proname as name, md5(regexp_replace(prosrc, '\\s', '', 'g')) as md5, prosecdef as sec, proconfig as cfg from pg_proc where oid in (to_regprocedure($1), to_regprocedure($2)) order by proname`, [OV, ST]);
    expect(bodies).toEqual([
      { name: "platform_company_overview", md5: OV_MD5, sec: true, cfg: ["search_path=pg_catalog, public"] },
      { name: "platform_set_organization_status", md5: ST_MD5, sec: true, cfg: ["search_path=pg_catalog, public, security_audit"] },
    ]);
    await q(read(RELEASE));
    expect(await otherFunctionsFingerprint()).toBe(before);
    expect(await q("select * from public.organizations order by id")).toEqual(organizations);
    expect((await verifyRows()).every((r) => r.ok === true)).toBe(true);
  });

  it("2. the owner's overview has every company with the right counts: active people only, jobs, invoices, and issued invoices apart from drafts and voids", async () => {
    const r = await overview(owner);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const by = (id: string) => r.value.find((row) => row.organization_id === id);
    expect(by(A.org)).toMatchObject({ name: A.name, status: "active", user_count: "4", job_count: "2", invoice_count: "3", issued_invoice_count: "1" });
    expect(by(B.org)).toMatchObject({ name: B.name, status: "active", user_count: "1", job_count: "0", invoice_count: "0", issued_invoice_count: "0" });
    expect(by(HOME)).toMatchObject({ user_count: "0", job_count: "0", invoice_count: "0", issued_invoice_count: "0" });
  });

  it("3. a company admin, office, workshop, viewer, anon, service_role, an owner without the second step and a deactivated owner are refused the overview", async () => {
    for (const p of [A.admin, A.office, A.workshop, A.viewer, B.admin]) expect(await overview(p), p.email).toMatchObject({ ok: false, code: "42501" });
    expect(await overview("anon")).toMatchObject({ ok: false, code: "42501" });
    expect(await overview("service")).toMatchObject({ ok: false, code: "42501" });
    expect(await overview(owner, { aal: "aal1" })).toMatchObject({ ok: false, code: "42501", hint: "mfa_required" });
    await q("update public.user_profiles set active = false where id = $1", [ownerInside.id]);
    try {
      expect(await overview(ownerInside)).toMatchObject({ ok: false, code: "42501", hint: "platform_required" });
    } finally {
      await q("update public.user_profiles set active = true where id = $1", [ownerInside.id]);
    }
  });

  it("4. Close needs the second step, a code under 15 minutes old, the exact name and a reason: each missing one is refused and changes nothing", async () => {
    const reason = "Test company no longer needed";
    const unchanged = async () => { expect(await statusOf(B.org)).toBe("active"); expect(await auditCount(B.org, "PLATFORM_CLOSE_ORGANIZATION")).toBe(0); };
    expect(await setStatus(owner, B.org, "closed", B.name, reason, { aal: "aal1", amr: fresh() })).toMatchObject({ ok: false, code: "42501", hint: "mfa_required" });
    expect(await setStatus(owner, B.org, "closed", B.name, reason, { amr: stale() })).toMatchObject({ ok: false, code: "42501", hint: "mfa_recent_required" });
    expect(await setStatus(owner, B.org, "closed", B.name, reason)).toMatchObject({ ok: false, code: "42501", hint: "mfa_recent_required" });
    expect(await setStatus(owner, B.org, "closed", `${B.name} `.toUpperCase(), reason, { amr: fresh() })).toMatchObject({ ok: false, code: "22023", hint: "name_mismatch" });
    expect(await setStatus(owner, B.org, "closed", "", reason, { amr: fresh() })).toMatchObject({ ok: false, code: "22023", hint: "name_mismatch" });
    expect(await setStatus(owner, B.org, "closed", null, reason, { amr: fresh() })).toMatchObject({ ok: false, code: "22023", hint: "name_mismatch" });
    for (const bad of [null, "", "abc", "x".repeat(501)]) expect(await setStatus(owner, B.org, "closed", B.name, bad, { amr: fresh() }), String(bad).slice(0, 5)).toMatchObject({ ok: false, code: "22023", hint: "reason_required" });
    for (const bad of ["deleted", "paused", "", null]) expect(await setStatus(owner, B.org, bad as string, B.name, reason, { amr: fresh() }), String(bad)).toMatchObject({ ok: false, code: "22023", hint: "status_invalid" });
    expect(await setStatus(owner, randomUUID(), "closed", B.name, reason, { amr: fresh() })).toMatchObject({ ok: false, code: "P0002", hint: "company_not_found" });
    await unchanged();
  });

  it("5. a company admin (of that company or another), office, workshop, viewer, anon and service_role cannot close or reopen a company", async () => {
    const reason = "Cross-company attempt";
    for (const p of [B.admin, A.admin, A.office, A.workshop, A.viewer]) {
      expect(await setStatus(p, B.org, "closed", B.name, reason, { amr: fresh() }), p.email).toMatchObject({ ok: false, code: "42501" });
      expect(await setStatus(p, B.org, "active", null, reason, { amr: fresh() }), p.email).toMatchObject({ ok: false, code: "42501" });
    }
    expect(await setStatus("anon", B.org, "closed", B.name, reason)).toMatchObject({ ok: false, code: "42501" });
    expect(await setStatus("service", B.org, "closed", B.name, reason)).toMatchObject({ ok: false, code: "42501" });
    expect(await statusOf(B.org)).toBe("active");
    expect(await auditCount(B.org, "PLATFORM_CLOSE_ORGANIZATION")).toBe(0);
  });

  it("6. the owner whose session is inside company A cannot close A, but closing another company from the same session works", async () => {
    const reason = "Closing from inside another company";
    expect(await setStatus(ownerInside, A.org, "closed", A.name, reason, { amr: fresh() })).toMatchObject({ ok: false, code: "22023", hint: "inside_company" });
    expect(await statusOf(A.org)).toBe("active");
    const other = await makeOrg("scratch");
    const r = await setStatus(ownerInside, other.id, "closed", other.name, reason, { amr: fresh() });
    expect(r).toMatchObject({ ok: true, value: { organization_id: other.id, status: "closed", changed: true } });
    expect(await setStatus(ownerInside, other.id, "active", null, reason)).toMatchObject({ ok: true, value: { status: "active", changed: true } });
  });

  it("7. Close with everything right closes the company: its people lose access at once, the owner cannot enter it, one audit row records it, nothing is deleted", async () => {
    const reason = "Test company no longer needed";
    const before = await rowCounts(B.org);
    expect(await companyIdFor(B.admin)).toBe(B.org);
    const r = await setStatus(owner, B.org, "closed", `  ${B.name}  `, reason, { amr: fresh() });
    expect(r).toMatchObject({ ok: true, value: { organization_id: B.org, status: "closed", changed: true } });
    expect(await statusOf(B.org)).toBe("closed");
    expect(await companyIdFor(B.admin)).toBeNull();
    const enter = await as(owner, async (db) => { try { await db.query("select public.platform_enter_organization($1, 'Check a closed company', 1)", [B.org]); return "entered"; } catch (e) { return (e as { code?: string }).code ?? "error"; } });
    expect(enter).toBe("P0002");
    const audit = await q<{ metadata: Record<string, unknown>; actor_user_id: string; entity_table: string; entity_id: string }>(
      "select metadata, actor_user_id, entity_table, entity_id from security_audit.audit_log where organization_id = $1 and action = 'PLATFORM_CLOSE_ORGANIZATION'", [B.org]);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor_user_id: owner.id, entity_table: "organizations", entity_id: B.org });
    expect(audit[0].metadata).toMatchObject({ from: "active", to: "closed", reason, actor: owner.id });
    expect(await rowCounts(B.org)).toEqual(before);
    const listed = await overview(owner);
    expect(listed.ok && listed.value.find((row) => row.organization_id === B.org)?.status).toBe("closed");
  });

  it("8. closing a closed company changes nothing and writes no second row; a paused company is neither closed nor reopened", async () => {
    const again = await setStatus(owner, B.org, "closed", B.name, "Closing it again", { amr: fresh() });
    expect(again).toMatchObject({ ok: true, value: { status: "closed", changed: false } });
    expect(await auditCount(B.org, "PLATFORM_CLOSE_ORGANIZATION")).toBe(1);
    const p = await makeOrg("paused");
    await q("update public.organizations set status = 'paused' where id = $1", [p.id]);
    expect(await setStatus(owner, p.id, "closed", p.name, "Close a paused company", { amr: fresh() })).toMatchObject({ ok: false, code: "22023", hint: "status_transition" });
    expect(await setStatus(owner, p.id, "active", null, "Reopen a paused company")).toMatchObject({ ok: false, code: "22023", hint: "status_transition" });
    expect(await statusOf(p.id)).toBe("paused");
  });

  it("9. Reopen needs the owner, the second step and a reason (no name, no fresh code), gives the access back and writes one audit row; reopening an active company changes nothing", async () => {
    expect(await setStatus(owner, B.org, "active", null, "Reopen it", { aal: "aal1" })).toMatchObject({ ok: false, code: "42501", hint: "mfa_required" });
    expect(await setStatus(owner, B.org, "active", null, "")).toMatchObject({ ok: false, code: "22023", hint: "reason_required" });
    expect(await statusOf(B.org)).toBe("closed");
    const r = await setStatus(owner, B.org, "active", null, "Closed by mistake, reopening");
    expect(r).toMatchObject({ ok: true, value: { organization_id: B.org, status: "active", changed: true } });
    expect(await statusOf(B.org)).toBe("active");
    expect(await companyIdFor(B.admin)).toBe(B.org);
    expect(await auditCount(B.org, "PLATFORM_REOPEN_ORGANIZATION")).toBe(1);
    expect(await setStatus(owner, B.org, "active", null, "Reopen it once more")).toMatchObject({ ok: true, value: { changed: false } });
    expect(await auditCount(B.org, "PLATFORM_REOPEN_ORGANIZATION")).toBe(1);
  });

  it("10. nothing was deleted: the companies, jobs, invoices, people and every other company field are as they were", async () => {
    expect(await rowCounts(A.org)).toEqual({ orgs: 1, jobs: 2, invoices: 3, members: 6, profiles: 6 });
    expect(await rowCounts(B.org)).toMatchObject({ orgs: 1, jobs: 0, invoices: 0, members: 1 });
    expect((await q<{ name: string }>("select name from public.organizations where id = $1", [B.org]))[0].name).toBe(B.name);
  });

  it("11. two simultaneous closes of the same company change it once and write one audit row", async () => {
    const c = await makeOrg("race");
    const reason = "Two owners press Close together";
    const [x, y] = await Promise.all([setStatus(owner, c.id, "closed", c.name, reason, { amr: fresh() }), setStatus(ownerInside, c.id, "closed", c.name, reason, { amr: fresh() })]);
    expect([x, y].every((r) => r.ok)).toBe(true);
    expect([x, y].filter((r) => r.ok && r.value.changed)).toHaveLength(1);
    expect(await statusOf(c.id)).toBe("closed");
    expect(await auditCount(c.id, "PLATFORM_CLOSE_ORGANIZATION")).toBe(1);
  });

  it("12. rollback removes the two functions and nothing else (closed companies stay closed), and the release can be applied again", async () => {
    const c = await makeOrg("rollback");
    await setStatus(owner, c.id, "closed", c.name, "Closed before the rollback", { amr: fresh() });
    const before = await otherFunctionsFingerprint();
    const organizations = await q("select * from public.organizations order by id");
    await q(read(ROLLBACK));
    expect(await haveFunctions()).toBe(false);
    expect((await q<{ n: string }>("select count(*) as n from pg_proc where pronamespace = 'public'::regnamespace and proname in ('platform_company_overview', 'platform_set_organization_status')"))[0].n).toBe("0");
    expect(await otherFunctionsFingerprint()).toBe(before);
    expect(await q("select * from public.organizations order by id")).toEqual(organizations);
    expect(await statusOf(c.id)).toBe("closed");
    await q(read(ROLLBACK)); // absent: nothing to do
    await q(read(RELEASE));
    expect(await haveFunctions()).toBe(true);
    expect((await verifyRows()).every((r) => r.ok === true)).toBe(true);
    expect(await otherFunctionsFingerprint()).toBe(before);
    expect(await q("select * from public.organizations order by id")).toEqual(organizations);
  });

  it("13. a function of either name that is not 164's makes both the release and the rollback refuse, and is left as it was", async () => {
    await q(read(ROLLBACK));
    await q("create function public.platform_company_overview() returns table (organization_id uuid) language sql as $$ select null::uuid $$");
    try {
      await expect(q(read(RELEASE))).rejects.toThrow(/exists but is not 164's/);
      await expect(q(read(ROLLBACK))).rejects.toThrow(/is not 164's/);
      expect((await q<{ src: string }>("select prosrc as src from pg_proc where oid = to_regprocedure($1)", [OV]))[0].src).toContain("select null::uuid");
    } finally {
      await q(`drop function if exists ${OV}`);
    }
    await q("create function public.platform_set_organization_status(p_org uuid, p_status text, p_confirm_name text, p_reason text) returns text language sql as $$ select 'x'::text $$");
    try {
      await expect(q(read(RELEASE))).rejects.toThrow(/exists but is not 164's/);
      await expect(q(read(ROLLBACK))).rejects.toThrow(/is not 164's/);
    } finally {
      await q(`drop function if exists ${ST}`);
    }
    await q(read(RELEASE));
    expect(await haveFunctions()).toBe(true);
    expect((await verifyRows()).every((r) => r.ok === true)).toBe(true);
  });
});
