/**
 * Linked despatch and invoicing with remaining quantities (migration 034, W2). A delivery note is made from a sales order (or a
 * job), with the quantity despatched per line and what remains tracked; over-despatch is refused; an invoice can be made from
 * delivery notes at the order's own prices; a delivery note can be invoiced once.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { documentTotals } from "@/lib/money";
import { type SyntheticWorld, adminClient, allowInspectors, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { recordInspection } from "./inspection-support";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
let n = 0;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  await allowInspectors(world);
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

// Three lines, mixed VAT, with a price that makes the pennies matter: 7 x 14.29 = 100.03, VAT 20.01.
const LINES = [
  { description: "Flange 80mm", quantity: 12, unit_price: 150, vat_pct: 20, vat_exempt: false },
  { description: "Spacer", quantity: 4, unit_price: 2.5, vat_pct: 0, vat_exempt: false },
  { description: "Bush 25mm", quantity: 7, unit_price: 14.29, vat_pct: 20, vat_exempt: false },
];
const TODAY = new Date().toISOString().slice(0, 10);

/** An accepted quote with LINES and an order for it (net value), made with the service role. */
async function orderWithLines(org = world.tenants.alpha.id, customer = "Despatch Co") {
  n += 1;
  const service = adminClient();
  const { data: quote, error } = await service.from("quotes").insert({ organization_id: org, quote_ref: `QUO-DSP-${world.runId}-${n}`, customer, status: "draft", total_value: 0 }).select("id").single();
  if (error) throw new Error(error.message);
  expect((await service.from("quote_line_items").insert(LINES.map((l, position) => ({ ...l, position, quote_id: quote.id, organization_id: org })))).error).toBeNull();
  const totals = documentTotals(LINES.map((l) => ({ quantity: l.quantity, unitPrice: l.unit_price, vatPct: l.vat_pct })), 0, { vatEnabled: true });
  expect((await service.from("quotes").update({ total_value: totals.total, vat_enabled: true }).eq("id", quote.id)).error).toBeNull();
  expect((await service.from("quotes").update({ status: "accepted" }).eq("id", quote.id)).error).toBeNull();
  const { data: order, error: orderError } = await service.from("sales_orders").insert({
    organization_id: org, so_number: `PO-DSP-${world.runId}-${n}`, customer_po: `PO-DSP-${world.runId}-${n}`, customer, quote_id: quote.id, total_value: totals.subtotal, vat_enabled: true, status: "open",
  }).select("id").single();
  if (orderError) throw new Error(orderError.message);
  return { order: order.id as string, totals };
}

type DespatchLine = { line_id: string; line_position: number; description: string; ordered: number; despatched: number; remaining: number };
const lines = async (client: SupabaseClient, order: string) => {
  const { data, error } = await client.rpc("despatch_lines", { p_order: order, p_job: null });
  if (error) throw new Error(error.message);
  return (data as DespatchLine[]).map((l) => ({ ...l, ordered: Number(l.ordered), despatched: Number(l.despatched), remaining: Number(l.remaining) }));
};
const make = (client: SupabaseClient, order: string, picks: [number, number][], all: DespatchLine[], extra: Record<string, unknown> = {}) =>
  client.rpc("create_delivery_note", {
    p_order: order, p_job: null, p_ship_date: TODAY, p_tax_date: TODAY, p_ship_via: "Own van", p_notes: null,
    p_lines: picks.map(([index, quantity]) => ({ line_id: all[index].line_id, quantity })), ...extra,
  });
const sentOut = async (...ids: string[]) => { for (const id of ids) expect((await adminClient().from("delivery_notes").update({ status: "despatched" }).eq("id", id)).error).toBeNull(); };
const invoiceFrom = (client: SupabaseClient, ids: string[], due = "2099-02-01") => client.rpc("create_invoice_from_delivery_notes", { p_notes: ids, p_invoice_date: TODAY, p_due_date: due > TODAY ? due : TODAY, p_terms: "30 days" });

