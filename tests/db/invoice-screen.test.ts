/**
 * Migration 073 (invoice screen). void_invoice(p_invoice_id, p_reason): admin and office of the caller's company only; refuses a
 * draft, a void invoice, one with payments (paid or part paid, or imported payments not confirmed), one with a credit applied, a credit
 * note or customer credit against it, and one written off; the reason is required; the status change and a VOID_INVOICE audit row
 * are one transaction. A direct status update to void is refused for the browser roles (the gap: before 073 it worked even with a
 * credit applied), and a void invoice stays void. £0 text-only invoice lines (quantity 0, price 0, a description) are accepted and
 * excluded from the totals; quotes still refuse them. The invoice note and delivery address are saved on a draft and fixed once
 * issued; the customer's mobile is saved like the other fields.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
const as: Record<string, SupabaseClient> = {};
const TODAY = new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  for (const role of ["admin", "office", "workshop", "viewer"] as const) as[role] = await signedInClient(world.tenants.alpha.users[role]);
  as.betaAdmin = await signedInClient(world.tenants.beta.users.admin);
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

type Line = { description: string; quantity: number; unit_price: number; vat_pct?: number };
const PRICED: Line = { description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20 };

/** A draft invoice with these lines (default: 2 x £50 + 20% VAT = £120); totals as given. */
async function draftInvoice(client: SupabaseClient = as.admin, lines: Line[] = [PRICED], totals = { subtotal: 100, vat: 20, total: 120 }) {
  return client.rpc("create_with_lines", {
    p_parent: "invoices",
    p_header: { customer: "Void Co", ...totals, carriage: 0, vat_enabled: true, carriage_vat: false, status: "draft", amount_paid: 0, due_date: "2099-01-31" },
    p_child: "invoice_line_items", p_fk: "invoice_id",
    p_lines: lines.map((line, position) => ({ position, vat_exempt: false, vat_pct: 20, ...line })),
  });
}
async function issuedInvoice(client: SupabaseClient = as.admin) {
  const created = await draftInvoice(client);
  expect(created.error).toBeNull();
  expect((await as.admin.rpc("issue_invoice", { p_invoice: created.data as string })).error).toBeNull();
  return created.data as string;
}
const voidIt = (id: string, client: SupabaseClient = as.office, reason: string | null = "Raised in error") =>
  client.rpc("void_invoice", { p_invoice_id: id, p_reason: reason });
const statusOf = async (id: string) => (await adminClient().from("invoices").select("status").eq("id", id).single()).data!.status as string;
const lineOf = async (invoice: string) => (await adminClient().from("invoice_line_items").select("id").eq("invoice_id", invoice).order("position")).data![0].id as string;
const pay = (id: string, amount: number) =>
  as.admin.rpc("record_invoice_payment", { p_request_id: randomUUID(), p_invoice: id, p_amount: amount, p_paid_on: TODAY, p_method: "BACS", p_reference: null });
const creditNote = async (invoice: string) =>
  as.admin.rpc("create_credit_note", { p_invoice: invoice, p_reason: "Returned", p_credit_date: TODAY, p_lines: [{ invoice_line_id: await lineOf(invoice), quantity: 1 }] });
const voidAudits = async (id: string) =>
  withDb(async (db) => (await db.query<{ actor_user_id: string; metadata: Record<string, string> }>(
    "select actor_user_id, metadata from security_audit.audit_log where action = 'VOID_INVOICE' and entity_table = 'invoices' and entity_id = $1", [id])).rows);

