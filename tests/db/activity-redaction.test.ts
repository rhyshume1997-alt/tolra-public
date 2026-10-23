/**
 * Money in record history (audit B7a: SEC8; migration 024). Older audit rows can carry money that workshop and viewer
 * staff may not see: jobs.value changes from before 009, job_values child rows, amounts in app event metadata. Their
 * view of a job's history leaves money out; admin and office still see it; the stored rows are unchanged.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
let jobId: string;
const as = new Map<string, SupabaseClient>();

type Activity = { action: string; entity_table: string; changes: Record<string, unknown> | null; snapshot: Record<string, unknown> | null; metadata: Record<string, unknown> | null };

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as.set(role, await signedInClient(world.tenants.alpha.users[role]));
  const org = world.tenants.alpha.id;
  const { data, error } = await adminClient().from("jobs").insert({ organization_id: org, job_no: `J-${world.runId}`, customer: "Redaction Co", description: "Bushes" }).select("id").single();
  expect(error).toBeNull();
  jobId = data!.id;
  // Legacy history, as an import or pre-009 database would have written it.
  await withDb(async (db) => {
    const add = (action: string, table: string, entity: string, oldData: unknown, newData: unknown, metadata: unknown) =>
      db.query(
        "insert into security_audit.audit_log (organization_id, action, entity_table, entity_id, old_data, new_data, metadata) values ($1, $2, $3, $4, $5, $6, $7)",
        [org, action, table, entity, oldData, newData, metadata],
      );
    await add("UPDATE", "jobs", jobId, { id: jobId, stage: "Programming", value: 1200 }, { id: jobId, stage: "Machining", value: 1500 }, {});
    await add("UPDATE", "jobs", jobId, { id: jobId, value: 1500 }, { id: jobId, value: 1750.5 }, {});
    await add("UPDATE", "job_values", jobId, { job_id: jobId, value: 1750.5 }, { job_id: jobId, value: 1800 }, {});
    await add("CONVERT_TO_JOB", "jobs", jobId, null, { job_no: `J-${world.runId}`, status: "open" },
      { source: "write_audit", so_number: "SO-R1", total_value: 2160, order: { net: 1800, vat_amount: 360, lines: [{ description: "Bush", unit_price: 25, quantity: 72 }] } });
  });
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

async function history(role: string): Promise<Activity[]> {
  const { data, error } = await as.get(role)!.rpc("record_activity", { p_table: "jobs", p_id: jobId });
  expect(error).toBeNull();
  return data as Activity[];
}

const MONEY_KEYS = new Set(["value", "unit_price", "total_value", "vat_amount", "net"]);
const AMOUNTS = new Set([1200, 1500, 1750.5, 1800, 2160, 360]);

/** Every key and number inside what the history panel shows (not ids or timestamps, which contain random digits). */
function shown(rows: Activity[]) {
  const keys: string[] = [];
  const numbers: number[] = [];
  const walk = (value: unknown) => {
    if (typeof value === "number") numbers.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { keys.push(k); walk(v); }
  };
  for (const row of rows) [row.changes, row.snapshot, row.metadata].forEach(walk);
  return { moneyKeys: keys.filter((k) => MONEY_KEYS.has(k)), amounts: numbers.filter((n) => AMOUNTS.has(n)) };
}

describe("job history and money", () => {
  for (const role of ["workshop", "viewer"]) {
    it(`${role} sees operational changes without any amounts`, async () => {
      const rows = await history(role);
      expect(shown(rows)).toEqual({ moneyKeys: [], amounts: [] });
      const updates = rows.filter((r) => r.action === "UPDATE");
      // The stage change stays; the value-only change and the job_values row aren't shown at all.
      expect(updates).toHaveLength(1);
      expect(updates[0].changes).toEqual({ stage: { from: "Programming", to: "Machining" } });
      const conversion = rows.find((r) => r.action === "CONVERT_TO_JOB");
      expect(conversion?.metadata).toEqual({ so_number: "SO-R1", order: { lines: [{ description: "Bush", quantity: 72 }] } });
    });
  }

  for (const role of ["admin", "office"]) {
    it(`${role} still sees the amounts`, async () => {
      const rows = await history(role);
      const updates = rows.filter((r) => r.action === "UPDATE");
      expect(updates.map((r) => r.entity_table).sort()).toEqual(["job_values", "jobs", "jobs"]);
      expect(updates.map((r) => r.changes)).toContainEqual({ value: { from: 1500, to: 1750.5 } });
      const conversion = rows.find((r) => r.action === "CONVERT_TO_JOB");
      expect(conversion?.metadata).toMatchObject({ total_value: 2160, order: { net: 1800, vat_amount: 360 } });
    });
  }

  it("the stored audit rows keep their amounts", async () => {
    const stored = await withDb(async (db) => (await db.query(
      "select count(*)::int as n from security_audit.audit_log where entity_id = $1 and (new_data ? 'value' or metadata ? 'total_value')", [jobId])).rows[0].n);
    expect(stored).toBe(4);
  });

  it("another company gets nothing", async () => {
    const other = await signedInClient(world.tenants.beta.users.admin);
    const { data, error } = await other.rpc("record_activity", { p_table: "jobs", p_id: jobId });
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });
});
