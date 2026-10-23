/**
 * Customer credit (migration 034): balance = total - payments - credits applied + refunds. Credit beyond an invoice is the customer's,
 * never lost: £120 invoice, £60 paid, £80 credit leaves £20 of customer credit, which an admin can refund or anyone in the office can
 * apply to another invoice of the same customer. Refunds are an append-only, audited, admin-only ledger. amount_paid is still the sum
 * of the payments.
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

/** An issued invoice for 12 x £10 = £120, no VAT, for the given customer. */
async function invoiceFor(customer: string, client: SupabaseClient = as.admin) {
  const created = await client.rpc("create_with_lines", {
    p_parent: "invoices", p_header: { customer, subtotal: 120, carriage: 0, vat: 0, total: 120, vat_enabled: false, carriage_vat: false, status: "draft", amount_paid: 0, due_date: "2099-01-31" },
    p_child: "invoice_line_items", p_fk: "invoice_id", p_lines: [{ position: 0, description: "Widget", quantity: 12, unit_price: 10, vat_pct: 0, vat_exempt: false }],
  });
  expect(created.error).toBeNull();
  expect((await client.rpc("issue_invoice", { p_invoice: created.data })).error).toBeNull();
  return created.data as string;
}
const lineOf = async (invoice: string) => (await adminClient().from("invoice_line_items").select("id").eq("invoice_id", invoice).single()).data!.id as string;
const pay = (id: string, amount: number, client: SupabaseClient = as.admin) =>
  client.rpc("record_invoice_payment", { p_request_id: randomUUID(), p_invoice: id, p_amount: amount, p_paid_on: TODAY, p_method: "BACS", p_reference: null });
/** A credit note for `quantity` widgets (£10 each). Issuing it applies all of it to the invoice, in the same transaction. */
async function credited(invoice: string, quantity: number) {
  const made = await as.admin.rpc("create_credit_note", { p_invoice: invoice, p_reason: "Returned", p_credit_date: TODAY, p_lines: [{ invoice_line_id: await lineOf(invoice), quantity }] });
  expect(made.error).toBeNull();
  expect((await as.admin.rpc("issue_credit_note", { p_credit: made.data })).error).toBeNull();
  return { id: made.data as string };
}
const refund = (id: string, amount: number, client: SupabaseClient = as.admin, request = randomUUID()) =>
  client.rpc("refund_customer_credit", { p_invoice: id, p_amount: amount, p_paid_on: TODAY, p_method: "BACS", p_reference: "REF-1", p_reason: "Customer asked", p_request_id: request });
const transfer = (from: string, to: string, amount: number, client: SupabaseClient = as.admin, request = randomUUID()) =>
  client.rpc("apply_customer_credit", { p_from: from, p_to: to, p_amount: amount, p_request_id: request });
const note = async (id: string) => (await adminClient().from("credit_notes").select("*").eq("id", id).single()).data as Record<string, unknown>;
const invoice = async (id: string) => (await adminClient().from("invoices").select("*").eq("id", id).single()).data as Record<string, unknown>;
const paymentsSum = async (id: string) => Math.round(((await adminClient().from("invoice_payments").select("amount").eq("invoice_id", id)).data ?? []).reduce((sum, r) => sum + Math.round(Number(r.amount) * 100), 0)) / 100;
const pence = (n: unknown) => Math.round(Number(n) * 100);

/** The invariants that must always hold for an invoice. */
async function invariants(id: string) {
  const inv = await invoice(id);
  expect(pence(inv.amount_paid)).toBe(pence(await paymentsSum(id)));
  const allocated = ((await adminClient().from("invoice_credit_allocations").select("amount").eq("invoice_id", id)).data ?? []).reduce((sum, r) => sum + pence(r.amount), 0);
  const transfersIn = ((await adminClient().from("customer_credit_ledger").select("amount").eq("to_invoice_id", id)).data ?? []).reduce((sum, r) => sum + pence(r.amount), 0);
  const out = ((await adminClient().from("customer_credit_ledger").select("amount").eq("invoice_id", id)).data ?? []).reduce((sum, r) => sum + pence(r.amount), 0);
  expect(pence(inv.credited_amount)).toBe(allocated + transfersIn);
  expect(pence(inv.refunded_amount)).toBe(out);
  return inv;
}

