/**
 * AI allowance release (supabase/release/162_ai_allowance.release.sql, canonical source supabase/proposals/p162_ai_allowance.sql): a per-company
 * monthly AI request allowance by tier. The DB proof, below PostgREST, one `it` per case.
 *
 * Inputs: the disposable stack only (TEST_DATABASE_URL, isolation-checked). The post-144 fixture installs 145..160; this file then installs
 * it itself (its release file is safe to run again). Companies are synthetic (slug t-<run>-...) and removed afterwards. Plain SQL with forged
 * session claims (no Auth API), each call one transaction with role authenticated, as PostgREST runs it. Requests are seeded straight into
 * ai_helper_requests as the table owner. The only stored "key" is a synthetic placeholder string in a disposable database: no provider is
 * ever called, no flag or setting outside the synthetic companies is touched, AI stays off in the app.
 * Proves: the tier column (nullable, CHECK, no browser write); the function's catalogue (definer, search_path, authenticated only) and that
 * 150's two reserve bodies are untouched; small 100, medium 400, large 1500 (the last allowed, the next refused with the numbers); unknown,
 * missing, differently cased tier means no allowance and writes nothing; refused rows never count; the UTC month (a row one second before
 * the month does not count, a row at its first instant does, the next month does not); another company's usage never counts; the existing
 * pence cap still decides every allowed call and a company without a tier is untouched by ai_helper_reserve; roles; feature check;
 * the assistant route; the release (guard refusal, fingerprint self-check, repeat install); rollback text and re-release; a race on two real
 * connections (the second seen waiting on the lock, exactly one wins the last request).
 * Not proved here: PostgREST's own error mapping, hosted grants, any app caller (there is none yet).
 * Must not change: this file proves; it never edits a release, proposal or rollback file to make itself pass.
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
const RELEASE = "supabase/release/162_ai_allowance.release.sql";
const PROPOSAL = "supabase/proposals/p162_ai_allowance.sql";
const FN = "public.ai_helper_reserve_allowance(text,integer,text,integer)";
const RESERVE_MD5 = "48b3f8302686bc6310402b117ea09ad5";
const ASSISTANT_MD5 = "3c415227fefdeda349442ff870a88e64";
const DIGEST = "a".repeat(64);
const TIERS: [string, number][] = [["small", 100], ["medium", 400], ["large", 1500]];

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
/** A release file without its own BEGIN / COMMIT, to run inside a test transaction. */
function body(file: string) {
  const s = read(file);
  expect(s.match(/^BEGIN;$/gm), file).toHaveLength(1);
  expect(s.match(/^COMMIT;$/gm), file).toHaveLength(1);
  return s.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, "");
}

