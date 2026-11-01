/**
 * Quote accepted -> sales order -> job, automatic (migration 058). accept_quote accepts the quote, makes its one sales order (the terms
 * lib/order-from-quote.ts would carry, refused exactly when it refuses) and, when the company's setting is automatic, its job (not
 * started). One order and one job per quote whatever the timing; other companies' quotes, viewers and the workshop refused; the second
 * step enforced; the customer PO set later follows to the order's reference and its job; convert_sales_order takes customer_po.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { documentTotals } from "@/lib/money";
import { orderTermsFromQuote } from "@/lib/order-from-quote";
import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, setRequireAdminMfaForTest, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { enrolTotp, passSecondStep } from "../support/totp";

let world: SyntheticWorld;
const as = {} as Record<"admin" | "office" | "workshop" | "viewer", SupabaseClient>;
let seq = 0;
const org = () => world.tenants.alpha.id;

type Line = { quantity: number; unit_price: number; vat_pct: number; vat_exempt?: boolean };
type Accepted = {
  quote_id: string; accepted: boolean; created: boolean; so_id: string | null; so_number: string | null; so_created: boolean; provisional: boolean;
  job_id: string | null; job_no: string | null; job_created: boolean; auto_convert: boolean; needs: string | null; reason: string | null; job_reason: string | null;
};

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
});

afterAll(async () => {
  if (world) {
    await withDb((db) => db.query("update public.organizations set require_admin_mfa = false where id = any($1)", [[world.tenants.alpha.id, world.tenants.beta.id]]));
    await destroySyntheticWorld(world.runId);
  }
});

/** A quote (sent unless told otherwise) whose stored total equals its lines, made with the service role. */
async function quote(lines: Line[], opts: { vat?: boolean; status?: "draft" | "sent"; tenant?: "alpha" | "beta"; ref?: string; total?: number } = {}) {
  seq += 1;
  const service = adminClient();
  const organization = world.tenants[opts.tenant ?? "alpha"].id;
  const vat = opts.vat ?? true;
  const ref = opts.ref ?? `QQ-${world.runId}-${seq}`;
  const total = opts.total ?? documentTotals(lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unit_price, vatPct: l.vat_pct, vatExempt: Boolean(l.vat_exempt) })), 0, { vatEnabled: vat }).total;
  const { data, error } = await service.from("quotes").insert({ organization_id: organization, quote_ref: ref, customer: `Q2J Co ${seq}`, status: "draft", total_value: total, vat_enabled: vat }).select("id").single();
  if (error) throw new Error(error.message);
  if (lines.length) {
    const { error: lineError } = await service.from("quote_line_items").insert(lines.map((l, position) => ({ organization_id: organization, quote_id: data.id, position, description: `Part ${position}`, vat_exempt: false, ...l })));
    if (lineError) throw new Error(lineError.message);
  }
  if ((opts.status ?? "sent") === "sent") {
    const { error: sentError } = await service.from("quotes").update({ status: "sent" }).eq("id", data.id);
    if (sentError) throw new Error(sentError.message);
  }
  return { id: data.id as string, ref, lines, vat, total };
}

const accept = (client: SupabaseClient, id: string, po: string | null = null, delivery: string | null = null) =>
  client.rpc("accept_quote", { p_quote: id, p_customer_po: po, p_delivery_date: delivery });
const ok = async (client: SupabaseClient, id: string, po: string | null = null, delivery: string | null = null) => {
  const { data, error } = await accept(client, id, po, delivery);
  if (error) throw new Error(`accept_quote: ${error.message}`);
  return data as Accepted;
};
const ordersFor = async (quoteId: string) => (await adminClient().from("sales_orders").select("*").eq("quote_id", quoteId)).data ?? [];
const jobsFor = async (orderIds: string[]) => (orderIds.length ? (await adminClient().from("jobs").select("*").in("converted_from_sales_order_id", orderIds)).data ?? [] : []);
const acceptEvents = (quoteId: string) =>
  withDb(async (db) => (await db.query("select metadata from security_audit.audit_log where action = 'ACCEPT' and entity_table = 'quotes' and entity_id = $1", [quoteId])).rows);
