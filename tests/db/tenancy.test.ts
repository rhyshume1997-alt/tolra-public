/**
 * Two-tenant isolation and role fixtures through the real API path (audit B1: synthetic ownership, role fixtures,
 * setup/teardown). Every request goes through Supabase Auth + PostgREST with the anon key and a signed-in synthetic
 * user, exactly like the browser, so RLS is what is under test.
 *
 * The role matrix pins today's behaviour as the regression baseline; where a table belongs to a page section, the
 * expected readers come from lib/sections.ts so the database and the app's page rules can't drift apart silently.
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MEMBER_SECTIONS } from "@/lib/sections";

import { isolatedBackend } from "../support/isolation";
import { TABLES } from "../support/tenancy-tables";
import {
  ROLES,
  type Role,
  type SyntheticWorld,
  adminClient,
  createSyntheticWorld,
  destroySyntheticWorld,
  leftoverRows,
  signedInClient,
  verifyBackendIdentity,
} from "../support/fixtures";

const sectionRoles = (key: string) => {
  const section = MEMBER_SECTIONS.find((s) => s.key === key);
  if (!section) throw new Error(`unknown section ${key}`);
  return [...section.roles].sort();
};

/** Who may read each table in their own organisation. */
const READERS: Record<string, Role[]> = {
  customers: sectionRoles("customers"),
  suppliers: sectionRoles("suppliers"),
  quotes: sectionRoles("quotes"),
  rfqs: sectionRoles("rfq"),
  jobs: sectionRoles("jobs"),
  sales_orders: sectionRoles("sales-orders"),
  invoices: sectionRoles("invoices"),
  purchase_orders: sectionRoles("purchase-orders"),
  delivery_notes: sectionRoles("delivery-notes"),
  machines: sectionRoles("schedule"),
  stock: ["admin", "office"],
  email_history: sectionRoles("email"),
};

/** Who may insert into each table in their own organisation (baseline at audit SHA 146fd5c; sales orders and invoices open to office in 034). */
const WRITERS: Record<string, Role[]> = {
  customers: ["admin", "office"],
  suppliers: ["admin", "office"],
  quotes: ["admin", "office"],
  rfqs: ["admin", "office"],
  jobs: ["admin", "office", "workshop"],
  sales_orders: ["admin", "office"],
  invoices: ["admin", "office"],
  purchase_orders: ["admin", "office"],
  delivery_notes: ["admin", "office", "workshop"],
  machines: ["admin", "office"],
  stock: ["admin", "office"],
  email_history: [],
};

/** Who may update / delete a row of their own organisation (pinned from the policies: the baseline for the next change). */
const UPDATERS: Record<string, Role[]> = { ...WRITERS, email_history: ["admin", "office"] };
const DELETERS: Record<string, Role[]> = { ...WRITERS, email_history: ["admin", "office"], jobs: ["admin"], delivery_notes: ["admin", "office"], sales_orders: ["admin"] };

let world: SyntheticWorld;
const seeded: Record<"alpha" | "beta", Record<string, string>> = { alpha: {}, beta: {} };
const clients = new Map<string, SupabaseClient>();

async function as(tenant: "alpha" | "beta", role: Role) {
  const key = `${tenant}:${role}`;
  if (!clients.has(key)) clients.set(key, await signedInClient(world.tenants[tenant].users[role]));
  return clients.get(key)!;
}

