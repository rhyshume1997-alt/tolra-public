/**
 * Costing rates, release 143, part two: public.save_costing_settings_atomic(p_org, p_expected, p_value) and what the rates must never do.
 * Real SQL on the disposable database: synthetic companies, forged session claims (no Auth API), one transaction per request as PostgREST
 * runs it, committed rows so two connections can race. Proves:
 *   - nothing is built in: no rate column has a default, a new company has no rows (costing off), a half-entered set is refused by the database;
 *   - company scoping: p_org must be the caller's own company; another company's ids and rates cannot be reached; two companies' rates never mix;
 *   - who: admin and office save; workshop, viewer and a support session (elevated or not) are refused; anon and service_role have no EXECUTE;
 *   - the second step: an admin of a company that requires it is refused at aal1 (hint mfa_required), allowed at aal2;
 *   - optimistic concurrency: a stale p_expected is refused with 40001 and changes nothing; concurrent saves serialise behind one advisory lock;
 *   - the whole set is validated to the tables' ranges before anything is written (22023); a failure part-way rolls back EVERYTHING;
 *   - unchanged rows are left alone (updated_at, updated_by, audit trail); changed rows are in the audit log with the person;
 *   - past records do not change when rates are edited: no table references the rate tables, no quote or job column holds a rate, and quotes,
 *     quote lines, jobs and job values are byte-for-byte the same after every kind of rate edit.
 */
import { randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";
import { SYNTHETIC_SLUG_PREFIX } from "../support/isolation";

const run = randomUUID().slice(0, 8);
let counter = 0;
type Person = { id: string; email: string; session?: string; aal?: string };
const person = (name: string): Person => ({ id: randomUUID(), email: `${name}-${(counter += 1)}.${run}@example.test` });
const orgs: string[] = [];

async function makeOrg(db: Client, label: string) {
  const id = randomUUID();
  counter += 1;
  await db.query("insert into public.organizations (id, name, slug, status) values ($1, $2, $3, 'active')", [id, `143s ${label} ${run}`, `${SYNTHETIC_SLUG_PREFIX}${run}-143s-${label}-${counter}`]);
  orgs.push(id);
  return id;
}

async function member(db: Client, org: string, p: Person, role: string) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await db.query(`insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, $3, $4, $5, true, false)`,
    [p.id, p.email, `Person ${counter}`, role, org]);
  await db.query("insert into public.organization_members (user_id, organization_id, role, active) values ($1, $2, $3, true)", [p.id, org, role]);
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id) values ($1, $2, $3)", [p.session, p.id, org]);
}

async function supportMember(db: Client, org: string, p: Person) {
  await db.query("insert into auth.users (id, email) values ($1, $2)", [p.id, p.email]);
  await db.query(`insert into public.user_profiles (id, email, full_name, role, organization_id, active, must_change_password) values ($1, $2, 'Tolra Support', 'admin', $3, true, false)`, [p.id, p.email, org]);
  await db.query("insert into security_audit.platform_admins (user_id) values ($1)", [p.id]);
  const grant = randomUUID();
  await db.query(`insert into public.organization_members (user_id, organization_id, role, active, support, expires_at, support_grant) values ($1, $2, 'admin', true, true, now() + interval '2 hours', $3)`, [p.id, org, grant]);
  p.session = randomUUID();
  await db.query("insert into auth.sessions (id, user_id) values ($1, $2)", [p.session, p.id]);
  await db.query("insert into security_audit.session_company (session_id, user_id, organization_id, grant_id) values ($1, $2, $3, $4)", [p.session, p.id, org, grant]);
}

type Role = "authenticated" | "anon" | "service_role";
/** One API request: its own transaction, as the role with the person's claims (as PostgREST runs it). */
async function as<T>(p: Person | null, fn: (db: Client) => Promise<T>, role: Role = "authenticated"): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query(`set local role ${role}`);
      if (p) {
        await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
          [JSON.stringify({ sub: p.id, role, aud: "authenticated", aal: p.aal ?? "aal2", email: p.email, session_id: p.session }), p.id]);
      }
      const result = await fn(db);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  });
}

type Fail = { ok: false; code: string; message: string; hint?: string };
type Result = { ok: true } | Fail;
const SAVE = "select public.save_costing_settings_atomic($1, $2::jsonb, $3::jsonb)";
async function save(p: Person | null, org: string | null, expected: unknown, value: unknown, role: Role = "authenticated"): Promise<Result> {
  try {
    await as(p, (db) => db.query(SAVE, [org, JSON.stringify(expected), JSON.stringify(value)]), role);
    return { ok: true };
  } catch (error) {
    const e = error as { code?: string; message?: string; hint?: string };
    return { ok: false, code: e.code ?? "error", message: e.message ?? "", hint: e.hint };
  }
}

const sql = <T extends Record<string, unknown>>(text: string, params: unknown[] = []) => withDb(async (db) => (await db.query<T>(text, params)).rows);

