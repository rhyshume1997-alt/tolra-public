/**
 * A converted sales order's value and VAT are its job's (migration 088). Proves in SQL (as PostgREST runs it: role authenticated with
 * the JWT claims; the service role and the owner for the exemptions), so it also runs against plain PostgreSQL with stand-ins:
 *   - once converted (convert_sales_order), a change of total_value, vat_enabled, vat_pct or vat_exempt is refused for admin and office
 *     (42501, hint sales_order_converted, "Converted to J-...: change the job, not the order.") and the row is unchanged;
 *   - the same values written again (the Edit dialog sends all four) and the other fields still save; clearing the order's own link
 *     first does not reopen its money (the job still names the order);
 *   - an order not converted is still edited by admin and office; the conversion itself still works and carries the value to the job;
 *   - the database owner and the service role are exempt (maintenance, the server's own jobs);
 *   - the job's side of the link: a signed-in clear or change of jobs.converted_from_sales_order_id is refused while the order exists
 *     (42501, hint sales_order_converted, "J-... was made from SO-...: the link stays."), so clearing both links and then editing (the
 *     three-step way round) stops at the job; the conversion still sets it; the owner and the service role may clear it; deleting the
 *     order still sets it to NULL (ON DELETE SET NULL, after the order is gone). The data import and its undo never UPDATE a job's link
 *     (INSERTs and DELETEs only), so the delete case is the one that path takes.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, createSyntheticWorld, destroySyntheticWorld, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
let seq = 0;
type Role = "admin" | "office" | "workshop";
const alpha = () => world.tenants.alpha;

/** One statement as a signed-in member of alpha (authenticated, aal2: admins' two-step sign-in done), in its own transaction. */
async function asRole<R extends Record<string, unknown> = Record<string, unknown>>(role: Role, text: string, params: unknown[] = []): Promise<R[]> {
  return withDb(async (db) => {
    await db.query("begin");
    try {
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ sub: alpha().users[role].id, role: "authenticated", aud: "authenticated", session_id: randomUUID(), aal: "aal2" })]);
      const rows = (await db.query<R>(text, params)).rows;
      await db.query("commit");
      return rows;
    } catch (err) {
      await db.query("rollback");
      throw err;
    }
  });
}
async function refusal(role: Role, text: string, params: unknown[] = []) {
  try {
    await asRole(role, text, params);
    return null;
  } catch (err) {
    const e = err as { code?: string; hint?: string; message: string };
    return { code: e.code, hint: e.hint, message: e.message };
  }
}
const owner = <R extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) =>
  withDb(async (db) => (await db.query<R>(text, params)).rows);

type Order = { id: string; total_value: string; vat_enabled: boolean; vat_pct: string; vat_exempt: boolean; status: string; converted_to_job_id: string | null };
const jobLink = async (jobId: string) =>
  (await owner<{ l: string | null }>("select converted_from_sales_order_id as l from public.jobs where id = $1", [jobId]))[0]?.l ?? null;
const soNumber = async (id: string) => (await owner<{ n: string }>("select so_number as n from public.sales_orders where id = $1", [id]))[0].n;
const read = async (id: string) =>
  (await owner<Order>("select id, total_value, vat_enabled, vat_pct, vat_exempt, status, converted_to_job_id from public.sales_orders where id = $1", [id]))[0];

/** A new open order written by office, as the app's New sales order form does. */
async function newOrder() {
  seq += 1;
  const ref = `PO-088-${world.runId}-${seq}`;
  const [row] = await asRole<{ id: string }>("office", `insert into public.sales_orders (organization_id, so_number, customer_po, customer, total_value, vat_enabled, vat_pct, vat_exempt, status)
    values ($1, $2, $2, 'Converted Guard Co', 480, true, 20, false, 'open') returning id`, [alpha().id, ref]);
  return row.id;
}
async function convert(id: string, role: Role = "office") {
  const [row] = await asRole<{ r: { job_id: string; job_no: string; created: boolean } }>(role, "select public.convert_sales_order($1) as r", [id]);
  return row.r;
}