describe("credit beyond the invoice is the customer's", () => {
  it("£120 invoice, £60 paid, £80 credit: £20 customer credit, the invoice is settled, and amount paid is still the payments", async () => {
    const inv = await invoiceFor("Credit Customer Ltd");
    expect((await pay(inv, 60)).data).toMatchObject({ status: "partial", balance_due: 60 });
    const credit = await credited(inv, 8);
    // Issuing applied all £80 at once: the £60 owed is settled and the other £20 is customer credit on the invoice, nothing left unapplied.
    expect(await note(credit.id)).toMatchObject({ status: "issued", total: 80, allocated_amount: 80 });
    expect(await invariants(inv)).toMatchObject({ status: "paid", amount_paid: 60, credited_amount: 80, refunded_amount: 0 });
    expect((await as.office.rpc("customer_credit", { p_customer: "Credit Customer Ltd" })).data).toEqual([{ customer: "Credit Customer Ltd", credit: 20, invoices: 1 }]);
    // Nothing more can be paid on it.
    expect((await pay(inv, 1)).error).toMatchObject({ code: "22023" });
  });

  it("issuing applies the whole credit in the one transaction: the allocation covers the credit note, the audit says how much of it settled the invoice, and nothing is left to apply", async () => {
    const inv = await invoiceFor("Atomic Credit Ltd");
    await pay(inv, 60);
    const credit = await credited(inv, 8);
    const allocations = (await adminClient().from("invoice_credit_allocations").select("amount, invoice_id").eq("credit_note_id", credit.id)).data!;
    expect(allocations).toEqual([{ amount: 80, invoice_id: inv }]);
    const trail = await withDb(async (db) => (await db.query("select metadata from security_audit.audit_log where entity_table = 'invoices' and entity_id = $1 and action = 'APPLY_CREDIT'", [inv])).rows);
    expect(trail).toHaveLength(1);
    expect(trail[0].metadata).toMatchObject({ amount: 80, applied_to_balance: 60, balance_due: 0, customer_credit: 20, status: "paid" });
    // Nothing is left on the credit note to apply, and it can't be applied twice.
    const again = await as.admin.rpc("allocate_credit_note", { p_credit: credit.id, p_amount: 0.01, p_request_id: randomUUID() });
    expect(again.error!.message).toMatch(/more than the credit note has left/);
    expect((await as.admin.rpc("issue_credit_note", { p_credit: credit.id })).error).toBeNull(); // issuing again changes nothing
    expect((await adminClient().from("invoice_credit_allocations").select("id").eq("credit_note_id", credit.id)).data).toHaveLength(1);
    await invariants(inv);
  });

  it("a credit on an invoice that is already paid in full is all customer credit: visible, and refundable or usable on another invoice", async () => {
    const inv = await invoiceFor("Paid Then Credited Ltd");
    expect((await pay(inv, 120)).data).toMatchObject({ status: "paid", balance_due: 0 });
    const credit = await credited(inv, 3); // £30
    expect(await note(credit.id)).toMatchObject({ status: "issued", total: 30, allocated_amount: 30 });
    expect(await invariants(inv)).toMatchObject({ status: "paid", amount_paid: 120, credited_amount: 30, refunded_amount: 0 });
    expect((await as.office.rpc("customer_credit", { p_customer: "Paid Then Credited Ltd" })).data).toEqual([{ customer: "Paid Then Credited Ltd", credit: 30, invoices: 1 }]);
    const trail = await withDb(async (db) => (await db.query("select metadata from security_audit.audit_log where entity_table = 'invoices' and entity_id = $1 and action = 'APPLY_CREDIT'", [inv])).rows);
    expect(trail[0].metadata).toMatchObject({ amount: 30, applied_to_balance: 0, balance_due: 0, customer_credit: 30 });
    // The £30 is usable: £10 to another invoice of the customer, the rest refunded.
    const other = await invoiceFor("Paid Then Credited Ltd");
    expect((await transfer(inv, other, 10, as.office)).data).toMatchObject({ from_credit: 20, to_balance_due: 110 });
    expect((await refund(inv, 20)).data).toMatchObject({ customer_credit: 0 });
    expect((await as.admin.rpc("customer_credit", {})).data).not.toContainEqual(expect.objectContaining({ customer: "Paid Then Credited Ltd" }));
    await invariants(inv);
    await invariants(other);
  });

  it("workshop and viewer can't see customer credit, and another company sees none of it", async () => {
    const inv = await invoiceFor("Private Credit Ltd");
    await pay(inv, 120);
    await credited(inv, 1);
    for (const role of ["workshop", "viewer"]) expect((await as[role].rpc("customer_credit", {})).data, role).toEqual([]);
    expect(JSON.stringify((await as.betaAdmin.rpc("customer_credit", {})).data)).not.toContain("Private Credit Ltd");
    expect((await as.office.rpc("customer_credit", { p_customer: "Private Credit Ltd" })).data).toEqual([{ customer: "Private Credit Ltd", credit: 10, invoices: 1 }]);
  });
});