describe("two synthetic tenants on the isolated backend", () => {
  beforeAll(async () => {
    await verifyBackendIdentity();
    world = await createSyntheticWorld();
    const admin = adminClient();
    for (const tenant of ["alpha", "beta"] as const) {
      for (const [table, seed] of Object.entries(TABLES)) {
        const { data, error } = await admin.from(table).insert(seed(world.tenants[tenant].id, `${tenant}-seed`)).select("id").single();
        if (error) throw new Error(`seed ${table}: ${error.message}`);
        seeded[tenant][table] = data.id;
      }
    }
  });

  afterAll(async () => {
    if (!world) return;
    await destroySyntheticWorld(world.runId);
    expect(await leftoverRows(world.runId)).toEqual({});
  });

  it("every synthetic user signs in to their own organisation with their own role", async () => {
    for (const tenant of ["alpha", "beta"] as const) {
      for (const role of ROLES) {
        const client = await as(tenant, role);
        const { data: orgId } = await client.rpc("current_user_organization_id");
        const { data: current } = await client.rpc("current_user_role");
        expect({ tenant, role, orgId, current }).toEqual({ tenant, role, orgId: world.tenants[tenant].id, current: role });
      }
    }
  });

  it("signed-out (anon) requests see and write nothing", async () => {
    const { apiUrl, anonKey } = isolatedBackend();
    const anon = createClient(apiUrl, anonKey, { auth: { persistSession: false } });
    for (const [table, seed] of Object.entries(TABLES)) {
      const { data } = await anon.from(table).select("id");
      expect({ table, rows: data?.length ?? 0 }).toEqual({ table, rows: 0 });
      const { error } = await anon.from(table).insert(seed(world.tenants.alpha.id, "anon"));
      expect({ table, refused: Boolean(error) }).toEqual({ table, refused: true });
    }
  });

  it("reads follow the role matrix and never include the other tenant's rows", async () => {
    const seen: Record<string, Role[]> = {};
    for (const role of ROLES) {
      const client = await as("alpha", role);
      for (const table of Object.keys(TABLES)) {
        const { data, error } = await client.from(table).select("id, organization_id");
        expect(error).toBeNull();
        expect((data ?? []).filter((row) => row.organization_id !== world.tenants.alpha.id)).toEqual([]);
        if ((data ?? []).some((row) => row.id === seeded.alpha[table])) (seen[table] ??= []).push(role);
      }
    }
    for (const table of Object.keys(TABLES)) expect({ table, readers: (seen[table] ?? []).sort() }).toEqual({ table, readers: READERS[table] });
  });

  it("inserts into the user's own organisation follow the role matrix", async () => {
    const wrote: Record<string, Role[]> = {};
    for (const role of ROLES) {
      const client = await as("alpha", role);
      for (const [table, seed] of Object.entries(TABLES)) {
        const { error } = await client.from(table).insert(seed(world.tenants.alpha.id, `alpha-${role}`));
        if (!error) (wrote[table] ??= []).push(role);
      }
    }
    for (const table of Object.keys(TABLES)) expect({ table, writers: (wrote[table] ?? []).sort() }).toEqual({ table, writers: [...WRITERS[table]].sort() });
  });

  it("updates and deletes in the user's own organisation follow the role matrix (own rows only)", async () => {
    const service = adminClient();
    const changed: Record<string, Role[]> = {};
    const removed: Record<string, Role[]> = {};
    for (const role of ROLES) {
      const client = await as("alpha", role);
      for (const [table, seed] of Object.entries(TABLES)) {
        // Update: the row's own organisation written back (a no-op that still goes through the update policy and triggers).
        const update = await client.from(table).update({ organization_id: world.tenants.alpha.id }).eq("id", seeded.alpha[table]).select("id");
        if ((update.data ?? []).length === 1) (changed[table] ??= []).push(role);
        // Delete: a fresh row each time, so one role's delete doesn't hide another's.
        const { data: row, error } = await service.from(table).insert(seed(world.tenants.alpha.id, `del-${role}`)).select("id").single();
        if (error) throw new Error(`seed ${table}: ${error.message}`);
        const del = await client.from(table).delete().eq("id", row.id).select("id");
        if ((del.data ?? []).length === 1) (removed[table] ??= []).push(role);
        else await service.from(table).delete().eq("id", row.id);
      }
    }
    const sorted = (m: Record<string, Role[]>) => Object.fromEntries(Object.keys(TABLES).map((t) => [t, [...(m[t] ?? [])].sort()]));
    expect({ updaters: sorted(changed) }).toEqual({ updaters: sorted(UPDATERS) });
    expect({ deleters: sorted(removed) }).toEqual({ deleters: sorted(DELETERS) });
  });

  it("no role can read, create, change or delete the other tenant's rows", async () => {
    const admin = adminClient();
    for (const role of ROLES) {
      const client = await as("alpha", role);
      for (const [table, seed] of Object.entries(TABLES)) {
        const foreignId = seeded.beta[table];
        const read = await client.from(table).select("id").eq("id", foreignId);
        expect({ role, table, read: read.data?.length ?? 0 }).toEqual({ role, table, read: 0 });

        const insert = await client.from(table).insert(seed(world.tenants.beta.id, `cross-${role}`));
        expect({ role, table, insertRefused: Boolean(insert.error) }).toEqual({ role, table, insertRefused: true });

        const update = await client.from(table).update({ organization_id: world.tenants.alpha.id }).eq("id", foreignId).select("id");
        expect({ role, table, updated: update.data?.length ?? 0 }).toEqual({ role, table, updated: 0 });

        const remove = await client.from(table).delete().eq("id", foreignId).select("id");
        expect({ role, table, deleted: remove.data?.length ?? 0 }).toEqual({ role, table, deleted: 0 });

        const still = await admin.from(table).select("organization_id").eq("id", foreignId).single();
        expect({ role, table, owner: still.data?.organization_id }).toEqual({ role, table, owner: world.tenants.beta.id });
      }
    }
  });

  it("a user cannot move their own organisation's row into the other tenant", async () => {
    const client = await as("alpha", "admin");
    const { data, error } = await client.from("customers").update({ organization_id: world.tenants.beta.id }).eq("id", seeded.alpha.customers).select("id");
    expect(Boolean(error) || (data ?? []).length === 0).toBe(true);
    const { data: row } = await adminClient().from("customers").select("organization_id").eq("id", seeded.alpha.customers).single();
    expect(row?.organization_id).toBe(world.tenants.alpha.id);
  });
});