type Mat = { id: string; name: string; price_pence: number; price_unit: string; scrap_pct: number };
type Mac = { id: string; name: string; hourly_rate_pence: number; labour_rate_pence: number | null };
type Def = { labour_rate_pence: number; programming_rate_pence: number; overhead_pct: number; default_margin_pct: number };
type Set = { materials: Mat[]; machines: Mac[]; defaults: Def | null };
const mat = (id: string, name: string, price = 235, unit = "kg", scrap = 5): Mat => ({ id, name, price_pence: price, price_unit: unit, scrap_pct: scrap });
const mac = (id: string, name: string, hourly = 6500, labour: number | null = null): Mac => ({ id, name, hourly_rate_pence: hourly, labour_rate_pence: labour });
const DEF: Def = { labour_rate_pence: 3250, programming_rate_pence: 7500, overhead_pct: 150, default_margin_pct: 20 };
const EMPTY: Set = { materials: [], machines: [], defaults: null };
const id = () => randomUUID();

/** What the company has now, in the shape the function compares (read as the table owner, so it is a neutral witness). */
async function current(org: string): Promise<Set> {
  const m = await sql<{ id: string; name: string; price_pence: number; price_unit: string; scrap_pct: string }>(
    "select id, name, price_pence, price_unit, scrap_pct from public.costing_materials where organization_id = $1 order by id", [org]);
  const k = await sql<{ id: string; name: string; hourly_rate_pence: number; labour_rate_pence: number | null }>(
    "select id, name, hourly_rate_pence, labour_rate_pence from public.costing_machines where organization_id = $1 order by id", [org]);
  const d = await sql<{ labour_rate_pence: number; programming_rate_pence: number; overhead_pct: string; default_margin_pct: string }>(
    "select labour_rate_pence, programming_rate_pence, overhead_pct, default_margin_pct from public.costing_defaults where organization_id = $1", [org]);
  return {
    materials: m.map((r) => ({ ...r, scrap_pct: Number(r.scrap_pct) })),
    machines: k,
    defaults: d[0] ? { ...d[0], overhead_pct: Number(d[0].overhead_pct), default_margin_pct: Number(d[0].default_margin_pct) } : null,
  };
}
const stamps = (org: string) => sql<{ t: string; id: string; updated_at: string; updated_by: string | null }>(
  `select 'm' as t, id::text, updated_at::text, updated_by::text from public.costing_materials where organization_id = $1
   union all select 'k', id::text, updated_at::text, updated_by::text from public.costing_machines where organization_id = $1
   union all select 'd', id::text, updated_at::text, updated_by::text from public.costing_defaults where organization_id = $1 order by 1, 2`, [org]);
const auditCount = async (org: string) => Number((await sql<{ n: string }>(
  "select count(*)::text as n from security_audit.audit_log where organization_id = $1 and entity_table in ('costing_materials','costing_machines','costing_defaults')", [org]))[0].n);

const requireAdminMfa = (org: string, value: boolean) => withDb(async (db) => {
  await db.query("begin");
  await db.query("set local session_replication_role = replica");
  await db.query("update public.organizations set require_admin_mfa = $2 where id = $1", [org, value]);
  await db.query("commit");
});

const A = { admin: person("a-admin"), office: person("a-office"), workshop: person("a-workshop"), viewer: person("a-viewer"), support: person("a-support") };
const B = { admin: person("b-admin") };
const C = { admin: person("c-admin"), office: person("c-office") };
let orgA = "", orgB = "", orgC = "";

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    orgA = await makeOrg(db, "alpha");
    orgB = await makeOrg(db, "beta");
    orgC = await makeOrg(db, "gamma");
    await member(db, orgA, A.admin, "admin");
    await member(db, orgA, A.office, "office");
    await member(db, orgA, A.workshop, "workshop");
    await member(db, orgA, A.viewer, "viewer");
    await supportMember(db, orgA, A.support);
    await member(db, orgB, B.admin, "admin");
    await member(db, orgC, C.admin, "admin");
    await member(db, orgC, C.office, "office");
  });
});

afterAll(async () => {
  const people = [...Object.values(A), ...Object.values(B), ...Object.values(C)].map((p) => p.id);
  await withDb(async (db) => {
    await db.query("begin");
    await db.query("set local session_replication_role = replica");
    for (const t of ["public.costing_materials", "public.costing_machines", "public.costing_defaults", "public.quote_line_items", "public.quotes", "public.job_values",
      "public.jobs", "security_audit.audit_log", "public.organization_members", "public.user_profiles"]) await db.query(`delete from ${t} where organization_id = any($1)`, [orgs]);
    await db.query("delete from security_audit.session_company where user_id = any($1)", [people]);
    await db.query("delete from security_audit.platform_admins where user_id = any($1)", [people]);
    await db.query("delete from public.organizations where id = any($1)", [orgs]);
    await db.query("commit");
    await db.query("delete from auth.users where id = any($1)", [people]);
  });
});

