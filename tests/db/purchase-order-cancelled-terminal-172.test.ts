// Runs release 172 and its verification on the disposable database, restoring the schema after the test.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { verifyBackendIdentity, withDb } from "../support/fixtures";

const sqlBody = (path: string) => readFileSync(path, "utf8").replace(/^(BEGIN|COMMIT|ROLLBACK);$/gm, "");
const release = sqlBody("supabase/release/172_purchase_order_cancelled_terminal.release.sql");
const verify = sqlBody("supabase/verify/purchase_order_cancelled_terminal_172.sql");
const rollback = sqlBody("supabase/release/172_purchase_order_cancelled_terminal.rollback.sql");

it("installs idempotently, verifies browser transitions, and rolls back without removing the issue lock", async () => {
  await verifyBackendIdentity();
  await withDb(async (db) => {
    await db.query("BEGIN");
    try {
      await db.query(release);
      await db.query(release);
      await db.query(verify);
      await db.query("RESET ROLE");
      await db.query(rollback);
      await db.query(rollback);
      const { rows } = await db.query(`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'public.purchase_orders'::regclass
          AND tgname IN ('purchase_order_issue_lock', 'purchase_order_cancelled_terminal')
      `);
      expect(rows).toEqual([{ tgname: "purchase_order_issue_lock" }]);
    } finally {
      await db.query("ROLLBACK");
    }
  });
});
