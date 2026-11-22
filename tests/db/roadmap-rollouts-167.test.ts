/**
 * Release 167 (supabase/release/167_roadmap_rollouts.release.sql): the owner-only Roadmap list and the owner-only Rollouts of the existing per-company
 * switches (hidden_nav "<name>:on" markers), below PostgREST, one `it` per case.
 *
 * Inputs: the disposable stack (TEST_DATABASE_URL, isolation-checked); the post-144 fixture installs 145..167. Synthetic companies (slug t-<run>-...) and
 * people, forged claims as PostgREST sets them (no Auth API); each call is one transaction. The release stays installed when this file ends (the CI schema
 * marker after the DB suite expects it).
 * Proves: installed and verified (10 rows true), applying again changes nothing; the platform owner creates roadmap items (all, one, a chosen few), reads
 * them in order, moves them up and down (the ends do nothing), and the shipped date is set on shipped and cleared when it leaves; a company admin, anon
 * and an owner on a first-step-only (aal1) session are refused 42501 and change nothing; bad statuses, targets and companies are refused 22023, an
 * unknown item P0002; neither tables can be read or written by authenticated or service_role directly; rollout apply is service-role only (a signed-in
 * session, even the owner's, is refused), accepts only the six listed markers, turns one marker on or off for the named companies and touches nothing
 * else in hidden_nav, in the row, or in any company not named, writes exactly one log row per call (who, when, which switch, which companies, on or off,
 * how many changed), changes nothing and writes nothing when refused, refuses "on" for an inactive company but allows "off", and an unknown actor; the log
 * is append-only (update, delete, truncate refused); the overview is owner-only; the rollback refuses while rows exist and changes nothing, then removes
 * only 167's objects (fingerprint of every other function and of organization_settings unchanged) and the release can be applied again.
 * Not proved here: PostgREST's own error mapping, the Next.js routes (tests/unit/platform-owner-routes.test.ts), hosted grants.
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
const RELEASE = "supabase/release/167_roadmap_rollouts.release.sql";
const ROLLBACK = "supabase/release/167_roadmap_rollouts.rollback.sql";
const VERIFY = "supabase/verify/roadmap_rollouts_167.sql";
const FNS = ["platform_rollout_log_guard", "_platform_owner_check", "platform_roadmap_list", "platform_roadmap_save", "platform_roadmap_move", "platform_rollout_overview", "platform_rollout_apply"];
const MARKERS = ["reports:on", "reports-revenue:on", "iso-templates:on", "job-time-variance:on", "job-ncr-register:on", "tooly-admin-tour:on"];

let pool: Pool;
type Row = Record<string, unknown>;
type Person = { id: string; email: string; session: string };
type Outcome<T = unknown> = { ok: true; value: T } | { ok: false; code?: string; hint?: string; message: string };
const orgs: string[] = [];
const people: Person[] = [];
let owner: Person;
let companyAdmin: Person;
let orgA: string;
let orgB: string;
let orgC: string;
let orgGone: string;

async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await pool.connect();
  try { return (await db.query(sql, params)).rows as T[]; }
  catch (error) {
    // A release or rollback file opens its own transaction; when its guard refuses, the connection must not go back to the pool aborted.
    await db.query("rollback").catch(() => undefined);
    throw error;
  } finally { db.release(); }
}
async function makeOrg(label: string, status = "active") {
  const id = randomUUID();
  seq += 1;
  await q("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, $4)", [id, `167 ${label} ${runId}`, `${SYNTHETIC_SLUG_PREFIX}${runId}-167-${label}-${seq}`, status]);
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
/** A platform owner: on security_audit.platform_admins, an active profile with its own password, in no company and with no support session. */
async function makeOwner(org: string, name: string): Promise<Person> {
  seq += 1;
  const p = { id: randomUUID(), email: `${name}-${seq}.${runId}@example.test`, session: randomUUID() };
  await q("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await q(`insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, 'Platform Owner', 'admin', $3, true, false)`, [p.id, p.email, org]);
  await q("insert into security_audit.platform_admins (user_id) values ($1)", [p.id]);
  await q("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  people.push(p);
  return p;
}
/** One API request: its own transaction, as role authenticated (the person's claims), anon, or service_role (no person), as PostgREST runs it. */
async function as<T>(who: Person | "anon" | "service", fn: (db: PoolClient) => Promise<T>, aal: "aal1" | "aal2" = "aal2"): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    if (who === "anon") {
      await db.query("set local role anon");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    } else if (who === "service") {
      await db.query("set local role service_role");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
    } else {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: who.id, role: "authenticated", aud: "authenticated", aal, email: who.email, session_id: who.session }), who.id]);
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
async function call<T = Row>(who: Person | "anon" | "service", sql: string, params: unknown[] = [], aal: "aal1" | "aal2" = "aal2"): Promise<Outcome<T>> {
  try {
    const rows = await as(who, async (db) => (await db.query(sql, params)).rows, aal);
    return { ok: true, value: rows[0]?.r as T };
  } catch (e) {
    const err = e as { code?: string; hint?: string; message: string };
    return { ok: false, code: err.code, hint: err.hint, message: err.message };
  }
}
type Item = { id: string; title: string; description: string; status: string; sort_order: number; target_kind: string; target_orgs: string[]; created_at: string; shipped_at: string | null };
const list = async (who: Person, aal: "aal1" | "aal2" = "aal2") => call<Item[]>(who, "select public.platform_roadmap_list() as r", [], aal);
const save = (who: Person | "anon", id: string | null, title: string, status: string, kind: string, targets: string[], aal: "aal1" | "aal2" = "aal2") =>
  call<{ id: string }>(who, "select public.platform_roadmap_save($1, $2, 'd', $3, $4, $5::uuid[]) as r", [id, title, status, kind, targets], aal);