describe("143: no rate is built in, a blank company is not configured", () => {
  it("no rate column has a default and every figure is NOT NULL (except a machine's own labour rate, which means 'use the company default')", async () => {
    const rows = await sql<{ table_name: string; column_name: string; column_default: string | null; is_nullable: string }>(
      `select table_name, column_name, column_default, is_nullable from information_schema.columns where table_schema = 'public'
         and table_name in ('costing_materials','costing_machines','costing_defaults')
         and column_name in ('price_pence','price_unit','scrap_pct','hourly_rate_pence','labour_rate_pence','programming_rate_pence','overhead_pct','default_margin_pct')
       order by table_name, column_name`);
    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => r.column_default !== null)).toEqual([]);
    expect(rows.filter((r) => r.is_nullable === "YES").map((r) => `${r.table_name}.${r.column_name}`)).toEqual(["costing_machines.labour_rate_pence"]);
  });

  it("a company that has entered nothing has no rows in any of the three tables; the release inserted none for anyone", async () => {
    for (const org of [orgA, orgB, orgC]) expect(await current(org)).toEqual(EMPTY);
  });

  it("the function refuses a half-entered set: no defaults object, defaults missing a figure, a machine with no hourly rate", async () => {
    const expected = await current(orgC);
    for (const [label, value] of [
      ["no defaults", { materials: [mat(id(), "Steel")], machines: [mac(id(), "Mill")] }],
      ["defaults null", { materials: [], machines: [], defaults: null }],
      ["defaults without programming rate", { materials: [], machines: [], defaults: { labour_rate_pence: 1, overhead_pct: 150, default_margin_pct: 20 } }],
      ["defaults without margin", { materials: [], machines: [], defaults: { labour_rate_pence: 1, programming_rate_pence: 1, overhead_pct: 150 } }],
      ["machine without hourly rate", { materials: [], machines: [{ id: id(), name: "Mill", labour_rate_pence: null }], defaults: DEF }],
    ] as const) {
      expect(await save(C.admin, orgC, expected, value), label).toMatchObject({ ok: false, code: "22023" });
    }
    expect(await current(orgC)).toEqual(EMPTY);
  });
});

