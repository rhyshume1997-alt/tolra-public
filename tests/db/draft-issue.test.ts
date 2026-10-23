/**
 * Drafts, explicit issue and separate send records (migration 027; independent review of 0604bf4).
 * Invoices: drafts have no number and aren't owed; issue_invoice gives the next number (no gaps from drafts), records
 * issuer/customer and fixes the contents; issued invoices are owed whether or not e-mailed; recording the send changes
 * nothing else. Purchase orders: drafts editable, issued ones fixed except delivery date, notes and progress.
 * Quotes and invoices can't leave draft unless their lines add up to their stored totals.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { owed } from "@/lib/receivables";
import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
let admin: SupabaseClient;
let office: SupabaseClient;

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  admin = await signedInClient(world.tenants.alpha.users.admin);
  office = await signedInClient(world.tenants.alpha.users.office);
  // A new purchase order names a supplier on the Suppliers list (082).
  const listed = await adminClient().from("suppliers").insert([{ organization_id: world.tenants.alpha.id, name: "Steel Ltd" }, { organization_id: world.tenants.alpha.id, name: "Other Ltd" }]);
  if (listed.error) throw new Error(`suppliers: ${listed.error.message}`);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

/** A draft invoice for 2 x £50 + 20% VAT = £120, made the way the app makes it. */
async function draftInvoice(client: SupabaseClient = admin, customer = "Issue Co") {
  const { data, error } = await client.rpc("create_with_lines", {
    p_parent: "invoices",
    p_header: { customer, subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: true, status: "draft", amount_paid: 0, due_date: "2099-01-31" },
    p_child: "invoice_line_items",
    p_fk: "invoice_id",
    p_lines: [{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }],
  });
  expect(error).toBeNull();
  return data as string;
}

const row = async (id: string) => (await admin.from("invoices").select("*").eq("id", id).single()).data as Record<string, unknown>;
const refNumber = (ref: unknown) => Number(String(ref).replace(/^INV-/, ""));

describe("invoices: draft, issue, numbering", () => {
  it("a draft has no number and isn't money owed", async () => {
    const id = await draftInvoice();
    const draft = await row(id);
    expect({ status: draft.status, ref: draft.invoice_ref }).toEqual({ status: "draft", ref: null });
    expect(owed(draft as never)).toBe(0);
  });

  it("issuing gives the next number, records issuer and customer, and makes it owed; issuing again changes nothing", async () => {
    const id = await draftInvoice();
    const { data: ref, error } = await admin.rpc("issue_invoice", { p_invoice: id });
    expect(error).toBeNull();
    expect(String(ref)).toMatch(/^INV-\d{4,}$/);
    const issued = await row(id);
    expect(issued).toMatchObject({ status: "issued", invoice_ref: ref });
    expect(issued.issuer_snapshot).toBeTruthy();
    expect(owed(issued as never)).toBe(120);
    expect((await admin.rpc("issue_invoice", { p_invoice: id })).data).toBe(ref);
    expect((await row(id)).invoice_ref).toBe(ref);
  });

  it("drafts never use up a number: deleting one leaves no gap between issued invoices", async () => {
    const [a, b, c] = [await draftInvoice(), await draftInvoice(), await draftInvoice()];
    expect((await admin.from("invoices").delete().eq("id", b).select("id")).data).toHaveLength(1);
    const first = (await admin.rpc("issue_invoice", { p_invoice: a })).data;
    const second = (await admin.rpc("issue_invoice", { p_invoice: c })).data;
    expect(refNumber(second) - refNumber(first)).toBe(1);
  });

  it("two invoices issued at the same moment get two different, consecutive numbers", async () => {
    const [a, b] = [await draftInvoice(), await draftInvoice()];
    const results = await Promise.all([admin.rpc("issue_invoice", { p_invoice: a }), admin.rpc("issue_invoice", { p_invoice: b })]);
    for (const r of results) expect(r.error).toBeNull();
    const numbers = results.map((r) => refNumber(r.data)).sort((x, y) => x - y);
    expect(numbers[1] - numbers[0]).toBe(1);
  });

  it("admin and office can issue, workshop and viewer can't; another company's invoice isn't found", async () => {
    const id = await draftInvoice();
    for (const role of ["workshop", "viewer"] as const) {
      expect((await (await signedInClient(world.tenants.alpha.users[role])).rpc("issue_invoice", { p_invoice: id })).error, role).not.toBeNull();
    }
    expect((await row(id)).status).toBe("draft");
    const other = await signedInClient(world.tenants.beta.users.admin);
    expect((await other.rpc("issue_invoice", { p_invoice: id })).error).toMatchObject({ code: "P0002" });
    expect((await row(id)).status).toBe("draft");
  });

  it("an invoice can't leave draft without a number (a plain status update is refused)", async () => {
    const id = await draftInvoice();
    const { error } = await admin.from("invoices").update({ status: "issued" }).eq("id", id);
    expect(error).toMatchObject({ code: "23514" });
    expect((await row(id)).status).toBe("draft");
  });
});

