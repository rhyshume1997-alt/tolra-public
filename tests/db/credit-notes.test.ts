/**
 * Credit notes (migration 034, W4): a credit note against an issued invoice, issued with a CRD number (CN before 078) and locked like an invoice;
 * applying it to the invoice is an allocation, not a payment, so invoices.amount_paid stays the sum of the payments and the
 * balance due is total - payments - credits applied. Over-credit is refused when a credit note is made, when it is issued and when
 * it is applied; another company can't see or touch any of it.
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

/** An issued invoice: 2 x £50 + 20% VAT = £120. */
async function issuedInvoice(client: SupabaseClient = as.admin) {
  const created = await client.rpc("create_with_lines", {
    p_parent: "invoices",
    p_header: { customer: "Credit Co", subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: true, status: "draft", amount_paid: 0, due_date: "2099-01-31" },
    p_child: "invoice_line_items", p_fk: "invoice_id",
    p_lines: [{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }],
  });
  expect(created.error).toBeNull();
  expect((await client.rpc("issue_invoice", { p_invoice: created.data as string })).error).toBeNull();
  return created.data as string;
}
/** A credit note for `quantity` bushes (£50 + 20% VAT each = £60 each). */
const lineOf = async (invoice: string) => (await adminClient().from("invoice_line_items").select("id").eq("invoice_id", invoice).order("position")).data![0].id as string;
/** `quantity` bushes of the invoice's one line; the description, VAT and (unless given) price come from the invoice. */
const credit = async (invoice: string, quantity: number, client: SupabaseClient = as.admin, reason: string | null = "Returned", extra: Record<string, unknown> = {}) =>
  client.rpc("create_credit_note", { p_invoice: invoice, p_reason: reason, p_credit_date: TODAY, p_lines: [{ invoice_line_id: await lineOf(invoice), quantity, ...extra }] });
const issue = (id: string, client: SupabaseClient = as.admin) => client.rpc("issue_credit_note", { p_credit: id });
const apply = (id: string, amount: number, client: SupabaseClient = as.admin, request = randomUUID()) => client.rpc("allocate_credit_note", { p_credit: id, p_amount: amount, p_request_id: request });
const pay = (id: string, amount: number, client: SupabaseClient = as.admin) =>
  client.rpc("record_invoice_payment", { p_request_id: randomUUID(), p_invoice: id, p_amount: amount, p_paid_on: TODAY, p_method: "BACS", p_reference: null });
const invoice = async (id: string) => (await adminClient().from("invoices").select("*").eq("id", id).single()).data as Record<string, unknown>;
const note = async (id: string) => (await adminClient().from("credit_notes").select("*").eq("id", id).single()).data as Record<string, unknown>;
const paymentsSum = async (id: string) => Math.round(((await adminClient().from("invoice_payments").select("amount").eq("invoice_id", id)).data ?? []).reduce((sum, r) => sum + Math.round(Number(r.amount) * 100), 0)) / 100;
/** total - payments - credits applied, from the rows. */
const balance = async (id: string) => {
  const inv = await invoice(id);
  const allocated = ((await adminClient().from("invoice_credit_allocations").select("amount").eq("invoice_id", id)).data ?? []).reduce((sum, r) => sum + Math.round(Number(r.amount) * 100), 0);
  return (Math.round(Number(inv.total) * 100) - Math.round((await paymentsSum(id)) * 100) - allocated) / 100;
};