describe("143: who can save, and for which company", () => {
  it("admin saves the whole set (first save from blank); the database stamps who", async () => {
    const value: Set = { materials: [mat(id(), "Mild steel"), mat(id(), "Insert", 45, "each", 12.5)], machines: [mac(id(), "Haas VF-2"), mac(id(), "Lathe", 4000, 2800)], defaults: DEF };
    expect(await save(A.admin, orgA, EMPTY, value)).toEqual({ ok: true });
    const now = await current(orgA);
    expect(now.materials.map((m) => m.name).sort()).toEqual(["Insert", "Mild steel"]);
    expect(now.machines.find((m) => m.name === "Lathe")).toMatchObject({ hourly_rate_pence: 4000, labour_rate_pence: 2800 });
    expect(now.machines.find((m) => m.name === "Haas VF-2")?.labour_rate_pence).toBeNull();
    expect(now.defaults).toEqual(DEF);
    expect((await stamps(orgA)).every((r) => r.updated_by === A.admin.id)).toBe(true);
  });

  it("office saves a change (a rate edit); workshop, viewer and support refuse with 42501 and nothing moves", async () => {
    const before = await current(orgA);
    const edited: Set = { ...before, materials: before.materials.map((m) => (m.name === "Mild steel" ? { ...m, price_pence: 250 } : m)) };
    expect(await save(A.office, orgA, before, edited)).toEqual({ ok: true });
    expect((await current(orgA)).materials.find((m) => m.name === "Mild steel")?.price_pence).toBe(250);
    const base = await current(orgA);
    const tryEdit: Set = { ...base, materials: base.materials.map((m) => ({ ...m, price_pence: 1 })) };
    for (const who of [A.workshop, A.viewer, A.support]) {
      expect(await save(who, orgA, base, tryEdit), who.email).toMatchObject({ ok: false, code: "42501" });
    }
    expect(await current(orgA)).toEqual(base);
  });

  it("a support session is refused by the function even when elevated to write (the tables would allow it); an elevated one still cannot save", async () => {
    await sql("update security_audit.session_company set elevated_until = now() + interval '1 hour' where user_id = $1", [A.support.id]);
    const base = await current(orgA);
    const result = await save(A.support, orgA, base, { ...base, defaults: { ...DEF, labour_rate_pence: 1 } });
    expect(result).toMatchObject({ ok: false, code: "42501", message: "Not permitted" });
    expect(await current(orgA)).toEqual(base);
    await sql("update security_audit.session_company set elevated_until = null where user_id = $1", [A.support.id]);
  });

  it("p_org must be the caller's own company: A's admin cannot save to B, B's admin cannot save to A, a null or made-up company is refused", async () => {
    const a = await current(orgA);
    const b = await current(orgB);
    const value: Set = { materials: [mat(id(), "Planted")], machines: [mac(id(), "Planted")], defaults: DEF };
    expect(await save(A.admin, orgB, b, value)).toMatchObject({ ok: false, code: "42501" });
    expect(await save(B.admin, orgA, a, value)).toMatchObject({ ok: false, code: "42501" });
    expect(await save(A.admin, null, a, value)).toMatchObject({ ok: false, code: "42501" });
    expect(await save(A.admin, id(), a, value)).toMatchObject({ ok: false, code: "42501" });
    expect(await current(orgA)).toEqual(a);
    expect(await current(orgB)).toEqual(b);
  });

  it("two companies cannot touch each other's rates: B saves its own, A's are unchanged; B submitting A's row ids is refused and changes neither company", async () => {
    const aBefore = await current(orgA);
    const bValue: Set = { materials: [mat(id(), "Mild steel", 240)], machines: [mac(id(), "Haas VF-2", 7000)], defaults: { ...DEF, labour_rate_pence: 3000 } };
    expect(await save(B.admin, orgB, EMPTY, bValue)).toEqual({ ok: true });
    expect(await current(orgA)).toEqual(aBefore);
    const bBefore = await current(orgB);
    expect(bBefore.materials).toHaveLength(1);
    // B's admin submits A's own material id (a rate row of another company) as if it were B's.
    const hijack: Set = { ...bBefore, materials: [...bBefore.materials, { ...aBefore.materials[0], price_pence: 1, name: "Hijack" }] };
    const refused = await save(B.admin, orgB, bBefore, hijack);
    expect(refused).toMatchObject({ ok: false, code: "42501" });
    expect(await current(orgA)).toEqual(aBefore);
    expect(await current(orgB)).toEqual(bBefore);
    // B reading through its own request sees only its own rows (row-level security still applies inside an invoker function's tables).
    const seen = await as(B.admin, async (db) => (await db.query<{ n: string }>("select count(*)::text as n from public.costing_materials")).rows[0].n);
    expect(seen).toBe("1");
  });

  it("anon and service_role have no EXECUTE; a signed-out call by the table owner is refused inside; the function is SECURITY INVOKER with a pinned search_path", async () => {
    const base = await current(orgA);
    expect(await save(null, orgA, base, base, "anon")).toMatchObject({ ok: false, code: "42501", message: expect.stringMatching(/permission denied/) });
    expect(await save(A.admin, orgA, base, base, "service_role")).toMatchObject({ ok: false, code: "42501", message: expect.stringMatching(/permission denied/) });
    const owner = await withDb(async (db) => {
      try { await db.query(SAVE, [orgA, JSON.stringify(base), JSON.stringify(base)]); return "allowed"; } catch (e) { return (e as { message: string }).message; }
    });
    expect(owner).toBe("Not permitted");
    expect(await sql(`select prosecdef, proconfig::text as cfg, has_function_privilege('anon', oid, 'EXECUTE') as anon, has_function_privilege('authenticated', oid, 'EXECUTE') as auth,
                       has_function_privilege('service_role', oid, 'EXECUTE') as svc, has_function_privilege('public'::name, oid, 'EXECUTE') as pub
                      from pg_proc where oid = 'public.save_costing_settings_atomic(uuid,jsonb,jsonb)'::regprocedure`))
      .toEqual([{ prosecdef: false, cfg: expect.stringContaining("search_path=pg_catalog"), anon: false, auth: true, svc: false, pub: false }]);
  });

  it("the second step: an admin of a company that requires it is refused at aal1 (hint mfa_required) and allowed at aal2; office is not held to it", async () => {
    await requireAdminMfa(orgC, true);
    try {
      const expected = await current(orgC);
      const value: Set = { materials: [mat(id(), "Steel")], machines: [mac(id(), "Mill")], defaults: DEF };
      C.admin.aal = "aal1";
      expect(await save(C.admin, orgC, expected, value)).toMatchObject({ ok: false, code: "42501", hint: "mfa_required" });
      expect(await current(orgC)).toEqual(EMPTY);
      C.admin.aal = "aal2";
      expect(await save(C.admin, orgC, expected, value)).toEqual({ ok: true });
      const now = await current(orgC);
      // Even a save that would change nothing is refused at aal1. Two independent checks do it: the function's first statement (assert_privileged_aal) and
      // the tables' statement-level admin_mfa trigger, which fires for every INSERT, UPDATE and DELETE statement even when no row matches.
      C.admin.aal = "aal1";
      expect(await save(C.admin, orgC, now, now)).toMatchObject({ ok: false, code: "42501", hint: "mfa_required" });
      C.admin.aal = "aal2";
      C.office.aal = "aal1";
      expect(await save(C.office, orgC, now, { ...now, defaults: { ...DEF, default_margin_pct: 25 } })).toEqual({ ok: true });
    } finally {
      await requireAdminMfa(orgC, false);
    }
  });
});

