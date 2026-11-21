/**
 * Release 163 (supabase/release/163_chase_steps_atomic.release.sql): the chase steps screen saves all its steps in one database call,
 * public.save_chase_steps_atomic(p_org, p_expected, p_steps). The DB proof, below PostgREST, one `it` per case.
 *
 * Inputs: the disposable stack (TEST_DATABASE_URL, isolation-checked), baseline migrations only (163 needs 138 and the access helpers, none
 * of the post-144 releases). The file applies 163 itself, proves it, and in afterAll puts the database back as it found it by running
 * 163's own rollback file (so the frozen baseline checks that run in the same database never see the function). Synthetic companies
 * (slug t-<run>-...) and people, forged claims as PostgREST sets them (no Auth API); each call is one transaction.
 * Proves: apply, verify (8 rows true), apply again changes nothing; admin and office save steps and get ids back; a second save keeps
 * the id of an unchanged offset, changes a tone, drops an offset, adds one; a stale snapshot is refused 40001 and changes nothing; five
 * bad lists are refused 22023 and change nothing; another company, workshop, viewer and anon are refused 42501; two simultaneous saves
 * of the same snapshot have exactly one winner; rollback removes the function and nothing else (fingerprint of every other function
 * unchanged, saved steps stay) and the release can be applied again.
 * Not proved here: PostgREST's own error mapping, hosted grants (service_role there comes from Supabase's default privileges).
 * Must not change: this file proves; it never edits a release, verify or rollback file to make itself pass.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedBackend, SYNTHETIC_SLUG_PREFIX } from "../support/isolation";
import { verifyBackendIdentity } from "../support/fixtures";

const runId = randomBytes(4).toString("hex");
let seq = 0;
const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const RELEASE = "supabase/release/163_chase_steps_atomic.release.sql";
const ROLLBACK = "supabase/release/163_chase_steps_atomic.rollback.sql";
const VERIFY = "supabase/verify/chase_steps_atomic_163.sql";
const FN = "public.save_chase_steps_atomic(uuid,jsonb,jsonb)";
const BODY_MD5 = "63145f3026fdc7db5dc1ba0a5928177a";

let pool: Pool;
type Row = Record<string, unknown>;
type Person = { id: string; email: string; session: string };
type Step = { id?: string; days: number; tone: string };
type Outcome = { ok: true; steps: Step[] } | { ok: false; code?: string; message: string };
const orgs: string[] = [];
const people: Person[] = [];
let A: { org: string; admin: Person; office: Person; workshop: Person; viewer: Person };
let B: { org: string; admin: Person };

async function q<T = Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await pool.connect();
  try { return (await db.query(sql, params)).rows as T[]; } finally { db.release(); }
}
async function makeOrg(label: string) {
  const id = randomUUID();
  seq += 1;
  await q("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [id, `163 ${label} ${runId}`, `${SYNTHETIC_SLUG_PREFIX}${runId}-163-${label}-${seq}`]);
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
/** One API request: its own transaction, as role authenticated (the person's claims) or anon, as PostgREST runs it. */
async function as<T>(p: Person | "anon", fn: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    if (p === "anon") {
      await db.query("set local role anon");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
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
  } finally {
    db.release();
  }
}
const SAVE = "select public.save_chase_steps_atomic($1, $2::jsonb, $3::jsonb) as r";
async function save(p: Person | "anon", org: string, expected: unknown, steps: unknown): Promise<Outcome> {
  try {
    const rows = await as(p, async (db) => (await db.query(SAVE, [org, JSON.stringify(expected), JSON.stringify(steps)])).rows);
    return { ok: true, steps: rows[0].r as Step[] };
  } catch (e) {
    const err = e as { code?: string; message: string };
    return { ok: false, code: err.code, message: err.message };
  }
}
/** The company's steps as the screen reads them (the shape p_expected must have). */
async function current(org: string): Promise<Step[]> {
  return (await q<{ id: string; offset_days: number; tone: string }>("select id, offset_days, tone from public.chase_steps where organization_id = $1 order by offset_days, id", [org]))
    .map((r) => ({ id: r.id, days: r.offset_days, tone: r.tone }));
}
/** md5 over every function in public and security_audit except 163's, with security, config, body and grants. */
async function otherFunctionsFingerprint() {
  return (await q<{ fp: string }>(`select md5(coalesce(string_agg(md5(concat_ws('|', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), p.prosecdef::text, coalesce(p.proconfig::text, ''), md5(p.prosrc), coalesce(p.proacl::text, ''))), '' order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), '')) as fp
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'security_audit') and not (n.nspname = 'public' and p.proname = 'save_chase_steps_atomic')
      and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`))[0].fp;
}
const hasFunction = async () => (await q<{ ok: boolean }>("select to_regprocedure($1) is not null as ok", [FN]))[0].ok;
const verifyRows = async () => (await q<{ check_name: string; ok: boolean }>(read(VERIFY)));

