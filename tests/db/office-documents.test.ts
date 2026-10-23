/**
 * Office access to sales orders and invoices (migration 034, W1). The office role reads and writes sales orders, converts
 * them to jobs, creates invoice drafts, issues them and records payments. Reversing a payment, confirming imported payments
 * and deleting a sales order stay with admins. Workshop and viewer have none of it, and another company has none of it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity } from "../support/fixtures";

let world: SyntheticWorld;
const clients: Record<string, SupabaseClient> = {};
const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) clients[role] = await signedInClient(world.tenants.alpha.users[role]);
  clients.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
  clients.betaOffice = await signedInClient(world.tenants.beta.users.office);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

const draftInvoice = (client: SupabaseClient) =>
  client.rpc("create_with_lines", {
    p_parent: "invoices",
    p_header: { customer: "Office Co", subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: true, status: "draft", amount_paid: 0, due_date: "2099-01-31" },
    p_child: "invoice_line_items", p_fk: "invoice_id",
    p_lines: [{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }],
  });
const salesOrder = (client: SupabaseClient, tag: string) =>
  client.from("sales_orders").insert({ organization_id: world.tenants.alpha.id, so_number: `SO-OFF-${tag}-${world.runId}`, customer: "Office Co", total_value: 100 }).select("id").single();

describe("sales orders", () => {
  it("office creates, edits and converts an order; workshop and viewer can't touch one; only an admin deletes", async () => {
    const created = await salesOrder(clients.office, "A");
    expect(created.error).toBeNull();
    const id = created.data!.id as string;
    expect((await clients.office.from("sales_orders").update({ customer: "Office Co Ltd" }).eq("id", id).select("id")).data).toHaveLength(1);
    expect((await clients.office.from("sales_orders").select("id").eq("id", id)).data).toHaveLength(1);

    for (const role of ["workshop", "viewer"]) {
      expect((await salesOrder(clients[role], role)).error, `${role} create`).not.toBeNull();
      expect((await clients[role].from("sales_orders").select("id").eq("id", id)).data, `${role} read`).toEqual([]);
      expect((await clients[role].rpc("convert_sales_order", { p_order: id })).error, `${role} convert`).toMatchObject({ code: "42501" });
    }
    expect((await clients.betaOffice.rpc("convert_sales_order", { p_order: id })).error).toMatchObject({ code: "P0002" });

    const converted = await clients.office.rpc("convert_sales_order", { p_order: id });
    expect(converted.error).toBeNull();
    expect(converted.data).toMatchObject({ created: true });
    const job = (await adminClient().from("jobs").select("organization_id, converted_from_sales_order_id").eq("id", converted.data.job_id).single()).data;
    expect(job).toEqual({ organization_id: world.tenants.alpha.id, converted_from_sales_order_id: id });

    expect((await clients.office.from("sales_orders").delete().eq("id", id).select("id")).data).toEqual([]);
    expect((await clients.admin.from("sales_orders").delete().eq("id", id).select("id")).data).toHaveLength(1);
  });
});

describe("invoices", () => {
  it("office creates a draft, issues it and records the payments; admin-only steps stay refused", async () => {
    const created = await draftInvoice(clients.office);
    expect(created.error).toBeNull();
    const id = created.data as string;
    const issued = await clients.office.rpc("issue_invoice", { p_invoice: id });
    expect(issued.error).toBeNull();
    expect(issued.data).toMatch(/^INV-\d+$/);

    const first = await clients.office.rpc("record_invoice_payment", { p_request_id: crypto.randomUUID(), p_invoice: id, p_amount: 50, p_paid_on: TODAY, p_method: "BACS", p_reference: null });
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ status: "partial", balance_due: 70 });
    const second = await clients.office.rpc("record_invoice_payment", { p_request_id: crypto.randomUUID(), p_invoice: id, p_amount: 70, p_paid_on: TODAY, p_method: "BACS", p_reference: null });
    expect(second.data).toMatchObject({ status: "paid", balance_due: 0 });

    expect((await clients.office.rpc("reverse_invoice_payment", { p_payment: first.data.payment_id, p_reason: "Office may not" })).error).toMatchObject({ code: "42501" });
    expect((await clients.office.rpc("confirm_invoice_payments", { p_invoice: id, p_note: "Office may not" })).error).toMatchObject({ code: "42501" });
    expect((await clients.admin.rpc("reverse_invoice_payment", { p_payment: first.data.payment_id, p_reason: "Admin may" })).error).toBeNull();

    // Office can read the payments and the line items; the totals on the invoice are the stored ones.
    expect((await clients.office.from("invoice_payments").select("id").eq("invoice_id", id)).data).toHaveLength(3);
    expect((await clients.office.from("invoice_line_items").select("id").eq("invoice_id", id)).data).toHaveLength(1);
  });

  it("workshop and viewer can't create, read, issue or pay an invoice", async () => {
    const id = (await draftInvoice(clients.admin)).data as string;
    for (const role of ["workshop", "viewer"]) {
      expect((await draftInvoice(clients[role])).error, `${role} create`).not.toBeNull();
      expect((await clients[role].from("invoices").select("id").eq("id", id)).data, `${role} read`).toEqual([]);
      expect((await clients[role].from("invoice_line_items").select("id").eq("invoice_id", id)).data, `${role} lines`).toEqual([]);
      expect((await clients[role].rpc("issue_invoice", { p_invoice: id })).error, `${role} issue`).toMatchObject({ code: "42501" });
    }
    expect((await clients.admin.rpc("issue_invoice", { p_invoice: id })).error).toBeNull();
    for (const role of ["workshop", "viewer"]) {
      expect((await clients[role].rpc("record_invoice_payment", { p_request_id: crypto.randomUUID(), p_invoice: id, p_amount: 10, p_paid_on: TODAY, p_method: "BACS", p_reference: null })).error, `${role} pay`).toMatchObject({ code: "42501" });
    }
  });

  it("another company's office user can't see, issue or pay it", async () => {
    const id = (await draftInvoice(clients.office)).data as string;
    expect((await clients.betaOffice.from("invoices").select("id").eq("id", id)).data).toEqual([]);
    expect((await clients.betaOffice.rpc("issue_invoice", { p_invoice: id })).error).toMatchObject({ code: "P0002" });
    expect((await clients.office.rpc("issue_invoice", { p_invoice: id })).error).toBeNull();
    expect((await clients.betaOffice.rpc("record_invoice_payment", { p_request_id: crypto.randomUUID(), p_invoice: id, p_amount: 10, p_paid_on: TODAY, p_method: "BACS", p_reference: null })).error).toMatchObject({ code: "P0002" });
    expect((await clients.betaOffice.from("invoice_payments").select("id").eq("invoice_id", id)).data).toEqual([]);
  });

  it("an office user can delete a draft but not an issued invoice", async () => {
    const draft = (await draftInvoice(clients.office)).data as string;
    expect((await clients.office.from("invoices").delete().eq("id", draft).select("id")).data).toHaveLength(1);
    const issued = (await draftInvoice(clients.office)).data as string;
    await clients.office.rpc("issue_invoice", { p_invoice: issued });
    expect((await clients.office.from("invoices").delete().eq("id", issued).select("id")).error).toMatchObject({ code: "42501" });
  });
});
