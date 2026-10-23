/**
 * Audit log claims (audit B7a: SEC1, A5; migration 023). Only events the caller's role could perform are accepted,
 * actor and organisation always come from the session, and the database's own change rows still record changes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
const as = new Map<string, SupabaseClient>();

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as.set(role, await signedInClient(world.tenants.alpha.users[role]));
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

const write = (role: string, action: string, table: string, entityId: string | null = "x") =>
  as.get(role)!.rpc("write_audit", { p_action: action, p_entity_table: table, p_entity_id: entityId, p_old: null, p_new: { claim: true }, p_metadata: {}, p_ip: null, p_user_agent: null });

async function rows(action: string, table: string) {
  return withDb(async (db) => (await db.query(
    "select actor_user_id, organization_id from security_audit.audit_log where action = $1 and entity_table = $2 and organization_id = $3",
    [action, table, world.tenants.alpha.id])).rows);
}

describe("who can record what", () => {
  const cases: [string, string, string, boolean][] = [
    ["viewer", "MARK_PAID", "invoices", false],
    ["viewer", "CREATE", "customers", false],
    ["viewer", "DELETE", "jobs", false],
    ["viewer", "EXPORT", "jobs", true],
    ["viewer", "EXPORT", "invoices", false],
    // MARK_PAID and the other payment events are written by the database only (035): no role can record one.
    ["office", "MARK_PAID", "invoices", false],
    ["office", "CREATE", "sales_orders", true],
    ["workshop", "MARK_PAID", "invoices", false],
    ["office", "SEND", "quotes", true],
    ["workshop", "UPDATE_WORKSHEET", "jobs", true],
    ["workshop", "EXPORT", "quotes", false],
    ["admin", "MARK_PAID", "invoices", false],
    ["admin", "MADE_UP", "invoices", false],
    ["admin", "EXPORT", "secret_table", false],
    ["office", "CREATE_USER", "user_profiles", false],
    ["admin", "CREATE_USER", "user_profiles", true],
  ];
  for (const [role, action, table, allowed] of cases) {
    it(`${role} ${allowed ? "can" : "can't"} record ${action} on ${table}`, async () => {
      const before = (await rows(action, table)).length;
      const { error } = await write(role, action, table);
      expect({ allowed: !error }).toEqual({ allowed });
      expect((await rows(action, table)).length).toBe(before + (allowed ? 1 : 0));
    });
  }

  it("a password change can only be recorded about yourself", async () => {
    const viewer = world.tenants.alpha.users.viewer;
    expect((await write("viewer", "CHANGE_OWN_PASSWORD", "user_profiles", world.tenants.alpha.users.admin.id)).error).not.toBeNull();
    expect((await write("viewer", "CHANGE_OWN_PASSWORD", "user_profiles", viewer.id)).error).toBeNull();
  });

  it("the actor and organisation are the caller's, whatever the payload says", async () => {
    await write("viewer", "EXPORT", "machines");
    const found = await rows("EXPORT", "machines");
    expect(found.at(-1)).toEqual({ actor_user_id: world.tenants.alpha.users.viewer.id, organization_id: world.tenants.alpha.id });
  });
});

describe("database change rows still record what happened", () => {
  it("an update by office is logged by the trigger, independently of write_audit", async () => {
    const { data } = await adminClient().from("customers").insert({ organization_id: world.tenants.alpha.id, name: "Audited" }).select("id").single();
    await as.get("office")!.from("customers").update({ name: "Audited Ltd" }).eq("id", data!.id);
    const logged = await withDb(async (db) => (await db.query(
      "select action, actor_user_id from security_audit.audit_log where entity_table = 'customers' and entity_id = $1 and action = 'UPDATE'", [data!.id])).rows);
    expect(logged).toEqual([{ action: "UPDATE", actor_user_id: world.tenants.alpha.users.office.id }]);
  });
});