beforeAll(async () => {
  await verifyBackendIdentity();
  pool = new Pool({ connectionString: isolatedBackend().databaseUrl, max: 6 });
  // Leave nothing from an earlier crashed run: the function is only ever here while this file runs.
  if (await hasFunction()) await q(read(ROLLBACK));
  const orgA = await makeOrg("alpha");
  const orgB = await makeOrg("beta");
  A = { org: orgA, admin: await makePerson(orgA, "a-admin", "admin"), office: await makePerson(orgA, "a-office", "office"),
        workshop: await makePerson(orgA, "a-workshop", "workshop"), viewer: await makePerson(orgA, "a-viewer", "viewer") };
  B = { org: orgB, admin: await makePerson(orgB, "b-admin", "admin") };
});

afterAll(async () => {
  if (!pool) return;
  try {
    if (await hasFunction()) await q(read(ROLLBACK));
    const ids = people.map((p) => p.id);
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      for (const t of ["public.chase_pauses", "public.chase_steps", "public.organization_members", "public.user_profiles"]) await db.query(`delete from ${t} where organization_id = any($1)`, [orgs]);
      await db.query("delete from security_audit.session_company where user_id = any($1)", [ids]);
      await db.query("delete from public.organizations where id = any($1)", [orgs]);
      await db.query("commit");
      await db.query("delete from auth.users where id = any($1)", [ids]);
    } catch (e) { await db.query("rollback").catch(() => undefined); throw e; } finally { db.release(); }
  } finally {
    await pool.end();
  }
});