describe("void_invoice refuses", () => {
  it("a draft and an invoice that is already void", async () => {
    const draft = await draftInvoice();
    expect((await voidIt(draft.data as string)).error).toMatchObject({ code: "22023", hint: "invoice_draft" });
    const inv = await issuedInvoice();
    expect((await voidIt(inv)).error).toBeNull();
    expect((await voidIt(inv)).error).toMatchObject({ code: "22023", hint: "invoice_already_void" });
    expect(await voidAudits(inv)).toHaveLength(1);
  });

  it("paid and part paid", async () => {
    const part = await issuedInvoice();
    expect((await pay(part, 20)).error).toBeNull();
    expect((await voidIt(part)).error).toMatchObject({ code: "22023", hint: "invoice_paid" });
    const paid = await issuedInvoice();
    expect((await pay(paid, 120)).error).toBeNull();
    expect((await voidIt(paid)).error).toMatchObject({ code: "22023", hint: "invoice_paid" });
    expect([await statusOf(part), await statusOf(paid)]).toEqual(["partial", "paid"]);
  });

  it("imported payments not yet confirmed", async () => {
    const inv = await issuedInvoice();
    await withDb((db) => db.query("update public.invoices set payment_unverified = true where id = $1", [inv]));
    expect((await voidIt(inv)).error).toMatchObject({ code: "22023", hint: "invoice_payments_unconfirmed" });
  });

  it("credited (a credit note applied, in full or in part) and with a draft credit note against it", async () => {
    const applied = await issuedInvoice();
    const made = await creditNote(applied);
    expect(made.error).toBeNull();
    expect((await as.admin.rpc("issue_credit_note", { p_credit: made.data })).error).toBeNull();
    expect(Number((await adminClient().from("invoices").select("credited_amount").eq("id", applied).single()).data!.credited_amount)).toBeGreaterThan(0);
    expect((await voidIt(applied)).error).toMatchObject({ code: "22023", hint: "invoice_credited" });
    const drafted = await issuedInvoice();
    expect((await creditNote(drafted)).error).toBeNull();
    expect((await voidIt(drafted)).error).toMatchObject({ code: "22023", hint: "invoice_has_credit_notes" });
    // Fully credited: status 'credited'.
    const credited = await issuedInvoice();
    const full = await as.admin.rpc("create_credit_note", { p_invoice: credited, p_reason: "All back", p_credit_date: TODAY, p_lines: [{ invoice_line_id: await lineOf(credited), quantity: 2 }] });
    expect(full.error).toBeNull();
    expect((await as.admin.rpc("issue_credit_note", { p_credit: full.data })).error).toBeNull();
    expect(await statusOf(credited)).toBe("credited");
    expect((await voidIt(credited)).error).toMatchObject({ code: "22023", hint: "invoice_credited" });
  });

  it("written off", async () => {
    const inv = await issuedInvoice();
    expect((await adminClient().from("invoices").update({ status: "written_off" }).eq("id", inv)).error).toBeNull();
    expect((await voidIt(inv)).error).toMatchObject({ code: "22023", hint: "invoice_written_off" });
  });

  it("no reason, a blank one or one over 500 characters", async () => {
    const inv = await issuedInvoice();
    for (const reason of [null, "", "   ", "x".repeat(501)]) expect((await voidIt(inv, as.office, reason)).error).toMatchObject({ code: "22023", hint: "void_reason_required" });
    expect(await statusOf(inv)).toBe("issued");
    expect(await voidAudits(inv)).toHaveLength(0);
  });

  it("workshop, viewer and another company", async () => {
    const inv = await issuedInvoice();
    for (const role of ["workshop", "viewer"]) expect((await voidIt(inv, as[role])).error, role).toMatchObject({ code: "42501" });
    expect((await voidIt(inv, as.betaAdmin)).error).toMatchObject({ code: "P0002" });
    expect(await statusOf(inv)).toBe("issued");
    expect(await voidAudits(inv)).toHaveLength(0);
  });
});

