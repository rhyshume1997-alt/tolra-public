/**
 * Release order guards, in PostgreSQL itself. The plan says 144, 145, 146, 147, 148, 149, 150, 151, one after the other. Each release
 * must refuse, by its OWN guard (an object its predecessor creates), when the predecessor is missing. Every case is one transaction that
 * is always rolled back: with every release installed, roll back from 151 down to the one before the target, then apply the target's
 * release text. Pure SQL through the database connection (no Supabase Auth API).
 *   - 149 without 148, 150 without 149, 151 without 150: refused with a message naming the missing release, and nothing changes;
 *   - 144 without 107's tables: refused naming 107;
 *   - control: the same release applied right after its predecessor (one step down, not two) is accepted by the guard.
 * The test sets the rollbacks' own "accepted" switches only for the rollbacks it uses to set the scene (the fixture holds no data).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

import { preparePost144Fixture } from "../support/post-144-release-fixture";
import { verifyBackendIdentity, withDb } from "../support/fixtures";

const read = (file: string) => readFileSync(path.resolve(__dirname, "../..", file), "utf8");
const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");
const rel = (n: string, kind: "release" | "rollback") => unwrapped(read(`supabase/release/${n}.${kind}.sql`));
const FILES: Record<number, string> = { 148: "148_job_profitability_actuals", 149: "149_xero_launch_hold", 150: "150_ai_cap_key_off", 151: "151_xero_invite_hardening" };

beforeAll(async () => {
  await verifyBackendIdentity();
  await withDb(db => preparePost144Fixture({ verify: verifyBackendIdentity, query: sql => db.query(sql) }));
});

/** One transaction, always rolled back: roll back every release from 151 down to `downTo` (inclusive), then `fn`. */
async function scene<T>(downTo: number, fn: (db: Client) => Promise<T>): Promise<T> {
  return withDb(async db => {
    await db.query("BEGIN");
    try {
      await db.query("SELECT set_config('tolra.x149_accept_old_sending', 'yes', true), set_config('tolra.x151_accept_deleting_open_invites', 'yes', true)");
      // The scene-setting rollbacks may meet data other files left; they are told, as an operator would be, that deleting it is accepted.
      await db.query("SELECT set_config('tolra.x148_accept_deleting_job_costs', 'yes', true)");
      for (const n of [151, 150, 149, 148].filter(x => x >= downTo)) await db.query(rel(FILES[n], "rollback"));
      return await fn(db);
    } finally {
      await db.query("ROLLBACK");
    }
  });
}
async function refused(db: Client, sql: string): Promise<string | null> {
  await db.query("SAVEPOINT guard");
  try {
    await db.query(sql);
    return null;
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT guard");
    return (e as Error).message;
  }
}

describe("a release applied out of order is refused by its own guard", () => {
  it("151 without 150 (149 and everything older in place): refused, naming 150", async () => {
    await scene(150, async db => {
      expect(await refused(db, rel(FILES[151], "release"))).toMatch(/151: required release 150 \(AI cap and key-off\) is missing/);
      expect((await db.query("SELECT to_regprocedure('public.integration_invite_code_verify(text,text,text,text)') AS f")).rows[0].f).toBeNull();
    });
  });
  it("150 without 149 (148 and everything older in place): refused, naming 149", async () => {
    await scene(149, async db => {
      expect(await refused(db, rel(FILES[150], "release"))).toMatch(/150: required release 149 \(the Xero transfer switch\) is missing/);
      expect((await db.query("SELECT to_regprocedure('public._ai_helper_force_off(uuid,text)') AS f")).rows[0].f).toBeNull();
    });
  });
  it("149 without 148 (147 and everything older in place): refused, naming 148", async () => {
    await scene(148, async db => {
      expect(await refused(db, rel(FILES[149], "release"))).toMatch(/149: required release 148 \(job costing\) is missing/);
      expect((await db.query("SELECT to_regclass('public.xero_transfer_hold') AS t")).rows[0].t).toBeNull();
    });
  });
  it("144 without 107's tables: refused, naming 107", async () => {
    await withDb(async db => {
      await db.query("BEGIN");
      try {
        await db.query("DROP TABLE public.integration_connect_invites CASCADE");
        await db.query("DROP TABLE public.integration_app_credentials CASCADE");
        expect(await refused(db, unwrapped(read("supabase/release/144_accounting_connections.release.sql")))).toMatch(/144: release 107 \(integrations connect\) is not in place/);
      } finally {
        await db.query("ROLLBACK");
      }
    });
  });
  it("control: each release is accepted straight after its predecessor", async () => {
    for (const [n, down] of [[151, 151], [150, 150], [149, 149]] as const) {
      await scene(down, async db => expect(await refused(db, rel(FILES[n], "release"))).toBeNull());
    }
  });
});