const setAuto = (on: boolean) => withDb((db) => db.query(
  "insert into public.organization_settings (organization_id, auto_convert_sales_orders) values ($1, $2) on conflict (organization_id) do update set auto_convert_sales_orders = excluded.auto_convert_sales_orders", [org(), on]));
/** What the Sales Orders page (lib/order-from-quote.ts) would carry for this quote: the database must agree exactly. */
const appTerms = (q: { lines: Line[]; vat: boolean; total: number }) =>
  orderTermsFromQuote({ vat_enabled: q.vat, total_value: q.total }, q.lines.map((l) => ({ ...l, vat_exempt: Boolean(l.vat_exempt) })), true);

describe("accepting a quote makes its sales order and its job", () => {
  it("a sent quote: accepted once, one order at the app's terms with a provisional number, one job not started, one ACCEPT event", async () => {
    // A QUO number, so the job takes the quote's number (J-4101) as Convert to Job does (a fresh company each run).
    const q = await quote([{ quantity: 10, unit_price: 25, vat_pct: 20 }], { ref: "QUO-4101" });
    const result = await ok(as.office, q.id, null, "2026-12-01");
    expect(result).toMatchObject({ accepted: true, created: true, so_created: true, provisional: true, job_created: true, auto_convert: true, needs: null, reason: null, job_reason: null });
    const { data: stored } = await adminClient().from("quotes").select("status, accepted_at, accepted_by").eq("id", q.id).single();
    expect(stored).toMatchObject({ status: "accepted", accepted_by: world.tenants.alpha.users.office.id });
    expect(stored!.accepted_at).toBeTruthy();

    const orders = await ordersFor(q.id);
    expect(orders).toHaveLength(1);
    const terms = appTerms(q);
    if (!terms.ok) throw new Error("expected terms");
    expect({ value: Number(orders[0].total_value), vat: orders[0].vat_enabled, pct: Number(orders[0].vat_pct), exempt: orders[0].vat_exempt })
      .toEqual({ value: terms.value, vat: terms.vatOn, pct: Number(terms.vat), exempt: false });
    expect(orders[0]).toMatchObject({ id: result.so_id, so_number: result.so_number, customer_po: null, customer: `Q2J Co ${seq}`, quote_ref: q.ref, status: "converted", delivery_date: "2026-12-01", organization_id: org() });
    expect(orders[0].so_number).toMatch(/^SO-\d{4,}$/);

    const jobs = await jobsFor([orders[0].id]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: result.job_id, job_no: result.job_no, started_at: null, finished_at: null, stage: "material", customer_po: null, organization_id: org(), due_date: "2026-12-01" });
    expect(jobs[0].job_no).toBe(`J-${q.ref.slice(4)}`);
    expect(orders[0].converted_to_job_id).toBe(jobs[0].id);
    const events = await acceptEvents(q.id);
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ so_id: result.so_id, job_id: result.job_id, so_created: true, job_created: true });
  });

  it("with the customer's PO: the order is referenced by it, and the job carries it", async () => {
    const q = await quote([{ quantity: 2, unit_price: 20, vat_pct: 20 }], { vat: false });
    const result = await ok(as.admin, q.id, `  PO-Q2J-${seq}  `);
    expect(result).toMatchObject({ so_created: true, provisional: false, so_number: `PO-Q2J-${seq}`, job_created: true });
    const [order] = await ordersFor(q.id);
    expect(order).toMatchObject({ so_number: `PO-Q2J-${seq}`, customer_po: `PO-Q2J-${seq}`, vat_enabled: false });
    expect(Number(order.total_value)).toBe(40);
    const [job] = await jobsFor([order.id]);
    expect(job.customer_po).toBe(`PO-Q2J-${seq}`);
  });

  it("a draft quote can be accepted directly (020), and gets its order and job the same way", async () => {
    const q = await quote([{ quantity: 1, unit_price: 100, vat_pct: 5 }], { status: "draft" });
    const result = await ok(as.admin, q.id);
    expect(result).toMatchObject({ accepted: true, so_created: true, job_created: true });
    expect(Number((await ordersFor(q.id))[0].vat_pct)).toBe(5);
  });
});

