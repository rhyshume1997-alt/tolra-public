/**
 * The audit chain's previous-hash lookup served by an index (migration 077). security_audit.set_audit_hash still takes 006's company
 * lock, picks 006's previous row and writes 006's hash; it only reads that row through audit_log_org_created_idx instead of scanning
 * and sorting the whole log.
 *
 *   * index-served: each audit row's lookup is one scan of audit_log_org_created_idx (no sequential scan of audit_log), for a company
 *     and for the NULL chain; the plan has an Index Cond on organization_id and no Sort;
 *   * the same previous row as 006, ties included: 006's own lookup, re-run on every row in a second trigger, agrees, also when several
 *     rows share the latest created_at (the lowest ctid wins under both);
 *   * the same lock: a second writer of the company waits on the advisory lock the first holds (also on 050's time_company_lock, the
 *     same key), then chains to the first's row once it commits;
 *   * a rolled-back transaction or savepoint leaves no gap: the next row chains to the last committed (or kept) row;
 *   * existing rows untouched (ctid, xmin, hash); the whole chain of each company still verifies (links and hashes).
 */
import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
const alpha = () => world.tenants.alpha.id;
const beta = () => world.tenants.beta.id;

beforeAll(async () => { await verifyBackendIdentity(); world = await createSyntheticWorld(); });
afterAll(async () => { if (world) await destroySyntheticWorld(world.runId); });

/** One audit row written straight into the log (the chain trigger fills previous_hash, hash and created_at). */
async function write(db: Client, org: string | null, action = "AUDIT_077_TEST") {
  return (await db.query<{ id: string; previous_hash: string | null; hash: string }>(
    `insert into security_audit.audit_log (organization_id, action, entity_table, entity_id, new_data)
     values ($1, $2, 'audit_chain_077', gen_random_uuid()::text, jsonb_build_object('n', clock_timestamp()::text))
     returning id, previous_hash, hash`, [org, action])).rows[0];
}
/** 006's lookup, verbatim: the hash of the company's latest row (organization_id IS NOT DISTINCT FROM, ORDER BY created_at DESC). */
async function head006(db: Client, org: string | null) {
  return (await db.query<{ hash: string | null }>(
    "select (select hash from security_audit.audit_log where organization_id is not distinct from $1::uuid order by created_at desc limit 1) as hash", [org])).rows[0].hash;
}
/** Runs `fn` in a transaction that is always rolled back. */
async function rolledBack<T>(fn: (db: Client) => Promise<T>) {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      return await fn(db);
    } finally {
      await db.query("rollback");
    }
  });
}

/** 006's lookup re-run on every row, after set_audit_hash (trigger name order): the insert fails if the two disagree. In-transaction only. */
const ORACLE = `
  create function pg_temp.audit_chain_077_oracle() returns trigger language plpgsql as $$
  declare previous text;
  begin
    select hash into previous from security_audit.audit_log
    where organization_id is not distinct from NEW.organization_id order by created_at desc limit 1;
    if previous is distinct from NEW.previous_hash then
      raise exception 'oracle: 006 would chain to %, 077 chained to %', previous, NEW.previous_hash;
    end if;
    return NEW;
  end $$;
  create trigger audit_log_set_hash_zz_077_oracle before insert on security_audit.audit_log
    for each row execute function pg_temp.audit_chain_077_oracle();`;