// ---- Synthetic companies and people ----------------------------------------------------------------------------------------------
async function makeOrg(label: string, tier: string | null) {
  const id = randomUUID();
  seq += 1;
  await q("insert into public.organizations (id, name, slug, status, ai_allowance_tier) values ($1, $2, $3, 'active', $4)", [id, `ai-allowance ${label} ${runId}`, `${SYNTHETIC_SLUG_PREFIX}${runId}-161-${label}-${seq}`, tier]);
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
/** A company with an admin, the helper switched on (roundup and assistant), a synthetic placeholder in the key slot and the given pence cap. */
async function company(label: string, tier: string | null, capPence = 1000) {
  const org = await makeOrg(label, tier);
  const admin = await makePerson(org, `${label}-admin`, "admin");
  await q("insert into public.ai_helper_settings (organization_id, roundup_enabled, rfq_enabled, assistant_enabled, monthly_cap_pence) values ($1, true, true, true, $2)", [org, capPence]);
  await q("insert into public.ai_helper_secrets (organization_id, api_key_enc) values ($1, 'v1.synthetic.placeholder.notakey')", [org]);
  return { org, admin };
}
/** Requests straight into the ledger as the table owner. `at` is a SQL timestamptz expression. */
async function seed(org: string, n: number, status: string, at = "now()") {
  if (n <= 0) return;
  await q(`insert into public.ai_helper_requests (organization_id, user_id, feature, month, status, refusal, input_digest, input_bytes, created_at)
           select $1, $2, 'roundup', date_trunc('month', now() at time zone 'Europe/London')::date, $3, case when $3 = 'refused' then 'cap' end, $4, 0, ${at}
           from generate_series(1, $5)`, [org, randomUUID(), status, DIGEST, n]);
}
const MONTH_START = "(date_trunc('month', now() at time zone 'utc') at time zone 'utc')";
const countOf = async (org: string, extra = "") => Number((await q<{ n: string }>(`select count(*) as n from public.ai_helper_requests where organization_id = $1 ${extra}`, [org]))[0].n);

/** One API request: its own transaction, as role authenticated (the person's claims) or as anon, as PostgREST runs it. */
async function as<T>(p: Person | "anon", fn: (db: PoolClient) => Promise<T>, db0?: PoolClient): Promise<T> {
  const db = db0 ?? await pool.connect();
  try {
    if (!db0) await db.query("begin");
    if (p === "anon") {
      await db.query("set local role anon");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "anon" })]);
    } else {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
        [JSON.stringify({ sub: p.id, role: "authenticated", aud: "authenticated", aal: "aal2", email: p.email, session_id: p.session }), p.id]);
    }
    const result = await fn(db);
    if (!db0) await db.query("commit");
    return result;
  } catch (error) {
    if (!db0) await db.query("rollback").catch(() => undefined);
    throw error;
  } finally { if (!db0) db.release(); }
}
async function call(p: Person | "anon", text: string, params: unknown[] = []): Promise<Answer> {
  try {
    const value = await as(p, async (db) => (await db.query<{ v: Row | null }>(`select ${text} as v`, params)).rows[0]?.v ?? null);
    return { ok: true, value };
  } catch (error) {
    const e = error as { code?: string; hint?: string; message?: string };
    return { ok: false, code: e.code ?? "error", hint: e.hint, message: e.message };
  }
}
const allow = (p: Person | "anon", feature = "roundup", pence = 5) => call(p, "public.ai_helper_reserve_allowance($1, $2, $3, $4)", [feature, pence, DIGEST, 10]);
const plain = (p: Person, feature = "roundup", pence = 5) => call(p, "public.ai_helper_reserve($1, $2, $3, $4)", [feature, pence, DIGEST, 10]);
const value = (a: Answer) => { if (!a.ok) throw new Error(`expected an answer, got ${a.code}: ${a.message}`); return a.value as Row; };

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb((db) => preparePost144Fixture({ verify: verifyBackendIdentity, query: (sql) => db.query(sql) }));
  pool = new Pool({ connectionString: isolatedBackend().databaseUrl, max: 8 });
  // The release is installed by its own release file (safe to run twice). Disposable database only.
  const db = await pool.connect();
  try { await db.query(read(RELEASE)); } finally { db.release(); }
});

afterAll(async () => {
  if (pool) {
    const ids = people.map((p) => p.id);
    const db = await pool.connect();
    try {
      await db.query("begin");
      await db.query("set local session_replication_role = replica");
      for (const t of ["public.ai_helper_requests", "public.ai_helper_usage", "public.ai_helper_settings", "public.ai_helper_secrets", "security_audit.audit_log", "public.organization_members", "public.user_profiles"]) {
        await db.query(`delete from ${t} where organization_id = any($1)`, [orgs]);
      }
      await db.query("delete from security_audit.session_company where user_id = any($1)", [ids]);
      await db.query("delete from public.organizations where id = any($1)", [orgs]);
      await db.query("commit");
      await db.query("delete from auth.users where id = any($1)", [ids]);
    } catch (e) { await db.query("rollback").catch(() => undefined); throw e; } finally { db.release(); }
    await pool.end();
  }
});