describe("one order and one job per quote, whatever the timing", () => {
  it("accepting again (a double click, a retry) changes nothing and returns the same order and job; no second ACCEPT event", async () => {
    const q = await quote([{ quantity: 3, unit_price: 10, vat_pct: 20 }]);
    const first = await ok(as.admin, q.id);
    const snapshot = async () => JSON.stringify([await ordersFor(q.id), await jobsFor((await ordersFor(q.id)).map((o) => o.id)), (await adminClient().from("quotes").select("*").eq("id", q.id).single()).data]);
    const before = await snapshot();
    for (const client of [as.admin, as.office]) {
      const again = await ok(client, q.id, "PO-TOO-LATE");
      expect(again).toMatchObject({ accepted: false, created: false, so_id: first.so_id, so_number: first.so_number, so_created: false, job_id: first.job_id, job_no: first.job_no, job_created: false });
    }
    expect(await snapshot()).toBe(before);
    expect(await acceptEvents(q.id)).toHaveLength(1);
  });

  it("two people accepting at the same moment: one accepts and makes the order and job, the other gets the same ones", async () => {
    for (let round = 0; round < 3; round += 1) {
      const q = await quote([{ quantity: 4, unit_price: 12.5, vat_pct: 20 }]);
      const results = await Promise.all([accept(as.admin, q.id), accept(as.office, q.id), accept(as.admin, q.id)]);
      expect(results.map((r) => r.error)).toEqual([null, null, null]);
      const data = results.map((r) => r.data as Accepted);
      expect(data.filter((d) => d.accepted)).toHaveLength(1);
      expect(data.filter((d) => d.so_created)).toHaveLength(1);
      expect(data.filter((d) => d.job_created)).toHaveLength(1);
      expect(new Set(data.map((d) => d.so_id)).size).toBe(1);
      expect(new Set(data.map((d) => d.job_id)).size).toBe(1);
      const orders = await ordersFor(q.id);
      expect(orders).toHaveLength(1);
      expect(await jobsFor(orders.map((o) => o.id))).toHaveLength(1);
      expect(await acceptEvents(q.id)).toHaveLength(1);
    }
  });

  it("the table refuses a second order for a quote, whoever writes it (sales_orders_one_per_quote)", async () => {
    const q = await quote([{ quantity: 1, unit_price: 50, vat_pct: 20 }]);
    await ok(as.admin, q.id);
    const { error } = await adminClient().from("sales_orders").insert({ organization_id: org(), so_number: `PO-DUP-${seq}`, customer_po: `PO-DUP-${seq}`, customer: "Dup", quote_id: q.id, total_value: 50, status: "open" });
    expect(error?.code).toBe("23505");
    // An earlier build's New Sales Order is a plain insert under the office's own rules: refused the same way.
    const office = await as.office.from("sales_orders").insert({ organization_id: org(), so_number: `PO-DUP2-${seq}`, customer_po: `PO-DUP2-${seq}`, customer: "Dup", quote_id: q.id, total_value: 50, status: "open" });
    expect(office.error?.code).toBe("23505");
    expect(await ordersFor(q.id)).toHaveLength(1);
  });

  it("an order made by hand first (an earlier build's New Sales Order) is the one accept_quote returns; no second order, no job made for it", async () => {
    const q = await quote([{ quantity: 1, unit_price: 80, vat_pct: 20 }]);
    // The earlier build: the quote accepted by a plain update, then its order entered by hand.
    expect((await as.office.from("quotes").update({ status: "accepted", accepted_at: new Date().toISOString() }).eq("id", q.id).eq("status", "sent").select("id")).data).toHaveLength(1);
    const { data: manual, error } = await as.office.from("sales_orders").insert({ organization_id: org(), so_number: `PO-HAND-${seq}`, customer_po: `PO-HAND-${seq}`, customer: "Hand", quote_id: q.id, total_value: 80, status: "open" }).select("id").single();
    expect(error).toBeNull();
    const result = await ok(as.admin, q.id);
    expect(result).toMatchObject({ accepted: false, so_id: manual!.id, so_created: false, job_id: null, job_created: false });
    expect(await ordersFor(q.id)).toHaveLength(1);
    expect(await acceptEvents(q.id)).toHaveLength(0);
  });

  it("a quote accepted by an earlier build with no order yet gets its order (and job) from accept_quote, without a second ACCEPT", async () => {
    const q = await quote([{ quantity: 2, unit_price: 30, vat_pct: 20 }]);
    expect((await as.office.from("quotes").update({ status: "accepted", accepted_at: new Date().toISOString() }).eq("id", q.id).select("id")).data).toHaveLength(1);
    const result = await ok(as.office, q.id, `PO-LATER-${seq}`);
    expect(result).toMatchObject({ accepted: false, so_created: true, so_number: `PO-LATER-${seq}`, job_created: true });
    expect(await acceptEvents(q.id)).toHaveLength(0);
  });

  it("a rejected quote is refused and nothing is made", async () => {
    const q = await quote([{ quantity: 1, unit_price: 10, vat_pct: 20 }]);
    expect((await as.office.from("quotes").update({ status: "rejected", rejected_at: new Date().toISOString() }).eq("id", q.id).select("id")).data).toHaveLength(1);
    const { error } = await accept(as.admin, q.id);
    expect({ code: error?.code, hint: error?.hint }).toEqual({ code: "22023", hint: "quote_decided" });
    expect(await ordersFor(q.id)).toHaveLength(0);
  });
});

