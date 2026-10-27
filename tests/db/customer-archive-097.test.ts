/**
 * Migration 097: customers can be archived (028's Archive / Unarchive), never deleted once used.
 *
 *   - admin and office archive and unarchive their own company's customers; the customer row is never changed;
 *   - workshop and viewer can't; another company's customer is refused as not found; the table is still written only through
 *     set_archive_state, and members see only their own company's choices;
 *   - a customer named on any document (quote, RFQ, sales order, job, delivery note, invoice, credit note) can't be deleted by a
 *     signed-in user through the API (082's guard), archived or not; a customer used nowhere can be;
 *   - supabase/verify/customer_archive_097.sql answers TRUE on every row; the rollback puts 028's function and check back (inside a
 *     transaction that is rolled back) and the release applies again cleanly.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

const ROOT = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const unwrapped = (sql: string) => sql.replace(/^BEGIN;$/m, "").replace(/^COMMIT;\s*$/m, "");

let world: SyntheticWorld;
const customer: Record<"alpha" | "beta", string> = { alpha: "", beta: "" };

async function newCustomer(org: string, name: string) {
  const { data, error } = await adminClient().from("customers").insert({ organization_id: org, name }).select("id").single();
  expect(error).toBeNull();
  return data!.id as string;
}

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const t of ["alpha", "beta"] as const) customer[t] = await newCustomer(world.tenants[t].id, `Archive Customer ${t} ${world.runId}`);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("set_archive_state for customers (097)", () => {
  it("admin and office archive and unarchive their own company's customer; the customer row is unchanged", async () => {
    const before = (await adminClient().from("customers").select("*").eq("id", customer.alpha).single()).data;
    const office = await signedInClient(world.tenants.alpha.users.office);
    expect((await office.rpc("set_archive_state", { p_table: "customers", p_id: customer.alpha, p_state: "archived" })).error).toBeNull();
    expect((await office.from("record_archive_state").select("record_table, state").eq("record_id", customer.alpha).single()).data).toEqual({ record_table: "customers", state: "archived" });
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    expect((await admin.rpc("set_archive_state", { p_table: "customers", p_id: customer.alpha, p_state: "auto" })).error).toBeNull();
    expect((await admin.from("record_archive_state").select("state").eq("record_id", customer.alpha)).data).toEqual([]);
    expect((await admin.rpc("set_archive_state", { p_table: "customers", p_id: customer.alpha, p_state: "archived" })).error).toBeNull();
    expect((await adminClient().from("customers").select("*").eq("id", customer.alpha).single()).data).toEqual(before);
  });

  it("workshop and viewer can't archive a customer", async () => {
    for (const role of ["workshop", "viewer"] as const) {
      const client = await signedInClient(world.tenants.alpha.users[role]);
      expect((await client.rpc("set_archive_state", { p_table: "customers", p_id: customer.alpha, p_state: "auto" })).error).toMatchObject({ code: "42501" });
    }
    expect((await adminClient().from("record_archive_state").select("state").eq("record_id", customer.alpha).single()).data).toEqual({ state: "archived" });
  });

  it("another company's customer is refused as not found; the table can't be written directly; choices stay in their company", async () => {
    const alphaAdmin = await signedInClient(world.tenants.alpha.users.admin);
    for (const state of ["archived", "auto"]) {
      expect((await alphaAdmin.rpc("set_archive_state", { p_table: "customers", p_id: customer.beta, p_state: state })).error).toMatchObject({ code: "P0002" });
    }
    expect((await adminClient().from("record_archive_state").select("state").eq("record_id", customer.beta)).data).toEqual([]);
    const direct = await alphaAdmin.from("record_archive_state").insert({ organization_id: world.tenants.alpha.id, record_table: "customers", record_id: customer.beta, state: "archived" });
    expect(direct.error).not.toBeNull();
    const betaAdmin = await signedInClient(world.tenants.beta.users.admin);
    expect((await betaAdmin.from("record_archive_state").select("record_id").eq("record_id", customer.alpha)).data).toEqual([]);
    // Another company's own admin may archive its customer.
    expect((await betaAdmin.rpc("set_archive_state", { p_table: "customers", p_id: customer.beta, p_state: "archived" })).error).toBeNull();
    expect((await alphaAdmin.from("record_archive_state").select("record_id").eq("record_id", customer.beta)).data).toEqual([]);
  });
});

describe("hard delete of a customer (082's guard, through the API)", () => {
  it("a customer named on any document can't be deleted, archived or not; the documents keep naming it", async () => {
    const org = world.tenants.alpha.id;
    const tag = world.runId.slice(0, 6);
    const docs: Array<[table: string, row: Record<string, unknown>]> = [
      ["quotes", { quote_ref: `Q-CA-${tag}`, status: "draft", total_value: 0 }],
      ["rfqs", { description: `R-CA-${tag}` }],
      ["sales_orders", { so_number: `SO-CA-${tag}`, status: "open" }],
      ["jobs", { job_no: `J-CA-${tag}` }],
      ["delivery_notes", { dn_number: `DN-CA-${tag}` }],
      ["invoices", {}],
      ["credit_notes", {}],
    ];
    // A credit note needs an invoice: one for another customer, so only the credit note names this one.
    const other = await adminClient().from("invoices").insert({ organization_id: org, customer: `Other ${world.runId}` }).select("id").single();
    expect(other.error).toBeNull();
    (docs[6][1] as Record<string, unknown>).invoice_id = other.data!.id;
    const office = await signedInClient(world.tenants.alpha.users.office);
    for (const [table, row] of docs) {
      const name = `Used on ${table} ${world.runId}`;
      const id = await newCustomer(org, name);
      const inserted = await adminClient().from(table).insert({ organization_id: org, customer: name, ...row }).select("id").single();
      expect(inserted.error, `${table} insert`).toBeNull();
      for (const archived of [false, true]) {
        if (archived) expect((await office.rpc("set_archive_state", { p_table: "customers", p_id: id, p_state: "archived" })).error).toBeNull();
        const refused = await office.from("customers").delete().eq("id", id).select("id");
        expect(refused.error, `${table} ${archived ? "archived" : "active"}`).toMatchObject({ code: "22023", hint: "customer_in_use" });
      }
      expect((await adminClient().from("customers").select("id").eq("id", id)).data).toHaveLength(1);
      expect((await adminClient().from(table).select("customer").eq("id", inserted.data!.id).single()).data).toEqual({ customer: name });
    }
  });

  it("a customer used nowhere can be deleted by admin or office; another company's can't be reached", async () => {
    const org = world.tenants.alpha.id;
    const free = await newCustomer(org, `Unused ${world.runId}`);
    const otherCompany = await newCustomer(world.tenants.beta.id, `Unused beta ${world.runId}`);
    const admin = await signedInClient(world.tenants.alpha.users.admin);
    const reach = await admin.from("customers").delete().eq("id", otherCompany).select("id");
    expect(reach.error).toBeNull();
    expect(reach.data).toEqual([]);
    expect((await adminClient().from("customers").select("id").eq("id", otherCompany)).data).toHaveLength(1);
    const deleted = await admin.from("customers").delete().eq("id", free).select("id");
    expect(deleted.error).toBeNull();
    expect(deleted.data).toEqual([{ id: free }]);
  });
});

describe("097 release files on the local stack", () => {
  it("the verify script answers TRUE on every row", async () => {
    const rows = await withDb(async (db) => (await db.query<{ check_name: string; ok: boolean }>(read("supabase/verify/customer_archive_097.sql"))).rows);
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => !r.ok)).toEqual([]);
  });

  it("the rollback puts 028's function and check back; the release then applies again (all inside a rolled-back transaction)", async () => {
    await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("insert into public.record_archive_state (organization_id, record_table, record_id, state) values ($1, 'jobs', gen_random_uuid(), 'archived')", [world.tenants.alpha.id]);
        await db.query(unwrapped(read("supabase/release/097_customer_archive.rollback.sql")));
        const after = (await db.query<{ check_name: string; ok: boolean }>(read("supabase/verify/customer_archive_097.sql"))).rows;
        expect(Object.fromEntries(after.map((r) => [r.check_name, r.ok]))).toMatchObject({ set_archive_state_is_097: false, record_archive_state_accepts_customers: false });
        expect((await db.query("select count(*)::int as n from public.record_archive_state where record_table = 'customers'")).rows[0].n).toBe(0);
        expect((await db.query("select count(*)::int as n from public.record_archive_state where record_table = 'jobs' and organization_id = $1", [world.tenants.alpha.id])).rows[0].n).toBeGreaterThan(0);
        await db.query(unwrapped(read("supabase/release/097_customer_archive.release.sql")));
        const again = (await db.query<{ ok: boolean }>(read("supabase/verify/customer_archive_097.sql"))).rows;
        expect(again.every((r) => r.ok)).toBe(true);
        // Safe to run again.
        await db.query(unwrapped(read("supabase/release/097_customer_archive.release.sql")));
      } finally {
        await db.query("rollback");
      }
    });
  });
});