describe("refunds", () => {
  async function withCredit(customer: string) {
    const inv = await invoiceFor(customer);
    await pay(inv, 60);
    await credited(inv, 8);
    return inv;
  }

  it("admin only: office, workshop and viewer are refused; more than the credit is refused; a part refund leaves the rest", async () => {
    const inv = await withCredit("Refund Ltd");
    for (const role of ["office", "workshop", "viewer"]) expect((await refund(inv, 5, as[role])).error, role).toMatchObject({ code: "42501" });
    expect((await refund(inv, 20.01)).error!.message).toMatch(/more than the customer credit on INV-\d+ \(£20\.00 available\)/);
    for (const amount of [0, -1, 5.005]) expect((await refund(inv, amount)).error, String(amount)).toMatchObject({ code: "22023" });
    const part = await refund(inv, 15);
    expect(part.error).toBeNull();
    expect(part.data).toMatchObject({ customer_credit: 5 });
    expect(await invariants(inv)).toMatchObject({ status: "paid", amount_paid: 60, credited_amount: 80, refunded_amount: 15 });
    expect((await as.admin.rpc("customer_credit", { p_customer: "Refund Ltd" })).data).toEqual([{ customer: "Refund Ltd", credit: 5, invoices: 1 }]);
    expect((await refund(inv, 5)).error).toBeNull();
    expect((await refund(inv, 0.01)).error!.message).toMatch(/no customer credit to refund/);
    expect((await as.admin.rpc("customer_credit", {})).data).not.toContainEqual(expect.objectContaining({ customer: "Refund Ltd" }));
  });

  it("is recorded in an append-only ledger and audited; the same request twice is one refund", async () => {
    const inv = await withCredit("Ledger Ltd");
    const request = randomUUID();
    const first = await refund(inv, 10, as.admin, request);
    const again = await refund(inv, 10, as.admin, request);
    expect(again.data).toMatchObject({ ledger_id: first.data.ledger_id, repeated: true });
    const rows = (await adminClient().from("customer_credit_ledger").select("*").eq("invoice_id", inv)).data!;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "refund", amount: 10, method: "BACS", reference: "REF-1", reason: "Customer asked", organization_id: world.tenants.alpha.id, created_by: world.tenants.alpha.users.admin.id });
    for (const role of ["admin", "office"]) {
      expect((await as[role].from("customer_credit_ledger").update({ amount: 1 }).eq("id", rows[0].id).select("id")).error).not.toBeNull();
      expect((await as[role].from("customer_credit_ledger").delete().eq("id", rows[0].id).select("id")).error).not.toBeNull();
      expect((await as[role].from("customer_credit_ledger").insert({ organization_id: world.tenants.alpha.id, kind: "refund", invoice_id: inv, amount: 5, paid_on: TODAY })).error).not.toBeNull();
    }
    expect((await as.admin.from("customer_credit_ledger").select("id").eq("invoice_id", inv)).data).toHaveLength(1);
    expect((await as.workshop.from("customer_credit_ledger").select("id")).data).toEqual([]);
    const audit = await withDb(async (db) => (await db.query("select metadata, actor_user_id from security_audit.audit_log where entity_table = 'invoices' and entity_id = $1 and action = 'REFUND_CUSTOMER_CREDIT'", [inv])).rows);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ amount: 10, method: "BACS", reference: "REF-1", reason: "Customer asked", customer_credit: 10 });
    // The balances can't be edited by hand.
    expect((await as.admin.from("invoices").update({ refunded_amount: 0 }).eq("id", inv).select("id")).error).toMatchObject({ code: "42501" });
  });

  it("reversing the payment afterwards keeps the books straight: what was refunded is then owed", async () => {
    const inv = await withCredit("Reversal Ltd");
    await refund(inv, 20);
    const payment = (await adminClient().from("invoice_payments").select("id").eq("invoice_id", inv).single()).data!.id;
    const reversed = await as.admin.rpc("reverse_invoice_payment", { p_payment: payment, p_reason: "Wrong invoice" });
    expect(reversed.error).toBeNull();
    // 120 - 0 paid - 80 credit + 20 refunded = 60 owed.
    expect(reversed.data).toMatchObject({ status: "issued", balance_due: 60, amount_paid: 0 });
    await invariants(inv);
  });

  it("another company's admin can't refund or apply it", async () => {
    const inv = await withCredit("Foreign Ltd");
    expect((await refund(inv, 5, as.betaAdmin)).error).toMatchObject({ code: "P0002" });
    expect((await transfer(inv, inv, 5, as.betaAdmin)).error).toMatchObject({ code: "22023" });
    expect(await invariants(inv)).toMatchObject({ refunded_amount: 0 });
  });
});

