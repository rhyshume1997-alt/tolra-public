/**
 * Links between business records must stay inside one organisation (audit B0b: SEC14). A foreign key only proves
 * the parent exists; RLS hides the other tenant's parent but doesn't stop a known id being written. Each link is
 * tried by a signed-in admin of tenant alpha against tenant beta's records, on INSERT and UPDATE.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

type Parent = "rfqs" | "quotes" | "customers" | "jobs" | "sales_orders";

const ROWS: Record<Parent | "invoices" | "delivery_notes", (org: string, tag: string) => Record<string, unknown>> = {
  rfqs: (o, t) => ({ organization_id: o, customer: `C ${t}` }),
  quotes: (o, t) => ({ organization_id: o, quote_ref: `Q-${t}`, customer: `C ${t}` }),
  customers: (o, t) => ({ organization_id: o, name: `C ${t}` }),
  jobs: (o, t) => ({ organization_id: o, job_no: `J-${t}`, customer: `C ${t}` }),
  sales_orders: (o, t) => ({ organization_id: o, so_number: `SO-${t}` }),
  invoices: (o, t) => ({ organization_id: o, customer: `C ${t}` }),
  delivery_notes: (o, t) => ({ organization_id: o, dn_number: `DN-${t}` }),
};

/** child table, link column, parent table */
const LINKS: [keyof typeof ROWS, string, Parent][] = [
  ["quotes", "rfq_id", "rfqs"],
  ["sales_orders", "quote_id", "quotes"],
  ["sales_orders", "customer_id", "customers"],
  ["sales_orders", "converted_to_job_id", "jobs"],
  ["jobs", "quote_id", "quotes"],
  ["jobs", "converted_from_sales_order_id", "sales_orders"],
  ["invoices", "job_id", "jobs"],
  ["delivery_notes", "sales_order_id", "sales_orders"],
  ["delivery_notes", "customer_id", "customers"],
];

let world: SyntheticWorld;
const parents: Record<"alpha" | "beta", Record<Parent, string>> = { alpha: {} as Record<Parent, string>, beta: {} as Record<Parent, string> };

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  const admin = adminClient();
  for (const tenant of ["alpha", "beta"] as const) {
    for (const parent of ["rfqs", "quotes", "customers", "jobs", "sales_orders"] as Parent[]) {
      const { data, error } = await admin.from(parent).insert(ROWS[parent](world.tenants[tenant].id, `${tenant}-parent`)).select("id").single();
      if (error) throw new Error(`${parent}: ${error.message}`);
      parents[tenant][parent] = data.id;
    }
  }
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("cross-organisation links are refused", () => {
  for (const [child, column, parent] of LINKS) {
    it(`${child}.${column} -> ${parent}: other tenant refused on insert and update; own tenant and null allowed`, async () => {
      const client = await signedInClient(world.tenants.alpha.users.admin);
      const alpha = world.tenants.alpha.id;
      const tag = `${child}-${column}`;

      const foreign = await client.from(child).insert({ ...ROWS[child](alpha, `${tag}-x`), [column]: parents.beta[parent] }).select("id");
      expect({ insertForeign: foreign.error ? "refused" : "allowed" }).toEqual({ insertForeign: "refused" });

      const own = await client.from(child).insert({ ...ROWS[child](alpha, `${tag}-own`), [column]: parents.alpha[parent] }).select("id").single();
      expect(own.error).toBeNull();
      const blank = await client.from(child).insert({ ...ROWS[child](alpha, `${tag}-null`), [column]: null }).select("id").single();
      expect(blank.error).toBeNull();

      const update = await client.from(child).update({ [column]: parents.beta[parent] }).eq("id", blank.data!.id).select(column);
      expect({ updateForeign: update.error ? "refused" : "allowed" }).toEqual({ updateForeign: "refused" });
      const { data: stored } = await adminClient().from(child).select(column).eq("id", blank.data!.id).single();
      expect((stored as Record<string, unknown> | null)?.[column] ?? null).toBeNull();
    });
  }

  it("the service role (imports) is held to the same rule", async () => {
    const { error } = await adminClient().from("invoices").insert({ ...ROWS.invoices(world.tenants.alpha.id, "svc"), job_id: parents.beta.jobs });
    expect(error).not.toBeNull();
  });
});

describe("existing behaviour kept", () => {
  it("order and job can still be linked both ways inside one transaction (deferrable import)", async () => {
    const alpha = world.tenants.alpha.id;
    await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("set constraints all deferred");
        const job = await db.query<{ id: string }>(
          "insert into public.jobs (organization_id, job_no, customer, converted_from_sales_order_id) values ($1, 'J-DEFER', 'C', gen_random_uuid()) returning id", [alpha]);
        const so = await db.query<{ id: string }>(
          "insert into public.sales_orders (organization_id, so_number, converted_to_job_id) values ($1, 'SO-DEFER', $2) returning id", [alpha, job.rows[0].id]);
        await db.query("update public.jobs set converted_from_sales_order_id = $1 where id = $2", [so.rows[0].id, job.rows[0].id]);
        await db.query("commit");
      } catch (error) {
        await db.query("rollback");
        throw error;
      }
    });
    const { data } = await adminClient().from("sales_orders").select("converted_to_job_id").eq("so_number", "SO-DEFER").single();
    expect(data?.converted_to_job_id).toBeTruthy();
  });

  for (const [child, column, parent, childRow, parentRow] of [
    ["jobs", "converted_from_sales_order_id", "sales_orders", "(organization_id, job_no, customer, converted_from_sales_order_id) values ($1, 'J-DX', 'C', $2)", "(id, organization_id, so_number) values ($2, $1, 'SO-DX')"],
    ["sales_orders", "converted_to_job_id", "jobs", "(organization_id, so_number, converted_to_job_id) values ($1, 'SO-DY', $2)", "(id, organization_id, job_no, customer) values ($2, $1, 'J-DY', 'C')"],
  ] as const) {
    it(`a deferred ${child}.${column} link to a ${parent} created later in another company is refused at commit`, async () => {
      const outcome = await withDb(async (db) => {
        const target = (await db.query<{ id: string }>("select gen_random_uuid() as id")).rows[0].id;
        await db.query("begin");
        try {
          await db.query("set constraints all deferred");
          await db.query(`insert into public.${child} ${childRow}`, [world.tenants.alpha.id, target]);
          await db.query(`insert into public.${parent} ${parentRow}`, [world.tenants.beta.id, target]);
          await db.query("commit");
          return "committed";
        } catch {
          await db.query("rollback").catch(() => undefined);
          return "refused";
        }
      });
      expect(outcome).toBe("refused");
    });
  }

  it("deleting a parent still clears the link (ON DELETE SET NULL)", async () => {
    const admin = adminClient();
    const alpha = world.tenants.alpha.id;
    const { data: customer } = await admin.from("customers").insert(ROWS.customers(alpha, "doomed")).select("id").single();
    const { data: dn } = await admin.from("delivery_notes").insert({ ...ROWS.delivery_notes(alpha, "doomed"), customer_id: customer!.id }).select("id").single();
    expect((await admin.from("customers").delete().eq("id", customer!.id)).error).toBeNull();
    const { data: after } = await admin.from("delivery_notes").select("customer_id").eq("id", dn!.id).single();
    expect(after?.customer_id).toBeNull();
  });
});
