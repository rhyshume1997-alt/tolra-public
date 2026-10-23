/**
 * Issued documents (audit B4a: D8, D9, A8). An issued invoice keeps its amounts, customer and lines; payment and
 * status still change. Quotes and invoices remember the issuer and customer details as they were when issued.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { documentTotals } from "@/lib/money";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
let admin: SupabaseClient;
let seq = 0;
const customer = "Snapshot Customer Ltd";

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  admin = await signedInClient(world.tenants.alpha.users.admin);
  const { error } = await adminClient().from("customers").insert({ organization_id: world.tenants.alpha.id, name: customer, address: "1 Old Road\nOldtown\nOL1 1AA" });
  if (error) throw new Error(error.message);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

/** "sent" = a finished (issued) invoice: since 033 an API user can only create drafts, so it is drafted, then issued. */
async function createInvoice(status: "sent" | "draft", extraHeader: Record<string, unknown> = {}) {
  seq += 1;
  const lines = [{ quantity: 2, unitPrice: 150, vatPct: 20 }, { quantity: 1, unitPrice: 40, vatPct: 0 }];
  const totals = documentTotals(lines, 0, { vatEnabled: true, standardRate: 20 });
  const { data, error } = await admin.rpc("create_with_lines", {
    p_parent: "invoices",
    p_header: { customer, subtotal: totals.subtotal, carriage: 0, vat: totals.vat, total: totals.total, vat_enabled: true, carriage_vat: false, status: "draft", amount_paid: 0, due_date: "2026-11-08", ...extraHeader },
    p_child: "invoice_line_items",
    p_fk: "invoice_id",
    p_lines: lines.map((l, position) => ({ position, description: `Line ${position}`, quantity: l.quantity, unit_price: l.unitPrice, vat_pct: l.vatPct, vat_exempt: false })),
  });
  if (error) throw new Error(error.message);
  if (status === "sent") {
    const issued = await admin.rpc("issue_invoice", { p_invoice: data as string });
    if (issued.error) throw new Error(issued.error.message);
  }
  return data as string;
}

const row = async (id: string) => (await adminClient().from("invoices").select("*").eq("id", id).single()).data as Record<string, unknown>;

describe("snapshot at issue", () => {
  it("records issuer and customer details from the server, ignoring any the caller sends", async () => {
    const id = await createInvoice("sent", { issuer_snapshot: { documentName: "Forged Ltd" }, customer_snapshot: { name: "Forged" } });
    const invoice = await row(id);
    expect(invoice.status).toBe("issued");
    expect(invoice.issuer_snapshot).toMatchObject({ documentName: world.tenants.alpha.name, vatNumber: "GB 000 0000 00", vatRegistered: true, defaultVatRate: 20, addressLines: ["Unit 1, Test Estate", "Testtown", "TE1 1ST"] });
    expect(invoice.customer_snapshot).toEqual({ name: customer, address: "1 Old Road\nOldtown\nOL1 1AA", found: true });
  });

  it("later changes to the company or the customer don't touch an issued document's snapshot", async () => {
    const id = await createInvoice("sent");
    const before = await row(id);
    const service = adminClient();
    const { data: settings } = await service.from("organization_settings").select("company_profile").eq("organization_id", world.tenants.alpha.id).single();
    await service.from("organization_settings").update({ company_profile: { ...(settings!.company_profile as object), addressLines: ["New HQ"], vatRegistered: false, defaultVatRate: 17.5 } }).eq("organization_id", world.tenants.alpha.id);
    await service.from("customers").update({ address: "99 New Street" }).eq("name", customer);
    try {
      const after = await row(id);
      expect(after.issuer_snapshot).toEqual(before.issuer_snapshot);
      expect(after.customer_snapshot).toEqual(before.customer_snapshot);
      expect([after.subtotal, after.vat, after.total]).toEqual([before.subtotal, before.vat, before.total]);
    } finally {
      await service.from("organization_settings").update({ company_profile: settings!.company_profile }).eq("organization_id", world.tenants.alpha.id);
      await service.from("customers").update({ address: "1 Old Road\nOldtown\nOL1 1AA" }).eq("name", customer);
    }
  });
});