describe("077: the previous-hash lookup is served by audit_log_org_created_idx", () => {
  it("the installed function has the two indexable lookups, 006's lock first and 006's hash text", async () => {
    const body = await withDb(async (db) => (await db.query<{ b: string }>(
      "select regexp_replace(prosrc, '\\s', '', 'g') as b from pg_proc where oid = 'security_audit.set_audit_hash()'::regprocedure")).rows[0].b);
    expect(body).toContain("WHEREorganization_idISNULLORDERBYorganization_id,created_atDESCLIMIT1;");
    expect(body).toContain("WHEREorganization_id=NEW.organization_idORDERBYorganization_id,created_atDESCLIMIT1;");
    expect(body).not.toContain("WHEREorganization_idISNOTDISTINCTFROM");
    expect(body).toMatch(/^DECLAREpreviousTEXT;BEGINPERFORMpg_advisory_xact_lock\(hashtext\(coalesce\(NEW\.organization_id::TEXT,''\)\)\);NEW\.created_at:=clock_timestamp\(\);/);
    expect(body).toContain("NEW.hash:=encode(digest(coalesce(previous,'')||coalesce(NEW.organization_id::TEXT,'')||coalesce(NEW.actor_user_id::TEXT,'')||NEW.action||NEW.entity_table||coalesce(NEW.entity_id,'')||coalesce(NEW.old_data::TEXT,'')||coalesce(NEW.new_data::TEXT,'')||coalesce(NEW.metadata::TEXT,'')||NEW.created_at::TEXT,'sha256'),'hex');RETURNNEW;END;");
  });

  it("each audit row is one index scan, never a sequential scan of the log (a company and the NULL chain)", async () => {
    const counts = await rolledBack(async (db) => {
      // A small test log could make a sequential scan the cheaper plan; this pins the planner to what it does on a real log.
      await db.query("set local enable_seqscan = off");
      const scans = async () => (await db.query<{ seq: string; idx: string }>(
        `select pg_stat_get_xact_numscans('security_audit.audit_log'::regclass) as seq,
                pg_stat_get_xact_numscans('security_audit.audit_log_org_created_idx'::regclass) as idx`)).rows[0];
      const before = await scans();
      for (let i = 0; i < 4; i += 1) await write(db, alpha());
      for (let i = 0; i < 3; i += 1) await write(db, null);
      const after = await scans();
      return { seq: Number(after.seq) - Number(before.seq), idx: Number(after.idx) - Number(before.idx) };
    });
    expect(counts).toEqual({ seq: 0, idx: 7 });
  });

  it("the plans: an Index Cond on organization_id (= the company, or IS NULL), no Sort", async () => {
    const plans = await rolledBack(async (db) => {
      await db.query("set local enable_seqscan = off");
      const plan = async (text: string) => JSON.stringify((await db.query(`explain (format json, costs off) ${text}`)).rows[0]["QUERY PLAN"]);
      return {
        company: await plan(`select hash from security_audit.audit_log where organization_id = '${alpha()}' order by organization_id, created_at desc limit 1`),
        none: await plan("select hash from security_audit.audit_log where organization_id is null order by organization_id, created_at desc limit 1"),
      };
    });
    for (const p of [plans.company, plans.none]) {
      expect(p).toContain('"Index Name":"audit_log_org_created_idx"');
      expect(p).toContain('"Scan Direction":"Forward"');
      expect(p).not.toContain('"Node Type":"Sort"');
    }
    expect(plans.company).toContain(`"Index Cond":"(organization_id = '${alpha()}'::uuid)"`);
    expect(plans.none).toContain('"Index Cond":"(organization_id IS NULL)"');
  });
});

describe("077: the same previous row as 006, ties included", () => {
  it("006's own lookup agrees on every row: two companies, the NULL chain, several rows in one statement", async () => {
    const n = await rolledBack(async (db) => {
      await db.query(ORACLE);
      for (const org of [alpha(), beta(), null, alpha(), alpha(), beta(), null]) await write(db, org, "AUDIT_077_ORACLE");
      await db.query(
        `insert into security_audit.audit_log (organization_id, action, entity_table)
         select case g % 3 when 0 then $1::uuid when 1 then $2::uuid end, 'AUDIT_077_ORACLE', 'audit_chain_077' from generate_series(1, 12) g`, [alpha(), beta()]);
      return Number((await db.query("select count(*) as c from security_audit.audit_log where action = 'AUDIT_077_ORACLE'")).rows[0].c);
    });
    expect(n).toBe(19);
  });

  it("several rows with the same latest created_at: both pick the lowest ctid (here not the first inserted)", async () => {
    const out = await rolledBack(async (db) => {
      await db.query(ORACLE);
      await db.query("set local session_replication_role = replica");
      // Three tied rows per chain (written without the chain trigger, as no real row could be); the third goes into the free space a
      // dead row leaves on an earlier page only if there is one, so compare against the lowest ctid, whatever it is.
      for (const tie of ["tie-1", "tie-2", "tie-3"]) {
        for (const org of [alpha(), null]) {
          await db.query(
            `insert into security_audit.audit_log (organization_id, action, entity_table, created_at, hash)
             values ($1, 'AUDIT_077_TIE', 'audit_chain_077', '2999-01-01 00:00:00+00', $2)`, [org, `${tie}-${org ?? "null"}`]);
        }
      }
      await db.query("set local session_replication_role = origin");
      const lowest = async (org: string | null) => (await db.query<{ hash: string }>(
        `select hash from security_audit.audit_log where action = 'AUDIT_077_TIE' and organization_id is not distinct from $1::uuid order by ctid limit 1`, [org])).rows[0].hash;
      return {
        alpha: { chained: (await write(db, alpha())).previous_hash, lowest: await lowest(alpha()), by006: await head006(db, alpha()) },
        none: { chained: (await write(db, null)).previous_hash, lowest: await lowest(null), by006: await head006(db, null) },
      };
    });
    for (const chain of [out.alpha, out.none]) {
      expect(chain.chained).toBe(chain.lowest);
      expect(chain.by006).toBe(chain.lowest);
    }
  });
});