describe("terms one order can't hold: the quote is accepted, the order is made by hand", () => {
  // 126: a quote for 0.00 (the old "no lines" case) is refused before this point; see the test after this list.
  const cases: [string, Line[], { vat?: boolean; total?: number }][] = [
    ["lines at different VAT rates", [{ quantity: 1, unit_price: 10, vat_pct: 20 }, { quantity: 1, unit_price: 10, vat_pct: 5 }], {}],
    ["a VAT rate an order can't hold (17.5%)", [{ quantity: 1, unit_price: 100, vat_pct: 17.5 }], {}],
    ["a penny of per-line VAT rounding (3p + 3p at 20%)", [{ quantity: 1, unit_price: 0.03, vat_pct: 20 }, { quantity: 1, unit_price: 0.03, vat_pct: 20 }], {}],
  ];
  for (const [name, lines, opts] of cases) {
    it(`${name}: accepted, no order, no job, the same reason the Sales Orders page gives`, async () => {
      const q = await quote(lines, { ...opts, status: lines.length ? "sent" : "draft" });
      const terms = appTerms(q);
      expect(terms.ok).toBe(false);
      const result = await ok(as.office, q.id, "PO-NOT-USED");
      expect(result).toMatchObject({ accepted: true, so_id: null, so_created: false, job_id: null, job_created: false, needs: "sales_order_by_hand" });
      expect(result.reason).toBe(terms.ok ? null : terms.reason);
      expect((await adminClient().from("quotes").select("status").eq("id", q.id).single()).data?.status).toBe("accepted");
      expect(await ordersFor(q.id)).toHaveLength(0);
      const events = await acceptEvents(q.id);
      expect(events).toHaveLength(1);
      expect(events[0].metadata.reason).toBe(result.reason);
      // Retrying is refused again, the same way, and changes nothing.
      expect(await ok(as.office, q.id)).toMatchObject({ accepted: false, so_id: null, needs: "sales_order_by_hand", reason: result.reason });
    });
  }

  it("126: a quote for 0.00 (here with no lines) is refused as the app refuses it: not accepted, no order, no event", async () => {
    const q = await quote([], { total: 0, status: "draft" });
    const { error } = await accept(as.office, q.id, "PO-NOT-USED");
    expect({ code: error?.code, hint: error?.hint, message: error?.message })
      .toEqual({ code: "22023", hint: "quote_zero_value", message: "A quote for £0.00 can't be accepted. Add a price or decline it." });
    expect((await adminClient().from("quotes").select("status").eq("id", q.id).single()).data?.status).toBe("draft");
    expect(await ordersFor(q.id)).toHaveLength(0);
    expect(await acceptEvents(q.id)).toHaveLength(0);
  });

  it("the cases one order can hold are carried exactly as the app carries them (VAT off, 5%, exempt, 0%)", async () => {
    const holdable: [Line[], boolean][] = [
      [[{ quantity: 2, unit_price: 20, vat_pct: 20 }, { quantity: 1, unit_price: 5, vat_pct: 5 }], false],
      [[{ quantity: 4, unit_price: 25, vat_pct: 5 }], true],
      [[{ quantity: 3, unit_price: 7.5, vat_pct: 0, vat_exempt: true }], true],
      [[{ quantity: 1, unit_price: 9.99, vat_pct: 0 }, { quantity: 2, unit_price: 1.01, vat_pct: 0 }], true],
    ];
    for (const [lines, vat] of holdable) {
      const q = await quote(lines, { vat });
      const terms = appTerms(q);
      if (!terms.ok) throw new Error(terms.reason);
      const result = await ok(as.admin, q.id);
      expect(result.so_created).toBe(true);
      const [order] = await ordersFor(q.id);
      const stored = { value: Number(order.total_value), vatOn: order.vat_enabled, vat: order.vat_exempt ? "exempt" : String(Number(order.vat_pct)) };
      expect(stored).toEqual({ value: terms.value, vatOn: terms.vatOn, vat: terms.vat });
    }
  });
});

