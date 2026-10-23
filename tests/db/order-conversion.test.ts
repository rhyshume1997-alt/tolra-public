/**
 * Sales order -> job conversion (audit B2: D3, D4, D15, A3): one transaction, exactly one job per order, retries
 * and concurrent callers get the same job, a failure part-way leaves nothing behind.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
let admin: SupabaseClient;
let n = 0;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  admin = await signedInClient(world.tenants.alpha.users.admin);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

/** A quote with two mixed-VAT lines and an order for it (net value), created with the service role. */
async function orderWithQuote(quoteRef: string | null, lines = [{ description: "Flange 80mm", quantity: 12, unit_price: 150, vat_pct: 20 }, { description: "Spacer", quantity: 4, unit_price: 2.5, vat_pct: 0 }]) {
  n += 1;
  const service = adminClient();
  const org = world.tenants.alpha.id;
  let quoteId: string | null = null;
  if (quoteRef) {
    // Draft first, lines, then accepted: issued quotes' lines are locked (migration 020).
    const { data: quote, error } = await service.from("quotes").insert({ organization_id: org, quote_ref: quoteRef, customer: "Acme", status: "draft", total_value: 0 }).select("id").single();
    if (error) throw new Error(error.message);
    quoteId = quote.id;
    const { error: lineError } = await service.from("quote_line_items").insert(lines.map((l, position) => ({ ...l, position, quote_id: quoteId, organization_id: org })));
    if (lineError) throw new Error(lineError.message);
    // Its stored total must equal its lines (net + VAT per line) before it can leave draft (migration 027).
    const pence = (x: number) => Math.round(x * 100);
    const total = lines.reduce((sum, l) => { const net = pence(l.quantity * l.unit_price); return sum + net + Math.round(net * l.vat_pct / 100); }, 0) / 100;
    const { error: totalError } = await service.from("quotes").update({ total_value: total, vat_enabled: true }).eq("id", quoteId);
    if (totalError) throw new Error(totalError.message);
    const { error: acceptError } = await service.from("quotes").update({ status: "accepted" }).eq("id", quoteId);
    if (acceptError) throw new Error(acceptError.message);
  }
  const { data: order, error } = await service.from("sales_orders").insert({
    // An order entered by hand: its reference is the customer's PO, stored in both columns (the job takes customer_po, 058).
    organization_id: org, so_number: `PO-CUST-${n}`, customer_po: `PO-CUST-${n}`, customer: "Acme", quote_id: quoteId, quote_ref: quoteRef, total_value: 1810, status: "open", delivery_date: "2026-11-20", order_date: "2026-10-09",
  }).select("id").single();
  if (error) throw new Error(error.message);
  return order.id as string;
}

const convert = (client: SupabaseClient, id: string) => client.rpc("convert_sales_order", { p_order: id });

async function jobsFor(orderId: string) {
  const { data } = await adminClient().from("jobs").select("id, job_no, specification, drawings, quantity_required, quote_id, customer_po").eq("converted_from_sales_order_id", orderId);
  return data ?? [];
}