describe("making and issuing a credit note", () => {
  it("works out the totals on the server, numbers it CRD- (078), freezes it, and refuses changes after issue", async () => {
    const inv = await issuedInvoice();
    const made = await credit(inv, 1);
    expect(made.error).toBeNull();
    const draft = await note(made.data);
    expect(draft).toMatchObject({ status: "draft", credit_ref: null, subtotal: 50, vat: 10, total: 60, vat_enabled: true, allocated_amount: 0, invoice_id: inv, customer: "Credit Co", organization_id: world.tenants.alpha.id });
    // A draft can be edited and deleted; the lines can be changed.
    expect((await as.office.from("credit_notes").update({ reason: "Faulty" }).eq("id", made.data).select("id")).data).toHaveLength(1);

    const ref = await issue(made.data, as.office);
    expect(ref.error).toBeNull();
    expect(ref.data).toMatch(/^CRD-\d+$/);
    expect((await issue(made.data)).data).toBe(ref.data); // issuing again changes nothing
    const issued = await note(made.data);
    expect(issued).toMatchObject({ status: "issued", credit_ref: ref.data });
    expect(issued.issuer_snapshot).toBeTruthy();
    expect(issued.customer_snapshot).toBeDefined();
    expect(issued.issued_at).toBeTruthy();

    for (const [name, change] of [["total", { total: 1 }], ["reason", { reason: "Changed" }], ["customer", { customer: "Other" }], ["status back", { status: "draft" }], ["number", { credit_ref: "CN-9999" }], ["allocation", { allocated_amount: 10 }]] as const) {
      expect((await as.admin.from("credit_notes").update(change).eq("id", made.data).select("id")).error, name).toMatchObject({ code: "42501" });
    }
    expect((await as.admin.from("credit_notes").delete().eq("id", made.data).select("id")).error).toMatchObject({ code: "42501" });
    expect((await as.admin.from("credit_note_lines").update({ quantity: 5 }).eq("credit_note_id", made.data).select("id")).error).toMatchObject({ code: "42501" });
    expect((await as.admin.from("credit_note_lines").insert({ organization_id: world.tenants.alpha.id, credit_note_id: made.data, description: "Extra", quantity: 1, unit_price: 1 })).error).toMatchObject({ code: "42501" });
    expect((await as.admin.from("credit_note_lines").delete().eq("credit_note_id", made.data).select("id")).error).toMatchObject({ code: "42501" });
    expect(await note(made.data)).toMatchObject({ status: "issued", total: 60 });
    // The next one takes the next number.
    const second = await issue((await credit(inv, 1)).data);
    const num = (r: unknown) => Number(/(\d+)$/.exec(String(r))![1]);
    expect(second.data).toMatch(/^CRD-\d+$/);
    expect(num(second.data)).toBe(num(ref.data) + 1);
  });

  it("a draft can be deleted; lines, an empty credit note and a bad line are refused", async () => {
    const inv = await issuedInvoice();
    const made = await credit(inv, 1);
    expect((await as.office.from("credit_notes").delete().eq("id", made.data).select("id")).data).toHaveLength(1);
    const lid = await lineOf(inv);
    const call = (lines: unknown) => as.admin.rpc("create_credit_note", { p_invoice: inv, p_reason: null, p_credit_date: TODAY, p_lines: lines });
    expect((await call([])).error).toMatchObject({ code: "22023" });
    expect((await call([{ quantity: 1 }])).error).toMatchObject({ code: "22023" }); // no invoice line
    expect((await call([{ invoice_line_id: randomUUID(), quantity: 1 }])).error).toMatchObject({ code: "22023" }); // not on this invoice
    expect((await call([{ invoice_line_id: await lineOf(await issuedInvoice()), quantity: 1 }])).error).toMatchObject({ code: "22023" }); // another invoice's line
    expect((await call([{ invoice_line_id: lid, quantity: 0 }])).error).toMatchObject({ code: "22023" });
    expect((await call([{ invoice_line_id: lid, quantity: 1, unit_price: -1 }])).error).toMatchObject({ code: "22023" });
    expect((await call([{ invoice_line_id: lid, quantity: 1, unit_price: 10.005 }])).error).toMatchObject({ code: "22023" });
    expect((await call([{ invoice_line_id: lid, quantity: 1, unit_price: 50.01 }])).error).toMatchObject({ code: "22023" }); // more than invoiced
    expect((await call([{ invoice_line_id: lid, quantity: 1, unit_price: 0 }])).error).toMatchObject({ code: "22023" });
    expect((await call([{ invoice_line_id: lid, quantity: 1 }, { invoice_line_id: lid, quantity: 1 }])).error).toMatchObject({ code: "22023" }); // twice
    const draftInvoice = (await as.admin.rpc("create_with_lines", {
      p_parent: "invoices", p_header: { customer: "D", subtotal: 10, carriage: 0, vat: 2, total: 12, vat_enabled: true, carriage_vat: true, status: "draft", amount_paid: 0 },
      p_child: "invoice_line_items", p_fk: "invoice_id", p_lines: [{ position: 0, description: "X", quantity: 1, unit_price: 10, vat_pct: 20, vat_exempt: false }],
    })).data as string;
    expect((await credit(draftInvoice, 1)).error!.message).toMatch(/can't be credited/);
  });
});

describe("issuing applies the credit: an allocation, not a payment", () => {
  it("issuing reduces the balance in the same transaction, without touching amount paid or the payments; the rest can then be paid", async () => {
    const inv = await issuedInvoice();
    const made = await credit(inv, 1);
    expect(await invoice(inv)).toMatchObject({ credited_amount: 0 }); // a draft changes nothing
    expect((await issue(made.data)).error).toBeNull();
    expect(await invoice(inv)).toMatchObject({ amount_paid: 0, credited_amount: 60, status: "issued", paid_at: null });
    expect(await paymentsSum(inv)).toBe(0);
    expect((await adminClient().from("invoice_payments").select("id").eq("invoice_id", inv)).data).toEqual([]);
    expect(await note(made.data)).toMatchObject({ allocated_amount: 60 });
    expect(await balance(inv)).toBe(60);

    // £60 left to pay: more than that is refused, exactly that settles the invoice.
    expect((await pay(inv, 60.01)).error!.message).toMatch(/more than the balance due on INV-\d+ \(£60\.00 of £120\.00\)/);
    const paid = await pay(inv, 60);
    expect(paid.data).toMatchObject({ status: "paid", balance_due: 0, amount_paid: 60 });
    expect(await invoice(inv)).toMatchObject({ status: "paid", amount_paid: 60, credited_amount: 60 });
    expect(await paymentsSum(inv)).toBe(60); // amount_paid still equals the sum of the payments
    expect(await balance(inv)).toBe(0);
  });

  it("a credit that settles the whole invoice makes it 'credited', and it then takes no payment", async () => {
    const inv = await issuedInvoice();
    const made = await credit(inv, 2);
    expect((await issue(made.data)).error).toBeNull();
    expect(await invoice(inv)).toMatchObject({ status: "credited", amount_paid: 0, credited_amount: 120 });
    expect((await pay(inv, 1)).error).toMatchObject({ code: "22023" });
    expect((await credit(inv, 1)).error).toMatchObject({ code: "22023" }); // already credited in full
  });

  it("£120 invoiced, £60 paid, £80 credited: the invoice is settled (nothing owed), £20 is customer credit, and the credit note is fully applied", async () => {
    const created = await as.admin.rpc("create_with_lines", {
      p_parent: "invoices", p_header: { customer: "Settled Co", subtotal: 120, carriage: 0, vat: 0, total: 120, vat_enabled: false, carriage_vat: false, status: "draft", amount_paid: 0, due_date: "2099-01-31" },
      p_child: "invoice_line_items", p_fk: "invoice_id", p_lines: [{ position: 0, description: "Widget", quantity: 12, unit_price: 10, vat_pct: 0, vat_exempt: false }],
    });
    const inv = created.data as string;
    expect((await as.admin.rpc("issue_invoice", { p_invoice: inv })).error).toBeNull();
    expect((await pay(inv, 60)).error).toBeNull();
    const made = await credit(inv, 8);
    expect((await issue(made.data)).error).toBeNull();
    expect(await invoice(inv)).toMatchObject({ status: "paid", amount_paid: 60, credited_amount: 80, refunded_amount: 0 });
    expect(await note(made.data)).toMatchObject({ total: 80, allocated_amount: 80 });
    expect(await balance(inv)).toBe(-20); // total - payments - credits: the £20 below zero is customer credit
    expect((await as.office.rpc("customer_credit", { p_customer: "Settled Co" })).data).toEqual([{ customer: "Settled Co", credit: 20, invoices: 1 }]);
    expect((await pay(inv, 1)).error).toMatchObject({ code: "22023" }); // nothing is owed
  });

  it("a credit note can't be applied twice or for more than it has left; the same request twice is one allocation", async () => {
    const inv = await issuedInvoice();
    const made = await credit(inv, 1);
    await issue(made.data);
    const over = await apply(made.data, 0.01);
    expect(over.error).toMatchObject({ code: "22023" });
    expect(over.error!.message).toMatch(/more than the credit note has left/);
    const first = (await adminClient().from("invoice_credit_allocations").select("id, amount, request_id").eq("credit_note_id", made.data)).data!;
    expect(first).toHaveLength(1);
    expect(first[0].amount).toBe(60);
    const again = await apply(made.data, 60, as.admin, first[0].request_id);
    expect(again.data).toMatchObject({ allocation_id: first[0].id, repeated: true });
    expect((await adminClient().from("invoice_credit_allocations").select("id").eq("credit_note_id", made.data)).data).toHaveLength(1);
    for (const amount of [0, -5, 10.001]) expect((await apply(made.data, amount)).error, String(amount)).toMatchObject({ code: "22023" });
    expect(await note(made.data)).toMatchObject({ allocated_amount: 60 });
    expect(await invoice(inv)).toMatchObject({ credited_amount: 60, status: "issued" });
  });

  it("an unissued credit note can't be applied", async () => {
    const draft = await credit(await issuedInvoice(), 1);
    expect((await apply(draft.data, 10)).error!.message).toMatch(/Issue the credit note/);
  });

  it("refuses over-credit: at creation (drafts count) and at issue, whatever route put the extra credit there", async () => {
    const inv = await issuedInvoice();
    const first = await credit(inv, 1);
    expect(first.error).toBeNull();
    const second = await credit(inv, 1);
    expect(second.error).toBeNull(); // 60 + 60 = 120: exactly the invoice
    const third = await credit(inv, 1);
    expect(third.error).toMatchObject({ code: "22023" });
    expect(third.error!.message).toMatch(/More credited than invoiced on "Bush": 2 invoiced, 3 credited in all/);
    // Issue-time check, when another draft's lines were pushed up by another route (service role).
    await adminClient().from("credit_note_lines").update({ quantity: 2, vat_amount: 20 }).eq("credit_note_id", second.data);
    const refused = await issue(first.data);
    expect(refused.error).toMatchObject({ code: "22023" });
    expect(refused.error!.message).toMatch(/More credited than invoiced/);
    expect(await note(first.data)).toMatchObject({ status: "draft" });
    expect(await invoice(inv)).toMatchObject({ credited_amount: 0 });
    await adminClient().from("credit_note_lines").update({ quantity: 1, vat_amount: 10 }).eq("credit_note_id", second.data);

    // Paid down to £20 owing: a £60 credit is applied in full when issued; the £40 beyond what was owed is customer credit, not lost (customer-credit.test.ts).
    const inv2 = await issuedInvoice();
    expect((await pay(inv2, 100)).error).toBeNull();
    const big = await credit(inv2, 1);
    expect((await issue(big.data)).error).toBeNull();
    expect(await invoice(inv2)).toMatchObject({ status: "paid", amount_paid: 100, credited_amount: 60 });
    expect(await note(big.data)).toMatchObject({ allocated_amount: 60 });
    expect((await apply(big.data, 0.01)).error!.message).toMatch(/more than the credit note has left/);
    expect((await as.admin.rpc("customer_credit", { p_customer: "Credit Co" })).data![0].credit).toBeGreaterThanOrEqual(40);
  });

  it("reversing a payment counts the credit too", async () => {
    const inv = await issuedInvoice();
    const made = await credit(inv, 1);
    await issue(made.data);
    const paid = await pay(inv, 60);
    expect(paid.data.status).toBe("paid");
    const reversed = await as.admin.rpc("reverse_invoice_payment", { p_payment: paid.data.payment_id, p_reason: "Wrong invoice" });
    expect(reversed.data).toMatchObject({ status: "issued", balance_due: 60, amount_paid: 0 });
    expect(await invoice(inv)).toMatchObject({ status: "issued", amount_paid: 0, credited_amount: 60, paid_at: null });
    expect(await balance(inv)).toBe(60);
  });

  it("the credits and the payments can't be set by editing the invoice", async () => {
    const inv = await issuedInvoice();
    for (const role of ["admin", "office"]) {
      expect((await as[role].from("invoices").update({ credited_amount: 120 }).eq("id", inv).select("id")).error, role).toMatchObject({ code: "42501" });
      expect((await as[role].from("invoices").update({ status: "credited" }).eq("id", inv).select("id")).error, role).toMatchObject({ code: "42501" });
    }
    expect((await as.admin.from("invoice_credit_allocations").insert({ organization_id: world.tenants.alpha.id, invoice_id: inv, credit_note_id: randomUUID(), amount: 5, allocated_on: TODAY })).error).not.toBeNull();
    expect(await invoice(inv)).toMatchObject({ credited_amount: 0, status: "issued" });
  });
});

describe("the header of a draft credit note can't be edited to say more than its lines", () => {
  const edits: Array<[string, Record<string, unknown>]> = [
    ["total only", { total: 120 }],
    ["total, subtotal and VAT", { subtotal: 100, vat: 20, total: 120 }],
    ["VAT switched off", { vat_enabled: false }],
    ["customer", { customer: "Other Co" }],
    ["issued ahead of issue", { status: "issued", credit_ref: "CN-9999" }],
    ["allocation", { allocated_amount: 60 }],
  ];

  it("a £60 credit can't be changed to £120 by editing it directly, so it can't be issued as £120", async () => {
    for (const role of ["admin", "office"]) {
      const inv = await issuedInvoice();
      const made = await credit(inv, 1);
      expect(made.error).toBeNull();
      for (const [name, change] of edits) {
        expect((await as[role].from("credit_notes").update(change).eq("id", made.data).select("id")).error, `${role}: ${name}`).toMatchObject({ code: "42501" });
      }
      expect(await note(made.data)).toMatchObject({ status: "draft", subtotal: 50, vat: 10, total: 60, vat_enabled: true, customer: "Credit Co" });
      expect((await issue(made.data, as[role])).error).toBeNull();
      expect(await note(made.data)).toMatchObject({ status: "issued", subtotal: 50, vat: 10, total: 60, allocated_amount: 60 });
      expect(await invoice(inv)).toMatchObject({ credited_amount: 60, status: "issued" });
      expect(await balance(inv)).toBe(60);
    }
  });

  it("the invoice, the company and the id can't be moved either, and a draft can't be inserted directly with its own amounts", async () => {
    const inv = await issuedInvoice();
    const other = await issuedInvoice();
    const made = await credit(inv, 1);
    for (const change of [{ invoice_id: other }, { organization_id: world.tenants.beta.id }, { issuer_snapshot: { x: 1 } }, { customer_snapshot: { x: 1 } }, { issued_at: new Date().toISOString() }]) {
      expect((await as.admin.from("credit_notes").update(change).eq("id", made.data).select("id")).error, JSON.stringify(change)).not.toBeNull();
    }
    for (const role of ["admin", "office"]) {
      const forged = await as[role].from("credit_notes").insert({ organization_id: world.tenants.alpha.id, invoice_id: inv, customer: "Credit Co", subtotal: 100, vat: 20, total: 120 });
      expect(forged.error, role).toMatchObject({ code: "42501" });
    }
    expect((await adminClient().from("credit_notes").select("id").eq("invoice_id", inv)).data).toHaveLength(1);
    expect(await note(made.data)).toMatchObject({ invoice_id: inv, total: 60 });
  });

  it("the reason and the date of a draft can still be edited, and the draft can be deleted", async () => {
    const inv = await issuedInvoice();
    const made = await credit(inv, 1);
    expect((await as.office.from("credit_notes").update({ reason: "Faulty", credit_date: "2026-01-02" }).eq("id", made.data).select("id")).data).toHaveLength(1);
    expect(await note(made.data)).toMatchObject({ reason: "Faulty", credit_date: "2026-01-02", total: 60 });
    expect((await as.admin.from("credit_notes").delete().eq("id", made.data).select("id")).data).toHaveLength(1);
  });

  it("issuing works the credit note out again from its lines and the invoice: a header that was changed by any route is refused, and nothing is issued or applied", async () => {
    const service = adminClient();
    for (const [name, change] of [["total", { total: 120 }], ["total, subtotal and VAT", { subtotal: 100, vat: 20, total: 120 }], ["VAT only", { vat: 12, total: 62 }], ["subtotal only", { subtotal: 51, total: 61 }], ["customer", { customer: "Other Co" }], ["VAT switch", { vat_enabled: false }]] as const) {
      const inv = await issuedInvoice();
      const made = await credit(inv, 1);
      expect((await service.from("credit_notes").update(change).eq("id", made.data)).error, name).toBeNull();
      const refused = await issue(made.data);
      expect({ name, code: refused.error?.code }).toEqual({ name, code: "22023" });
      expect(refused.error!.message).toMatch(/does not match its lines and the invoice/);
      expect(await note(made.data)).toMatchObject({ status: "draft", credit_ref: null, allocated_amount: 0 });
      expect(await invoice(inv)).toMatchObject({ credited_amount: 0, status: "issued" });
      expect((await service.from("invoice_credit_allocations").select("id").eq("credit_note_id", made.data)).data).toEqual([]);
    }
  });

  it("issuing also refuses lines that were changed behind the lock: a bigger quantity or price, another VAT rate, VAT on an exempt line, or a line from another invoice", async () => {
    const service = adminClient();
    const cases: Array<[string, (inv: string, note: string) => Promise<unknown>]> = [
      ["price above the invoice", async (_inv, id) => service.from("credit_note_lines").update({ unit_price: 80 }).eq("credit_note_id", id)],
      ["VAT amount inflated", async (_inv, id) => service.from("credit_note_lines").update({ vat_amount: 20 }).eq("credit_note_id", id)],
      ["rate changed", async (_inv, id) => service.from("credit_note_lines").update({ vat_pct: 0 }).eq("credit_note_id", id)],
      ["exemption changed", async (_inv, id) => service.from("credit_note_lines").update({ vat_exempt: true }).eq("credit_note_id", id)],
      ["description changed", async (_inv, id) => service.from("credit_note_lines").update({ description: "Gold" }).eq("credit_note_id", id)],
      ["another invoice's line", async (_inv, id) => service.from("credit_note_lines").update({ invoice_line_id: await lineOf(await issuedInvoice()) }).eq("credit_note_id", id)],
      ["no invoice line", async (_inv, id) => service.from("credit_note_lines").update({ invoice_line_id: null }).eq("credit_note_id", id)],
    ];
    for (const [name, tamper] of cases) {
      const inv = await issuedInvoice();
      const made = await credit(inv, 1);
      await tamper(inv, made.data);
      const refused = await issue(made.data);
      expect({ name, code: refused.error?.code }).toEqual({ name, code: "22023" });
      expect(await note(made.data)).toMatchObject({ status: "draft" });
      expect(await invoice(inv)).toMatchObject({ credited_amount: 0 });
    }
  });
});

describe("VAT is shared out over the credits for a line so that they add up to the line's VAT", () => {
  /** An issued invoice of one line: `quantity` x `price`, 20% VAT, with the totals the invoice itself works out. */
  async function invoiceOf(quantity: number, price: number) {
    const net = Math.round(quantity * price * 100) / 100;
    const vat = Math.round(net * 20) / 100;
    const created = await as.admin.rpc("create_with_lines", {
      p_parent: "invoices", p_header: { customer: "Penny Co", subtotal: net, carriage: 0, vat, total: Math.round((net + vat) * 100) / 100, vat_enabled: true, carriage_vat: false, status: "draft", amount_paid: 0, due_date: "2099-01-31" },
      p_child: "invoice_line_items", p_fk: "invoice_id", p_lines: [{ position: 0, description: "Penny bush", quantity, unit_price: price, vat_pct: 20, vat_exempt: false }],
    });
    expect(created.error).toBeNull();
    expect((await as.admin.rpc("issue_invoice", { p_invoice: created.data })).error).toBeNull();
    return created.data as string;
  }
  const lineVats = async (inv: string) => (await adminClient().from("credit_note_lines").select("vat_amount, credit_notes!inner(invoice_id, created_at)").eq("credit_notes.invoice_id", inv)).data!.map((r) => Number(r.vat_amount));

  it("2 x £50.03: the line's VAT is £20.01; credited one at a time it is £10.01 then £10.00, and the second credit is accepted", async () => {
    const inv = await invoiceOf(2, 50.03);
    expect(await invoice(inv)).toMatchObject({ subtotal: 100.06, vat: 20.01, total: 120.07 });
    const first = await credit(inv, 1);
    expect(first.error).toBeNull();
    expect(await note(first.data)).toMatchObject({ subtotal: 50.03, vat: 10.01, total: 60.04 });
    const second = await credit(inv, 1);
    expect(second.error).toBeNull();
    expect(await note(second.data)).toMatchObject({ subtotal: 50.03, vat: 10, total: 60.03 });
    expect((await lineVats(inv)).sort()).toEqual([10, 10.01]);
    // Together they are exactly the invoice, and both issue and settle it.
    expect((await issue(first.data)).error).toBeNull();
    expect((await issue(second.data)).error).toBeNull();
    expect(await invoice(inv)).toMatchObject({ status: "credited", credited_amount: 120.07 });
    expect(await balance(inv)).toBe(0);
    // And that is all there is to credit.
    expect((await credit(inv, 0.001)).error).toMatchObject({ code: "22023" });
  });

  it("credited in the other order, or both in one credit note, the VAT is the same £20.01", async () => {
    const both = await invoiceOf(2, 50.03);
    const all = await credit(both, 2);
    expect(await note(all.data)).toMatchObject({ subtotal: 100.06, vat: 20.01, total: 120.07 });
    // Delete the first of two drafts and make it again: the sum still lands on the line's VAT.
    const inv = await invoiceOf(2, 50.03);
    const a = await credit(inv, 1);
    const b = await credit(inv, 1);
    expect(b.error).toBeNull();
    expect((await as.admin.from("credit_notes").delete().eq("id", a.data).select("id")).data).toHaveLength(1);
    const c = await credit(inv, 1);
    expect(c.error).toBeNull();
    const vats = (await lineVats(inv)).reduce((sum, v) => sum + Math.round(v * 100), 0);
    expect(vats).toBeGreaterThanOrEqual(2000); // never above the line's £20.01 (the cap), and not a penny of it lost
    expect(vats).toBeLessThanOrEqual(2001);
  });

  it("3 credits of a line of 3 x £10.01 (VAT £6.01): £2.00, £2.00 and the remainder £2.01", async () => {
    const inv = await invoiceOf(3, 10.01);
    expect(await invoice(inv)).toMatchObject({ vat: 6.01, total: 36.04 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const made = await credit(inv, 1);
      expect(made.error, `credit ${i + 1}`).toBeNull();
      ids.push(made.data);
    }
    expect((await Promise.all(ids.map(async (id) => Number((await note(id)).vat))))).toEqual([2, 2, 2.01]);
    for (const id of ids) expect((await issue(id)).error).toBeNull();
    expect(await invoice(inv)).toMatchObject({ status: "credited", credited_amount: 36.04 });
  });

  it("a lower price per unit takes VAT on what was credited, not the line's remainder", async () => {
    const inv = await invoiceOf(2, 50.03);
    const cheap = await credit(inv, 2, as.admin, null, { unit_price: 25 });
    expect(await note(cheap.data)).toMatchObject({ subtotal: 50, vat: 10, total: 60 });
  });
});

describe("who may, and other companies", () => {
  it("admin and office make, issue and apply credit notes; workshop and viewer can't do or see any of it", async () => {
    const inv = await issuedInvoice();
    const made = await credit(inv, 1, as.office);
    expect(made.error).toBeNull();
    expect((await issue(made.data, as.office)).error).toBeNull();
    expect((await apply(made.data, 10, as.office)).error!.message).toMatch(/more than the credit note has left/); // allowed to ask; issuing applied it all
    for (const role of ["workshop", "viewer"]) {
      expect((await credit(inv, 1, as[role])).error, `${role} make`).toMatchObject({ code: "42501" });
      expect((await issue(made.data, as[role])).error, `${role} issue`).toMatchObject({ code: "42501" });
      expect((await apply(made.data, 10, as[role])).error, `${role} apply`).toMatchObject({ code: "42501" });
      for (const table of ["credit_notes", "credit_note_lines", "invoice_credit_allocations"]) expect((await as[role].from(table).select("id")).data ?? [], `${role} ${table}`).toEqual([]);
    }
    for (const table of ["credit_notes", "credit_note_lines", "invoice_credit_allocations"]) expect((await as.office.from(table).select("id").limit(1)).data!.length, table).toBe(1);
  });

  it("another company can't see, make, issue or apply them, or point one at our invoice", async () => {
    const inv = await issuedInvoice();
    const made = await credit(inv, 1);
    await issue(made.data);
    expect((await as.betaAdmin.from("credit_notes").select("id").eq("id", made.data)).data).toEqual([]);
    expect((await as.betaAdmin.from("credit_note_lines").select("id").eq("credit_note_id", made.data)).data).toEqual([]);
    expect((await credit(inv, 1, as.betaAdmin)).error).toMatchObject({ code: "P0002" });
    expect((await issue(made.data, as.betaAdmin)).error).toMatchObject({ code: "P0002" });
    expect((await apply(made.data, 10, as.betaAdmin)).error).toMatchObject({ code: "P0002" });
    const forged = await as.betaAdmin.from("credit_notes").insert({ organization_id: world.tenants.beta.id, invoice_id: inv, customer: "X" });
    expect(forged.error).not.toBeNull();
    expect(await note(made.data)).toMatchObject({ allocated_amount: 60, status: "issued" }); // applied once, by issuing
    // And the numbers are per company.
    const theirs = await issuedInvoice(as.betaAdmin);
    const theirNote = await as.betaAdmin.rpc("create_credit_note", { p_invoice: theirs, p_reason: null, p_credit_date: TODAY, p_lines: [{ invoice_line_id: await lineOf(theirs), quantity: 1 }] });
    const ref = await issue(theirNote.data, as.betaAdmin);
    expect(ref.data).toMatch(/^CRD-\d+$/);
    await withDb(async (db) => expect((await db.query("select count(*)::int as n from public.credit_notes where credit_ref = $1", [ref.data])).rows[0].n).toBeGreaterThanOrEqual(1));
  });
});

describe("an invoice without VAT", () => {
  it("credits at no VAT, and a company not registered for VAT never credits VAT", async () => {
    const created = await as.admin.rpc("create_with_lines", {
      p_parent: "invoices", p_header: { customer: "No VAT Co", subtotal: 100, carriage: 0, vat: 0, total: 100, vat_enabled: false, carriage_vat: false, status: "draft", amount_paid: 0 },
      p_child: "invoice_line_items", p_fk: "invoice_id", p_lines: [{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }],
    });
    expect((await as.admin.rpc("issue_invoice", { p_invoice: created.data })).error).toBeNull();
    const made = await credit(created.data as string, 1);
    expect(await note(made.data)).toMatchObject({ subtotal: 50, vat: 0, total: 50, vat_enabled: false });
  });
});

describe("credit lines come from the invoice's lines, with its tax treatment and caps", () => {
  it("the caller can't choose the VAT: the invoice's rate and exemption are used, whatever is sent", async () => {
    const inv = await issuedInvoice();
    const made = await credit(inv, 1, as.admin, "Returned", { vat_pct: 0, vat_exempt: true, description: "Anything", unit_price: 50 });
    expect(made.error).toBeNull();
    expect(await note(made.data)).toMatchObject({ subtotal: 50, vat: 10, total: 60, vat_enabled: true });
    expect((await adminClient().from("credit_note_lines").select("description, vat_pct, vat_exempt, invoice_line_id").eq("credit_note_id", made.data)).data).toEqual([{ description: "Bush", vat_pct: 20, vat_exempt: false, invoice_line_id: await lineOf(inv) }]);
  });

  it("an invoice line that was VAT exempt, or an invoice without VAT, is credited the same way", async () => {
    const mixed = await as.admin.rpc("create_with_lines", {
      p_parent: "invoices", p_header: { customer: "Mixed Co", subtotal: 150, carriage: 0, vat: 20, total: 170, vat_enabled: true, carriage_vat: true, status: "draft", amount_paid: 0 },
      p_child: "invoice_line_items", p_fk: "invoice_id",
      p_lines: [{ position: 0, description: "Taxed", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }, { position: 1, description: "Exempt", quantity: 1, unit_price: 50, vat_pct: 0, vat_exempt: true }],
    });
    expect((await as.admin.rpc("issue_invoice", { p_invoice: mixed.data })).error).toBeNull();
    const ids = (await adminClient().from("invoice_line_items").select("id, description").eq("invoice_id", mixed.data).order("position")).data!;
    const made = await as.admin.rpc("create_credit_note", { p_invoice: mixed.data, p_reason: null, p_credit_date: TODAY, p_lines: ids.map((l) => ({ invoice_line_id: l.id, quantity: 1 })) });
    expect(await note(made.data)).toMatchObject({ subtotal: 150, vat: 20, total: 170 });
  });

  it("a registration change after the invoice was issued doesn't change how it is credited", async () => {
    const inv = await issuedInvoice();
    const settings = (await adminClient().from("organization_settings").select("company_profile").eq("organization_id", world.tenants.alpha.id).single()).data!.company_profile as Record<string, unknown>;
    await adminClient().from("organization_settings").update({ company_profile: { ...settings, vatRegistered: false } }).eq("organization_id", world.tenants.alpha.id);
    try {
      expect(await note((await credit(inv, 1)).data)).toMatchObject({ vat: 10, total: 60, vat_enabled: true });
    } finally {
      await adminClient().from("organization_settings").update({ company_profile: settings }).eq("organization_id", world.tenants.alpha.id);
    }
  });

  it("quantity, net and VAT are capped per line against what was invoiced less earlier credits; a lower price is allowed", async () => {
    const inv = await issuedInvoice();
    expect((await credit(inv, 1, as.admin, null, { unit_price: 25 })).error).toBeNull(); // £25 + £5
    expect((await credit(inv, 1)).error).toBeNull(); // £50 + £10: 2 of 2 bushes
    const over = await credit(inv, 0.001);
    expect(over.error).toMatchObject({ code: "22023" });
    expect(over.error!.message).toMatch(/More credited than invoiced on "Bush"/);
    // The caps hold at issue too: a draft pushed over by another route is refused when issued.
    const inv2 = await issuedInvoice();
    const first = await credit(inv2, 2);
    expect(first.error).toBeNull();
    await adminClient().from("credit_note_lines").update({ quantity: 3, vat_amount: 30 }).eq("credit_note_id", first.data);
    await adminClient().from("credit_notes").update({ subtotal: 150, vat: 30, total: 180 }).eq("id", first.data);
    const refused = await issue(first.data);
    expect(refused.error).toMatchObject({ code: "22023" });
    expect(await note(first.data)).toMatchObject({ status: "draft" });
  });

  it("two credit notes made at once can't between them credit more than was invoiced", async () => {
    const inv = await issuedInvoice();
    const lid = await lineOf(inv);
    const make = (client: SupabaseClient) => client.rpc("create_credit_note", { p_invoice: inv, p_reason: null, p_credit_date: TODAY, p_lines: [{ invoice_line_id: lid, quantity: 2 }] });
    const results = await Promise.all([make(as.admin), make(as.office)]);
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    expect((await adminClient().from("credit_notes").select("id").eq("invoice_id", inv)).data).toHaveLength(1);
  });
});

describe("the lines of a credit note can't be moved or written around the checks", () => {
  it("a line can't be moved between credit notes, into or out of an issued one, or written directly", async () => {
    const inv = await issuedInvoice();
    const issuedNote = (await credit(inv, 1)).data as string;
    await issue(issuedNote);
    const inv2 = await issuedInvoice();
    const draftNote = (await credit(inv2, 1)).data as string;
    const draftLine = (await adminClient().from("credit_note_lines").select("id").eq("credit_note_id", draftNote).single()).data!.id;
    const issuedLine = (await adminClient().from("credit_note_lines").select("id").eq("credit_note_id", issuedNote).single()).data!.id;
    // Into an issued credit note, out of an issued credit note.
    expect((await as.admin.from("credit_note_lines").update({ credit_note_id: issuedNote }).eq("id", draftLine).select("id")).error).toMatchObject({ code: "42501" });
    expect((await as.admin.from("credit_note_lines").update({ credit_note_id: draftNote }).eq("id", issuedLine).select("id")).error).toMatchObject({ code: "42501" });
    // Changing a draft's line directly, or adding one, would skip the caps.
    expect((await as.admin.from("credit_note_lines").update({ quantity: 50 }).eq("id", draftLine).select("id")).error).toMatchObject({ code: "42501" });
    expect((await as.office.from("credit_note_lines").insert({ organization_id: world.tenants.alpha.id, credit_note_id: draftNote, description: "Extra", quantity: 1, unit_price: 1 })).error).toMatchObject({ code: "42501" });
    expect((await adminClient().from("credit_note_lines").select("credit_note_id, quantity").in("id", [draftLine, issuedLine])).data!.map((r) => [r.credit_note_id === draftNote, r.quantity]).sort()).toEqual([[false, 1], [true, 1]]);
    // Deleting the draft still removes its lines.
    expect((await as.admin.from("credit_notes").delete().eq("id", draftNote).select("id")).data).toHaveLength(1);
    expect((await adminClient().from("credit_note_lines").select("id").eq("credit_note_id", draftNote)).data).toEqual([]);
  });
});