describe("the company setting: make the job automatically or not", () => {
  it("manual: the order is made and waits for Convert to Job, which then gives the job the order's customer PO", async () => {
    await setAuto(false);
    try {
      const q = await quote([{ quantity: 5, unit_price: 10, vat_pct: 20 }]);
      const result = await ok(as.office, q.id, `PO-MAN-${seq}`);
      expect(result).toMatchObject({ so_created: true, auto_convert: false, job_id: null, job_created: false });
      const [order] = await ordersFor(q.id);
      expect(order).toMatchObject({ status: "open", converted_to_job_id: null });
      expect(await jobsFor([order.id])).toHaveLength(0);
      const converted = await as.office.rpc("convert_sales_order", { p_order: order.id });
      expect(converted.error).toBeNull();
      expect((await jobsFor([order.id]))[0].customer_po).toBe(`PO-MAN-${seq}`);
    } finally {
      await setAuto(true);
    }
  });

  it("only an admin changes it: the admin through set_auto_convert_sales_orders (audited); office, workshop and viewer refused, directly too", async () => {
    for (const role of ["office", "workshop", "viewer"] as const) {
      const { error } = await as[role].rpc("set_auto_convert_sales_orders", { p_on: false });
      expect({ role, code: error?.code }).toEqual({ role, code: "42501" });
    }
    const direct = await as.office.from("organization_settings").upsert({ organization_id: org(), auto_convert_sales_orders: false }, { onConflict: "organization_id" });
    expect(direct.error).not.toBeNull();
    const read = async () => (await adminClient().from("organization_settings").select("auto_convert_sales_orders").eq("organization_id", org()).maybeSingle()).data?.auto_convert_sales_orders ?? true;
    expect(await read()).toBe(true);
    // Office may still save its column choices on the same row.
    expect((await as.office.from("organization_settings").upsert({ organization_id: org(), hidden_columns: {} }, { onConflict: "organization_id" })).error).toBeNull();
    expect((await as.admin.rpc("set_auto_convert_sales_orders", { p_on: false })).data).toBe(false);
    expect(await read()).toBe(false);
    expect((await as.admin.rpc("set_auto_convert_sales_orders", { p_on: true })).data).toBe(true);
    expect(await read()).toBe(true);
    const events = await withDb(async (db) => (await db.query("select metadata from security_audit.audit_log where organization_id = $1 and entity_table = 'organization_settings' and metadata ->> 'section' = 'sales_orders' order by created_at", [org()])).rows);
    expect(events.map((e) => e.metadata.auto_convert_sales_orders)).toEqual([false, true]);
    // Beta's setting is untouched (default: automatic).
    expect((await adminClient().from("organization_settings").select("auto_convert_sales_orders").eq("organization_id", world.tenants.beta.id).maybeSingle()).data?.auto_convert_sales_orders ?? true).toBe(true);
  });
});