describe("077: the same company lock; rollbacks leave no gap", () => {
  it("a second writer of the company waits on the first one's advisory lock (and on 050's time_company_lock), then chains to its row", async () => {
    await withDb(async (a) => withDb(async (b) => withDb(async (watch) => {
      const waiting = async (pid: number) => {
        for (let i = 0; i < 100; i += 1) {
          const r = (await watch.query<{ w: string | null }>("select wait_event_type || ':' || wait_event as w from pg_stat_activity where pid = $1", [pid])).rows[0];
          if (r?.w === "Lock:advisory") return true;
          await new Promise((res) => setTimeout(res, 20));
        }
        return false;
      };
      const bPid = (await b.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;
      const aPid = (await a.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0].pid;

      // 1. a writes a row and holds the lock; b's row for the same company waits, then chains to a's row once a commits.
      await a.query("begin");
      const first = await write(a, alpha());
      await b.query("begin");
      const second = write(b, alpha());
      expect(await waiting(bPid)).toBe(true);
      const blockers = (await watch.query<{ p: number[] }>("select pg_blocking_pids($1) as p", [bPid])).rows[0].p;
      expect(blockers).toEqual([aPid]);
      await a.query("commit");
      expect((await second).previous_hash).toBe(first.hash);
      await b.query("commit");

      // 2. 050's time_company_lock (the same key) held by a: b's audit row for that company waits too.
      const lockFn = (await watch.query<{ v: boolean }>("select to_regprocedure('public.time_company_lock(uuid)') is not null as v")).rows[0].v;
      if (lockFn) {
        await a.query("begin");
        await a.query("select public.time_company_lock($1)", [alpha()]);
        await b.query("begin");
        const third = write(b, alpha());
        expect(await waiting(bPid)).toBe(true);
        await a.query("rollback");
        expect((await third).previous_hash).toBe((await second).hash);
        await b.query("rollback");
      }

      // 3. A rolled-back writer leaves no gap: b, waiting behind it, chains to the last committed row.
      await a.query("begin");
      await write(a, alpha());
      await b.query("begin");
      const fourth = write(b, alpha());
      expect(await waiting(bPid)).toBe(true);
      await a.query("rollback");
      expect((await fourth).previous_hash).toBe((await second).hash);
      await b.query("commit");
    })));
  });

  it("a savepoint rolled back inside a transaction leaves no gap either", async () => {
    const out = await rolledBack(async (db) => {
      const kept = await write(db, beta());
      await db.query("savepoint s");
      await write(db, beta());
      await write(db, beta());
      await db.query("rollback to savepoint s");
      const next = await write(db, beta());
      return { kept: kept.hash, next: next.previous_hash };
    });
    expect(out.next).toBe(out.kept);
  });

  it("existing rows are never touched, and each company's whole chain verifies (links and hashes)", async () => {
    const rowsOf = (db: Client) => db.query<{ r: string }>(
      "select ctid::text || ' ' || xmin::text || ' ' || id::text || ' ' || hash as r from security_audit.audit_log where organization_id = any($1::uuid[])",
      [[alpha(), beta()]]).then((r) => r.rows.map((x) => x.r));
    const before = await withDb(rowsOf);
    await withDb(async (db) => {
      await write(db, alpha());
      await write(db, beta());
    });
    const after = new Set(await withDb(rowsOf));
    expect(before.length).toBeGreaterThan(0);
    expect(before.filter((r) => !after.has(r))).toEqual([]);
    expect(after.size).toBe(before.length + 2);
    const result = await rolledBack(async (db) => {
      // set_audit_hash hashes created_at::text; the stack runs in UTC.
      await db.query("set local timezone to 'UTC'");
      return (await db.query<{ org: string; total: number; broken_links: number; bad_hashes: number }>(`
        with r as (
          select a.*, lag(a.hash) over (partition by a.organization_id order by a.created_at) as expected_previous
          from security_audit.audit_log a where a.organization_id = any($1::uuid[]))
        select organization_id::text as org, count(*)::int as total,
               count(*) filter (where previous_hash is distinct from expected_previous)::int as broken_links,
               count(*) filter (where hash is distinct from encode(extensions.digest(
                 coalesce(previous_hash, '') || coalesce(organization_id::text, '') || coalesce(actor_user_id::text, '') || action || entity_table ||
                 coalesce(entity_id, '') || coalesce(old_data::text, '') || coalesce(new_data::text, '') || coalesce(metadata::text, '') || created_at::text,
                 'sha256'), 'hex'))::int as bad_hashes
        from r group by organization_id order by 1`, [[alpha(), beta()]])).rows;
    });
    expect(result).toHaveLength(2);
    for (const r of result) expect(r, r.org).toMatchObject({ broken_links: 0, bad_hashes: 0 });
    expect(result.every((r) => r.total >= 2)).toBe(true);
  });
});
