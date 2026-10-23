/**
 * The tenancy matrix's table list and its cross-company probe, shared by tests/db/tenancy.test.ts (two companies, every role) and
 * tests/db/two-level-access.test.ts (one person holding several companies, and the platform owner's support access).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { expect } from "vitest";

import { adminClient } from "./fixtures";

export type Seed = (org: string, tag: string) => Record<string, unknown>;

/** Minimal valid row per business table. */
export const TABLES: Record<string, Seed> = {
  customers: (o, t) => ({ organization_id: o, name: `Customer ${t}` }),
  suppliers: (o, t) => ({ organization_id: o, name: `Supplier ${t}` }),
  quotes: (o, t) => ({ organization_id: o, quote_ref: `Q-${t}`, customer: `Customer ${t}` }),
  rfqs: (o, t) => ({ organization_id: o, customer: `Customer ${t}` }),
  jobs: (o, t) => ({ organization_id: o, job_no: `J-${t}`, customer: `Customer ${t}` }),
  sales_orders: (o, t) => ({ organization_id: o, so_number: `SO-${t}` }),
  invoices: (o, t) => ({ organization_id: o, customer: `Customer ${t}` }),
  // A new purchase order names a supplier on the list (082): the suppliers row made just before it with the same tag.
  purchase_orders: (o, t) => ({ organization_id: o, status: "draft", supplier: `Supplier ${t}` }),
  delivery_notes: (o, t) => ({ organization_id: o, dn_number: `DN-${t}` }),
  machines: (o, t) => ({ organization_id: o, name: `Machine ${t}` }),
  stock: (o, t) => ({ organization_id: o, sku: `SKU-${t}`, material: "EN8" }),
  email_history: (o) => ({ organization_id: o, to_email: "someone@example.test", subject: "Synthetic", body: "Synthetic", status: "drafted" }),
};

/** One row per table for a company, made with the service role, keyed by table name. */
export async function seedCompany(org: string, tag: string) {
  const seeded: Record<string, string> = {};
  const admin = adminClient();
  for (const [table, seed] of Object.entries(TABLES)) {
    const { data, error } = await admin.from(table).insert(seed(org, tag)).select("id").single();
    if (error) throw new Error(`seed ${table}: ${error.message}`);
    seeded[table] = data.id;
  }
  return seeded;
}

/**
 * Whatever `client` is working as right now can neither read, create, change nor delete the foreign company's rows in any table of
 * the matrix: every read is empty, every insert refused, every update and delete touches nothing, and the owner is unchanged.
 */
export async function expectNoAccessTo(client: SupabaseClient, foreignOrg: string, foreign: Record<string, string>, label: string) {
  const admin = adminClient();
  for (const [table, seed] of Object.entries(TABLES)) {
    const id = foreign[table];
    const read = await client.from(table).select("id").eq("id", id);
    expect({ label, table, read: read.data?.length ?? 0 }).toEqual({ label, table, read: 0 });
    const insert = await client.from(table).insert(seed(foreignOrg, `x-${label}`));
    expect({ label, table, insertRefused: Boolean(insert.error) }).toEqual({ label, table, insertRefused: true });
    const update = await client.from(table).update({ organization_id: foreignOrg }).eq("id", id).select("id");
    expect({ label, table, updated: update.data?.length ?? 0 }).toEqual({ label, table, updated: 0 });
    const remove = await client.from(table).delete().eq("id", id).select("id");
    expect({ label, table, deleted: remove.data?.length ?? 0 }).toEqual({ label, table, deleted: 0 });
    const still = await admin.from(table).select("organization_id").eq("id", id).single();
    expect({ label, table, owner: still.data?.organization_id }).toEqual({ label, table, owner: foreignOrg });
  }
}

/** Everything `client` can read in the matrix tables belongs to `org` (and its own seeded row is there). */
export async function expectOnlyCompany(client: SupabaseClient, org: string, own: Record<string, string>, label: string) {
  for (const table of Object.keys(TABLES)) {
    const { data, error } = await client.from(table).select("id, organization_id");
    expect({ label, table, error: error?.message ?? null }).toEqual({ label, table, error: null });
    expect({ label, table, foreign: (data ?? []).filter((row) => row.organization_id !== org).length }).toEqual({ label, table, foreign: 0 });
    expect({ label, table, ownVisible: (data ?? []).some((row) => row.id === own[table]) }).toEqual({ label, table, ownVisible: true });
  }
}

/** Every table of the matrix refuses an insert for `org` (the session may not write there). */
export async function expectNoWrites(client: SupabaseClient, org: string, own: Record<string, string>, label: string) {
  for (const [table, seed] of Object.entries(TABLES)) {
    const insert = await client.from(table).insert(seed(org, `w-${label}`));
    expect({ label, table, insertRefused: Boolean(insert.error) }).toEqual({ label, table, insertRefused: true });
    const update = await client.from(table).update({ organization_id: org }).eq("id", own[table]).select("id");
    expect({ label, table, updatedRows: update.error ? 0 : (update.data?.length ?? 0) }).toEqual({ label, table, updatedRows: 0 });
    const remove = await client.from(table).delete().eq("id", own[table]).select("id");
    expect({ label, table, deletedRows: remove.error ? 0 : (remove.data?.length ?? 0) }).toEqual({ label, table, deletedRows: 0 });
  }
}
