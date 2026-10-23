/** The read-only verify script for migration 034 (supabase/verify/workflow_034.sql) runs in a READ ONLY transaction. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyBackendIdentity, withDb } from "../support/fixtures";

beforeAll(async () => {
  await verifyBackendIdentity();
});

describe("supabase/verify/workflow_034.sql", () => {
  it("answers as expected on a database built from the migrations", async () => {
    const text = readFileSync(path.resolve(__dirname, "../../supabase/verify/workflow_034.sql"), "utf8");
    const rows = await withDb(async (db) => {
      await db.query("begin read only");
      try {
        return (await db.query<{ n: number; check_name: string; value: string; expected: string }>(text)).rows;
      } finally {
        await db.query("rollback");
      }
    });
    expect(rows.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    // 1 to 5 are facts about the schema. 6 to 11 count data that other suites create with the service role (and some of it
    // deliberately inconsistent), so here they only have to run and answer with a number.
    for (const row of rows.filter((r) => r.n <= 5)) expect({ n: row.n, value: row.value }).toEqual({ n: row.n, value: "true" });
    for (const row of rows.filter((r) => r.n > 5)) expect({ n: row.n, numeric: /^\d+$/.test(row.value) }).toEqual({ n: row.n, numeric: true });
    // 14 is about the schema too (the second step on every privileged workflow function and table): always 0.
    expect(rows.find((r) => r.n === 14)?.value).toBe("0");
  });

  it("finds nothing wrong on a database where only the migrations ran (the counts are all zero)", async () => {
    const text = readFileSync(path.resolve(__dirname, "../../supabase/verify/workflow_034.sql"), "utf8");
    const rows = await withDb(async (db) => {
      await db.query("begin");
      try {
        // Inside a transaction that is rolled back: clear what other suites left, then ask.
        await db.query("set local session_replication_role = replica");
        for (const table of ["invoice_credit_allocations", "credit_note_lines", "credit_notes", "delivery_note_items", "delivery_notes", "sales_order_lines", "job_inspections", "job_files", "invoice_payments", "invoice_line_items", "invoices", "jobs"]) {
          await db.query(`delete from public.${table}`);
        }
        return (await db.query<{ n: number; value: string; expected: string }>(text)).rows;
      } finally {
        await db.query("rollback");
      }
    });
    for (const row of rows.filter((r) => r.expected === "0")) expect({ n: row.n, value: row.value }).toEqual({ n: row.n, value: "0" });
  });
});