describe("conversion", () => {
  it("creates one job with the quote's number, net value, workshop details and the link", async () => {
    const order = await orderWithQuote("QUO-0101");
    const { data, error } = await convert(admin, order);
    expect(error).toBeNull();
    expect(data).toMatchObject({ job_no: "J-0101", created: true });
    const [job] = await jobsFor(order);
    expect(job.drawings).toEqual([]);
    expect(job.customer_po).toBe(`PO-CUST-${n}`);
    expect(job.specification).toContain("Flange 80mm x 12");
    expect(job.specification).toContain("Spacer x 4");
    expect(job.specification).not.toMatch(/150|2\.5/);
    expect(job.quote_id).toBeTruthy();
    const { data: value } = await adminClient().from("job_values").select("value").eq("job_id", job.id).single();
    expect(Number(value?.value)).toBe(1810);
    const { data: so } = await adminClient().from("sales_orders").select("status, converted_to_job_id").eq("id", order).single();
    expect(so).toEqual({ status: "converted", converted_to_job_id: job.id });
  });

  it("retries, double clicks and converting after despatch all return the same job", async () => {
    const order = await orderWithQuote("QUO-0102");
    const first = await convert(admin, order);
    expect((await convert(admin, order)).data).toEqual({ ...first.data, created: false });
    await adminClient().from("sales_orders").update({ status: "despatched" }).eq("id", order);
    expect((await convert(admin, order)).data).toEqual({ ...first.data, created: false });
    expect(await jobsFor(order)).toHaveLength(1);
  });

  it("five people converting the same order at once get one job", async () => {
    const order = await orderWithQuote("QUO-0103");
    const clients = await Promise.all(Array.from({ length: 5 }, () => signedInClient(world.tenants.alpha.users.admin)));
    const results = await Promise.all(clients.map((client) => convert(client, order)));
    expect(results.map((r) => r.error)).toEqual([null, null, null, null, null]);
    expect(results.filter((r) => r.data?.created).length).toBe(1);
    expect(new Set(results.map((r) => r.data?.job_id)).size).toBe(1);
    const jobs = await jobsFor(order);
    expect(jobs).toHaveLength(1);
    const { count } = await adminClient().from("job_values").select("job_id", { count: "exact", head: true }).eq("job_id", jobs[0].id);
    expect(count).toBe(1);
  });

  it("uses the next J number when the quote's job number is taken; a single whole-number line sets the quantity", async () => {
    const first = await orderWithQuote("QUO-0104", [{ description: "Shaft", quantity: 25, unit_price: 10, vat_pct: 20 }]);
    const second = await orderWithQuote(null);
    await adminClient().from("sales_orders").update({ quote_ref: "QUO-0104" }).eq("id", second);
    expect((await convert(admin, first)).data).toMatchObject({ job_no: "J-0104" });
    const other = await convert(admin, second);
    expect(other.error).toBeNull();
    expect(other.data.job_no).toMatch(/^J-\d{4,}$/);
    expect(other.data.job_no).not.toBe("J-0104");
    expect((await jobsFor(first))[0].quantity_required).toBe(25);
  });

  it("a manual order (no quote) still converts", async () => {
    const order = await orderWithQuote(null);
    const { data, error } = await convert(admin, order);
    expect(error).toBeNull();
    expect(data.created).toBe(true);
    const [job] = await jobsFor(order);
    expect(job.quantity_required).toBeNull();
    expect(job.specification).toBe(`Sales order PO-CUST-${n}; customer delivery required 20/11/2026.`);
  });

  it("an existing link from before (job side only) is returned and the order link repaired", async () => {
    const order = await orderWithQuote(null);
    const { data: legacy } = await adminClient().from("jobs").insert({ organization_id: world.tenants.alpha.id, job_no: `J-LEG-${n}`, customer: "Acme", converted_from_sales_order_id: order }).select("id").single();
    const { data } = await convert(admin, order);
    expect(data).toEqual({ job_id: legacy!.id, job_no: `J-LEG-${n}`, created: false });
    const { data: so } = await adminClient().from("sales_orders").select("converted_to_job_id").eq("id", order).single();
    expect(so?.converted_to_job_id).toBe(legacy!.id);
  });
});