describe("invoices: issue lock, sending, balances", () => {
  let id: string;
  beforeAll(async () => {
    id = await draftInvoice();
    expect((await admin.rpc("issue_invoice", { p_invoice: id })).error).toBeNull();
  });

  it("issued: amounts, customer and lines are fixed; it can't be deleted or go back to draft", async () => {
    expect((await admin.from("invoices").update({ total: 999 }).eq("id", id)).error).toMatchObject({ code: "42501" });
    expect((await admin.from("invoices").update({ customer: "Someone Else" }).eq("id", id)).error).toMatchObject({ code: "42501" });
    expect((await admin.from("invoices").update({ status: "draft" }).eq("id", id)).error).toMatchObject({ code: "42501" });
    expect((await admin.from("invoices").delete().eq("id", id)).error).toMatchObject({ code: "42501" });
    expect((await admin.from("invoice_line_items").update({ unit_price: 1 }).eq("invoice_id", id)).error).toMatchObject({ code: "42501" });
    expect(await row(id)).toMatchObject({ total: 120, customer: "Issue Co", status: "issued" });
  });

  it("recording the send sets only the send time; it's owed before and after", async () => {
    expect(owed((await row(id)) as never)).toBe(120);
    const sentAt = new Date().toISOString();
    expect((await admin.from("invoices").update({ sent_date: sentAt }).eq("id", id)).error).toBeNull();
    const after = await row(id);
    expect(after).toMatchObject({ status: "issued", total: 120 });
    expect(after.sent_date).toBeTruthy();
    expect(owed(after as never)).toBe(120);
  });

  it("a part payment reduces what is owed; paying the rest settles it", async () => {
    // Payments are recorded with record_invoice_payment (migration 032); the lock no longer lets amount_paid be edited.
    expect((await admin.from("invoices").update({ amount_paid: 45.5 }).eq("id", id)).error).toMatchObject({ code: "42501" });
    expect((await admin.rpc("record_invoice_payment", { p_request_id: crypto.randomUUID(), p_invoice: id, p_amount: 45.5, p_paid_on: "2026-10-01", p_method: "BACS", p_reference: null })).error).toBeNull();
    expect(owed((await row(id)) as never)).toBe(74.5);
    expect((await admin.rpc("record_invoice_payment", { p_request_id: crypto.randomUUID(), p_invoice: id, p_amount: 74.5, p_paid_on: "2026-10-02", p_method: "BACS", p_reference: null })).error).toBeNull();
    expect(owed((await row(id)) as never)).toBe(0);
  });
});

describe("nothing leaves draft unless its lines add up to its stored totals", () => {
  it("invoice: a draft whose stored total doesn't match its lines can't be issued, and keeps its amounts", async () => {
    const id = await draftInvoice();
    // As an import or the SQL editor could leave it: header total no longer equal to the lines.
    await withDb((db) => db.query("update public.invoices set total = 150, vat = 50 where id = $1", [id]));
    const { error } = await admin.rpc("issue_invoice", { p_invoice: id });
    expect(error).toMatchObject({ code: "22023" });
    expect(await row(id)).toMatchObject({ status: "draft", invoice_ref: null, total: 150 });
  });

  it("quote: a mismatched draft can't be sent or accepted; a matching one can", async () => {
    const make = async (ref: string) => {
      const { data, error } = await office.rpc("create_with_lines", {
        p_parent: "quotes",
        p_header: { quote_ref: ref, customer: "Issue Co", total_value: 144, vat_enabled: true, status: "draft" },
        p_child: "quote_line_items", p_fk: "quote_id",
        p_lines: [{ position: 0, description: "Line", quantity: 2, unit_price: 60, vat_pct: 20, vat_exempt: false }],
      });
      expect(error).toBeNull();
      return data as string;
    };
    const bad = await make(`QUO-M1-${world.runId}`);
    await withDb((db) => db.query("update public.quotes set total_value = 120 where id = $1", [bad]));
    for (const status of ["sent", "accepted"]) {
      expect((await office.from("quotes").update({ status }).eq("id", bad)).error).toMatchObject({ code: "22023" });
    }
    const good = await make(`QUO-M2-${world.runId}`);
    expect((await office.from("quotes").update({ status: "sent" }).eq("id", good)).error).toBeNull();
  });
});