describe("issued invoice lock", () => {
  const refused: [string, (id: string, client: SupabaseClient) => PromiseLike<{ error: unknown; data?: unknown }>][] = [
    ["change the total", (id, c) => c.from("invoices").update({ total: 1 }).eq("id", id)],
    ["change the customer", (id, c) => c.from("invoices").update({ customer: "Someone else" }).eq("id", id)],
    ["change the due date", (id, c) => c.from("invoices").update({ due_date: "2027-01-01" }).eq("id", id)],
    ["rewrite the snapshot", (id, c) => c.from("invoices").update({ issuer_snapshot: { documentName: "X" } }).eq("id", id)],
    ["go back to draft", (id, c) => c.from("invoices").update({ status: "draft" }).eq("id", id)],
    ["delete it", (id, c) => c.from("invoices").delete().eq("id", id)],
    ["add a line", (id, c) => c.from("invoice_line_items").insert({ organization_id: world.tenants.alpha.id, invoice_id: id, position: 9, description: "Extra", quantity: 1, unit_price: 1 })],
    ["change a line", (id, c) => c.from("invoice_line_items").update({ unit_price: 1 }).eq("invoice_id", id)],
    ["delete a line", (id, c) => c.from("invoice_line_items").delete().eq("invoice_id", id)],
  ];

  for (const [name, attempt] of refused) {
    it(`an admin can't ${name}`, async () => {
      const id = await createInvoice("sent");
      const before = await row(id);
      const linesBefore = (await adminClient().from("invoice_line_items").select("*").eq("invoice_id", id).order("position")).data;
      const { error } = await attempt(id, admin);
      expect(error).not.toBeNull();
      expect(await row(id)).toEqual(before);
      expect((await adminClient().from("invoice_line_items").select("*").eq("invoice_id", id).order("position")).data).toEqual(linesBefore);
    });
  }

  it("the service role is held to the same lock", async () => {
    const id = await createInvoice("sent");
    expect((await adminClient().from("invoices").update({ total: 1 }).eq("id", id)).error).not.toBeNull();
  });

  it("recording a payment still works through the lock (status, amount paid, paid date)", async () => {
    const id = await createInvoice("sent");
    const total = Number((await row(id)).total);
    const { error } = await admin.rpc("record_invoice_payment", { p_request_id: crypto.randomUUID(), p_invoice: id, p_amount: total, p_paid_on: "2026-10-01", p_method: "BACS", p_reference: null });
    expect(error).toBeNull();
    expect(await row(id)).toMatchObject({ status: "paid", amount_paid: total });
  });

  it("a draft invoice stays editable, lines included", async () => {
    const id = await createInvoice("draft");
    expect((await row(id)).status).toBe("draft");
    expect((await admin.from("invoice_line_items").update({ description: "Corrected" }).eq("invoice_id", id).eq("position", 0)).error).toBeNull();
    expect((await admin.from("invoices").update({ customer_po: "PO-1" }).eq("id", id)).error).toBeNull();
    expect((await admin.from("invoices").delete().eq("id", id)).error).toBeNull();
  });

  it("imports and maintenance as the database owner are not restricted", async () => {
    await withDb(async (db) => {
      const inv = await db.query<{ id: string }>(
        "insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status) values ($1, 'INV-IMPORT', 'Legacy', 10, 2, 12, 'paid') returning id", [world.tenants.alpha.id]);
      await db.query("insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price) values ($1, $2, 0, 'Legacy line', 1, 10)", [world.tenants.alpha.id, inv.rows[0].id]);
    });
    const { count } = await adminClient().from("invoice_line_items").select("id", { count: "exact", head: true }).eq("description", "Legacy line");
    expect(count).toBe(1);
  });
});