describe("refusals and rollback", () => {
  it("workshop and viewer can't convert; another company's admin can't see the order", async () => {
    const order = await orderWithQuote(null);
    for (const role of ["workshop", "viewer"] as const) {
      const { error } = await convert(await signedInClient(world.tenants.alpha.users[role]), order);
      expect({ role, refused: Boolean(error) }).toEqual({ role, refused: true });
    }
    const { error } = await convert(await signedInClient(world.tenants.beta.users.admin), order);
    expect(error?.message).toMatch(/not found/i);
    expect(await jobsFor(order)).toHaveLength(0);
  });

  it("a failure part-way (saving the value) leaves no job, no value and the order unchanged; a retry then works", async () => {
    const order = await orderWithQuote("QUO-0105");
    const name = `e2e_fail_value_${n}`;
    await withDb(async (db) => {
      await db.query(`create function public.${name}() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$`);
      await db.query(`create trigger ${name} before insert on public.job_values for each row execute function public.${name}()`);
    });
    try {
      const { error } = await convert(admin, order);
      expect(error?.message).toMatch(/injected failure/);
      expect(await jobsFor(order)).toHaveLength(0);
      const { data: so } = await adminClient().from("sales_orders").select("status, converted_to_job_id").eq("id", order).single();
      expect(so).toEqual({ status: "open", converted_to_job_id: null });
    } finally {
      await withDb(async (db) => {
        await db.query(`drop trigger ${name} on public.job_values`);
        await db.query(`drop function public.${name}()`);
      });
    }
    expect((await convert(admin, order)).data).toMatchObject({ created: true, job_no: "J-0105" });
  });

  it("the database refuses a second job for the same order", async () => {
    const order = await orderWithQuote(null);
    await convert(admin, order);
    const { error } = await adminClient().from("jobs").insert({ organization_id: world.tenants.alpha.id, job_no: `J-DUP-${n}`, customer: "Acme", converted_from_sales_order_id: order });
    expect(error?.code).toBe("23505");
  });

  it("the workshop sees the converted job but not its value", async () => {
    const order = await orderWithQuote(null);
    const { data } = await convert(admin, order);
    const workshop = await signedInClient(world.tenants.alpha.users.workshop);
    expect((await workshop.from("jobs").select("id").eq("id", data.job_id)).data).toHaveLength(1);
    expect((await workshop.from("job_values").select("value").eq("job_id", data.job_id)).data ?? []).toEqual([]);
  });
});

describe("several orders for one quote converting at the same time (migration 033)", () => {
  /**
   * Another order carrying the same quote reference as the first. Since 058 a quote has at most one order linked by quote_id
   * (sales_orders_one_per_quote, proved in quote-to-job.test.ts), so the siblings carry only the reference: convert_sales_order takes the
   * job number from the order's quote_ref first, so they still race for the quote's J number exactly as before.
   */
  async function siblingOrder(firstOrder: string) {
    const service = adminClient();
    const { data: first } = await service.from("sales_orders").select("quote_id, quote_ref").eq("id", firstOrder).single();
    n += 1;
    const { data, error } = await service.from("sales_orders").insert({
      organization_id: world.tenants.alpha.id, so_number: `PO-CUST-${n}`, customer_po: `PO-CUST-${n}`, customer: "Acme", quote_id: null, quote_ref: first!.quote_ref,
      total_value: 500, status: "open", delivery_date: "2026-11-20", order_date: "2026-10-09",
    }).select("id").single();
    if (error) throw new Error(error.message);
    return data.id as string;
  }

  it("four orders from one quote: no error, four different job numbers, one of them the quote's number", async () => {
    for (let round = 0; round < 3; round += 1) {
      const quoteRef = `QUO-${7770 + round * 10}`;
      const first = await orderWithQuote(quoteRef);
      const orders = [first, await siblingOrder(first), await siblingOrder(first), await siblingOrder(first)];
      const results = await Promise.all(orders.map((id) => convert(admin, id)));
      expect(results.map((r) => r.error)).toEqual([null, null, null, null]);
      const numbers = results.map((r) => r.data.job_no as string);
      expect(new Set(numbers).size).toBe(4);
      expect(numbers.filter((no) => no === `J-${quoteRef.slice(4)}`)).toHaveLength(1);
      for (const result of results) expect(result.data.created).toBe(true);
    }
  });

  it("a quote number that is taken already is skipped, not an error", async () => {
    const first = await orderWithQuote("QUO-7800");
    const second = await siblingOrder(first);
    expect((await convert(admin, first)).data).toMatchObject({ created: true, job_no: "J-7800" });
    const other = await convert(admin, second);
    expect(other.error).toBeNull();
    expect(other.data).toMatchObject({ created: true });
    expect(other.data.job_no).not.toBe("J-7800");
  });
});