describe("143: optimistic concurrency and one save at a time", () => {
  it("a stale p_expected is refused with 40001 (costing_settings_changed) and changes nothing; the person who saved first keeps their figures", async () => {
    const loaded = await current(orgA);
    const first: Set = { ...loaded, defaults: { ...DEF, overhead_pct: 160 } };
    expect(await save(A.office, orgA, loaded, first)).toEqual({ ok: true });
    const second: Set = { ...loaded, defaults: { ...DEF, overhead_pct: 175 } };
    expect(await save(A.admin, orgA, loaded, second)).toMatchObject({ ok: false, code: "40001", message: "Settings changed; reload", hint: "costing_settings_changed" });
    expect((await current(orgA)).defaults?.overhead_pct).toBe(160);
    // After reloading, the same person saves.
    expect(await save(A.admin, orgA, await current(orgA), second)).toEqual({ ok: true });
    expect((await current(orgA)).defaults?.overhead_pct).toBe(175);
  });

  it("every part of p_expected counts: an extra, a missing or a changed material, machine or defaults value is stale; formatting (case of ids, 5 vs 5.00, key order) is not", async () => {
    const base = await current(orgA);
    const stale = async (e: Set) => expect(await save(A.admin, orgA, e, base)).toMatchObject({ ok: false, code: "40001" });
    await stale({ ...base, materials: base.materials.slice(1) });
    await stale({ ...base, materials: [...base.materials, mat(id(), "Ghost")] });
    await stale({ ...base, machines: base.machines.map((m, i) => (i === 0 ? { ...m, hourly_rate_pence: m.hourly_rate_pence + 1 } : m)) });
    await stale({ ...base, machines: base.machines.map((m, i) => (i === 0 ? { ...m, labour_rate_pence: 1 } : m)) });
    await stale({ ...base, defaults: base.defaults && { ...base.defaults, default_margin_pct: 0 } });
    await stale({ ...base, defaults: null });
    // Same content written another way is accepted (nothing changes, so it is a no-op save).
    const reshaped = JSON.parse(JSON.stringify(base).replace(/"scrap_pct":5\b/g, '"scrap_pct":5.00'));
    reshaped.materials = reshaped.materials.map((m: Mat) => ({ ...m, id: m.id.toUpperCase() })).reverse();
    expect(await save(A.admin, orgA, reshaped, base)).toEqual({ ok: true });
    expect(await current(orgA)).toEqual(base);
  });

  it("concurrent saves serialise on the company's advisory lock: the second waits for the first, then is refused as stale (deterministic, not luck)", async () => {
    const loaded = await current(orgA);
    const one: Set = { ...loaded, defaults: { ...DEF, labour_rate_pence: 3300 } };
    const two: Set = { ...loaded, defaults: { ...DEF, labour_rate_pence: 3400 } };
    const holder = await withDb(async (db1) => {
      await db1.query("begin");
      await db1.query("set local role authenticated");
      await db1.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: A.admin.id, role: "authenticated", aal: "aal2", email: A.admin.email, session_id: A.admin.session }), A.admin.id]);
      await db1.query(SAVE, [orgA, JSON.stringify(loaded), JSON.stringify(one)]); // holds the lock, uncommitted
      const waiting = save(A.office, orgA, loaded, two); // a second connection: must block
      let waited = false;
      for (let i = 0; i < 100 && !waited; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        waited = (await sql<{ n: string }>(
          `select count(*)::text as n from pg_locks l join pg_stat_activity a on a.pid = l.pid where l.locktype = 'advisory' and not l.granted and a.datname = current_database()`))[0].n !== "0";
      }
      const stillPending = await Promise.race([waiting.then(() => false), new Promise((r) => setTimeout(() => r(true), 200))]);
      await db1.query("commit");
      return { waited, stillPending, second: await waiting };
    });
    expect(holder.waited).toBe(true);
    expect(holder.stillPending).toBe(true);
    expect(holder.second).toMatchObject({ ok: false, code: "40001" });
    expect((await current(orgA)).defaults?.labour_rate_pence).toBe(3300);
  });

  it("eight saves at once from the same loaded state: exactly one wins, seven are told to reload, and the result is the winner's whole set", async () => {
    const loaded = await current(orgA);
    const values = Array.from({ length: 8 }, (_, i): Set => ({ ...loaded, defaults: { ...DEF, labour_rate_pence: 4000 + i }, materials: loaded.materials.map((m) => ({ ...m, price_pence: 500 + i })) }));
    const results = await Promise.all(values.map((v, i) => save(i % 2 ? A.office : A.admin, orgA, loaded, v)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.code === "40001")).toBe(true);
    const winner = results.findIndex((r) => r.ok);
    const now = await current(orgA);
    expect(now.defaults?.labour_rate_pence).toBe(4000 + winner);
    expect(now.materials.every((m) => m.price_pence === 500 + winner)).toBe(true);
  });
});

