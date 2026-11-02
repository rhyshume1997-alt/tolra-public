/**
 * 131 and public.legacy_audit_log. No migration makes that table: supabase/import/import_legacy_tenant.sql makes it, with its one policy
 * "legacy_audit_log admins read", on a project that ran the legacy import (production did, with the import script's text from before 131,
 * which calls both helpers once per row). 131 rewrites that policy where the table is there, and its guard takes only the import script's
 * text or 131's. This test plays production's order on the local stack, inside ONE transaction that is rolled back at the end (nothing is
 * left behind): main's policies (131's rollback), the import script's DDL part, the policy as production has it, then 131's release, verify
 * (every row TRUE), the rollback (the exact text back), the release again; and the guard refusing any other text or a missing policy.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Client } from "pg";
import { describe, expect, it } from "vitest";

import { releaseSql } from "../../scripts/release-sql.mjs";
import { verifyBackendIdentity, withDb } from "../support/fixtures";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const FILE = "131_rls_select_wrap.sql";
/** Text between the file's own BEGIN; and COMMIT; (this test holds the transaction). */
const body = (sql: string) => {
  const lines = sql.split("\n");
  const begin = lines.indexOf("BEGIN;");
  const commit = lines.lastIndexOf("COMMIT;");
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(commit).toBeGreaterThan(begin);
  return lines.slice(begin + 1, commit).join("\n");
};
const RELEASE = body(read(path.join("supabase/release", FILE.replace(".sql", ".release.sql"))));
const ROLLBACK = body(read("supabase/release/131_rls_select_wrap.rollback.sql"));
const VERIFY = read("supabase/verify/rls_select_wrap_131.sql");
const PRECHECK = read("supabase/verify/rls_select_wrap_131_precheck.sql");
const IMPORT = read("supabase/import/import_legacy_tenant.sql");
/** The import script's support tables, policy and trigger (everything before the importer function). */
const IMPORT_DDL = IMPORT.slice(0, IMPORT.indexOf("-- The importer"));

const POLICY = `"legacy_audit_log admins read" ON public.legacy_audit_log`;
/** The policy as production has it: the import script's text before 131, as pg_policies prints it. */
const PRODUCTION_TEXT = "((organization_id = current_user_organization_id()) AND has_org_role(ARRAY['admin'::text]))";
const WRAPPED_TEXT = "((organization_id = ( SELECT current_user_organization_id() AS current_user_organization_id)) AND ( SELECT has_org_role(ARRAY['admin'::text]) AS has_org_role))";
const MD5_MAIN = "d52d07dfca8db97c66ed1573ebd3a6c1";
const MD5_131 = "0c3f9197b8141c8b66f15268b935ae94";

type Row = { permissive: string; cmd: string; roles: string; qual: string; with_check: string | null; m: string };
const legacy = async (db: Client) =>
  (await db.query<Row>(`select permissive, cmd, roles::text as roles, qual, with_check, md5(coalesce(qual, '') || '|' || coalesce(with_check, '')) as m
                        from pg_policies where schemaname = 'public' and tablename = 'legacy_audit_log'`)).rows;
const policies = async (db: Client) =>
  (await db.query<{ t: string }>(`select string_agg(concat_ws(' | ', schemaname, tablename, policyname, permissive, roles::text, cmd, qual, with_check), E'\\n'
                                  order by schemaname, tablename, policyname) as t from pg_policies`)).rows[0].t;
const verify = async (db: Client) => (await db.query<{ check_name: string; ok: boolean }>(VERIFY)).rows;
const precheck = async (db: Client) => (await db.query<{ n: number; live: string | null; state: string | null; ok: boolean }>(PRECHECK)).rows;
/** Runs sql; resolves to the error message it raised (undone with a savepoint), or null. */
const refusal = async (db: Client, sql: string) => {
  await db.query("savepoint s131");
  try {
    await db.query(sql);
    await db.query("release savepoint s131");
    return null;
  } catch (error) {
    await db.query("rollback to savepoint s131");
    return (error as Error).message;
  }
};