describe("applying customer credit to another invoice of the same customer", () => {
  it("moves it: the source's credit falls, the target's balance falls, both stay consistent; office may do it", async () => {
    const source = await invoiceFor("Transfer Ltd");
    await pay(source, 60);
    await credited(source, 8);
    const target = await invoiceFor("Transfer Ltd");
    const moved = await transfer(source, target, 15, as.office);
    expect(moved.error).toBeNull();
    expect(moved.data).toMatchObject({ from_credit: 5, to_balance_due: 105, to_status: "issued" });
    expect(await invariants(source)).toMatchObject({ refunded_amount: 15, credited_amount: 80 });
    expect(await invariants(target)).toMatchObject({ credited_amount: 15, amount_paid: 0, status: "issued" });
    expect((await as.admin.rpc("customer_credit", { p_customer: "Transfer Ltd" })).data).toEqual([{ customer: "Transfer Ltd", credit: 5, invoices: 1 }]);
    // The rest settles part of the target; paying the remaining balance then closes it.
    expect((await transfer(source, target, 5)).error).toBeNull();
    expect((await pay(target, 100)).data).toMatchObject({ status: "paid", balance_due: 0 });
    expect(await invariants(target)).toMatchObject({ status: "paid", amount_paid: 100, credited_amount: 20 });
    expect((await as.admin.rpc("customer_credit", {})).data).not.toContainEqual(expect.objectContaining({ customer: "Transfer Ltd" }));
  });

  it("refuses another customer, more than the credit, more than the target owes, a settled target, itself, and viewers", async () => {
    const source = await invoiceFor("Strict Ltd");
    await pay(source, 120);
    await credited(source, 5);
    const same = await invoiceFor("Strict Ltd");
    const other = await invoiceFor("Someone Else Ltd");
    expect((await transfer(source, other, 5)).error!.message).toMatch(/same customer/);
    expect((await transfer(source, same, 50.01)).error!.message).toMatch(/more than the customer credit/);
    expect((await transfer(source, source, 5)).error).toMatchObject({ code: "22023" });
    for (const role of ["workshop", "viewer"]) expect((await transfer(source, same, 5, as[role])).error, role).toMatchObject({ code: "42501" });
    // A target that owes £10 can't be given £20.
    expect((await pay(same, 110)).error).toBeNull();
    expect((await transfer(source, same, 20)).error!.message).toMatch(/more than the balance due on INV-\d+ \(£10\.00 of £120\.00\)/);
    expect((await transfer(source, same, 10)).data).toMatchObject({ to_status: "paid" });
    expect((await transfer(source, same, 1)).error!.message).toMatch(/can't take a credit/);
    await invariants(source);
    await invariants(same);
    // A repeated request is one transfer.
    const third = await invoiceFor("Strict Ltd");
    const request = randomUUID();
    const once = await transfer(source, third, 5, as.admin, request);
    expect((await transfer(source, third, 5, as.admin, request)).data).toMatchObject({ ledger_id: once.data.ledger_id, repeated: true });
    expect(await invariants(third)).toMatchObject({ credited_amount: 5 });
  });
});