describe("143: the whole set is validated first; a failure part-way keeps nothing", () => {
  it("each kind of bad value is refused with 22023 before anything is written", async () => {
    const base = await current(orgA);
    const m0 = base.materials[0];
    const k0 = base.machines[0];
    const bads: Array<[string, Set]> = [
      ["price 2.5 pence", { ...base, materials: [{ ...m0, price_pence: 2.5 }] }],
      ["negative price", { ...base, materials: [{ ...m0, price_pence: -1 }] }],
      ["price over GBP 100,000", { ...base, materials: [{ ...m0, price_pence: 10_000_001 }] }],
      ["price as text", { ...base, materials: [{ ...m0, price_pence: "12" as unknown as number }] }],
      ["blank name", { ...base, materials: [{ ...m0, name: "   " }] }],
      ["two-line name", { ...base, materials: [{ ...m0, name: "a\nb" }] }],
      ["81-character name", { ...base, materials: [{ ...m0, name: "x".repeat(81) }] }],
      ["unit lb", { ...base, materials: [{ ...m0, price_unit: "lb" }] }],
      ["scrap 100.01", { ...base, materials: [{ ...m0, scrap_pct: 100.01 }] }],
      ["scrap -0.01", { ...base, materials: [{ ...m0, scrap_pct: -0.01 }] }],
      ["scrap 1.005 (would be rounded)", { ...base, materials: [{ ...m0, scrap_pct: 1.005 }] }],
      ["id not a UUID", { ...base, materials: [{ ...m0, id: "not-a-uuid" }] }],
      ["machine hourly -1", { ...base, machines: [{ ...k0, hourly_rate_pence: -1 }] }],
      ["machine labour 1.5", { ...base, machines: [{ ...k0, labour_rate_pence: 1.5 }] }],
      ["machine labour missing key", { ...base, machines: [{ id: k0.id, name: k0.name, hourly_rate_pence: 1 } as unknown as Mac] }],
      ["overhead 99.99", { ...base, defaults: { ...DEF, overhead_pct: 99.99 } }],
      ["overhead 500.01", { ...base, defaults: { ...DEF, overhead_pct: 500.01 } }],
      ["margin 95.01", { ...base, defaults: { ...DEF, default_margin_pct: 95.01 } }],
      ["margin 12.345", { ...base, defaults: { ...DEF, default_margin_pct: 12.345 } }],
      ["labour rate 10,000,001", { ...base, defaults: { ...DEF, labour_rate_pence: 10_000_001 } }],
      ["same id twice", { ...base, materials: [m0, { ...m0, name: "Other" }] }],
      ["same name twice (case and spaces)", { ...base, materials: [m0, mat(id(), `  ${m0.name.toUpperCase()} `)] }],
      ["same machine name twice", { ...base, machines: [k0, mac(id(), k0.name.toLowerCase())] }],
      ["501 materials", { ...base, materials: Array.from({ length: 501 }, (_, i) => mat(id(), `M${i}`)) }],
      ["501 machines", { ...base, machines: Array.from({ length: 501 }, (_, i) => mac(id(), `K${i}`)) }],
    ];
    for (const [label, value] of bads) expect(await save(A.admin, orgA, base, value), label).toMatchObject({ ok: false, code: "22023" });
    for (const [label, expected, value] of [
      ["p_expected not an object", "x", base], ["p_value is null", base, null], ["materials not an array", base, { ...base, materials: {} }],
      ["p_expected without machines", { materials: [] }, base],
    ] as const) expect(await save(A.admin, orgA, expected, value), label).toMatchObject({ ok: false, code: "22023" });
    expect(await current(orgA)).toEqual(base);
  });

  it("the limits themselves are allowed: 500 materials and 500 machines, 100,000 pounds, scrap 100, overhead 500, margin 95, two decimal places", async () => {
    const before = await current(orgC);
    const big: Set = {
      materials: Array.from({ length: 500 }, (_, i) => mat(id(), `Material ${i}`, 10_000_000, "each", 100)),
      machines: Array.from({ length: 500 }, (_, i) => mac(id(), `Machine ${i}`, 10_000_000, 10_000_000)),
      defaults: { labour_rate_pence: 0, programming_rate_pence: 10_000_000, overhead_pct: 500, default_margin_pct: 95 },
    };
    expect(await save(C.admin, orgC, before, big)).toEqual({ ok: true });
    const now = await current(orgC);
    expect([now.materials.length, now.machines.length]).toEqual([500, 500]);
    const frac: Set = { ...now, defaults: { ...big.defaults!, overhead_pct: 100.25, default_margin_pct: 0.05 } };
    expect(await save(C.office, orgC, now, frac)).toEqual({ ok: true });
    expect((await current(orgC)).defaults).toMatchObject({ overhead_pct: 100.25, default_margin_pct: 0.05 });
    // Put company C back to a small set for the rest of the file.
    const small: Set = { materials: [mat(id(), "Steel")], machines: [mac(id(), "Mill")], defaults: DEF };
    expect(await save(C.admin, orgC, await current(orgC), small)).toEqual({ ok: true });
  });

  it("a failure part-way through the writes rolls back EVERYTHING: a delete, an edit and an add done before a name clash are all undone", async () => {
    const base = await current(orgA);
    const [steel, insert] = [...base.materials].sort((a, b) => a.name.localeCompare(b.name)).reverse(); // "Mild steel", "Insert"
    const third = mat(id(), "Third");
    const seed: Set = { ...base, materials: [...base.materials, third] };
    expect(await save(A.admin, orgA, base, seed)).toEqual({ ok: true });
    const start = await current(orgA);
    const auditBefore = await auditCount(orgA);
    // Swap the two names (each is taken by the other's row when its update runs: unique violation), drop "Third", add a machine, change the defaults.
    const swap: Set = {
      materials: [{ ...steel, name: insert.name }, { ...insert, name: steel.name }],
      machines: [...start.machines, mac(id(), "Added before the clash")],
      defaults: { ...DEF, labour_rate_pence: 9999 },
    };
    const refused = await save(A.admin, orgA, start, swap);
    expect(refused).toMatchObject({ ok: false, code: "23505" });
    expect(await current(orgA)).toEqual(start);
    expect((await current(orgA)).materials.some((m) => m.name === "Third")).toBe(true);
    expect(await auditCount(orgA)).toBe(auditBefore); // not even an audit row survived
    // Remove the helper row again.
    expect(await save(A.admin, orgA, start, base)).toEqual({ ok: true });
  });
});