describe("who may accept", () => {
  it("viewer and workshop are refused, and nothing changes", async () => {
    const q = await quote([{ quantity: 1, unit_price: 10, vat_pct: 20 }]);
    for (const role of ["viewer", "workshop"] as const) {
      const { error } = await accept(as[role], q.id, "PO-X");
      expect({ role, code: error?.code }).toEqual({ role, code: "42501" });
    }
    expect((await adminClient().from("quotes").select("status").eq("id", q.id).single()).data?.status).toBe("sent");
    expect(await ordersFor(q.id)).toHaveLength(0);
  });

  it("another company's quote is not found and is left exactly as it was", async () => {
    const q = await quote([{ quantity: 1, unit_price: 10, vat_pct: 20 }], { tenant: "beta" });
    const before = (await adminClient().from("quotes").select("*").eq("id", q.id).single()).data;
    for (const role of ["admin", "office"] as const) {
      const { error } = await accept(as[role], q.id, "PO-X");
      expect({ role, code: error?.code }).toEqual({ role, code: "P0002" });
    }
    expect((await adminClient().from("quotes").select("*").eq("id", q.id).single()).data).toEqual(before);
    expect(await ordersFor(q.id)).toHaveLength(0);
  });

  it("someone whose Sales Orders section is hidden: the quote is accepted, no order is made, and the reason says who makes it", async () => {
    const q = await quote([{ quantity: 1, unit_price: 10, vat_pct: 20 }]);
    const office = world.tenants.alpha.users.office.id;
    await withDb((db) => db.query("update public.organization_members set hidden_sections = array['sales-orders'] where user_id = $1 and organization_id = $2", [office, org()]));
    try {
      const result = await ok(as.office, q.id);
      expect(result).toMatchObject({ accepted: true, so_id: null, needs: "sales_order_by_hand" });
      expect(result.reason).toMatch(/Sales Orders section/);
      expect(await ordersFor(q.id)).toHaveLength(0);
    } finally {
      await withDb((db) => db.query("update public.organization_members set hidden_sections = '{}' where user_id = $1 and organization_id = $2", [office, org()]));
    }
  });

  it("create_sales_order_from_quote is internal: no signed-in or anonymous caller may run it", async () => {
    const q = await quote([{ quantity: 1, unit_price: 10, vat_pct: 20 }]);
    const { error } = await as.admin.rpc("create_sales_order_from_quote", { p_quote: q.id, p_customer_po: null, p_delivery_date: null });
    expect(error).not.toBeNull();
    expect(await ordersFor(q.id)).toHaveLength(0);
  });
});

