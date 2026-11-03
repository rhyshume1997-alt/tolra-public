/**
 * Costing rates inside Tolra (migration 143: costing_materials, costing_machines, costing_defaults). Runs the SQL proof
 * tests/scripts/costing-rates-143.proof.sql (one transaction it rolls back itself): admin and office of the company read and write its
 * rates, stamped by the database; workshop and viewer read and change nothing; another company sees and changes none; anon has no
 * access; every CHECK (whole pence 0 to 10,000,000, percentages in range, kg or each, one-line names of 1 to 80, one name per company
 * ignoring case and spaces, one defaults row) and the audit trail. Then, each inside a transaction that is rolled back: the verify script
 * (every row TRUE); preflight marker 143 applied, and "not applied" when the stamp function's body is not 143's or a table is missing
 * (the negative test); the file runs again cleanly and its guard refuses a stamp function with another body; the rollback removes it all.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const PROOF = read("tests/scripts/costing-rates-143.proof.sql");
/** The proof without psql's meta-commands (\set, \o, \echo): plain SQL, BEGIN ... ROLLBACK. */
const SQL = PROOF.split("\n").filter((line) => !line.startsWith("\\")).join("\n");
/** One PASS per check: each SELECT of pg_temp.ok / pg_temp.expect_refused (not their definitions or grants). */
const CHECKS = (PROOF.match(/(SELECT|PERFORM) pg_temp\.(ok|expect_refused)\(/g) ?? []).length;
const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");
const MD5_143 = "7e262df9f33ad0ece30d5ac7122995f3";
const SIG = "public.costing_rates_stamp()";

/** fn inside one transaction that is always rolled back. */
async function rolledBack<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      return await fn(db);
    } finally {
      await db.query("rollback");
    }
  });
}

const marker143 = async (db: Client) =>
  (await db.query<{ check: string; value: string }>(read("supabase/verify/release_preflight.sql"))).rows.find((r) => r.check.startsWith("marker 143 "))?.value;

/** Replaces costing_rates_stamp with its own text plus a harmless comment after its first BEGIN: same behaviour, an unknown body. */
const alterStamp = (db: Client) =>
  db.query(`do $d$ begin execute regexp_replace(pg_get_functiondef(to_regprocedure('${SIG}')), E'\\nBEGIN\\n', E'\\nBEGIN\\n  -- an unknown version\\n'); end $d$`);

beforeAll(async () => {
  await verifyBackendIdentity();
});

describe("costing rates (143)", () => {
  it("every check of the SQL proof passes, and nothing it wrote is kept", async () => {
    const notices: string[] = [];
    await withDb(async (db) => {
      const listen = (n: { message?: string }) => { if (n.message) notices.push(n.message); };
      db.on("notice", listen);
      try {
        await db.query(SQL);
      } catch (err) {
        await db.query("rollback");
        throw err;
      } finally {
        db.off("notice", listen);
      }
    });
    expect(notices.filter((n) => n.startsWith("FAIL "))).toEqual([]);
    expect(notices.filter((n) => n.startsWith("PASS ")).length).toBe(CHECKS);
    expect(CHECKS).toBeGreaterThanOrEqual(40);
    const left = await withDb(async (db) => (await db.query<{ n: number }>(
      "select count(*)::int as n from public.organizations where slug in ('t-cost143-a', 't-cost143-b')")).rows[0].n);
    expect(left).toBe(0);
  });

  it("the verify script: every row TRUE", async () => {
    const rows = await withDb(async (db) => (await db.query<{ check_name: string; ok: boolean }>(read("supabase/verify/costing_rates_143.sql"))).rows);
    expect(rows.length).toBe(10);
    expect(rows.filter((r) => r.ok !== true)).toEqual([]);
  });

  it("preflight marker 143 pins the stamp function's md5 and the three tables", () => {
    const line = read("supabase/verify/release_preflight.sql").split("\n").find((l) => l.includes("'143 costing rates'"))!;
    expect(line).toContain("to_regclass('public.costing_materials') IS NOT NULL AND to_regclass('public.costing_machines') IS NOT NULL");
    expect(read("supabase/verify/release_preflight.sql")).toContain(`to_regprocedure('${SIG}') AND md5(regexp_replace(p.prosrc, '\\s', '', 'g')) = '${MD5_143}'`);
    expect(read("supabase/migrations/143_costing_rates.sql").split(MD5_143).length - 1).toBe(2);
  });

  it("marker 143: applied; not applied with another stamp body or a table missing (negative test)", async () => {
    await rolledBack(async (db) => expect(await marker143(db)).toBe("applied"));
    await rolledBack(async (db) => {
      await alterStamp(db);
      expect((await db.query<{ m: string }>("select md5(regexp_replace(prosrc, '\\s', '', 'g')) as m from pg_proc where oid = to_regprocedure($1)", [SIG])).rows[0].m).not.toBe(MD5_143);
      expect(await marker143(db)).toBe("not applied");
    });
    await rolledBack(async (db) => {
      await db.query("drop table public.costing_defaults");
      expect(await marker143(db)).toBe("not applied");
    });
  });

  it("runs again cleanly; its guard refuses a stamp function with another body", async () => {
    await rolledBack(async (db) => {
      await db.query(unwrapped(read("supabase/release/143_costing_rates.release.sql")));
      expect(await marker143(db)).toBe("applied");
    });
    await rolledBack(async (db) => {
      await alterStamp(db);
      await expect(db.query(read("supabase/migrations/143_costing_rates.sql"))).rejects.toThrow(/143: public.costing_rates_stamp exists with another body/);
    });
  });

  it("the rollback removes the three tables and the function; marker 143 then reads not applied", async () => {
    await rolledBack(async (db) => {
      await db.query(unwrapped(read("supabase/release/143_costing_rates.rollback.sql")));
      const left = (await db.query<{ n: number }>(`select (to_regclass('public.costing_materials') is not null)::int + (to_regclass('public.costing_machines') is not null)::int
        + (to_regclass('public.costing_defaults') is not null)::int + (to_regprocedure('${SIG}') is not null)::int as n`)).rows[0].n;
      expect(left).toBe(0);
      expect(await marker143(db)).toBe("not applied");
    });
  });
});