const move = (who: Person | "anon", id: string, dir: string, aal: "aal1" | "aal2" = "aal2") => call<{ id: string; moved: boolean }>(who, "select public.platform_roadmap_move($1, $2) as r", [id, dir], aal);
type Applied = { log_id: string; switch: string; turned_on: boolean; requested: number; changed: number; changed_org_ids: string[] };
const apply = (who: Person | "anon" | "service", actor: string, email: string, marker: string, ids: string[], on: boolean, phase = "") =>
  call<Applied>(who, "select public.platform_rollout_apply($1, $2, $3, $4::uuid[], $5, $6) as r", [actor, email, marker, ids, on, phase]);
const titles = async () => (await list(owner) as { ok: true; value: Item[] }).value.filter((i) => i.title.endsWith(runId)).map((i) => i.title.replace(` ${runId}`, ""));
const nav = async (org: string) => (await q<{ hidden_nav: string[] }>("select hidden_nav from public.organization_settings where organization_id = $1", [org]))[0]?.hidden_nav ?? null;
const logCount = async () => Number((await q<{ n: string }>("select count(*) as n from public.platform_rollout_log where actor_id = $1", [owner.id]))[0].n);
async function settingsRow(org: string) {
  return (await q<{ r: string | null }>("select (to_jsonb(s) - 'hidden_nav' - 'updated_at')::text as r from public.organization_settings s where organization_id = $1", [org]))[0]?.r ?? null;
}
/** md5 over every function in public and security_audit except 167's, with security, config, body and grants; plus organization_settings structure and rows. */
async function fingerprint() {
  const fns = (await q<{ fp: string }>(`select md5(coalesce(string_agg(md5(concat_ws('|', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), p.prosecdef::text, coalesce(p.proconfig::text, ''), md5(p.prosrc), coalesce(p.proacl::text, ''))), '' order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), '')) as fp
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'security_audit') and not (n.nspname = 'public' and p.proname = any($1))
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`, [FNS]))[0].fp;
  const settings = (await q<{ fp: string }>(`select md5(coalesce(string_agg(concat_ws('|', column_name, data_type, is_nullable, coalesce(column_default, '')), ';' order by ordinal_position), '')) as fp
    from information_schema.columns where table_schema = 'public' and table_name = 'organization_settings'`))[0].fp;
  return `${fns}/${settings}`;
}
const installed = async () => Number((await q<{ n: string }>("select count(*) as n from pg_proc where pronamespace = 'public'::regnamespace and proname = any($1)", [FNS]))[0].n) === 7;
const verifyRows = async () => (await q<{ check_name: string; ok: boolean }>(read(VERIFY)));

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
  pool = new Pool({ connectionString: isolatedBackend().databaseUrl, max: 6 });
  orgA = await makeOrg("alpha");
  orgB = await makeOrg("beta");
  orgC = await makeOrg("gamma");
  orgGone = await makeOrg("gone", "suspended");
  owner = await makeOwner(orgA, "owner");
  companyAdmin = await makePerson(orgA, "a-admin", "admin");
  // Known starting points: A has an existing hidden item, B has no settings row at all, C has a setting of its own that must never move.
  await q("insert into public.organization_settings (organization_id, hidden_nav) values ($1, array['sales-orders']) on conflict (organization_id) do update set hidden_nav = excluded.hidden_nav", [orgA]);
  await q("delete from public.organization_settings where organization_id = $1", [orgB]);
  await q("insert into public.organization_settings (organization_id, hidden_nav) values ($1, array['jobs','reports:on']) on conflict (organization_id) do update set hidden_nav = excluded.hidden_nav", [orgC]);
});