describe("143: unchanged rows are left alone, changed rows are audited", () => {
  it("saving the same set again changes no stamp and writes no audit row; changing one row moves that row's stamp and adds audit rows for that row only", async () => {
    const base = await current(orgA);
    const stampsBefore = await stamps(orgA);
    const auditBefore = await auditCount(orgA);
    expect(await save(A.office, orgA, base, base)).toEqual({ ok: true });
    expect(await stamps(orgA)).toEqual(stampsBefore);
    expect(await auditCount(orgA)).toBe(auditBefore);

    const target = base.machines[0];
    const edited: Set = { ...base, machines: base.machines.map((m) => (m.id === target.id ? { ...m, hourly_rate_pence: m.hourly_rate_pence + 100 } : m)) };
    expect(await save(A.office, orgA, base, edited)).toEqual({ ok: true });
    const stampsAfter = await stamps(orgA);
    const moved = stampsAfter.filter((s, i) => s.updated_at !== stampsBefore[i].updated_at);
    expect(moved.map((s) => s.id)).toEqual([target.id]);
    expect(moved[0].updated_by).toBe(A.office.id);
    const rows = await sql<{ action: string; entity_id: string; actor_user_id: string; old_h: number; new_h: number }>(
      `select action, entity_id, actor_user_id, (old_data->>'hourly_rate_pence')::int as old_h, (new_data->>'hourly_rate_pence')::int as new_h
         from security_audit.audit_log where organization_id = $1 and entity_table = 'costing_machines' and entity_id = $2 order by created_at desc, id desc limit 1`, [orgA, target.id]);
    expect(rows).toEqual([{ action: "UPDATE", entity_id: target.id, actor_user_id: A.office.id, old_h: target.hourly_rate_pence, new_h: target.hourly_rate_pence + 100 }]);
    expect(await auditCount(orgA)).toBe(auditBefore + 1);
  });

  it("deleting a material and adding one are each audited with the person; the delete keeps the old values in the audit row", async () => {
    const base = await current(orgA);
    const gone = base.materials[0];
    const added = mat(id(), "Brand new", 99, "kg", 2);
    expect(await save(A.admin, orgA, base, { ...base, materials: [...base.materials.slice(1), added] })).toEqual({ ok: true });
    const del = await sql<{ actor_user_id: string; name: string }>(
      "select actor_user_id, old_data->>'name' as name from security_audit.audit_log where organization_id = $1 and entity_table = 'costing_materials' and action = 'DELETE' and entity_id = $2", [orgA, gone.id]);
    expect(del).toEqual([{ actor_user_id: A.admin.id, name: gone.name }]);
    const ins = await sql<{ actor_user_id: string }>(
      "select actor_user_id from security_audit.audit_log where organization_id = $1 and entity_table = 'costing_materials' and action = 'INSERT' and entity_id = $2", [orgA, added.id]);
    expect(ins).toEqual([{ actor_user_id: A.admin.id }]);
  });
});