describe("the customer's PO, later (set_sales_order_customer_po)", () => {
  it("a provisional order takes the PO as its reference, and its unfinished job gets it (a worksheet change: the version moves)", async () => {
    const q = await quote([{ quantity: 1, unit_price: 60, vat_pct: 20 }]);
    const result = await ok(as.office, q.id);
    const jobBefore = (await adminClient().from("jobs").select("customer_po, worksheet_version").eq("id", result.job_id!).single()).data!;
    const { data, error } = await as.office.rpc("set_sales_order_customer_po", { p_order: result.so_id, p_customer_po: ` PO-LATE-${seq} ` });
    expect(error).toBeNull();
    expect(data).toMatchObject({ so_number: `PO-LATE-${seq}`, customer_po: `PO-LATE-${seq}`, changed: true, job_updated: true, job_id: result.job_id });
    const [order] = await ordersFor(q.id);
    expect(order).toMatchObject({ so_number: `PO-LATE-${seq}`, customer_po: `PO-LATE-${seq}` });
    const job = (await adminClient().from("jobs").select("customer_po, worksheet_version").eq("id", result.job_id!).single()).data!;
    expect(job.customer_po).toBe(`PO-LATE-${seq}`);
    expect(job.worksheet_version).toBe(jobBefore.worksheet_version + 1);
    // The same PO again: no change at all.
    expect((await as.office.rpc("set_sales_order_customer_po", { p_order: result.so_id, p_customer_po: `PO-LATE-${seq}` })).data).toMatchObject({ changed: false });
    // Replaced: the reference follows (it was the PO), and so does the job.
    expect((await as.admin.rpc("set_sales_order_customer_po", { p_order: result.so_id, p_customer_po: `PO-NEW-${seq}` })).data).toMatchObject({ so_number: `PO-NEW-${seq}`, job_updated: true });
    expect((await adminClient().from("jobs").select("customer_po").eq("id", result.job_id!).single()).data?.customer_po).toBe(`PO-NEW-${seq}`);
  });

  it("a finished job keeps the PO it was made with; the order still takes the new one", async () => {
    const q = await quote([{ quantity: 1, unit_price: 70, vat_pct: 20 }]);
    const result = await ok(as.office, q.id);
    await withDb((db) => db.query("update public.jobs set started_at = now() - interval '1 hour', finished_at = now() where id = $1", [result.job_id]));
    const { data, error } = await as.office.rpc("set_sales_order_customer_po", { p_order: result.so_id, p_customer_po: `PO-FIN-${seq}` });
    expect(error).toBeNull();
    expect(data).toMatchObject({ customer_po: `PO-FIN-${seq}`, job_updated: false });
    expect((await adminClient().from("jobs").select("customer_po").eq("id", result.job_id!).single()).data?.customer_po).toBeNull();
  });

  it("an order whose reference is not its PO keeps its reference", async () => {
    const { data: order } = await adminClient().from("sales_orders").insert({ organization_id: org(), so_number: `SO-REF-${seq}`, customer_po: `PO-A-${seq}`, customer: "Ref Co", total_value: 10, status: "open" }).select("id").single();
    expect((await as.office.rpc("set_sales_order_customer_po", { p_order: order!.id, p_customer_po: `PO-B-${seq}` })).data).toMatchObject({ so_number: `SO-REF-${seq}`, customer_po: `PO-B-${seq}` });
  });

  it("refused for viewer and workshop, for another company's order, and for an empty or over-long PO", async () => {
    const { data: mine } = await adminClient().from("sales_orders").insert({ organization_id: org(), so_number: `SO-R-${seq}`, customer: "R Co", total_value: 10, status: "open" }).select("id").single();
    const { data: theirs } = await adminClient().from("sales_orders").insert({ organization_id: world.tenants.beta.id, so_number: `SO-B-${seq}`, customer: "B Co", total_value: 10, status: "open" }).select("id").single();
    for (const role of ["viewer", "workshop"] as const) {
      expect({ role, code: (await as[role].rpc("set_sales_order_customer_po", { p_order: mine!.id, p_customer_po: "PO-X" })).error?.code }).toEqual({ role, code: "42501" });
    }
    expect((await as.admin.rpc("set_sales_order_customer_po", { p_order: theirs!.id, p_customer_po: "PO-X" })).error?.code).toBe("P0002");
    expect((await as.admin.rpc("set_sales_order_customer_po", { p_order: mine!.id, p_customer_po: "   " })).error?.code).toBe("22023");
    expect((await as.admin.rpc("set_sales_order_customer_po", { p_order: mine!.id, p_customer_po: "X".repeat(101) })).error?.code).toBe("22023");
    const rows = (await adminClient().from("sales_orders").select("so_number, customer_po").in("id", [mine!.id, theirs!.id]).order("so_number")).data;
    expect(rows).toEqual([{ so_number: `SO-B-${seq}`, customer_po: null }, { so_number: `SO-R-${seq}`, customer_po: null }]);
  });
});

describe("convert_sales_order takes the order's customer_po, never its so_number", () => {
  it("an order numbered SO-#### with PO-Y gives the job PO-Y; with no PO, the job has none", async () => {
    const service = adminClient();
    const { data: withPo } = await service.from("sales_orders").insert({ organization_id: org(), so_number: `SO-X-${seq}`, customer_po: `PO-Y-${seq}`, customer: "C Co", total_value: 10, status: "open" }).select("id").single();
    const { data: noPo } = await service.from("sales_orders").insert({ organization_id: org(), so_number: `SO-Z-${seq}`, customer: "C Co", total_value: 10, status: "open" }).select("id").single();
    for (const [id, expected] of [[withPo!.id, `PO-Y-${seq}`], [noPo!.id, null]] as const) {
      const { data, error } = await as.admin.rpc("convert_sales_order", { p_order: id });
      expect(error).toBeNull();
      expect((await service.from("jobs").select("customer_po").eq("id", data.job_id).single()).data?.customer_po).toBe(expected);
    }
  });
});