const MONEY_CHANGES: Array<[string, string, unknown]> = [
  ["total_value", "update public.sales_orders set total_value = $2 where id = $1", 999],
  ["vat_enabled", "update public.sales_orders set vat_enabled = $2 where id = $1", false],
  ["vat_pct", "update public.sales_orders set vat_pct = $2 where id = $1", 5],
  ["vat_exempt", "update public.sales_orders set vat_exempt = $2 where id = $1", true],
];

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

describe("088: a converted sales order's value and VAT", () => {
  it("the conversion itself still works and carries the value to the job", async () => {
    const id = await newOrder();
    const job = await convert(id);
    expect(job.created).toBe(true);
    const order = await read(id);
    expect(order).toMatchObject({ status: "converted", converted_to_job_id: job.job_id, total_value: "480.00" });
    expect((await owner<{ value: string }>("select value from public.job_values where job_id = $1", [job.job_id]))[0].value).toBe("480.00");
    // A second call hands back the same job and changes nothing (018).
    expect(await convert(id, "admin")).toMatchObject({ job_id: job.job_id, created: false });
  });

  for (const role of ["admin", "office"] as const) {
    it.each(MONEY_CHANGES)(`refuses ${role} a change of %s once converted; the row is unchanged`, async (_column, sql, value) => {
      const id = await newOrder();
      const job = await convert(id);
      const before = await read(id);
      const refused = await refusal(role, sql, [id, value]);
      expect(refused).toEqual({ code: "42501", hint: "sales_order_converted", message: `Converted to ${job.job_no}: change the job, not the order.` });
      expect(await read(id)).toEqual(before);
    });
  }

  it("the same values written again (the Edit dialog sends all four) and the other fields still save on a converted order", async () => {
    const id = await newOrder();
    await convert(id);
    await asRole("office", `update public.sales_orders set total_value = 480, vat_enabled = true, vat_pct = 20, vat_exempt = false,
      notes = 'Delivery to site B', delivery_date = '2026-11-30' where id = $1`, [id]);
    expect((await owner<{ notes: string; d: string }>("select notes, delivery_date::text as d from public.sales_orders where id = $1", [id]))[0])
      .toEqual({ notes: "Delivery to site B", d: "2026-11-30" });
    // A money change in the same statement as allowed fields refuses the whole statement.
    expect((await refusal("admin", "update public.sales_orders set notes = 'x', total_value = 1 where id = $1", [id]))?.hint).toBe("sales_order_converted");
    expect((await owner<{ notes: string }>("select notes from public.sales_orders where id = $1", [id]))[0].notes).toBe("Delivery to site B");
  });

  it("clearing the order's own link first does not reopen its money: the job still names the order", async () => {
    const id = await newOrder();
    const job = await convert(id);
    await asRole("admin", "update public.sales_orders set converted_to_job_id = null where id = $1", [id]);
    expect((await read(id)).converted_to_job_id).toBeNull();
    expect(await refusal("admin", "update public.sales_orders set total_value = 1 where id = $1", [id]))
      .toEqual({ code: "42501", hint: "sales_order_converted", message: `Converted to ${job.job_no}: change the job, not the order.` });
    expect((await read(id)).total_value).toBe("480.00");
  });

  it("an order not converted is still edited by admin and office", async () => {
    const id = await newOrder();
    await asRole("office", "update public.sales_orders set total_value = 500, vat_pct = 5 where id = $1", [id]);
    await asRole("admin", "update public.sales_orders set total_value = 520, vat_enabled = false, vat_exempt = true where id = $1", [id]);
    expect(await read(id)).toMatchObject({ total_value: "520.00", vat_enabled: false, vat_pct: "5.00", vat_exempt: true, converted_to_job_id: null });
    // And converts with the edited value.
    const job = await convert(id, "admin");
    expect((await owner<{ value: string }>("select value from public.job_values where job_id = $1", [job.job_id]))[0].value).toBe("520.00");
  });

  it("the database owner and the service role are exempt (maintenance, the server's own jobs)", async () => {
    const id = await newOrder();
    await convert(id);
    await owner("update public.sales_orders set total_value = 481 where id = $1", [id]);
    await withDb(async (db) => {
      await db.query("begin");
      await db.query("set local role service_role");
      await db.query("update public.sales_orders set vat_pct = 5 where id = $1", [id]);
      await db.query("commit");
    });
    expect(await read(id)).toMatchObject({ total_value: "481.00", vat_pct: "5.00" });
  });

  for (const role of ["office", "admin", "workshop"] as const) {
    it(`refuses ${role} clearing the job's link while the order exists, so the three-step way round stops at step 2`, async () => {
      const id = await newOrder();
      const job = await convert(id);
      // Step 1: the order's own link is not frozen (workshop cannot update orders at all; office does it for that case).
      await asRole(role === "workshop" ? "office" : role, "update public.sales_orders set converted_to_job_id = null where id = $1", [id]);
      // Step 2: refused.
      expect(await refusal(role, "update public.jobs set converted_from_sales_order_id = null where id = $1", [job.job_id]))
        .toEqual({ code: "42501", hint: "sales_order_converted", message: `${job.job_no} was made from ${await soNumber(id)}: the link stays.` });
      expect(await jobLink(job.job_id)).toBe(id);
      // Step 3: the money stays frozen.
      if (role !== "workshop") {
        expect(await refusal(role, "update public.sales_orders set total_value = 1 where id = $1", [id]))
          .toEqual({ code: "42501", hint: "sales_order_converted", message: `Converted to ${job.job_no}: change the job, not the order.` });
      }
      expect((await read(id)).total_value).toBe("480.00");
    });
  }

  it("refuses re-pointing a job's link to another order; the same link written again and other job fields still save", async () => {
    const id = await newOrder();
    const other = await newOrder();
    const job = await convert(id);
    expect((await refusal("admin", "update public.jobs set converted_from_sales_order_id = $2 where id = $1", [job.job_id, other]))?.hint)
      .toBe("sales_order_converted");
    await asRole("office", "update public.jobs set converted_from_sales_order_id = $2, description = 'Same link' where id = $1", [job.job_id, id]);
    await asRole("workshop", "update public.jobs set description = 'Workshop text' where id = $1", [job.job_id]);
    expect(await jobLink(job.job_id)).toBe(id);
  });

  it("the conversion still sets the job's link, and a job's empty link may be set", async () => {
    const id = await newOrder();
    const job = await convert(id, "admin");
    expect(await jobLink(job.job_id)).toBe(id);
    const next = await newOrder();
    await owner("update public.jobs set converted_from_sales_order_id = null where id = $1", [job.job_id]);
    await asRole("office", "update public.jobs set converted_from_sales_order_id = $2 where id = $1", [job.job_id, next]);
    expect(await jobLink(job.job_id)).toBe(next);
  });

  it("the database owner and the service role may clear the job's link", async () => {
    const first = await convert(await newOrder());
    await owner("update public.jobs set converted_from_sales_order_id = null where id = $1", [first.job_id]);
    expect(await jobLink(first.job_id)).toBeNull();
    const second = await convert(await newOrder());
    await withDb(async (db) => {
      await db.query("begin");
      await db.query("set local role service_role");
      await db.query("update public.jobs set converted_from_sales_order_id = null where id = $1", [second.job_id]);
      await db.query("commit");
    });
    expect(await jobLink(second.job_id)).toBeNull();
  });

  it("deleting a converted order (admin signed in, and the owner) still sets the job's link to NULL and keeps the job", async () => {
    for (const who of ["admin", "owner"] as const) {
      const id = await newOrder();
      const job = await convert(id);
      if (who === "admin") await asRole("admin", "delete from public.sales_orders where id = $1", [id]);
      else await owner("delete from public.sales_orders where id = $1", [id]);
      expect((await owner<{ n: number }>("select count(*)::int as n from public.sales_orders where id = $1", [id]))[0].n, who).toBe(0);
      expect((await owner<{ n: number }>("select count(*)::int as n from public.jobs where id = $1", [job.job_id]))[0].n, who).toBe(1);
      expect(await jobLink(job.job_id), who).toBeNull();
    }
  });
});
