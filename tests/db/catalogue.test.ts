/**
 * Migration chain and catalogue checks (audit B1: SEC13, A1 prerequisites).
 *
 * The local stack builds the database from an empty Postgres by applying supabase/migrations in order, so these
 * tests prove the clean chain works and pin the resulting security catalogue (RLS, policies, functions, triggers,
 * grants) to tests/db/catalogue.snapshot.json. supabase/verify/catalogue.sql is the same read-only query a release
 * check runs on a live database. Regenerate the snapshot deliberately with UPDATE_CATALOGUE=1 after a reviewed
 * migration.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";

const ROOT = path.resolve(__dirname, "../..");
const CATALOGUE_SQL = readFileSync(path.join(ROOT, "supabase/verify/catalogue.sql"), "utf8");
const SNAPSHOT = path.join(__dirname, "catalogue.snapshot.json");
const MIGRATIONS_DIR = path.join(ROOT, "supabase/migrations");

/** Policy names the pre-hardening scripts (001, 005, root legacy SQL) create; 006 replaced them. */
const LEGACY_POLICY_NAMES = [
  "customers org isolation",
  "quote_line_items org isolation",
  "quote_attachments org isolation",
  "invoice_line_items org isolation",
  "delivery_note_items org isolation",
];

type Row = { kind: string; object: string; detail: string };

async function catalogue(db: Client): Promise<Row[]> {
  return (await db.query<Row>(CATALOGUE_SQL)).rows;
}

/** Structural rules every hardened database must satisfy, independent of the snapshot. Empty array = all good. */
async function securityViolations(db: Client): Promise<string[]> {
  const problems: string[] = [];
  const noRls = await db.query<{ t: string }>(`
    select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity order by 1`);
  noRls.rows.forEach((r) => problems.push(`RLS disabled: ${r.t}`));
  // Hardened tables use one permissive policy per command (each with its own role check); a permissive FOR ALL
  // policy is the legacy organisation-only shape, and OR-combines with the rest to widen access.
  const forAll = await db.query<{ p: string }>(`
    select tablename || ' :: ' || policyname as p from pg_policies
    where schemaname = 'public' and cmd = 'ALL' and permissive = 'PERMISSIVE' order by 1`);
  forAll.rows.forEach((r) => problems.push(`permissive FOR ALL policy: ${r.p}`));
  const legacy = await db.query<{ p: string }>(
    "select tablename || ' :: ' || policyname as p from pg_policies where schemaname = 'public' and policyname = any($1) order by 1",
    [LEGACY_POLICY_NAMES]);
  legacy.rows.forEach((r) => problems.push(`legacy policy present: ${r.p}`));
  return problems;
}

describe("migration chain and catalogue (isolated database)", () => {
  beforeAll(async () => {
    await verifyBackendIdentity();
  });

  it("applies every file in supabase/migrations, in order, and nothing else", async () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    const expected = files.map((f) => f.split("_")[0]);
    const identity = await verifyBackendIdentity();
    expect(identity.migrations).toEqual(expected);
  });

  it("satisfies the structural security rules (RLS everywhere, no legacy permissive policies)", async () => {
    expect(await withDb(securityViolations)).toEqual([]);
  });

  it("matches the reviewed catalogue snapshot", async () => {
    const rows = await withDb(catalogue);
    if (process.env.UPDATE_CATALOGUE === "1") writeFileSync(SNAPSHOT, `${JSON.stringify(rows, null, 1)}\n`);
    if (!existsSync(SNAPSHOT)) throw new Error("tests/db/catalogue.snapshot.json is missing: run with UPDATE_CATALOGUE=1 and review it");
    const expected: Row[] = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
    const key = (r: Row) => `${r.kind} ${r.object}`;
    const want = new Map(expected.map((r) => [key(r), r.detail]));
    const have = new Map(rows.map((r) => [key(r), r.detail]));
    const missing = [...want.keys()].filter((k) => !have.has(k));
    const extra = [...have.keys()].filter((k) => !want.has(k));
    const changed = [...want.keys()].filter((k) => have.has(k) && have.get(k) !== want.get(k));
    expect({ missing, extra, changed }).toEqual({ missing: [], extra: [], changed: [] });
  });

  it("detects a legacy migration replayed after hardening, and that the replay really widens access", async () => {
    // 001 recreates an organisation-only FOR ALL policy on customers. Replayed inside a transaction that is rolled
    // back, so the disposable database is left as it was.
    const legacy = readFileSync(path.join(MIGRATIONS_DIR, "001_customers_suppliers_quotes.sql"), "utf8");
    await withDb(async (db) => {
      const org = await db.query<{ id: string }>("insert into public.organizations (name, slug) values ('Replay probe', 't-replay-probe') returning id");
      const orgId = org.rows[0].id;
      const user = await db.query<{ id: string }>("insert into auth.users (id, email) values (gen_random_uuid(), 'viewer.replay@example.test') returning id");
      const userId = user.rows[0].id;
      await db.query("begin");
      try {
        await db.query("insert into public.organization_members (user_id, organization_id, role) values ($1, $2, 'viewer')", [userId, orgId]);
        await db.query("insert into public.user_profiles (id, email, role, organization_id) values ($1, 'viewer.replay@example.test', 'viewer', $2) on conflict (id) do update set role = 'viewer', organization_id = $2", [userId, orgId]);

        const asViewerInsert = async () => {
          await db.query("savepoint probe");
          await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)",
            [JSON.stringify({ sub: userId, role: "authenticated" }), userId]);
          await db.query("set local role authenticated");
          try {
            await db.query("insert into public.customers (organization_id, name) values ($1, 'Viewer wrote this')", [orgId]);
            return "allowed";
          } catch {
            return "refused";
          } finally {
            await db.query("rollback to savepoint probe");
            await db.query("reset role");
          }
        };

        expect(await asViewerInsert()).toBe("refused");
        await db.query(legacy);
        const problems = await securityViolations(db);
        expect(problems).toContain("permissive FOR ALL policy: customers :: customers org isolation");
        expect(problems).toContain("legacy policy present: customers :: customers org isolation");
        expect(await asViewerInsert()).toBe("allowed");
      } finally {
        await db.query("rollback");
        await db.query("delete from public.organizations where id = $1", [orgId]);
        await db.query("delete from auth.users where id = $1", [userId]);
      }
    });
    expect(await withDb(securityViolations)).toEqual([]);
  });
});