describe("AI allowance release: monthly AI request allowance by company tier", () => {
  it("1. the proposal's body is inside the release verbatim, and neither file carries a key", () => {
    const proposal = read(PROPOSAL).match(/^BEGIN;\n([\s\S]*)^COMMIT;\n/m)?.[1].trim();
    expect(proposal && proposal.length).toBeGreaterThan(500);
    expect(read(RELEASE)).toContain(proposal as string);
    for (const f of [PROPOSAL, RELEASE]) expect(read(f)).not.toMatch(/api[_-]?key\s*[:=]\s*'[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{10,}/);
  });

  it("2. the tier column is nullable text with no default and a small/medium/large CHECK; a browser role cannot write it", async () => {
    const [col] = await q<{ data_type: string; is_nullable: string; column_default: string | null }>("select data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'ai_allowance_tier'");
    expect(col).toEqual({ data_type: "text", is_nullable: "YES", column_default: null });
    const c = await company("col", null);
    const bad = await rolledBack(async (db) => { try { await db.query("update public.organizations set ai_allowance_tier = 'huge' where id = $1", [c.org]); return null; } catch (e) { return (e as { code: string }).code; } });
    expect(bad).toBe("23514");
    // A signed-in admin can still rename their company, but cannot choose their own tier (authenticated has UPDATE on name and updated_at only).
    const rename = await as(c.admin, async (db) => (await db.query("update public.organizations set name = name || '.' where id = $1", [c.org])).rowCount);
    expect(rename).toBe(1);
    for (const tier of ["small", "large", null]) {
      const r = await as(c.admin, async (db) => { try { await db.query("update public.organizations set ai_allowance_tier = $2 where id = $1", [c.org, tier]); return "updated"; } catch (e) { return (e as { code: string }).code; } });
      expect(r).toBe("42501");
    }
    expect((await q<{ t: string | null }>("select ai_allowance_tier as t from public.organizations where id = $1", [c.org]))[0].t).toBeNull();
    const readOwn = await as(c.admin, async (db) => (await db.query<{ t: string | null }>("select ai_allowance_tier as t from public.organizations where id = $1", [c.org])).rows);
    expect(readOwn).toEqual([{ t: null }]);
  });

  it("3. the function is SECURITY DEFINER with search_path pg_catalog, public, executable by authenticated only; 150's reserve bodies are untouched", async () => {
    const [fn] = await q<{ definer: boolean; cfg: string[]; auth: boolean; anon: boolean; pub: boolean }>(
      `select p.prosecdef as definer, p.proconfig as cfg, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth, has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('public', p.oid, 'EXECUTE') as pub from pg_proc p where p.oid = to_regprocedure($1)`, [FN]);
    expect(fn).toMatchObject({ definer: true, cfg: ["search_path=pg_catalog, public"], auth: true, anon: false, pub: false });
    const md5s = await q<{ m: string }>(`select md5(regexp_replace(prosrc, '\\s', '', 'g')) as m from pg_proc where oid in (to_regprocedure('public.ai_helper_reserve(text,integer,text,integer)'), to_regprocedure('public.ai_helper_reserve_assistant(integer,text,integer)')) order by 1`);
    expect(md5s.map((r) => r.m).sort()).toEqual([ASSISTANT_MD5, RESERVE_MD5].sort());
  });

  for (const [tier, limit] of TIERS) {
    it(`4. ${tier}: ${limit} requests a month: the last one is allowed and reserved, the next is refused with the numbers and writes nothing`, async () => {
      const c = await company(`t-${tier}`, tier);
      await seed(c.org, limit - 1, "suggested");
      const last = value(await allow(c.admin));
      expect(last.ok).toBe(true);
      expect(typeof last.request_id).toBe("string");
      expect(await countOf(c.org, "and status <> 'refused'")).toBe(limit);
      const rows = await countOf(c.org);
      const over = value(await allow(c.admin));
      expect(over).toMatchObject({ ok: false, reason: "allowance", limit, used: limit });
      expect(over.period).toMatch(/^\d{4}-\d{2}$/);
      expect(await countOf(c.org)).toBe(rows);
      const [{ ym }] = await q<{ ym: string }>("select to_char(now() at time zone 'utc', 'YYYY-MM') as ym");
      expect(over.period).toBe(ym);
    });
  }

  it("5. no tier, or a tier that is not small, medium or large, means no allowance: refused as no_allowance, nothing reserved, nothing written", async () => {
    const c = await company("none", null);
    const before = await countOf(c.org);
    expect(value(await allow(c.admin))).toMatchObject({ ok: false, reason: "no_allowance" });
    expect(await countOf(c.org)).toBe(before);
    // The CHECK cannot store these, so the proof drops it inside a rolled-back transaction: the function itself must still fail closed.
    for (const odd of ["enterprise", "SMALL", "Small ", "", "0", "1500"]) {
      const got = await rolledBack(async (db) => {
        await db.query("alter table public.organizations drop constraint organizations_ai_allowance_tier_check");
        await db.query("update public.organizations set ai_allowance_tier = $2 where id = $1", [c.org, odd]);
        return as(c.admin, async (d) => (await d.query<{ v: Row }>("select public.ai_helper_reserve_allowance('roundup', 5, $1, 10) as v", [DIGEST])).rows[0].v, db);
      });
      expect(got, odd).toMatchObject({ ok: false, reason: "no_allowance" });
    }
    expect(await countOf(c.org)).toBe(before);
  });

  it("6. refused rows never count: a full month of refusals still leaves the whole allowance", async () => {
    const c = await company("refused", "small");
    await seed(c.org, 150, "refused");
    expect(value(await allow(c.admin)).ok).toBe(true);
    for (const status of ["reserved", "expired", "suggested", "failed", "approved", "rejected"]) {
      const d = await company(`st-${status}`, "small");
      await seed(d.org, 100, status);
      expect(value(await allow(d.admin)), status).toMatchObject({ ok: false, reason: "allowance", used: 100 });
    }
  });

  it("7. the month is the UTC calendar month: its first instant counts, one second before it and the next month do not", async () => {
    const atStart = await company("utc-start", "small");
    await seed(atStart.org, 100, "suggested", MONTH_START);
    expect(value(await allow(atStart.admin))).toMatchObject({ ok: false, reason: "allowance", used: 100 });
    const lastMonth = await company("utc-prev", "small");
    await seed(lastMonth.org, 100, "suggested", `${MONTH_START} - interval '1 second'`);
    expect(value(await allow(lastMonth.admin)).ok).toBe(true);
    const nextMonth = await company("utc-next", "small");
    await seed(nextMonth.org, 100, "suggested", `${MONTH_START} + interval '1 month'`);
    expect(value(await allow(nextMonth.admin)).ok).toBe(true);
    // Not the London month the pence cap uses: these rows carry this month's London `month` value but were created before this UTC month.
    const london = await company("utc-london", "small");
    await seed(london.org, 100, "suggested", `${MONTH_START} - interval '1 minute'`);
    expect((await q<{ n: string }>("select count(*) as n from public.ai_helper_requests where organization_id = $1 and month = date_trunc('month', now() at time zone 'Europe/London')::date", [london.org]))[0].n).toBe("100");
    expect(value(await allow(london.admin)).ok).toBe(true);
  });

  it("8. another company's requests never count against mine", async () => {
    const a = await company("iso-a", "small");
    const b = await company("iso-b", "small");
    await seed(a.org, 100, "suggested");
    expect(value(await allow(a.admin))).toMatchObject({ ok: false, reason: "allowance" });
    expect(value(await allow(b.admin)).ok).toBe(true);
  });

  it("9. the pence cap still decides every allowed call; a company without a tier keeps today's behaviour through ai_helper_reserve", async () => {
    const tight = await company("cap", "large", 1);
    const capped = value(await allow(tight.admin, "roundup", 5));
    expect(capped).toMatchObject({ ok: false, reason: "cap" });
    expect(await countOf(tight.org, "and status = 'refused' and refusal = 'cap'")).toBe(1);
    expect(await countOf(tight.org, "and status <> 'refused'")).toBe(0);
    expect(value(await allow(tight.admin, "roundup", 5))).toMatchObject({ ok: false, reason: "cap" });
    const untiered = await company("untiered", null);
    expect(value(await plain(untiered.admin)).ok).toBe(true);
    expect(value(await allow(untiered.admin))).toMatchObject({ ok: false, reason: "no_allowance" });
    expect(await countOf(untiered.org, "and status <> 'refused'")).toBe(1);
  });

  it("10. the assistant feature takes the assistant reserver; rfq takes the other; an unknown feature is refused 22023 before anything is read", async () => {
    const c = await company("features", "medium");
    expect(value(await allow(c.admin, "assistant")).ok).toBe(true);
    expect(value(await allow(c.admin, "rfq")).ok).toBe(true);
    expect(await countOf(c.org, "and feature = 'assistant' and status = 'reserved'")).toBe(1);
    expect(await countOf(c.org, "and feature = 'rfq' and status = 'reserved'")).toBe(1);
    const off = await company("assistant-off", "medium");
    await q("update public.ai_helper_settings set assistant_enabled = false where organization_id = $1", [off.org]);
    const r = await allow(off.admin, "assistant");
    expect(r).toMatchObject({ ok: false, code: "42501", hint: "ai_helper_off" });
    for (const bad of ["finance", "", "ROUNDUP"]) expect(await allow(c.admin, bad), bad).toMatchObject({ ok: false, code: "22023" });
    expect(await call(c.admin, "public.ai_helper_reserve_allowance(NULL, 5, $1, 10)", [DIGEST])).toMatchObject({ ok: false, code: "22023" });
  });

  it("11. roles: viewer and workshop are refused 42501; office and admin are allowed; anon has no EXECUTE", async () => {
    const c = await company("roles", "small");
    const viewer = await makePerson(c.org, "roles-viewer", "viewer");
    const workshop = await makePerson(c.org, "roles-workshop", "workshop");
    const office = await makePerson(c.org, "roles-office", "office");
    expect(await allow(viewer)).toMatchObject({ ok: false, code: "42501" });
    expect(await allow(workshop)).toMatchObject({ ok: false, code: "42501" });
    expect(value(await allow(office)).ok).toBe(true);
    expect(value(await allow(c.admin)).ok).toBe(true);
    expect(await allow("anon")).toMatchObject({ ok: false, code: "42501" });
  });

  it("12. the release re-runs as a no-op, refuses when a 150 reserve body is not 150's, and its self-check holds", async () => {
    const before = await q<{ d: string }>("select pg_get_functiondef(to_regprocedure($1)) as d", [FN]);
    await rolledBack(async (db) => {
      await db.query(body(RELEASE));
      const after = await db.query<{ d: string }>("select pg_get_functiondef(to_regprocedure($1)) as d", [FN]);
      expect(after.rows).toEqual(before);
    });
    await rolledBack(async (db) => {
      await db.query("create or replace function public.ai_helper_reserve(p_feature text, p_estimate_pence integer, p_input_digest text, p_input_bytes integer) returns jsonb language sql as $$ select '{}'::jsonb $$");
      await expect(db.query(body(RELEASE))).rejects.toThrow(/ai_allowance: ai_helper_reserve or ai_helper_reserve_assistant is not release 150's body/);
    });
    await rolledBack(async (db) => {
      await db.query("grant update (require_admin_mfa) on public.organizations to authenticated");
      await expect(db.query(body(RELEASE))).rejects.toThrow(/ai_allowance: a browser role can already update an organizations column/);
    });
    await rolledBack(async (db) => {
      await db.query("grant update (ai_allowance_tier) on public.organizations to authenticated");
      await expect(db.query(body(RELEASE))).rejects.toThrow(/ai_allowance/);
    });
  });

  it("13. rollback text (drop the function, then the column) leaves nothing behind, and the release installs again", async () => {
    await rolledBack(async (db) => {
      await db.query("drop function public.ai_helper_reserve_allowance(text,integer,text,integer)");
      await db.query("alter table public.organizations drop column ai_allowance_tier");
      const gone = await db.query<{ f: string | null; c: number }>("select to_regprocedure($1)::text as f, (select count(*)::int from information_schema.columns where table_name = 'organizations' and column_name = 'ai_allowance_tier') as c", [FN]);
      expect(gone.rows[0]).toEqual({ f: null, c: 0 });
      await db.query(body(RELEASE));
      const back = await db.query<{ f: string | null; c: number }>("select to_regprocedure($1)::text as f, (select count(*)::int from information_schema.columns where table_name = 'organizations' and column_name = 'ai_allowance_tier') as c", [FN]);
      expect(back.rows[0].c).toBe(1);
      expect(back.rows[0].f).not.toBeNull();
    });
  });

  it("14. a race on two real connections: the second waits on the lock, and exactly one wins the last request of the month", async () => {
    const c = await company("race", "small");
    await seed(c.org, 99, "suggested");
    const first = await pool.connect();
    try {
      await first.query("begin");
      await as(c.admin, async (db) => {
        const r = (await db.query<{ v: Row }>("select public.ai_helper_reserve_allowance('roundup', 5, $1, 10) as v", [DIGEST])).rows[0].v;
        expect(r.ok).toBe(true);
      }, first);
      // The first transaction is still open and holds the company-month lock. The second call must queue behind it.
      const second = call(c.admin, "public.ai_helper_reserve_allowance('roundup', 5, $1, 10)", [DIGEST]);
      let waiting = false;
      for (let i = 0; i < 100 && !waiting; i++) {
        waiting = (await q<{ n: string }>("select count(*) as n from pg_stat_activity where wait_event_type = 'Lock' and wait_event = 'advisory' and query like '%ai_helper_reserve_allowance%'"))[0].n !== "0";
        if (!waiting) await new Promise((r) => setTimeout(r, 50));
      }
      expect(waiting).toBe(true);
      await first.query("commit");
      expect(value(await second)).toMatchObject({ ok: false, reason: "allowance", limit: 100, used: 100 });
    } finally {
      await first.query("rollback").catch(() => undefined);
      first.release();
    }
    expect(await countOf(c.org, "and status <> 'refused'")).toBe(100);
  });
});