describe("143: past records do not change when rates are edited", () => {
  it("nothing references the rate tables except their company, and no quote, line, job or job-value column holds a rate", async () => {
    const refs = await sql<{ c: string }>(
      `select conrelid::regclass::text || ' -> ' || confrelid::regclass::text as c from pg_constraint
        where contype = 'f' and (confrelid in ('public.costing_materials'::regclass, 'public.costing_machines'::regclass, 'public.costing_defaults'::regclass))`);
    expect(refs).toEqual([]); // no foreign key INTO a rate table, from anywhere
    const out = await sql<{ c: string }>(
      `select conrelid::regclass::text || ' -> ' || confrelid::regclass::text as c from pg_constraint
        where contype = 'f' and conrelid in ('public.costing_materials'::regclass, 'public.costing_machines'::regclass, 'public.costing_defaults'::regclass) order by 1`);
    expect(out.map((r) => r.c.split(" -> ")[1])).toEqual(["organizations", "organizations", "organizations"]);
    const cols = await sql<{ c: string }>(
      `select table_name || '.' || column_name as c from information_schema.columns where table_schema = 'public'
          and table_name in ('quotes','quote_line_items','jobs','job_values','sales_orders','sales_order_lines','invoices','invoice_line_items')
          and column_name ~ '(costing|material_id|machine_id|rate_pence|hourly|overhead|margin|scrap|labour_rate|programming)' order by 1`);
    expect(cols).toEqual([]);
    const dependants = await sql<{ d: string }>(
      `select distinct d.objid::text as d from pg_depend d where d.classid = 'pg_rewrite'::regclass
          and d.refobjid in ('public.costing_materials'::regclass, 'public.costing_machines'::regclass, 'public.costing_defaults'::regclass)`);
    expect(dependants).toEqual([]); // no view reads the rate tables
  });

  it("quotes, quote lines, jobs and job values are identical after rates are edited, saved whole, deleted one by one and emptied", async () => {
    const quote = id(), line = id(), job = id();
    await withDb(async (db) => {
      await db.query("insert into public.quotes (id, organization_id, quote_ref, customer, total_value, status) values ($1, $2, $3, 'Acme', 123.45, 'draft')", [quote, orgA, `Q-143-${run}`]);
      await db.query("insert into public.quote_line_items (id, organization_id, quote_id, position, description, quantity, unit_price, source) values ($1, $2, $3, 1, 'Bracket', 10, 12.345, 'manual')", [line, orgA, quote]);
      await db.query("insert into public.jobs (id, organization_id, job_no, quote_id, customer, description, job_time_quoted_hr, setup_time_hr, run_time_hr) values ($1, $2, $3, $4, 'Acme', 'Bracket', 3.5, 0.5, 3)", [job, orgA, `J-143-${run}`, quote]);
      await db.query("insert into public.job_values (job_id, organization_id, value) values ($1, $2, 123.45)", [job, orgA]);
    });
    const snapshot = async () => (await sql<{ t: string; r: string }>(
      `select 'q' as t, to_jsonb(q)::text as r from public.quotes q where organization_id = $1
       union all select 'l', to_jsonb(l)::text from public.quote_line_items l where organization_id = $1
       union all select 'j', to_jsonb(j)::text from public.jobs j where organization_id = $1
       union all select 'v', to_jsonb(v)::text from public.job_values v where organization_id = $1 order by 1, 2`, [orgA]));
    const before = await snapshot();
    expect(before).toHaveLength(4);

    // 1. a rate edited through the whole-set save, 2. a row edited directly, 3. rows deleted one by one, 4. the set emptied and entered again.
    const s0 = await current(orgA);
    expect(await save(A.admin, orgA, s0, { ...s0, materials: s0.materials.map((m) => ({ ...m, price_pence: m.price_pence + 77 })), defaults: { ...DEF, overhead_pct: 333.33, default_margin_pct: 41.5 } })).toEqual({ ok: true });
    await as(A.office, (db) => db.query("update public.costing_machines set hourly_rate_pence = hourly_rate_pence * 2, labour_rate_pence = 1"));
    await as(A.office, (db) => db.query("delete from public.costing_materials where id = (select id from public.costing_materials order by id limit 1)"));
    const s1 = await current(orgA);
    expect(await save(A.admin, orgA, s1, { materials: [], machines: [], defaults: DEF })).toEqual({ ok: true });
    expect((await current(orgA)).materials).toEqual([]);
    expect(await save(A.admin, orgA, await current(orgA), { materials: [mat(id(), "Re-entered", 1)], machines: [mac(id(), "Re-entered", 1)], defaults: DEF })).toEqual({ ok: true });
    await as(A.admin, (db) => db.query("delete from public.costing_defaults"));
    await as(A.admin, (db) => db.query("delete from public.costing_machines"));
    await as(A.admin, (db) => db.query("delete from public.costing_materials"));
    expect(await current(orgA)).toEqual(EMPTY);

    expect(await snapshot()).toEqual(before);
  });
});