describe("void_invoice voids", () => {
  it("an issued invoice with nothing against it: status void and one audit row with the trimmed reason, in one step", async () => {
    const inv = await issuedInvoice();
    const ref = (await adminClient().from("invoices").select("invoice_ref").eq("id", inv).single()).data!.invoice_ref;
    const result = await voidIt(inv, as.office, "  Raised to the wrong customer  ");
    expect(result.error).toBeNull();
    expect(result.data).toMatchObject({ invoice_id: inv, invoice_ref: ref, status: "void" });
    expect(await statusOf(inv)).toBe("void");
    const audits = await voidAudits(inv);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_user_id: world.tenants.alpha.users.office.id, metadata: { reason: "Raised to the wrong customer", invoice_ref: ref, from_status: "issued" } });
    // The invoice takes no payment or credit afterwards.
    expect((await pay(inv, 10)).error).toMatchObject({ code: "22023" });
    expect((await creditNote(inv)).error).toMatchObject({ code: "22023" });
  });

  it("a client can't make up a VOID_INVOICE event", async () => {
    const inv = await issuedInvoice();
    for (const role of ["admin", "office"]) {
      const forged = await as[role].rpc("write_audit", { p_action: "VOID_INVOICE", p_entity_table: "invoices", p_entity_id: inv, p_old: null, p_new: null, p_metadata: { reason: "made up" }, p_ip: null, p_user_agent: null });
      expect({ role, refused: forged.error !== null }).toEqual({ role, refused: true });
    }
    expect(await voidAudits(inv)).toHaveLength(0);
    expect(await statusOf(inv)).toBe("issued");
  });

  it("an admin can void too", async () => {
    const inv = await issuedInvoice();
    expect((await voidIt(inv, as.admin)).error).toBeNull();
    expect(await statusOf(inv)).toBe("void");
  });
});

describe("the direct route to void is closed", () => {
  it("a direct status update to void is refused with a credit applied (the gap) and without one", async () => {
    const credited = await issuedInvoice();
    const made = await creditNote(credited);
    expect((await as.admin.rpc("issue_credit_note", { p_credit: made.data })).error).toBeNull();
    for (const client of [as.admin, as.office]) {
      // Exact void statuses: the guard (only void_invoice voids). Other spellings: not an allowed status at all.
      for (const status of ["void", "cancelled"]) {
        expect((await client.from("invoices").update({ status }).eq("id", credited).select("id")).error, status).toMatchObject({ code: "42501", hint: "invoice_void_direct" });
      }
      for (const status of ["voided", "Canceled"]) {
        expect((await client.from("invoices").update({ status }).eq("id", credited).select("id")).error, status).toMatchObject({ code: "23514", hint: "invoice_status_not_allowed" });
      }
    }
    expect(await statusOf(credited)).toBe("issued");
    const plain = await issuedInvoice();
    expect((await as.office.from("invoices").update({ status: "void" }).eq("id", plain).select("id")).error).toMatchObject({ code: "42501" });
    expect(await statusOf(plain)).toBe("issued");
    // Other status changes are as before; 034's lock on paid / part paid / credited is still there.
    expect((await as.office.from("invoices").update({ status: "sent" }).eq("id", plain).select("id")).error).toBeNull();
    expect((await as.office.from("invoices").update({ status: "paid" }).eq("id", plain).select("id")).error).toMatchObject({ code: "42501" });
  });

  it("the review's bypass: void with a line break, a tab, a trailing space, a no-break space or in capitals is refused for every role", async () => {
    const credited = await issuedInvoice();
    const made = await creditNote(credited);
    expect((await as.admin.rpc("issue_credit_note", { p_credit: made.data })).error).toBeNull();
    const spellings = ["void\n", "\tvoid", "void ", `void${String.fromCharCode(160)}`, "VOID"]; // NBSP is char 160
    for (const status of spellings) {
      for (const role of ["admin", "office"]) {
        const result = await as[role].from("invoices").update({ status }).eq("id", credited).select("id");
        expect({ role, status, error: result.error?.code, hint: result.error?.hint }).toEqual({ role, status, error: "23514", hint: "invoice_status_not_allowed" });
      }
      // Workshop, viewer and another company can't reach the row at all: nothing changes.
      for (const role of ["workshop", "viewer", "betaAdmin"]) {
        const result = await as[role].from("invoices").update({ status }).eq("id", credited).select("id");
        expect({ role, status, changed: (result.data ?? []).length }).toEqual({ role, status, changed: 0 });
      }
      // The service role (server code, fixtures) is held to the allowlist too.
      expect((await adminClient().from("invoices").update({ status }).eq("id", credited)).error, status).toMatchObject({ code: "23514" });
    }
    expect(await statusOf(credited)).toBe("issued");
    // void_invoice still refuses it (credit applied).
    expect((await voidIt(credited)).error).toMatchObject({ code: "22023", hint: "invoice_credited" });
    // The normal path still works on an invoice with nothing against it.
    const plain = await issuedInvoice();
    expect((await voidIt(plain)).error).toBeNull();
    expect(await statusOf(plain)).toBe("void");
  });

  it("an older row with an odd status: void_invoice refuses it rather than guess; an odd void stays void", async () => {
    const odd = await issuedInvoice();
    await withDb((db) => db.query("update public.invoices set status = 'Sent ' where id = $1", [odd]));
    expect((await voidIt(odd)).error).toMatchObject({ code: "22023", hint: "invoice_status_not_voidable" });
    const oddVoid = await issuedInvoice();
    await withDb((db) => db.query("update public.invoices set status = $2 where id = $1", [oddVoid, "void\n"]));
    expect((await as.admin.from("invoices").update({ status: "issued" }).eq("id", oddVoid).select("id")).error).toMatchObject({ code: "42501", hint: "invoice_void_final" });
  });

  it("a void invoice stays void", async () => {
    const inv = await issuedInvoice();
    expect((await voidIt(inv)).error).toBeNull();
    expect((await as.admin.from("invoices").update({ status: "issued" }).eq("id", inv).select("id")).error).toMatchObject({ code: "42501" });
    expect(await statusOf(inv)).toBe("void");
  });

  it("the service role (importer) still writes finished records", async () => {
    const inv = await issuedInvoice();
    expect((await adminClient().from("invoices").update({ status: "void" }).eq("id", inv)).error).toBeNull();
  });
});