describe("despatching part, then the rest", () => {
  it("makes numbered delivery notes without an invoice, tracks what is left, and refuses more than is left", async () => {
    const { order } = await orderWithLines();
    const all = await lines(as.office, order);
    expect(all.map((l) => [l.description, l.ordered, l.despatched, l.remaining])).toEqual([["Flange 80mm", 12, 0, 12], ["Spacer", 4, 0, 4], ["Bush 25mm", 7, 0, 7]]);

    const first = await make(as.office, order, [[0, 5], [2, 7]], all);
    expect(first.error).toBeNull();
    expect(first.data.dn_number).toMatch(/^DLN-\d+$/);
    expect((await lines(as.office, order)).map((l) => l.remaining)).toEqual([7, 4, 0]);
    const head = (await adminClient().from("delivery_notes").select("status, invoice_ref, invoice_id, sales_order_id, organization_id, ship_via").eq("id", first.data.id).single()).data;
    expect(head).toEqual({ status: "awaiting", invoice_ref: null, invoice_id: null, sales_order_id: order, organization_id: world.tenants.alpha.id, ship_via: "Own van" });
    const items = (await adminClient().from("delivery_note_items").select("description, quantity, position").eq("delivery_note_id", first.data.id).order("position")).data;
    expect(items).toEqual([{ description: "Flange 80mm", quantity: 5, position: 0 }, { description: "Bush 25mm", quantity: 7, position: 1 }]);

    // More than is left on a line is refused and nothing is made.
    const before = (await adminClient().from("delivery_notes").select("id").eq("sales_order_id", order)).data!.length;
    const over = await make(as.office, order, [[0, 7.001]], all);
    expect(over.error).toMatchObject({ code: "22023" });
    expect(over.error!.message).toMatch(/More than is left to despatch on "Flange 80mm": 12 ordered, 5 already on delivery notes, 7 left/);
    expect((await make(as.office, order, [[2, 1]], all)).error).toMatchObject({ code: "22023" });
    expect((await adminClient().from("delivery_notes").select("id").eq("sales_order_id", order)).data).toHaveLength(before);

    // The rest goes out on a second note; then nothing is left.
    const second = await make(as.workshop, order, [[0, 7], [1, 4]], all);
    expect(second.error).toBeNull();
    expect((await lines(as.office, order)).map((l) => [l.despatched, l.remaining])).toEqual([[12, 0], [4, 0], [7, 0]]);
    expect((await make(as.office, order, [[1, 0.001]], all)).error).toMatchObject({ code: "22023" });
  });

  it("refuses zero or negative quantities, a line twice, another order's line, a fraction of a thousandth, and a viewer", async () => {
    const a = await orderWithLines();
    const b = await orderWithLines();
    const allA = await lines(as.office, a.order);
    const allB = await lines(as.office, b.order);
    for (const picks of [[[0, 0]], [[0, -1]], [[0, 1], [0, 2]], [[0, 0.0005]]] as [number, number][][]) {
      expect((await make(as.office, a.order, picks, allA)).error, JSON.stringify(picks)).toMatchObject({ code: "22023" });
    }
    expect((await make(as.office, a.order, [[0, 1]], allB)).error).toMatchObject({ code: "22023" }); // a line of the other order
    expect((await as.office.rpc("create_delivery_note", { p_order: a.order, p_job: null, p_ship_date: TODAY, p_tax_date: TODAY, p_ship_via: null, p_notes: null, p_lines: [] })).error).toMatchObject({ code: "22023" });
    expect((await make(as.viewer, a.order, [[0, 1]], allA)).error).toMatchObject({ code: "42501" });
    expect((await adminClient().from("delivery_notes").select("id").eq("sales_order_id", a.order)).data).toEqual([]);
  });

  it("two notes made at the same time can't between them despatch more than was ordered", async () => {
    const { order } = await orderWithLines();
    const all = await lines(as.admin, order);
    const results = await Promise.all([make(as.admin, order, [[0, 8]], all), make(as.office, order, [[0, 8]], all)]);
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    expect(results.filter((r) => r.error)[0].error).toMatchObject({ code: "22023" });
    expect((await lines(as.admin, order))[0]).toMatchObject({ despatched: 8, remaining: 4 });
  });
});

