/**
 * The app's audit contract (lib/audit-contract.ts) and the database's rule (audit_event_allowed, latest in migration 095, which keeps 076's read list): every
 * record type the database lets a read event name is one the app may send, so neither list drifts from the other.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AUDIT_TABLES } from "@/lib/audit-contract";

/** The newest migration that (re)defines audit_event_allowed, and the tables its read list names. */
function databaseReadTables() {
  const dir = path.resolve(__dirname, "../../supabase/migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const latest = files.filter((f) => /CREATE OR REPLACE FUNCTION public\.audit_event_allowed\(/i.test(readFileSync(path.join(dir, f), "utf8"))).at(-1)!;
  const sql = readFileSync(path.join(dir, latest), "utf8");
  const fn = sql.slice(sql.search(/CREATE OR REPLACE FUNCTION public\.audit_event_allowed\(/i));
  const read = fn.slice(fn.indexOf("v_read"), fn.indexOf("v_write"));
  return { latest, tables: [...read.matchAll(/WHEN '([a-z_]+)' THEN/g)].map((m) => m[1]) };
}

describe("audit contract", () => {
  it("every table the database accepts for a read event is in AUDIT_TABLES", () => {
    const { latest, tables } = databaseReadTables();
    expect(latest).toMatch(/_ai_finance_check_audit_events\.sql$/);
    expect(tables).toEqual(expect.arrayContaining(["invoice_payments", "time_week_approvals"]));
    for (const t of tables) expect(AUDIT_TABLES as readonly string[], `${t} (${latest})`).toContain(t);
  });
});