afterAll(async () => {
  if (!pool) return;
  try {
    if (!(await installed())) await q(read(RELEASE)); // this file leaves 167 installed, as the fixture and the CI schema marker expect
    const ids = people.map((p) => p.id);
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      await db.query("delete from public.platform_rollout_log where actor_id = any($1)", [ids]);
      await db.query("delete from public.platform_roadmap_items where title like $1", [`% ${runId}`]);
      await db.query("delete from public.organization_settings where organization_id = any($1)", [orgs]);
      await db.query("delete from public.organization_members where organization_id = any($1)", [orgs]);
      await db.query("delete from public.user_profiles where organization_id = any($1)", [orgs]);
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

describe("release 167: owner-only Roadmap and Rollouts", () => {
  it("1. the release is installed and verified (10 rows true), the preflight marker says applied, and applying it again changes nothing", async () => {
    expect(await installed()).toBe(true);
    const before = await fingerprint();
    const marker = (await q<{ check: string; value: string }>(read("supabase/verify/release_preflight.sql"))).find((r) => r.check === "post-144 marker 167 roadmap_rollouts");
    expect(marker?.value).toBe("applied");
    const rows = await verifyRows();
    expect(rows).toHaveLength(10);
    expect(rows.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
    await q(read(RELEASE));
    expect(await fingerprint()).toBe(before);
    expect((await verifyRows()).every((r) => r.ok === true)).toBe(true);
  });

  it("2. nobody can read or write either table directly: not anon, not signed in, not the service role, not even the owner", async () => {
    for (const who of ["anon", "service", owner] as const) {
      for (const sql of ["select 1 from public.platform_roadmap_items", "select 1 from public.platform_rollout_log", "insert into public.platform_roadmap_items (title, sort_order) values ('x', 1)", "delete from public.platform_rollout_log"]) {
        const r = await call(who, sql);
        expect(r.ok, `${typeof who === "string" ? who : "owner"}: ${sql}`).toBe(false);
        if (!r.ok) expect(r.code).toBe("42501");
      }
    }
  });

  it("3. the owner creates items for all, one company and a chosen few; the list is in creation order and starts with the status given", async () => {
    const a = await save(owner, null, `First ${runId}`, "idea", "all", []);
    const b = await save(owner, null, `Second ${runId}`, "planned", "one", [orgA]);
    const c = await save(owner, null, `Third ${runId}`, "shipped", "few", [orgA, orgB]);
    expect([a.ok, b.ok, c.ok]).toEqual([true, true, true]);
    expect(await titles()).toEqual(["First", "Second", "Third"]);
    const rows = (await list(owner) as { ok: true; value: Item[] }).value.filter((i) => i.title.endsWith(runId));
    expect(rows.map((r) => [r.status, r.target_kind, r.target_orgs.length])).toEqual([["idea", "all", 0], ["planned", "one", 1], ["shipped", "few", 2]]);
    expect(rows.map((r) => r.shipped_at !== null)).toEqual([false, false, true]);
    expect(rows.every((r) => typeof r.created_at === "string")).toBe(true);
  });

  it("4. move up and down changes the order by one place; the first cannot go up and the last cannot go down", async () => {
    const rows = () => list(owner).then((r) => (r as { ok: true; value: Item[] }).value.filter((i) => i.title.endsWith(runId)));
    const [first, , third] = await rows();
    expect((await move(owner, third.id, "up") as { ok: true; value: { moved: boolean } }).value.moved).toBe(true);
    expect(await titles()).toEqual(["First", "Third", "Second"]);
    expect((await move(owner, first.id, "up") as { ok: true; value: { moved: boolean } }).value.moved).toBe(false);
    expect((await move(owner, first.id, "down") as { ok: true; value: { moved: boolean } }).value.moved).toBe(true);
    expect(await titles()).toEqual(["Third", "First", "Second"]);
    const last = (await rows())[2];
    expect((await move(owner, last.id, "down") as { ok: true; value: { moved: boolean } }).value.moved).toBe(false);
    expect(await titles()).toEqual(["Third", "First", "Second"]);
  });

  it("5. editing keeps the item's place, sets the shipped date when it becomes shipped and clears it when it leaves", async () => {
    const rows = (await list(owner) as { ok: true; value: Item[] }).value.filter((i) => i.title.endsWith(runId));
    const first = rows.find((r) => r.title.startsWith("First"))!;
    expect((await save(owner, first.id, `First ${runId}`, "shipped", "all", [])).ok).toBe(true);
    const shipped = (await list(owner) as { ok: true; value: Item[] }).value.find((r) => r.id === first.id)!;
    expect(shipped.shipped_at).not.toBeNull();
    expect(shipped.sort_order).toBe(first.sort_order);
    expect(shipped.created_at).toBe(first.created_at);
    expect((await save(owner, first.id, `First ${runId}`, "shipped", "all", [])).ok).toBe(true);
    expect(((await list(owner) as { ok: true; value: Item[] }).value.find((r) => r.id === first.id)!).shipped_at).toBe(shipped.shipped_at);
    expect((await save(owner, first.id, `First ${runId}`, "building", "all", [])).ok).toBe(true);
    expect(((await list(owner) as { ok: true; value: Item[] }).value.find((r) => r.id === first.id)!).shipped_at).toBeNull();
    expect(await titles()).toEqual(["Third", "First", "Second"]);
  });

  it("6. a company admin, anon and the owner on a first-step-only (aal1) session are refused 42501 and nothing changes", async () => {
    const before = await titles();
    const target = (await list(owner) as { ok: true; value: Item[] }).value[0].id;
    for (const r of [await list(companyAdmin), await save(companyAdmin, null, `Nope ${runId}`, "idea", "all", []), await move(companyAdmin, target, "up"),
                     await call("anon", "select public.platform_roadmap_list() as r"), await save("anon", null, `Nope ${runId}`, "idea", "all", []),
                     await list(owner, "aal1"), await save(owner, null, `Nope ${runId}`, "idea", "all", [], "aal1"), await move(owner, target, "down", "aal1")]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("42501");
    }
    expect(await titles()).toEqual(before);
  });

  it("7. bad statuses, titles, targets and companies are refused 22023, an unknown item P0002, and nothing changes", async () => {
    const before = await titles();
    const cases: Array<Outcome> = [
      await save(owner, null, `X ${runId}`, "done", "all", []), await save(owner, null, "   ", "idea", "all", []), await save(owner, null, "x".repeat(121), "idea", "all", []),
      await save(owner, null, `X ${runId}`, "idea", "some", []), await save(owner, null, `X ${runId}`, "idea", "all", [orgA]), await save(owner, null, `X ${runId}`, "idea", "one", []),
      await save(owner, null, `X ${runId}`, "idea", "one", [orgA, orgB]), await save(owner, null, `X ${runId}`, "idea", "few", [orgA]), await save(owner, null, `X ${runId}`, "idea", "few", [orgA, orgA]),
      await save(owner, null, `X ${runId}`, "idea", "one", [randomUUID()]), await move(owner, (await list(owner) as { ok: true; value: Item[] }).value[0].id, "sideways"),
    ];
    for (const r of cases) { expect(r.ok).toBe(false); if (!r.ok) expect(r.code).toBe("22023"); }
    for (const r of [await save(owner, randomUUID(), `X ${runId}`, "idea", "all", []), await move(owner, randomUUID(), "up")]) { expect(r.ok).toBe(false); if (!r.ok) expect(r.code).toBe("P0002"); }
    expect(await titles()).toEqual(before);
  });

  it("8. rollout apply is service-role only: a signed-in session (the owner's too), anon and a non-owner actor are refused and change nothing", async () => {
    const before = [await nav(orgA), await nav(orgB), await logCount()];
    for (const who of [owner, companyAdmin, "anon"] as const) {
      const r = await apply(who, owner.id, owner.email, "reports:on", [orgA], true);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("42501");
    }
    const notOwner = await apply("service", companyAdmin.id, companyAdmin.email, "reports:on", [orgA], true);
    expect(notOwner.ok).toBe(false);
    if (!notOwner.ok) { expect(notOwner.code).toBe("42501"); expect(notOwner.hint).toBe("platform_required"); }
    expect([await nav(orgA), await nav(orgB), await logCount()]).toEqual(before);
  });

  it("9. only the six listed markers are accepted: Sales Orders, other text and a plain menu key are refused 22023 and change nothing", async () => {
    const before = [await nav(orgA), await logCount()];
    for (const marker of ["sales-orders:on", "sales-orders", "jobs", "reports:off", "", "reports:on ", "REPORTS:ON"]) {
      const r = await apply("service", owner.id, owner.email, marker, [orgA], true);
      expect(r.ok, marker).toBe(false);
      if (!r.ok) { expect(r.code, marker).toBe("22023"); expect(r.hint, marker).toBe("unknown_switch"); }
    }
    const r = await apply("service", owner.id, owner.email, "reports:on", [orgA], true);
    expect(r.ok).toBe(true);
    await apply("service", owner.id, owner.email, "reports:on", [orgA], false);
    expect(MARKERS).toHaveLength(6);
    expect((await nav(orgA))).toEqual(before[0]);
  });

  it("10. turning one switch ON for a chosen few adds only that marker, keeps every other entry, creates a missing row, leaves others alone, and writes one log row", async () => {
    const aRow = await settingsRow(orgA);
    const cBefore = [await nav(orgC), await settingsRow(orgC)];
    const logBefore = await logCount();
    const r = await apply("service", owner.id, owner.email, "job-ncr-register:on", [orgA, orgB], true, "Phase 1: JNR first");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ switch: "job-ncr-register:on", turned_on: true, requested: 2, changed: 2 });
    expect(r.value.changed_org_ids.sort()).toEqual([orgA, orgB].sort());
    expect(await nav(orgA)).toEqual(["sales-orders", "job-ncr-register:on"]);
    expect(await nav(orgB)).toEqual(["job-ncr-register:on"]);
    expect(await settingsRow(orgA)).toBe(aRow);
    expect([await nav(orgC), await settingsRow(orgC)]).toEqual(cBefore);
    expect(await logCount()).toBe(logBefore + 1);
    const log = (await q<Row>("select * from public.platform_rollout_log where id = $1", [r.value.log_id]))[0];
    expect(log).toMatchObject({ actor_id: owner.id, actor_email: owner.email, switch_marker: "job-ncr-register:on", turned_on: true, phase: "Phase 1: JNR first" });
    expect((log.org_ids as string[]).sort()).toEqual([orgA, orgB].sort());
    expect(log.org_names as string[]).toHaveLength(2);
    expect((log.changed_org_ids as string[]).sort()).toEqual([orgA, orgB].sort());
    expect(log.created_at).toBeInstanceOf(Date);
  });

  it("11. a second ON for the same companies changes nothing (0 changed, no duplicate marker) but is still logged", async () => {
    const logBefore = await logCount();
    const r = await apply("service", owner.id, owner.email, "job-ncr-register:on", [orgA, orgB], true, "Phase 2: the rest");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ requested: 2, changed: 0, changed_org_ids: [] });
    expect(await nav(orgA)).toEqual(["sales-orders", "job-ncr-register:on"]);
    expect(await logCount()).toBe(logBefore + 1);
  });

  it("12. a second marker is added beside the first, and turning one OFF removes only that marker and logs it", async () => {
    expect((await apply("service", owner.id, owner.email, "reports:on", [orgA], true)).ok).toBe(true);
    expect(await nav(orgA)).toEqual(["sales-orders", "job-ncr-register:on", "reports:on"]);
    const logBefore = await logCount();
    const off = await apply("service", owner.id, owner.email, "job-ncr-register:on", [orgA, orgB, orgC], false);
    expect(off.ok).toBe(true);
    if (off.ok) expect(off.value).toMatchObject({ turned_on: false, requested: 3, changed: 2 });
    expect(await nav(orgA)).toEqual(["sales-orders", "reports:on"]);
    expect(await nav(orgB)).toEqual([]);
    expect(await nav(orgC)).toEqual(["jobs", "reports:on"]);
    expect(await logCount()).toBe(logBefore + 1);
    expect((await q<{ turned_on: boolean }>("select turned_on from public.platform_rollout_log where actor_id = $1 order by created_at desc, id limit 1", [owner.id]))[0].turned_on).toBe(false);
  });

  it("13. turning OFF for a company with no settings row does not create one", async () => {
    await q("delete from public.organization_settings where organization_id = $1", [orgB]);
    const r = await apply("service", owner.id, owner.email, "reports:on", [orgB], false);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.changed).toBe(0);
    expect(await nav(orgB)).toBeNull();
  });

  it("14. ON for an inactive company is refused 22023 and nothing is changed or logged, even for the active ones in the same request; OFF for it is allowed", async () => {
    const before = [await nav(orgA), await nav(orgGone), await logCount()];
    const r = await apply("service", owner.id, owner.email, "iso-templates:on", [orgA, orgGone], true);
    expect(r.ok).toBe(false);
    if (!r.ok) { expect(r.code).toBe("22023"); expect(r.hint).toBe("company_not_active"); }
    expect([await nav(orgA), await nav(orgGone), await logCount()]).toEqual(before);
    const off = await apply("service", owner.id, owner.email, "iso-templates:on", [orgGone], false);
    expect(off.ok).toBe(true);
  });

  it("15. bad requests are refused and change nothing: no companies, duplicates, an unknown company, a long phase, a missing email", async () => {
    const before = [await nav(orgA), await logCount()];
    const cases = [
      await apply("service", owner.id, owner.email, "reports:on", [], true), await apply("service", owner.id, owner.email, "reports:on", [orgA, orgA], true),
      await apply("service", owner.id, owner.email, "reports:on", [orgA], true, "x".repeat(61)), await apply("service", owner.id, "  ", "reports:on", [orgA], true),
      await call("service", "select public.platform_rollout_apply($1, $2, 'reports:on', null, true, '') as r", [owner.id, owner.email]),
      await call("service", "select public.platform_rollout_apply($1, $2, 'reports:on', array[$3]::uuid[], null, '') as r", [owner.id, owner.email, orgA]),
    ];
    for (const r of cases) { expect(r.ok).toBe(false); if (!r.ok) expect(r.code).toBe("22023"); }
    const missing = await apply("service", owner.id, owner.email, "reports:on", [orgA, randomUUID()], true);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("P0002");
    expect([await nav(orgA), await logCount()]).toEqual(before);
  });

  it("16. the owner's overview lists every company with only the listed markers it has on, and the log newest first; a company admin, anon and aal1 are refused", async () => {
    const r = await call<{ companies: Array<{ organization_id: string; on: string[] }>; log: Array<{ actor_email: string; switch: string; turned_on: boolean; phase: string; org_names: string[]; changed: number }> }>(owner, "select public.platform_rollout_overview() as r");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const byOrg = new Map(r.value.companies.map((c) => [c.organization_id, c.on]));
    expect(byOrg.get(orgA)).toEqual(["reports:on"]);
    expect(byOrg.get(orgB)).toEqual([]);
    expect(byOrg.get(orgC)).toEqual(["reports:on"]);
    expect(r.value.log.length).toBeGreaterThan(0);
    expect(r.value.log.length).toBeLessThanOrEqual(200);
    const mine = r.value.log.filter((l) => l.actor_email === owner.email);
    expect(mine[0]).toMatchObject({ actor_email: owner.email });
    expect(mine.some((l) => l.phase === "Phase 1: JNR first" && l.switch === "job-ncr-register:on" && l.turned_on === true && l.changed === 2)).toBe(true);
    for (const x of [await call(companyAdmin, "select public.platform_rollout_overview() as r"), await call("anon", "select public.platform_rollout_overview() as r"), await call(owner, "select public.platform_rollout_overview() as r", [], "aal1")]) {
      expect(x.ok).toBe(false);
      if (!x.ok) expect(x.code).toBe("42501");
    }
  });

  it("17. the rollout log is append-only: update, delete and truncate are refused for everyone, even the database owner", async () => {
    const id = (await q<{ id: string }>("select id from public.platform_rollout_log where actor_id = $1 limit 1", [owner.id]))[0].id;
    for (const sql of ["update public.platform_rollout_log set phase = 'changed' where id = $1", "delete from public.platform_rollout_log where id = $1", "truncate public.platform_rollout_log"]) {
      await expect(q(sql, sql.includes("$1") ? [id] : [])).rejects.toMatchObject({ message: expect.stringContaining("append-only") });
    }
    expect((await q<{ phase: string }>("select phase from public.platform_rollout_log where id = $1", [id]))[0].phase).not.toBe("changed");
  });

  it("18. the rollback refuses while the roadmap or the log holds rows and changes nothing", async () => {
    const before = await fingerprint();
    await expect(q(read(ROLLBACK))).rejects.toMatchObject({ message: expect.stringContaining("holds rows") });
    expect(await installed()).toBe(true);
    expect(await fingerprint()).toBe(before);
    expect((await verifyRows()).every((r) => r.ok === true)).toBe(true);
  });

  it("19. with the tables empty the rollback removes only 167's objects (every other function and organization_settings unchanged), and the release applies again", async () => {
    const db = await pool.connect();
    const saved = { items: [] as Row[], log: [] as Row[] };
    try {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      saved.items = (await db.query("select * from public.platform_roadmap_items")).rows;
      saved.log = (await db.query("select * from public.platform_rollout_log")).rows;
      await db.query("delete from public.platform_roadmap_items");
      await db.query("delete from public.platform_rollout_log");
      await db.query("commit");
    } catch (e) { await db.query("rollback").catch(() => undefined); throw e; } finally { db.release(); }
    const before = await fingerprint();
    await q(read(ROLLBACK));
    expect(await installed()).toBe(false);
    expect((await q<{ a: string | null; b: string | null }>("select to_regclass('public.platform_roadmap_items')::text as a, to_regclass('public.platform_rollout_log')::text as b"))[0]).toEqual({ a: null, b: null });
    expect(await fingerprint()).toBe(before);
    await q(read(ROLLBACK)); // absent: nothing to do, changes nothing
    await q(read(RELEASE));
    expect(await installed()).toBe(true);
    expect(await fingerprint()).toBe(before);
    expect((await verifyRows()).every((r) => r.ok === true)).toBe(true);
    expect(saved.items.length).toBeGreaterThan(0);
    expect(saved.log.length).toBeGreaterThan(0);
  });
});