describe("despatching from a job", () => {
  it("needs the job to have passed inspection; the workshop sees no prices", async () => {
    const { order } = await orderWithLines();
    const converted = await as.admin.rpc("convert_sales_order", { p_order: order });
    expect(converted.error).toBeNull();
    const jobId = converted.data.job_id as string;
    const all = await lines(as.workshop, order);
    const viaJob = (client: SupabaseClient) => client.rpc("create_delivery_note", { p_order: null, p_job: jobId, p_ship_date: TODAY, p_tax_date: TODAY, p_ship_via: null, p_notes: null, p_lines: [{ line_id: all[0].line_id, quantity: 2 }] });

    const early = await viaJob(as.workshop);
    expect(early.error).toMatchObject({ code: "22023" });
    expect(early.error!.message).toMatch(/hasn't passed inspection/);
    // The order screen is held to the same rule.
    expect((await make(as.office, order, [[0, 2]], all)).error!.message).toMatch(/hasn't passed inspection/);

    await adminClient().from("jobs").update({ started_at: "2026-10-01T08:00:00Z", finished_at: "2026-10-02T08:00:00Z" }).eq("id", jobId);
    expect((await recordInspection(as.workshop, { p_job: jobId, p_result: "pass", p_notes: "In tolerance", p_attachment_path: null, p_attachment_name: null, p_concession_reason: null, p_expected_version: (await adminClient().from("jobs").select("worksheet_version").eq("id", jobId).single()).data!.worksheet_version })).error).toBeNull();
    const done = await viaJob(as.workshop);
    expect(done.error).toBeNull();
    expect((await adminClient().from("delivery_notes").select("job_id, job_ref, sales_order_id").eq("id", done.data.id).single()).data).toMatchObject({ job_id: jobId, sales_order_id: order });

    // No prices for the workshop, in the answer or by reading the table.
    expect(Object.keys((await as.workshop.rpc("despatch_lines", { p_order: null, p_job: jobId })).data[0]).sort()).toEqual(["description", "despatched", "line_id", "line_position", "ordered", "remaining"]);
    expect((await as.workshop.from("sales_order_lines").select("*").eq("sales_order_id", order)).data).toEqual([]);
    expect((await as.office.from("sales_order_lines").select("unit_price").eq("sales_order_id", order)).data).toHaveLength(3);
    // A job that isn't from an order has nothing to despatch from.
    const { data: lone } = await adminClient().from("jobs").insert({ organization_id: world.tenants.alpha.id, job_no: `J-LONE-${world.runId}`, customer: "X" }).select("id").single();
    expect((await as.workshop.rpc("despatch_lines", { p_order: null, p_job: lone!.id })).data).toEqual([]);
    expect((await as.workshop.rpc("create_delivery_note", { p_order: null, p_job: lone!.id, p_ship_date: TODAY, p_tax_date: TODAY, p_ship_via: null, p_notes: null, p_lines: [{ line_id: all[0].line_id, quantity: 1 }] })).error).toMatchObject({ code: "22023" });
  });
});

describe("invoicing from delivery notes", () => {
  async function despatchedInFull() {
    const { order, totals } = await orderWithLines();
    const all = await lines(as.office, order);
    const one = await make(as.office, order, [[0, 5], [2, 3]], all);
    const two = await make(as.office, order, [[0, 7], [1, 4], [2, 4]], all);
    await sentOut(one.data.id, two.data.id);
    return { order, totals, one: one.data.id as string, two: two.data.id as string };
  }

  it("reproduces the order's prices to the penny: one line per order line, the order's total, and it can be issued", async () => {
    const { order, totals, one, two } = await despatchedInFull();
    const made = await invoiceFrom(as.office, [one, two]);
    expect(made.error).toBeNull();
    expect(made.data).toMatchObject({ subtotal: totals.subtotal, vat: totals.vat, total: totals.total, lines: 3 });
    expect(totals).toMatchObject({ subtotal: 1910.03, vat: 380.01, total: 2290.04 });
    const invoice = (await adminClient().from("invoices").select("status, subtotal, vat, total, carriage, vat_enabled, customer, invoice_ref, organization_id, customer_po, quote_ref").eq("id", made.data.invoice_id).single()).data!;
    expect(invoice).toMatchObject({ status: "draft", subtotal: 1910.03, vat: 380.01, total: 2290.04, carriage: 0, vat_enabled: true, customer: "Despatch Co", invoice_ref: null, organization_id: world.tenants.alpha.id });
    expect(invoice.customer_po).toMatch(/^PO-DSP-/);
    const invoiceLines = (await adminClient().from("invoice_line_items").select("description, quantity, unit_price, vat_pct, vat_exempt").eq("invoice_id", made.data.invoice_id).order("position")).data;
    expect(invoiceLines).toEqual(LINES.map((l) => ({ description: l.description, quantity: l.quantity, unit_price: l.unit_price, vat_pct: l.vat_pct, vat_exempt: l.vat_exempt })));
    // Both notes now point at it, and the draft can be issued (its totals match its lines).
    expect((await adminClient().from("delivery_notes").select("invoice_id").in("id", [one, two])).data!.map((d) => d.invoice_id)).toEqual([made.data.invoice_id, made.data.invoice_id]);
    expect((await as.office.rpc("issue_invoice", { p_invoice: made.data.invoice_id })).error).toBeNull();
    expect(order).toBeTruthy();
  });

  it("an invoice per note adds up to the order's net value exactly; VAT, rounded per line on each invoice, can differ by a penny", async () => {
    const { totals, one, two } = await despatchedInFull();
    const a = await invoiceFrom(as.admin, [one]);
    const b = await invoiceFrom(as.admin, [two]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(Math.round((Number(a.data.subtotal) + Number(b.data.subtotal)) * 100) / 100).toBe(totals.subtotal);
    // VAT is rounded on each invoice line (the existing policy, lib/money.ts): the Bush line split 3 + 4 is 8.57 + 11.43, not 20.01.
    const vatApart = Math.round((Number(a.data.vat) + Number(b.data.vat)) * 100) / 100;
    expect(Math.abs(vatApart - totals.vat)).toBeLessThanOrEqual(0.01);
    expect(Math.round((Number(a.data.total) + Number(b.data.total)) * 100) / 100).toBe(Math.round((totals.subtotal + vatApart) * 100) / 100);
  });

  it("refuses to invoice the same delivery note twice, also when two requests arrive together", async () => {
    const { one, two } = await despatchedInFull();
    const first = await invoiceFrom(as.office, [one]);
    expect(first.error).toBeNull();
    const again = await invoiceFrom(as.office, [one, two]);
    expect(again.error).toMatchObject({ code: "22023" });
    expect(again.error!.message).toMatch(/already on a draft invoice|already on INV-/);
    expect((await adminClient().from("delivery_notes").select("invoice_id").eq("id", two).single()).data!.invoice_id).toBeNull();

    const race = await orderWithLines();
    const all = await lines(as.office, race.order);
    const note = await make(as.office, race.order, [[0, 1]], all);
    await sentOut(note.data.id);
    const results = await Promise.all([invoiceFrom(as.office, [note.data.id]), invoiceFrom(as.admin, [note.data.id])]);
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    expect((await adminClient().from("invoices").select("id").eq("customer", "Despatch Co").eq("subtotal", 150)).data!.length).toBeGreaterThanOrEqual(1);
  });

  it("deleting the draft frees its notes; an invoice that is voided does too; an issued one keeps them", async () => {
    const { one, two } = await despatchedInFull();
    const draft = await invoiceFrom(as.office, [one]);
    expect((await as.office.from("invoices").delete().eq("id", draft.data.invoice_id).select("id")).data).toHaveLength(1);
    expect((await adminClient().from("delivery_notes").select("invoice_id").eq("id", one).single()).data!.invoice_id).toBeNull();
    const second = await invoiceFrom(as.office, [one, two]);
    expect(second.error).toBeNull();
    expect((await as.office.rpc("issue_invoice", { p_invoice: second.data.invoice_id })).error).toBeNull();
    expect((await invoiceFrom(as.office, [one])).error).toMatchObject({ code: "22023" });
    expect((await as.admin.rpc("void_invoice", { p_invoice_id: second.data.invoice_id, p_reason: "Raised in error" })).error).toBeNull();
    expect((await invoiceFrom(as.office, [one])).error).toBeNull();
  });

  it("refuses notes that haven't gone out, that weren't made from an order, or that are for different customers", async () => {
    const a = await orderWithLines();
    const allA = await lines(as.office, a.order);
    const waiting = await make(as.office, a.order, [[0, 1]], allA);
    expect((await invoiceFrom(as.office, [waiting.data.id])).error!.message).toMatch(/hasn't gone out yet/);

    const manual = await as.office.rpc("create_with_lines", {
      p_parent: "delivery_notes", p_header: { dn_number: `DLN-MAN-${world.runId}`, customer: "Despatch Co", delivery_date: TODAY, ship_date: TODAY, tax_date: TODAY, status: "awaiting" },
      p_child: "delivery_note_items", p_fk: "delivery_note_id", p_lines: [{ position: 0, description: "Loose item", quantity: 2 }],
    });
    expect(manual.error).toBeNull();
    await sentOut(manual.data as string);
    expect((await invoiceFrom(as.office, [manual.data as string])).error!.message).toMatch(/weren't made from an order/);

    const other = await orderWithLines(world.tenants.alpha.id, "Other Customer Ltd");
    const allOther = await lines(as.office, other.order);
    const otherNote = await make(as.office, other.order, [[0, 1]], allOther);
    await sentOut(waiting.data.id, otherNote.data.id);
    expect((await invoiceFrom(as.office, [waiting.data.id, otherNote.data.id])).error!.message).toMatch(/different customers/);
    expect((await invoiceFrom(as.office, [])).error).toMatchObject({ code: "22023" });
    expect((await invoiceFrom(as.workshop, [waiting.data.id])).error).toMatchObject({ code: "42501" });
  });
});

describe("the links can't be forged", () => {
  it("the browser roles can't link items, change a linked quantity, point a note at an invoice, or delete an invoiced note", async () => {
    const { order } = await orderWithLines();
    const all = await lines(as.office, order);
    const note = await make(as.office, order, [[0, 2], [1, 1]], all);
    const noteId = note.data.id as string;
    const item = (await adminClient().from("delivery_note_items").select("id").eq("delivery_note_id", noteId).order("position")).data![0].id as string;

    for (const role of ["admin", "office", "workshop"]) {
      const forged = await as[role].from("delivery_note_items").insert({ organization_id: world.tenants.alpha.id, delivery_note_id: noteId, position: 9, description: "Forged", quantity: 1, sales_order_line_id: all[2].line_id });
      expect(forged.error, `${role} link`).toMatchObject({ code: "42501" });
      const bump = await as[role].from("delivery_note_items").update({ quantity: 11 }).eq("id", item).select("id");
      expect(bump.error, `${role} quantity`).toMatchObject({ code: "42501" });
      const relink = await as[role].from("delivery_note_items").update({ sales_order_line_id: all[1].line_id }).eq("id", item).select("id");
      expect(relink.error, `${role} relink`).toMatchObject({ code: "42501" });
    }
    const { data: draft } = await adminClient().from("invoices").insert({ organization_id: world.tenants.alpha.id, customer: "X", status: "draft" }).select("id").single();
    expect((await as.office.from("delivery_notes").update({ invoice_id: draft!.id }).eq("id", noteId).select("id")).error).toMatchObject({ code: "42501" });
    expect((await as.office.from("delivery_notes").insert({ organization_id: world.tenants.alpha.id, dn_number: `DLN-FORGE-${world.runId}`, invoice_id: draft!.id })).error).toMatchObject({ code: "42501" });
    expect((await as.office.from("delivery_notes").update({ sales_order_id: null }).eq("id", noteId).select("id")).error).toMatchObject({ code: "42501" });
    expect((await as.workshop.from("delivery_notes").update({ ship_via: "Courier" }).eq("id", noteId).select("id")).data).toHaveLength(1); // ordinary edits still work

    await sentOut(noteId);
    expect((await invoiceFrom(as.office, [noteId])).error).toBeNull();
    expect((await as.office.from("delivery_notes").delete().eq("id", noteId).select("id")).error).toMatchObject({ code: "42501" });
    expect((await as.office.from("delivery_note_items").delete().eq("id", item).select("id")).error).toMatchObject({ code: "42501" });
    expect((await adminClient().from("delivery_note_items").select("id").eq("delivery_note_id", noteId)).data).toHaveLength(2);
  });

  it("another company can't despatch, read the lines of, or invoice these notes", async () => {
    const { order } = await orderWithLines();
    const all = await lines(as.office, order);
    const note = await make(as.office, order, [[0, 1]], all);
    await sentOut(note.data.id);
    expect((await as.betaAdmin.rpc("despatch_lines", { p_order: order, p_job: null })).error).toMatchObject({ code: "P0002" });
    expect((await make(as.betaAdmin, order, [[0, 1]], all)).error).toMatchObject({ code: "P0002" });
    expect((await as.betaAdmin.rpc("ensure_sales_order_lines", { p_order: order })).error).toMatchObject({ code: "P0002" });
    expect((await invoiceFrom(as.betaAdmin, [note.data.id])).error).toMatchObject({ code: "P0002" });
    // Their own order, but one of our lines: not on that order.
    const mine = await orderWithLines(world.tenants.beta.id);
    const mineLines = await lines(as.betaAdmin, mine.order);
    const cross = await as.betaAdmin.rpc("create_delivery_note", { p_order: mine.order, p_job: null, p_ship_date: TODAY, p_tax_date: TODAY, p_ship_via: null, p_notes: null, p_lines: [{ line_id: all[0].line_id, quantity: 1 }] });
    expect(cross.error).toMatchObject({ code: "22023" });
    expect(mineLines).toHaveLength(3);
    expect((await as.betaAdmin.from("sales_order_lines").select("id").eq("sales_order_id", order)).data).toEqual([]);
    expect((await as.betaAdmin.from("delivery_note_items").select("id").eq("delivery_note_id", note.data.id)).data).toEqual([]);
  });
});

describe("an order that didn't come from a quote", () => {
  it("has one line for its value, which can be despatched in parts and invoiced at the order's price", async () => {
    const { data: order } = await adminClient().from("sales_orders").insert({ organization_id: world.tenants.alpha.id, so_number: `PO-PLAIN-${world.runId}`, customer_po: `PO-PLAIN-${world.runId}`, customer: "Plain Co", total_value: 480.5, vat_enabled: true, vat_pct: 20, status: "open" }).select("id").single();
    const all = await lines(as.office, order!.id);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ ordered: 1, remaining: 1 });
    const note = await make(as.office, order!.id, [[0, 1]], all);
    expect(note.error).toBeNull();
    await sentOut(note.data.id);
    const invoice = await invoiceFrom(as.office, [note.data.id]);
    expect(invoice.data).toMatchObject({ subtotal: 480.5, vat: 96.1, total: 576.6, lines: 1 });
    // Changing the order's value before anything is despatched rebuilds the line; afterwards the line is fixed.
    const { data: fresh } = await adminClient().from("sales_orders").insert({ organization_id: world.tenants.alpha.id, so_number: `PO-PLAIN2-${world.runId}`, customer: "Plain Co", total_value: 100, status: "open" }).select("id").single();
    await lines(as.office, fresh!.id);
    await adminClient().from("sales_orders").update({ total_value: 250 }).eq("id", fresh!.id);
    expect((await adminClient().from("sales_order_lines").select("unit_price").eq("sales_order_id", fresh!.id)).data).toEqual([{ unit_price: 100 }]);
    expect((await lines(as.office, fresh!.id)).length).toBe(1);
    expect((await adminClient().from("sales_order_lines").select("unit_price").eq("sales_order_id", fresh!.id)).data).toEqual([{ unit_price: 250 }]);
  });
});

describe("signatures on delivery notes with several items", () => {
  it("persist, with every item still there, whoever signs and however the note was made", async () => {
    const { order } = await orderWithLines();
    const all = await lines(as.office, order);
    const linked = (await make(as.office, order, [[0, 3], [1, 2], [2, 4]], all)).data.id as string;
    const manual = (await as.workshop.rpc("create_with_lines", {
      p_parent: "delivery_notes", p_header: { dn_number: `DLN-SIGN-${world.runId}`, customer: "Despatch Co", delivery_date: TODAY, ship_date: TODAY, tax_date: TODAY, status: "awaiting" },
      p_child: "delivery_note_items", p_fk: "delivery_note_id",
      p_lines: [{ position: 0, description: "Item one", quantity: 1 }, { position: 1, description: "Item two", quantity: 2 }, { position: 2, description: "Item three", quantity: 3 }],
    })).data as string;
    for (const [role, id, who] of [["workshop", linked, "A. Driver"], ["office", manual, "B. Receiver"]] as const) {
      const signedAt = "2026-10-10T12:00:00.000Z";
      const signed = await as[role].from("delivery_notes").update({ status: "signed", signed_by_name: who, signed_at: signedAt, signature_notes: "Counted in" }).eq("id", id).select("id");
      expect(signed.error, role).toBeNull();
      expect(signed.data).toHaveLength(1);
      const row = (await adminClient().from("delivery_notes").select("status, signed_by_name, signed_at, signature_notes").eq("id", id).single()).data!;
      expect(row).toMatchObject({ status: "signed", signed_by_name: who, signature_notes: "Counted in" });
      expect(new Date(row.signed_at).toISOString()).toBe(signedAt);
      expect((await adminClient().from("delivery_note_items").select("quantity").eq("delivery_note_id", id).order("position")).data!.length).toBe(3);
    }
    // Signed by a person, the note made from the order is on its automatic draft (059), once; the signature stays. The hand-made one isn't.
    const drafted = (await adminClient().from("delivery_notes").select("invoice_id").eq("id", linked).single()).data!.invoice_id as string;
    expect((await adminClient().from("invoices").select("status, invoice_ref").eq("id", drafted).single()).data).toEqual({ status: "draft", invoice_ref: null });
    expect((await invoiceFrom(as.office, [linked])).error).toMatchObject({ code: "22023" });
    expect((await adminClient().from("delivery_notes").select("invoice_id").eq("id", manual).single()).data!.invoice_id).toBeNull();
    expect((await adminClient().from("delivery_notes").select("status, signed_by_name").eq("id", linked).single()).data).toEqual({ status: "signed", signed_by_name: "A. Driver" });
    await withDb(async (db) => expect((await db.query("select count(*)::int as n from public.delivery_note_items where delivery_note_id = $1", [linked])).rows[0].n).toBe(3));
  });
});

describe("internal jobs are never despatched or invoiced (migration 042)", () => {
  it("in either company: refused through create_delivery_note, and by a direct write to delivery_notes or invoices (a job from another order too)", async () => {
    for (const [tenant, client] of [["alpha", as.admin], ["beta", as.betaAdmin]] as const) {
      const org = world.tenants[tenant].id;
      const made = await client.rpc("create_job", { p_customer: null, p_description: `Tooling ${tenant}`, p_internal: true, p_related: null, p_required: null, p_machines: [], p_clash_override: false, p_clashes: [], p_override_reason: null });
      expect(made.error, tenant).toBeNull();
      const internal = made.data.job_id as string;
      const { order } = await orderWithLines(org, `Internal Co ${tenant}`);
      const all = await lines(client, order);
      // Through the function: with the order, and from the job alone.
      const withOrder = await client.rpc("create_delivery_note", { p_order: order, p_job: internal, p_ship_date: TODAY, p_tax_date: TODAY, p_ship_via: null, p_notes: null, p_lines: [{ line_id: all[0].line_id, quantity: 1 }] });
      expect(withOrder.error, tenant).not.toBeNull();
      const alone = await client.rpc("create_delivery_note", { p_order: null, p_job: internal, p_ship_date: TODAY, p_tax_date: TODAY, p_ship_via: null, p_notes: null, p_lines: [{ line_id: all[0].line_id, quantity: 1 }] });
      expect(alone.error, tenant).not.toBeNull();
      expect((await adminClient().from("delivery_notes").select("id").eq("job_id", internal)).data).toEqual([]);
      // A job converted from ANOTHER order of the same company.
      const { order: other } = await orderWithLines(org, `Other Co ${tenant}`);
      const converted = await client.rpc("convert_sales_order", { p_order: other });
      expect(converted.error, tenant).toBeNull();
      const otherJob = converted.data.job_id as string;
      // Direct writes, as the database owner, each rolled back: the trigger holds every path to the same rule.
      const attempt = (sql: string, params: unknown[]) => withDb(async (db) => {
        await db.query("begin");
        try {
          await db.query(sql, params);
          return null;
        } catch (err) {
          return err as { code?: string; hint?: string };
        } finally {
          await db.query("rollback");
        }
      });
      expect(await attempt("insert into public.delivery_notes (organization_id, dn_number, job_id) values ($1, $2, $3)", [org, `DN-INT-${world.runId}-${tenant}`, internal])).toMatchObject({ code: "42501", hint: "internal_job" });
      expect(await attempt("insert into public.delivery_notes (organization_id, dn_number, sales_order_id, job_id) values ($1, $2, $3, $4)", [org, `DN-MIS-${world.runId}-${tenant}`, order, otherJob])).toMatchObject({ code: "42501", hint: "job_order_mismatch" });
      expect(await attempt("insert into public.invoices (organization_id, customer, job_id) values ($1, 'X', $2)", [org, internal])).toMatchObject({ code: "42501", hint: "internal_job" });
      // The matching job on its own order is still fine for the table (the function's other rules aside).
      expect(await attempt("insert into public.delivery_notes (organization_id, dn_number, sales_order_id, job_id) values ($1, $2, $3, $4)", [org, `DN-OK-${world.runId}-${tenant}`, other, otherJob])).toBeNull();
      // A one-sided link (the order's converted_to_job_id names the job, the job doesn't name the order), as create_delivery_note accepts it.
      const { order: oneSided } = await orderWithLines(org, `One-sided Co ${tenant}`);
      const sideJob = (await adminClient().from("jobs").insert({ organization_id: org, job_no: `J-SIDE-${world.runId}-${tenant}`, customer: "Side" }).select("id").single()).data!.id as string;
      expect((await adminClient().from("sales_orders").update({ converted_to_job_id: sideJob }).eq("id", oneSided)).error).toBeNull();
      expect(await attempt("insert into public.delivery_notes (organization_id, dn_number, sales_order_id, job_id) values ($1, $2, $3, $4)", [org, `DN-SIDE-${world.runId}-${tenant}`, oneSided, sideJob])).toBeNull();
      // Updates after the insert are held to the same rule: a swap to an internal job, a job from another order, another order for the job.
      const after = (setup: string, setupParams: unknown[], sql: string, params: unknown[]) => withDb(async (db) => {
        await db.query("begin");
        try {
          await db.query(setup, setupParams);
          await db.query(sql, params);
          return null;
        } catch (err) {
          return err as { code?: string; hint?: string };
        } finally {
          await db.query("rollback");
        }
      });
      const dnInsert = "insert into public.delivery_notes (id, organization_id, dn_number, sales_order_id, job_id) values ('11111111-1111-4111-8111-111111111111', $1, $2, $3, $4)";
      expect(await after(dnInsert, [org, `DN-UPD-${world.runId}-${tenant}`, other, otherJob], "update public.delivery_notes set job_id = $1 where id = '11111111-1111-4111-8111-111111111111'", [internal])).toMatchObject({ code: "42501", hint: "internal_job" });
      expect(await after(dnInsert, [org, `DN-UPD-${world.runId}-${tenant}`, other, otherJob], "update public.delivery_notes set sales_order_id = $1 where id = '11111111-1111-4111-8111-111111111111'", [order])).toMatchObject({ code: "42501", hint: "job_order_mismatch" });
      expect(await after(dnInsert, [org, `DN-UPD-${world.runId}-${tenant}`, other, otherJob], "update public.delivery_notes set job_id = $1 where id = '11111111-1111-4111-8111-111111111111'", [sideJob])).toMatchObject({ code: "42501", hint: "job_order_mismatch" });
      expect(await after(dnInsert, [org, `DN-UPD-${world.runId}-${tenant}`, other, otherJob], "update public.delivery_notes set notes = 'status only' where id = '11111111-1111-4111-8111-111111111111'", [])).toBeNull();
      const invInsert = "insert into public.invoices (id, organization_id, customer, job_id) values ('22222222-2222-4222-8222-222222222222', $1, 'X', $2)";
      expect(await after(invInsert, [org, otherJob], "update public.invoices set job_id = $1 where id = '22222222-2222-4222-8222-222222222222'", [internal])).toMatchObject({ code: "42501", hint: "internal_job" });
      expect(await after(invInsert, [org, otherJob], "update public.invoices set job_id = $1 where id = '22222222-2222-4222-8222-222222222222'", [sideJob])).toBeNull();

      // The typed job number on a manual delivery note (job_ref): matched against this company's job numbers on every insert and update.
      const internalNo = made.data.job_no as string;
      const otherNo = (await adminClient().from("jobs").select("job_no").eq("id", otherJob).single()).data!.job_no as string;
      const inTx = (steps: [string, unknown[]][]) => withDb(async (db) => {
        await db.query("begin");
        try {
          for (const [sql, params] of steps) await db.query(sql, params);
          return null;
        } catch (err) {
          return err as { code?: string; hint?: string; message?: string };
        } finally {
          await db.query("rollback");
        }
      });
      const refInsert = "insert into public.delivery_notes (id, organization_id, dn_number, customer, job_ref) values ('33333333-3333-4333-8333-333333333333', $1, $2, 'Typed Co', $3)";
      expect(await inTx([[refInsert, [org, `DN-REF-${world.runId}-${tenant}`, internalNo]]])).toMatchObject({ code: "42501", hint: "internal_job" });
      expect(await inTx([[refInsert, [org, `DN-REF-${world.runId}-${tenant}`, `  ${internalNo}  `]]])).toMatchObject({ code: "42501", hint: "internal_job" });
      expect(await inTx([[refInsert, [org, `DN-REF-${world.runId}-${tenant}`, otherNo]]])).toBeNull();
      expect(await inTx([[refInsert, [org, `DN-REF-${world.runId}-${tenant}`, `J-NOSUCH-${world.runId}`]]])).toBeNull();
      expect(await inTx([[refInsert, [org, `DN-REF-${world.runId}-${tenant}`, otherNo]], ["update public.delivery_notes set job_ref = $1 where id = '33333333-3333-4333-8333-333333333333'", [internalNo]]])).toMatchObject({ code: "42501", hint: "internal_job" });
      // A free-text reference that later becomes an internal job's number: the next update of the note (a status change before
      // despatch, a note) is refused; the number in another company doesn't count.
      const laterNo = `J-LATER-${world.runId}-${tenant}`;
      const otherOrg = world.tenants[tenant === "alpha" ? "beta" : "alpha"].id;
      const jobInsert = "insert into public.jobs (organization_id, job_no, customer, description, is_internal) values ($1, $2, null, 'Tooling later', true)";
      expect(await inTx([[refInsert, [org, `DN-REF-${world.runId}-${tenant}`, laterNo]], [jobInsert, [org, laterNo]], ["update public.delivery_notes set status = 'ready' where id = '33333333-3333-4333-8333-333333333333'", []]])).toMatchObject({ code: "42501", hint: "internal_job" });
      expect(await inTx([[refInsert, [org, `DN-REF-${world.runId}-${tenant}`, laterNo]], [jobInsert, [org, laterNo]], ["update public.delivery_notes set notes = 'checked' where id = '33333333-3333-4333-8333-333333333333'", []]])).toMatchObject({ code: "42501", hint: "internal_job" });
      expect(await inTx([[refInsert, [org, `DN-REF-${world.runId}-${tenant}`, laterNo]], [jobInsert, [otherOrg, laterNo]], ["update public.delivery_notes set notes = 'checked' where id = '33333333-3333-4333-8333-333333333333'", []]])).toBeNull();
      // Invoices carry no typed job reference: job_id is the only job column, so the link check above covers them.
      const invoiceJobColumns = await withDb((db) => db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'invoices' and column_name ilike '%job%' order by 1"));
      expect(invoiceJobColumns.rows.map((r) => r.column_name)).toEqual(["job_id"]);
      // And create_invoice_from_delivery_notes carries only job_id from the notes (no free text), so there is nothing else to resolve.
      const invoiceFn = await withDb((db) => db.query<{ src: string }>("select prosrc as src from pg_proc where proname = 'create_invoice_from_delivery_notes'"));
      expect(invoiceFn.rows[0].src).not.toMatch(/job_ref/);
    }
  });
});