describe("£0 text-only invoice lines", () => {
  it("accepted on a new invoice and excluded from the totals; it issues", async () => {
    const created = await draftInvoice(as.office, [PRICED, { description: "Collected by the customer", quantity: 0, unit_price: 0 }]);
    expect(created.error).toBeNull();
    const id = created.data as string;
    expect((await adminClient().from("invoices").select("subtotal, vat, total").eq("id", id).single()).data).toEqual({ subtotal: 100, vat: 20, total: 120 });
    expect(((await adminClient().from("invoice_line_items").select("quantity, unit_price").eq("invoice_id", id).order("position")).data ?? []).map((l) => [Number(l.quantity), Number(l.unit_price)])).toEqual([[2, 50], [0, 0]]);
    expect((await as.admin.rpc("issue_invoice", { p_invoice: id })).error).toBeNull();
  });

  it("an invoice of text lines only is refused at issue", async () => {
    const created = await draftInvoice(as.office, [{ description: "Note only", quantity: 0, unit_price: 0 }], { subtotal: 0, vat: 0, total: 0 });
    expect(created.error).toBeNull();
    expect((await as.admin.rpc("issue_invoice", { p_invoice: created.data as string })).error).toMatchObject({ code: "22023", hint: "invoice_text_lines_only" });
    expect(await statusOf(created.data as string)).toBe("draft");
  });

  it("refused: totals that count it, a price with no quantity, no text; quotes still refuse quantity 0", async () => {
    expect((await draftInvoice(as.office, [PRICED, { description: "Note", quantity: 0, unit_price: 0 }], { subtotal: 101, vat: 20, total: 121 })).error).toMatchObject({ code: "22023" });
    expect((await draftInvoice(as.office, [{ description: "Free", quantity: 0, unit_price: 5 }], { subtotal: 0, vat: 0, total: 0 })).error).toMatchObject({ code: "22023" });
    expect((await draftInvoice(as.office, [{ description: "  ", quantity: 0, unit_price: 0 }], { subtotal: 0, vat: 0, total: 0 })).error).toMatchObject({ code: "22023" });
    const quote = await as.office.rpc("create_with_lines", {
      p_parent: "quotes", p_header: { quote_ref: `Q-073-${world.runId}`, customer: "Void Co", total_value: 0, vat_enabled: true },
      p_child: "quote_line_items", p_fk: "quote_id", p_lines: [{ description: "Note", quantity: 0, unit_price: 0, vat_pct: 20 }],
    });
    expect(quote.error?.message).toMatch(/more than 0/);
  });

  it("a draft is corrected with a text line, the invoice note and the delivery address; all fixed once issued", async () => {
    const created = await draftInvoice(as.office);
    const id = created.data as string;
    const updatedAt = (await adminClient().from("invoices").select("updated_at").eq("id", id).single()).data!.updated_at;
    const saved = await as.office.rpc("replace_draft_invoice", {
      p_invoice: id, p_expected_updated_at: updatedAt,
      p_header: { subtotal: 100, vat: 20, total: 120, invoice_date: TODAY, due_date: "2099-01-31", invoice_note: "  Thank you for your order  ", delivery_address: "Unit 4\nDock Road" },
      p_lines: [{ ...PRICED, vat_exempt: false }, { description: "Delivered to site", quantity: 0, unit_price: 0, vat_pct: 0, vat_exempt: false }],
    });
    expect(saved.error).toBeNull();
    expect((await adminClient().from("invoices").select("invoice_note, delivery_address, total").eq("id", id).single()).data).toEqual({ invoice_note: "Thank you for your order", delivery_address: "Unit 4\nDock Road", total: 120 });
    const again = (await adminClient().from("invoices").select("updated_at").eq("id", id).single()).data!.updated_at;
    expect((await as.office.rpc("replace_draft_invoice", { p_invoice: id, p_expected_updated_at: again, p_header: { invoice_note: "two\nlines" }, p_lines: [PRICED] })).error).toMatchObject({ code: "22023" });
    expect((await as.admin.rpc("issue_invoice", { p_invoice: id })).error).toBeNull();
    expect((await as.admin.from("invoices").update({ invoice_note: "Changed" }).eq("id", id).select("id")).error).toMatchObject({ code: "42501" });
    expect((await as.admin.from("invoices").update({ delivery_address: "Elsewhere" }).eq("id", id).select("id")).error).toMatchObject({ code: "42501" });
    // Workshop and another company can't touch a draft.
    const other = (await draftInvoice(as.office)).data as string;
    expect((await as.workshop.rpc("replace_draft_invoice", { p_invoice: other, p_expected_updated_at: TODAY, p_header: {}, p_lines: [PRICED] })).error).toMatchObject({ code: "42501" });
    expect((await as.betaAdmin.rpc("replace_draft_invoice", { p_invoice: other, p_expected_updated_at: TODAY, p_header: {}, p_lines: [PRICED] })).error).toMatchObject({ code: "P0002" });
  });
});

describe("customer mobile", () => {
  it("saved like the other customer fields, capped at 40 characters, same company only", async () => {
    const { data, error } = await as.office.from("customers").insert({ organization_id: world.tenants.alpha.id, name: `Mobile Co ${world.runId}`, mobile: "07700 900123" }).select("id, mobile").single();
    expect(error).toBeNull();
    expect(data!.mobile).toBe("07700 900123");
    expect((await as.office.from("customers").update({ mobile: "1".repeat(41) }).eq("id", data!.id).select("id")).error).not.toBeNull();
    expect((await as.betaAdmin.from("customers").select("mobile").eq("id", data!.id)).data ?? []).toEqual([]);
    expect((await as.workshop.from("customers").select("mobile").eq("id", data!.id)).data ?? []).toEqual([]);
  });
});
