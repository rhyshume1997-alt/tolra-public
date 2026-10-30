/**
 * Migration 111: the dashboard's figures worked out in the database (E6).
 *
 *   - tests/scripts/dashboard-figures-111.proof.sql (two companies, figures counted by hand, called as signed-in users, beta's rows
 *     never in alpha's figures, anon refused) passes against the freshly built stack;
 *   - through the real API, a signed-in admin's call answers with every figure the page reads (an empty company: all zero), and a
 *     signed-out call is refused;
 *   - supabase/verify/dashboard_figures_111.sql answers TRUE on every row; the rollback removes both functions (inside a transaction
 *     that is rolled back) and the release applies again cleanly.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isolatedBackend } from "../support/isolation";
import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");

const WORK_ARGS = {
  p_today: "2026-10-30", p_week_end: "2026-11-06", p_since: "2026-05-01", p_month_start: "2026-10-01", p_quotes_since: "2026-08-01",
  p_week_start: "2026-10-26T00:00:00.000Z", p_week_stop: "2026-11-02T00:00:00.000Z", p_now: "2026-10-30T12:00:00.000Z",
};
const MONEY_ARGS = { p_today: "2026-10-30", p_since: "2026-05-01" };

let world: SyntheticWorld;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("111 dashboard figures", () => {
  it("passes the two-company proof (hand counts, no other company's rows, anon refused)", async () => {
    const result = await withDb((db) => db.query(read("tests/scripts/dashboard-figures-111.proof.sql")));
    const rows = (Array.isArray(result) ? result : [result]).flatMap((r) => r.rows ?? []);
    expect(rows).toContainEqual({ result: "E6 proof: all checks passed" });
  });

  it("answers a signed-in admin through the API with every figure the page reads, and refuses a signed-out call", async () => {
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const work = await admin.rpc("dashboard_work_figures", WORK_ARGS);
    expect(work.error).toBeNull();
    expect(Object.keys(work.data as object).sort()).toEqual(["drafts", "due_days", "finished_by_month", "jobs", "machines", "quotes", "quotes_90", "quotes_sent_this_month", "rfqs_outstanding", "right_first_time"]);
    const money = await admin.rpc("dashboard_money_figures", MONEY_ARGS);
    expect(money.error).toBeNull();
    expect(Object.keys(money.data as object).sort()).toEqual(["days_to_pay", "owed_by_age", "owed_pence", "paid_count", "received_by_month", "to_confirm", "top_customers", "unpaid_count"]);

    const backend = isolatedBackend();
    const anon = createClient(backend.apiUrl, backend.anonKey, { auth: { persistSession: false } });
    expect((await anon.rpc("dashboard_work_figures", WORK_ARGS)).error).not.toBeNull();
    expect((await anon.rpc("dashboard_money_figures", MONEY_ARGS)).error).not.toBeNull();
  });

  it("verify answers TRUE on every row; the rollback removes both functions and the release applies again", async () => {
    await withDb(async (db) => {
      const verify = read("supabase/verify/dashboard_figures_111.sql");
      const checks = (await db.query<{ check_name: string; ok: boolean }>(verify)).rows;
      expect(checks).toHaveLength(4);
      expect(checks.filter((c) => !c.ok)).toEqual([]);
      await db.query("begin");
      try {
        await db.query(unwrapped(read("supabase/release/111_dashboard_figures.rollback.sql")));
        const after = (await db.query<{ check_name: string; ok: boolean }>(verify)).rows;
        expect(after.every((c) => !c.ok)).toBe(true);
        await db.query(unwrapped(read("supabase/release/111_dashboard_figures.release.sql")));
        expect((await db.query<{ check_name: string; ok: boolean }>(verify)).rows.every((c) => c.ok)).toBe(true);
      } finally {
        await db.query("rollback");
      }
    });
  });
});