describe("131 and the legacy import's policy (supabase/import/import_legacy_tenant.sql)", () => {
  it("the release text is release-sql.mjs's wrap of the migration", () => {
    expect(read(path.join("supabase/release", FILE.replace(".sql", ".release.sql")))).toBe(releaseSql(read(path.join("supabase/migrations", FILE)), FILE));
  });

  it("main + the import script's DDL + production's text: release, verify TRUE, rollback gives the exact text back, release again", async () => {
    await verifyBackendIdentity();
    await withDb(async (db) => {
      await db.query("begin");
      try {
        // A table an earlier run left (legacy-import.test.ts removes the ones it creates) is replaced for this transaction only.
        await db.query("drop table if exists public.legacy_audit_log");
        // No table: 131's legacy section does nothing and verify's legacy row is TRUE; the precheck says so.
        expect((await verify(db)).every((r) => r.ok)).toBe(true);
        expect((await precheck(db)).find((r) => r.n === 5)).toMatchObject({ state: "no table (no legacy import here)", ok: true });
        expect(await refusal(db, RELEASE)).toBeNull();

        // main: the policies as main has them (131's rollback).
        expect(await refusal(db, ROLLBACK)).toBeNull();
        const main = await policies(db);
        expect(Object.fromEntries((await verify(db)).map((r) => [r.check_name, r.ok]))).toMatchObject({ policies_131_wrapped: false, legacy_audit_log_policy_wrapped: true });

        // The import script's DDL part writes 131's form already.
        await db.query(IMPORT_DDL);
        expect(await legacy(db)).toEqual([{ permissive: "PERMISSIVE", cmd: "SELECT", roles: "{authenticated}", qual: WRAPPED_TEXT, with_check: null, m: MD5_131 }]);
        // Production: the same policy with the import script's text before 131.
        await db.query(`alter policy ${POLICY} using (organization_id = public.current_user_organization_id() and public.has_org_role(array['admin']))`);
        expect(await legacy(db)).toEqual([{ permissive: "PERMISSIVE", cmd: "SELECT", roles: "{authenticated}", qual: PRODUCTION_TEXT, with_check: null, m: MD5_MAIN }]);
        const production = await policies(db);
        // The precheck as Rhys ran it on production: 182 main, nothing else calling a helper per row, the legacy policy "main".
        const pre = await precheck(db);
        expect(pre.filter((r) => r.n <= 5).map((r) => [r.n, r.ok])).toEqual([[1, true], [2, true], [3, true], [4, true], [5, true]]);
        expect(pre.find((r) => r.n === 3)!.live).toBe("182 main, 0 131, 0 other");
        expect(pre.find((r) => r.n === 4)!.live).toBe("0");
        expect(pre.find((r) => r.n === 5)).toMatchObject({ live: MD5_MAIN, state: "main" });

        // 131's release: every verify row TRUE, the legacy policy in 131's form.
        expect(await refusal(db, RELEASE)).toBeNull();
        expect(await verify(db)).toEqual([
          { check_name: "policies_131_wrapped", ok: true },
          { check_name: "no_helper_called_per_row", ok: true },
          { check_name: "wrapped_helpers_are_stable", ok: true },
          { check_name: "legacy_audit_log_policy_wrapped", ok: true },
        ]);
        expect((await legacy(db))[0]).toMatchObject({ qual: WRAPPED_TEXT, m: MD5_131 });
        const released = await policies(db);
        expect((await precheck(db)).find((r) => r.n === 5)).toMatchObject({ state: "131 already", ok: true });

        // Rollback: production's policies exactly, the legacy text included; twice gives the same.
        expect(await refusal(db, ROLLBACK)).toBeNull();
        expect((await legacy(db))[0]).toMatchObject({ qual: PRODUCTION_TEXT, m: MD5_MAIN });
        expect(await policies(db)).toBe(production);
        expect(await refusal(db, ROLLBACK)).toBeNull();
        expect(await policies(db)).toBe(production);
        expect((await verify(db)).find((r) => r.check_name === "legacy_audit_log_policy_wrapped")!.ok).toBe(false);

        // Release again (twice): the same as the first release.
        expect(await refusal(db, RELEASE)).toBeNull();
        expect(await policies(db)).toBe(released);
        expect(await refusal(db, RELEASE)).toBeNull();
        expect(await policies(db)).toBe(released);
        expect((await verify(db)).every((r) => r.ok)).toBe(true);

        // Running the import script again after 131 (cutover) keeps 131's form: verify stays TRUE.
        await db.query(IMPORT_DDL);
        expect(await policies(db)).toBe(released);
        expect((await verify(db)).every((r) => r.ok)).toBe(true);

        // The guard refuses any other text, command or roles, and a missing policy; nothing changes.
        for (const tamper of [
          `alter policy ${POLICY} using (organization_id = public.current_user_organization_id() and public.has_org_role(array['admin', 'office']))`,
          `alter policy ${POLICY} using (true)`,
          `alter policy ${POLICY} to authenticated, anon`,
          `drop policy ${POLICY}`,
        ]) {
          await db.query("savepoint tamper");
          await db.query(tamper);
          const tampered = await policies(db);
          expect(await refusal(db, RELEASE), tamper).toMatch(/^131: public\.legacy_audit_log :: legacy_audit_log admins read is not the import script's \(nor 131's\); stop and compare: /);
          expect(await refusal(db, ROLLBACK), tamper).toMatch(/^131 rollback: public\.legacy_audit_log :: legacy_audit_log admins read is neither 131's nor the import script's; stop and compare: /);
          expect(await policies(db)).toBe(tampered);
          expect((await precheck(db)).find((r) => r.n === 5)!.ok, tamper).toBe(false);
          await db.query("rollback to savepoint tamper");
        }
        expect(await policies(db)).toBe(released);
        expect(main).not.toBe(released);
      } finally {
        await db.query("rollback");
      }
    });
  });
});