describe("the second step (company requires it)", () => {
  let aal1: SupabaseClient;
  let aal2: SupabaseClient;
  beforeAll(async () => {
    // Beta's admin, so alpha's sessions above are not ended by the second step.
    const admin = world.tenants.beta.users.admin;
    const factor = await enrolTotp(await signedInClient(admin));
    aal2 = await signedInClient(admin);
    await passSecondStep(aal2, factor.factorId, factor.secret);
    await aal2.auth.refreshSession();
    aal1 = await signedInClient(admin);
    await setRequireAdminMfaForTest(world.tenants.beta.id, true);
  });

  it("an admin at aal1 is refused (mfa_required) by accept_quote, set_sales_order_customer_po and set_auto_convert_sales_orders, and nothing changes; at aal2 each goes through", async () => {
    const q = await quote([{ quantity: 1, unit_price: 40, vat_pct: 20 }], { tenant: "beta" });
    const mfa = { code: "42501", hint: "mfa_required" };
    const refused = await accept(aal1, q.id, "PO-AAL");
    expect({ code: refused.error?.code, hint: refused.error?.hint }).toEqual(mfa);
    expect((await adminClient().from("quotes").select("status").eq("id", q.id).single()).data?.status).toBe("sent");
    expect(await ordersFor(q.id)).toHaveLength(0);
    const setting = await aal1.rpc("set_auto_convert_sales_orders", { p_on: false });
    expect({ code: setting.error?.code, hint: setting.error?.hint }).toEqual(mfa);

    const done = await accept(aal2, q.id);
    expect(done.error).toBeNull();
    expect(done.data).toMatchObject({ accepted: true, so_created: true, job_created: true });
    const po = await aal1.rpc("set_sales_order_customer_po", { p_order: (done.data as Accepted).so_id, p_customer_po: "PO-AAL" });
    expect({ code: po.error?.code, hint: po.error?.hint }).toEqual(mfa);
    expect((await ordersFor(q.id))[0].customer_po).toBeNull();
    expect((await aal2.rpc("set_sales_order_customer_po", { p_order: (done.data as Accepted).so_id, p_customer_po: "PO-AAL" })).error).toBeNull();
  });
});

describe("supabase/verify/quote_to_job.sql (the read-only post-release check)", () => {
  it("every fact row is true after all of the above, in a read-only transaction", async () => {
    const text = readFileSync(path.resolve(__dirname, "../../supabase/verify/quote_to_job.sql"), "utf8");
    const rows = await withDb(async (db) => {
      await db.query("begin read only");
      try {
        return (await db.query<{ n: number; check_name: string; value: string; expected: string }>(text)).rows;
      } finally {
        await db.query("rollback");
      }
    });
    const facts = rows.filter((r) => r.expected === "true");
    expect(facts.length).toBe(11);
    expect(facts.filter((r) => r.value !== "true")).toEqual([]);
  });

  it("row 2 lists a quote with two orders (index dropped in a rolled-back transaction)", async () => {
    const text = readFileSync(path.resolve(__dirname, "../../supabase/verify/quote_to_job.sql"), "utf8");
    const q = await quote([{ quantity: 1, unit_price: 10, vat_pct: 20 }]);
    await ok(as.admin, q.id);
    const value = await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("drop index public.sales_orders_one_per_quote");
        await db.query("insert into public.sales_orders (organization_id, so_number, customer, quote_id, status) values ($1, 'PO-SECOND', 'Dup', $2, 'open')", [org(), q.id]);
        return (await db.query<{ n: number; value: string }>(text)).rows.find((r) => Number(r.n) === 2)!.value;
      } finally {
        await db.query("rollback");
      }
    });
    expect(value).toMatch(new RegExp(`^false: .*${q.ref}.*PO-SECOND`));
    // The release's pre-flight stops on the same data with a clear message (and changes nothing: one transaction).
    const migration = readFileSync(path.resolve(__dirname, "../../supabase/migrations/058_quote_to_job.sql"), "utf8");
    const stopped = await withDb(async (db) => {
      await db.query("begin");
      try {
        await db.query("drop index public.sales_orders_one_per_quote");
        await db.query("insert into public.sales_orders (organization_id, so_number, customer, quote_id, status) values ($1, 'PO-SECOND', 'Dup', $2, 'open')", [org(), q.id]);
        await db.query(migration);
        return null;
      } catch (err) {
        return (err as Error).message;
      } finally {
        await db.query("rollback");
      }
    });
    expect(stopped).toMatch(/^058 stopped: 1 quote\(s\) already have more than one sales order/);
    expect(await ordersFor(q.id)).toHaveLength(1);
  });
});
