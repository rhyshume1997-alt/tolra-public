/**
 * Test-only. The release 154 (customer portal sign-in) window for the database proof written for the state before 154: 153's proof rolls
 * 153 back, and 153's rollback refuses while 154 is installed (PM ruling (e): 154 is rolled back before 153). That proof runs with 154
 * rolled back, unchanged:
 *   enter154PortalWindow()  in beforeAll, AFTER preparePost144Fixture: runs supabase/release/154_customer_portal_signin.rollback.sql
 *                           (never forced: it refuses, and this throws, while any portal contact exists).
 *   exit154PortalWindow()   last in afterAll: runs supabase/release/154_customer_portal_signin.release.sql again and requires every row
 *                           of supabase/verify/customer_portal_signin_154.sql true. Each window is therefore also a rollback -> re-release proof.
 * Both are no-ops when there is nothing to do (154 not installed on entry; nothing rolled back on exit). If a file stops before its afterAll,
 * the next proof's preparePost144Fixture applies 154 again (its marker reads "not applied"). Both take the fixture's advisory lock 144145146.
 * Inputs: none (the disposable test database, through withDb). Outputs: none; throws on any refusal or failed verify row.
 * Must not change: the 154 release, rollback and verify files it reads (it never edits them or forces past a refusal).
 * Assumes database proof files run one at a time (vitest.db.config.ts: fileParallelism false).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";

import { withDb } from "./fixtures";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const MARKER = "post-144 marker 154 customer_portal_signin";
const RELEASE = "supabase/release/154_customer_portal_signin.release.sql";
const ROLLBACK = "supabase/release/154_customer_portal_signin.rollback.sql";
const VERIFY = "supabase/verify/customer_portal_signin_154.sql";

let rolledBack = false;

async function marker(db: Client): Promise<string | undefined> {
  const rows = (await db.query(read("supabase/verify/release_preflight.sql"))).rows as Array<{ check?: string; value?: string }>;
  return rows.find(row => row.check === MARKER)?.value;
}

/** Runs one release or rollback file (it opens and commits its own transaction) under the fixture's lock; never leaves a transaction open. */
async function locked<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async db => {
    await db.query("SELECT pg_advisory_lock(144145146)");
    try {
      return await fn(db);
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      await db.query("SELECT pg_advisory_unlock(144145146)").catch(() => undefined);
    }
  });
}

/** Rolls release 154 back for the rest of this file (no-op when 154 is not installed). Throws if the rollback refuses. */
export async function enter154PortalWindow(): Promise<void> {
  await locked(async db => {
    if ((await marker(db)) !== "applied") return;
    await db.query(read(ROLLBACK));
    if ((await marker(db)) === "applied") throw new Error("154 portal window: the rollback ran but the 154 marker still reads applied");
    rolledBack = true;
    await db.query("NOTIFY pgrst, 'reload schema'");
  });
}

/** Applies release 154 again and requires every verify row true (no-op when this file did not roll it back). */
export async function exit154PortalWindow(): Promise<void> {
  if (!rolledBack) return;
  await locked(async db => {
    await db.query(read(RELEASE));
    if ((await marker(db)) !== "applied") throw new Error("154 portal window: release 154 was applied again but its marker does not read applied");
    const rows = (await db.query(read(VERIFY))).rows as Array<{ check_name: string; ok: boolean }>;
    const bad = rows.filter(row => row.ok !== true).map(row => row.check_name);
    if (!rows.length || bad.length) throw new Error(`154 portal window: verify failed after the re-release: ${bad.join("; ") || "no rows"}`);
    rolledBack = false;
    await db.query("NOTIFY pgrst, 'reload schema'");
  });
}
