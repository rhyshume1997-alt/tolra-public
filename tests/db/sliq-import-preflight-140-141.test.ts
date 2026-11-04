/**
 * Migrations 140 (import source ref) and 141 (opening WIP) and the release preflight. Marker 140 accepts only 140's exact
 * public.source_ref_import_only() body (and the five source_ref columns); marker 141 only 141's exact "opening_wip rbac select"
 * policy. A harmless change (a comment in the function, the same policy with its two conditions swapped) makes the marker
 * "not applied", and 140's guard refuses to replace an unknown body. Both verify files read every row TRUE with 140 and 141 in;
 * after each rollback its marker reads "not applied" and the release brings it back. On main 136 to 139 are not there yet: the
 * markers do not depend on them (135 is followed by 140). Plain SQL inside transactions that are rolled back (nothing is kept).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");
const MD5_140 = "169cd2798340f7ba1d43b8b85e3be923";
const MD5_141_POLICY = "6a18e9fed9ee8dd956c314df2b296562"; // each helper in a sub-select (131); the same read rule as 131's "invoices rbac select"
const FN = "public.source_ref_import_only()";

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

/** The release preflight's marker rows for 135, 140 and 141, read inside the caller's (rolled-back) transaction. */
async function markers(db: Client) {
  const rows = (await db.query<{ check: string; value: string }>(read("supabase/verify/release_preflight.sql"))).rows;
  const get = (prefix: string) => rows.find((r) => r.check.startsWith(prefix))?.value;
  return { m135: get("marker 135 "), m140: get("marker 140 "), m141: get("marker 141 ") };
}

const verifyRows = async (db: Client, file: string) => (await db.query<{ check_name: string; ok: boolean }>(read(file))).rows;

const fnBody = async (db: Client) =>
  (await db.query<{ m: string }>("select md5(regexp_replace(prosrc, '\\s', '', 'g')) as m from pg_proc where oid = to_regprocedure($1)", [FN])).rows[0]?.m;

/** Replaces source_ref_import_only with its own text plus a harmless comment after its first BEGIN: same behaviour, an unknown body. */
const alterFn = (db: Client) =>
  db.query(`do $d$ begin execute regexp_replace(pg_get_functiondef(to_regprocedure('${FN}')), E'\\nBEGIN\\n', E'\\nBEGIN\\n  -- an unknown version\\n'); end $d$`);

/** The same read rule with its two conditions swapped: same rows, a different policy text. */
const alterPolicy = (db: Client) =>
  db.query(`alter policy "opening_wip rbac select" on public.opening_wip
              using ((SELECT public.has_org_role(ARRAY['admin', 'office'])) AND organization_id = (SELECT public.current_user_organization_id()))`);

beforeAll(async () => {
  await verifyBackendIdentity();
});

describe("140 and 141 and the release preflight: exact bodies only", () => {
  it("the markers name exactly 140's function md5 and 141's policy md5, after 135's marker", () => {
    const text = read("supabase/verify/release_preflight.sql");
    const at = (needle: string) => text.indexOf(needle);
    expect(at("('135 job spec customer po'")).toBeGreaterThan(0);
    expect(at("('140 import source ref'")).toBeGreaterThan(at("('135 job spec customer po'"));
    expect(at("('141 opening wip'")).toBeGreaterThan(at("('140 import source ref'"));
    expect(text.split(`'${MD5_140}'`).length).toBe(2);
    expect(text.slice(at("('141 opening wip'")).split(`'${MD5_141_POLICY}'`).length).toBe(2); // 131's marker pins the same text for invoices
    expect(read("supabase/verify/opening_wip_141.sql")).toContain(`'${MD5_141_POLICY}'`);
    for (const f of ["supabase/migrations/140_import_source_ref.sql", "supabase/release/140_import_source_ref.release.sql"]) {
      expect(read(f).split(`'${MD5_140}'`).length).toBe(3); // the guard and the self-check
    }
    expect(read("supabase/verify/import_source_ref_140.sql")).toContain(`'${MD5_140}'`);
  });

  it("with 140 and 141 in: both markers applied (135 too) and both verify files every row TRUE", async () => {
    await rolledBack(async (db) => {
      expect(await fnBody(db)).toBe(MD5_140);
      expect(await markers(db)).toEqual({ m135: "applied", m140: "applied", m141: "applied" });
      const v140 = await verifyRows(db, "supabase/verify/import_source_ref_140.sql");
      const v141 = await verifyRows(db, "supabase/verify/opening_wip_141.sql");
      expect([v140.length, v140.filter((r) => r.ok !== true).map((r) => r.check_name)]).toEqual([6, []]);
      expect([v141.length, v141.filter((r) => r.ok !== true).map((r) => r.check_name)]).toEqual([9, []]);
    });
  });

  it("an unknown source_ref_import_only body: marker 140 not applied (141 still applied) and 140's release refuses to replace it", async () => {
    await rolledBack(async (db) => {
      await alterFn(db);
      expect(await fnBody(db)).not.toBe(MD5_140);
      expect(await markers(db)).toEqual({ m135: "applied", m140: "not applied", m141: "applied" });
      await db.query("savepoint s");
      await expect(db.query(unwrapped(read("supabase/release/140_import_source_ref.release.sql")))).rejects.toThrow(/140: public\.source_ref_import_only\(\) exists with another body/);
      await db.query("rollback to savepoint s");
      expect(await markers(db)).toMatchObject({ m140: "not applied" });
    });
  });

  it("a changed opening_wip read policy: marker 141 not applied (140 still applied); 141's release puts its own back", async () => {
    await rolledBack(async (db) => {
      await alterPolicy(db);
      expect(await markers(db)).toEqual({ m135: "applied", m140: "applied", m141: "not applied" });
      await db.query(unwrapped(read("supabase/release/141_opening_wip.release.sql")));
      expect(await markers(db)).toEqual({ m135: "applied", m140: "applied", m141: "applied" });
    });
  });

  it("after 141's then 140's rollback: each marker not applied, 135 untouched; the releases bring both back", async () => {
    await rolledBack(async (db) => {
      await db.query(unwrapped(read("supabase/release/141_opening_wip.rollback.sql")));
      expect(await markers(db)).toEqual({ m135: "applied", m140: "applied", m141: "not applied" });
      await db.query(unwrapped(read("supabase/release/140_import_source_ref.rollback.sql")));
      expect(await markers(db)).toEqual({ m135: "applied", m140: "not applied", m141: "not applied" });
      await db.query(unwrapped(read("supabase/release/140_import_source_ref.release.sql")));
      await db.query(unwrapped(read("supabase/release/141_opening_wip.release.sql")));
      expect(await markers(db)).toEqual({ m135: "applied", m140: "applied", m141: "applied" });
    });
  });
});
