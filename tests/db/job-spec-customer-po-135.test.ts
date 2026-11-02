/**
 * Migration 135 and the release preflight: marker 080 and row 18 ("080 needs") accept 080's and 135's exact convert_sales_order bodies
 * only. With 135 in, 080 reads applied and row 18 "094 / 135"; any other body (a harmless comment added, in a rolled-back transaction)
 * makes marker 080 (and 135) "not applied" and row 18 "other", whose expected text says stop. The same after 135's rollback (080's body).
 * Plain SQL inside transactions that are rolled back (nothing is kept).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");
const MD5_080 = "dc8165549871bd15047765ac4fba811e";
const MD5_135 = "9bde44b5ddf519640f1053bcf747c26d";
const SIG = "public.convert_sales_order(uuid)";

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

/** The release preflight's rows, read inside the caller's (rolled-back) transaction. */
async function preflight(db: Client) {
  const rows = (await db.query<{ check: string; value: string; expected: string }>(read("supabase/verify/release_preflight.sql"))).rows;
  const get = (prefix: string) => rows.find((r) => r.check.startsWith(prefix));
  const needs = get("080 needs:");
  return { marker080: get("marker 080 ")?.value, marker135: get("marker 135 ")?.value, needs080: needs?.value, needs080Expected: needs?.expected };
}

const body = async (db: Client) =>
  (await db.query<{ m: string }>("select md5(regexp_replace(prosrc, '\\s', '', 'g')) as m from pg_proc where oid = to_regprocedure($1)", [SIG])).rows[0]?.m;

/** Replaces convert_sales_order with its own text plus a harmless comment after its first BEGIN: same behaviour, an unknown body. */
const alter = (db: Client) =>
  db.query(`do $d$ begin execute regexp_replace(pg_get_functiondef(to_regprocedure('${SIG}')), E'\\nBEGIN\\n', E'\\nBEGIN\\n  -- an unknown version\\n'); end $d$`);

beforeAll(async () => {
  await verifyBackendIdentity();
});

describe("135 and the release preflight: 080's and 135's exact convert_sales_order bodies only", () => {
  it("marker 080 names exactly those two md5s", () => {
    const line = read("supabase/verify/release_preflight.sql").split("\n").find((l) => l.includes("'080 activity labels, job work'"))!;
    expect(line).toContain(`proname = 'convert_sales_order' AND md5(regexp_replace(prosrc, '\\s', '', 'g')) IN ('${MD5_080}', '${MD5_135}'))`);
  });

  it("with 135 in: 080 and 135 applied, 094 / 135; an unknown body: both not applied and 'other' (stop)", async () => {
    await rolledBack(async (db) => {
      expect(await body(db)).toBe(MD5_135);
      expect(await preflight(db)).toMatchObject({ marker080: "applied", marker135: "applied", needs080: "094 / 135" });
      await alter(db);
      expect(await body(db)).not.toBe(MD5_135);
      const after = await preflight(db);
      expect(after).toMatchObject({ marker080: "not applied", marker135: "not applied", needs080: "094 / other" });
      expect(after.needs080Expected).toContain("other: stop");
    });
  });

  it("with 135 rolled back (080's body): 080 applied, 135 not applied, 094 / 080; an unknown body: 080 not applied and 'other'", async () => {
    await rolledBack(async (db) => {
      await db.query(unwrapped(read("supabase/release/135_job_spec_customer_po.rollback.sql")));
      expect(await body(db)).toBe(MD5_080);
      expect(await preflight(db)).toMatchObject({ marker080: "applied", marker135: "not applied", needs080: "094 / 080" });
      await alter(db);
      expect(await preflight(db)).toMatchObject({ marker080: "not applied", marker135: "not applied", needs080: "094 / other" });
    });
  });
});