describe("release 163: the chase steps screen saves all its steps in one call", () => {
  it("1. the release adds the one function and nothing else, verifies (8 rows true) and applying it again changes nothing", async () => {
    expect(await hasFunction()).toBe(false);
    const before = await otherFunctionsFingerprint();
    await q(read(RELEASE));
    expect(await hasFunction()).toBe(true);
    expect(await otherFunctionsFingerprint()).toBe(before);
    const rows = await verifyRows();
    expect(rows).toHaveLength(8);
    expect(rows.filter((r) => r.ok !== true).map((r) => r.check_name)).toEqual([]);
    const body = (await q<{ md5: string; sec: boolean; cfg: string[] }>(`select md5(regexp_replace(prosrc, '\\s', '', 'g')) as md5, prosecdef as sec, proconfig as cfg from pg_proc where oid = to_regprocedure($1)`, [FN]))[0];
    expect(body).toEqual({ md5: BODY_MD5, sec: false, cfg: ["search_path=pg_catalog, public"] });
    await q(read(RELEASE));
    expect(await otherFunctionsFingerprint()).toBe(before);
    expect((await verifyRows()).every((r) => r.ok === true)).toBe(true);
  });

  it("2. an admin saves three steps from none and gets three ids back; an office person can too", async () => {
    const r = await save(A.admin, A.org, [], [{ days: -3, tone: "before_due" }, { days: 7, tone: "friendly" }, { days: 21, tone: "firm" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.steps.map((s) => [s.days, s.tone])).toEqual([[-3, "before_due"], [7, "friendly"], [21, "firm"]]);
    expect(r.steps.every((s) => typeof s.id === "string")).toBe(true);
    expect(await current(A.org)).toEqual(r.steps);
    const o = await save(A.office, A.org, r.steps, r.steps);
    expect(o.ok).toBe(true);
  });

  it("3. a second save keeps the ids of unchanged offsets, changes a tone, drops one offset and adds one", async () => {
    const first = await current(A.org);
    const r = await save(A.admin, A.org, first, [{ days: -3, tone: "before_due" }, { days: 7, tone: "firm" }, { days: 30, tone: "final" }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const id = (list: Step[], d: number) => list.find((s) => s.days === d)?.id;
    expect(id(r.steps, -3)).toBe(id(first, -3));
    expect(id(r.steps, 7)).toBe(id(first, 7));
    expect(r.steps.find((s) => s.days === 7)?.tone).toBe("firm");
    expect(r.steps.some((s) => s.days === 21)).toBe(false);
    expect(id(r.steps, 30)).toBeDefined();
    expect(await current(A.org)).toEqual(r.steps);
  });

  it("4. a stale snapshot is refused with 40001 and changes nothing", async () => {
    const now = await current(A.org);
    const stale = now.slice(1);
    const r = await save(A.admin, A.org, stale, [{ days: 5, tone: "friendly" }]);
    expect(r).toMatchObject({ ok: false, code: "40001" });
    expect(await current(A.org)).toEqual(now);
  });

  it("5. five bad lists are refused with 22023 and change nothing", async () => {
    const now = await current(A.org);
    const bad: unknown[] = [
      [{ days: 5, tone: "friendly" }, { days: 5, tone: "firm" }],
      [{ days: 400, tone: "final" }],
      [{ days: 5, tone: "before_due" }],
      Array.from({ length: 11 }, (_, i) => ({ days: i + 1, tone: "friendly" })),
      { days: 5 },
    ];
    for (const steps of bad) expect(await save(A.admin, A.org, now, steps), JSON.stringify(steps)).toMatchObject({ ok: false, code: "22023" });
    expect(await current(A.org)).toEqual(now);
  });

  it("6. another company, workshop, viewer and anon are refused with 42501 and change nothing", async () => {
    const now = await current(A.org);
    const mine = await current(B.org);
    const one = [{ days: 5, tone: "friendly" }];
    expect(await save(B.admin, A.org, now, one)).toMatchObject({ ok: false, code: "42501" });
    expect(await save(A.admin, B.org, mine, one)).toMatchObject({ ok: false, code: "42501" });
    expect(await save(A.workshop, A.org, now, one)).toMatchObject({ ok: false, code: "42501" });
    expect(await save(A.viewer, A.org, now, one)).toMatchObject({ ok: false, code: "42501" });
    expect(await save("anon", A.org, now, one)).toMatchObject({ ok: false, code: "42501" });
    expect(await current(A.org)).toEqual(now);
    expect(await current(B.org)).toEqual(mine);
  });

  it("7. two simultaneous saves of the same snapshot have exactly one winner (the other gets 40001)", async () => {
    const now = await current(A.org);
    const [x, y] = await Promise.all([
      save(A.admin, A.org, now, [{ days: 10, tone: "friendly" }]),
      save(A.office, A.org, now, [{ days: 12, tone: "firm" }]),
    ]);
    const results = [x, y];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === "40001")).toHaveLength(1);
    const win = results.find((r) => r.ok);
    expect(await current(A.org)).toEqual(win && win.ok ? win.steps : []);
  });

  it("8. rollback removes the function and nothing else (saved steps stay), and the release can be applied again", async () => {
    const steps = await current(A.org);
    const before = await otherFunctionsFingerprint();
    await q(read(ROLLBACK));
    expect(await hasFunction()).toBe(false);
    expect(await otherFunctionsFingerprint()).toBe(before);
    expect(await current(A.org)).toEqual(steps);
    await q(read(ROLLBACK)); // absent: nothing to do
    await q(read(RELEASE));
    expect(await hasFunction()).toBe(true);
    expect((await verifyRows()).every((r) => r.ok === true)).toBe(true);
    expect(await otherFunctionsFingerprint()).toBe(before);
  });

  it("9. a function of that name that is not 163's makes both the release and the rollback refuse, and is left as it was", async () => {
    await q(read(ROLLBACK));
    await q("create function public.save_chase_steps_atomic(p_org uuid, p_expected jsonb, p_steps jsonb) returns jsonb language sql as $$ select '[]'::jsonb $$");
    try {
      await expect(q(read(RELEASE))).rejects.toThrow(/exists but is not 163's/);
      await expect(q(read(ROLLBACK))).rejects.toThrow(/is not 163's/);
      expect((await q<{ src: string }>("select prosrc as src from pg_proc where oid = to_regprocedure($1)", [FN]))[0].src).toContain("select '[]'::jsonb");
    } finally {
      await q(`drop function if exists ${FN}`);
    }
    await q(read(RELEASE));
    expect(await hasFunction()).toBe(true);
  });
});