describe("purchase orders: draft, issue, send record", () => {
  async function draftPo(ref: string) {
    const { data, error } = await office.from("purchase_orders")
      .insert({ organization_id: world.tenants.alpha.id, po_ref: ref, po_number: ref, supplier: "Steel Ltd", total_value: 250, status: "draft", items: [{ description: "Bar", qty: 10, unit_price: 25 }] })
      .select("id").single();
    expect(error).toBeNull();
    return data!.id as string;
  }
  const po = async (id: string) => (await office.from("purchase_orders").select("*").eq("id", id).single()).data as Record<string, unknown>;

  it("a draft can be changed and deleted", async () => {
    const id = await draftPo(`PO-D1-${world.runId}`);
    expect((await office.from("purchase_orders").update({ total_value: 300, supplier: "Other Ltd" }).eq("id", id)).error).toBeNull();
    expect((await office.from("purchase_orders").delete().eq("id", id).select("id")).data).toHaveLength(1);
  });

  it("issued: supplier, items and value fixed; delivery date, notes, send record and receipt still open; keeps its number", async () => {
    const ref = `PO-D2-${world.runId}`;
    const id = await draftPo(ref);
    expect((await office.from("purchase_orders").update({ status: "issued" }).eq("id", id)).error).toBeNull();
    expect((await office.from("purchase_orders").update({ total_value: 1 }).eq("id", id)).error).toMatchObject({ code: "42501" });
    expect((await office.from("purchase_orders").update({ supplier: "Other Ltd" }).eq("id", id)).error).toMatchObject({ code: "42501" });
    expect((await office.from("purchase_orders").update({ status: "draft" }).eq("id", id)).error).toMatchObject({ code: "42501" });
    expect((await office.from("purchase_orders").delete().eq("id", id)).error).toMatchObject({ code: "42501" });
    expect((await office.from("purchase_orders").update({ expected_delivery: "2099-02-01", notes: "Supplier moved delivery" }).eq("id", id)).error).toBeNull();
    expect((await office.from("purchase_orders").update({ sent_at: new Date().toISOString() }).eq("id", id)).error).toBeNull();
    expect(await po(id)).toMatchObject({ status: "issued", po_ref: ref, total_value: 250, supplier: "Steel Ltd" });
    expect((await office.from("purchase_orders").update({ status: "received", received_at: new Date().toISOString() }).eq("id", id)).error).toBeNull();
  });

  it("existing issued records keep their status: a legacy 'sent' order is treated as issued", async () => {
    const id = await draftPo(`PO-D3-${world.runId}`);
    await withDb((db) => db.query("update public.purchase_orders set status = 'sent' where id = $1", [id]));
    expect((await office.from("purchase_orders").update({ total_value: 1 }).eq("id", id)).error).toMatchObject({ code: "42501" });
    expect((await po(id)).status).toBe("sent");
  });
});

describe("imported invoices without payment details", () => {
  it("flagged invoices aren't owed until checked; confirming makes them owed; the flag can be cleared after issue", async () => {
    const id = await draftInvoice();
    expect((await admin.rpc("issue_invoice", { p_invoice: id })).error).toBeNull();
    await withDb((db) => db.query("update public.invoices set payment_unverified = true where id = $1", [id]));
    expect(owed((await row(id)) as never)).toBe(0);
    // Cleared only by the admin's explicit confirmation (migration 032), never by editing the flag.
    expect((await admin.from("invoices").update({ payment_unverified: false }).eq("id", id)).error).toMatchObject({ code: "42501" });
    expect((await admin.rpc("confirm_invoice_payments", { p_invoice: id, p_note: "Checked: still owed" })).error).toBeNull();
    expect(owed((await row(id)) as never)).toBe(120);
  });
});

describe("the previous app version against this database (between migrating and deploying)", () => {
  it("its quote send still works; an invoice or purchase order created as already issued is refused (033), never half-saved", async () => {
    // Old invoice form: number allocated up front, created as "sent" through create_with_lines. Refused since 033
    // (creating an invoice that skips the issue step); nothing is stored.
    const { data: ref } = await admin.rpc("next_doc_number", { p_prefix: "INV" });
    const before = (await adminClient().from("invoices").select("id", { count: "exact", head: true }).eq("organization_id", world.tenants.alpha.id)).count;
    const { error: invoiceError } = await admin.rpc("create_with_lines", {
      p_parent: "invoices",
      p_header: { invoice_ref: ref, customer: "Old App Co", subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: true, status: "sent", amount_paid: 0, due_date: "2099-01-31" },
      p_child: "invoice_line_items", p_fk: "invoice_id",
      p_lines: [{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }],
    });
    expect(invoiceError).toMatchObject({ code: "42501" });
    expect((await adminClient().from("invoices").select("id", { count: "exact", head: true }).eq("organization_id", world.tenants.alpha.id)).count).toBe(before);
    // Old PO form: created straight as "sent". Refused since 033.
    const { error: poError } = await office.from("purchase_orders")
      .insert({ organization_id: world.tenants.alpha.id, po_ref: `PO-OLD-${world.runId}`, po_number: `PO-OLD-${world.runId}`, supplier: "Steel Ltd", total_value: 90, status: "sent" });
    expect(poError).toMatchObject({ code: "42501" });
    // Old quote send: draft -> sent by a plain update, fine when the lines match.
    const { data: quoteId } = await office.rpc("create_with_lines", {
      p_parent: "quotes",
      p_header: { quote_ref: `QUO-OLD-${world.runId}`, customer: "Old App Co", total_value: 60, vat_enabled: true, status: "draft" },
      p_child: "quote_line_items", p_fk: "quote_id",
      p_lines: [{ position: 0, description: "Line", quantity: 1, unit_price: 50, vat_pct: 20, vat_exempt: false }],
    });
    expect((await office.from("quotes").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", quoteId as string)).error).toBeNull();
  });
});
