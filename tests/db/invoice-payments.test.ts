/**
 * Part payments on invoices (migration 032, GitHub issue #5): each receipt is an append-only row in invoice_payments and
 * invoices.amount_paid is always their sum. record_invoice_payment / reverse_invoice_payment are admin-only, lock the
 * invoice, refuse overpayment and write RECORD_PAYMENT / REVERSE_PAYMENT to the audit trail in the same transaction. The
 * issued-invoice lock lets amount_paid, paid_at and the move to part paid / paid change only through them. Existing
 * receipts become one 'legacy' row each; invoices flagged payment_unverified get none.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { owed } from "@/lib/receivables";
import { isolatedBackend } from "../support/isolation";
import { type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";

let world: SyntheticWorld;
let admin: SupabaseClient;
let adminBeta: SupabaseClient;
const staff = new Map<string, SupabaseClient>();

beforeAll(async () => {
  await verifyBackendIdentity();
  world = await createSyntheticWorld();
  admin = await signedInClient(world.tenants.alpha.users.admin);
  adminBeta = await signedInClient(world.tenants.beta.users.admin);
  for (const role of ["office", "workshop", "viewer"] as const) staff.set(role, await signedInClient(world.tenants.alpha.users[role]));
});

afterAll(async () => {
  if (world) await destroySyntheticWorld(world.runId);
});

const TODAY = new Date().toISOString().slice(0, 10);

/** A draft invoice for 2 x £50 + 20% VAT = £120, made the way the app makes it, then issued. */
async function issuedInvoice(client: SupabaseClient = admin) {
  const { data, error } = await client.rpc("create_with_lines", {
    p_parent: "invoices",
    p_header: { customer: "Payments Co", subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: true, status: "draft", amount_paid: 0, due_date: "2099-01-31" },
    p_child: "invoice_line_items",
    p_fk: "invoice_id",
    p_lines: [{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }],
  });
  expect(error).toBeNull();
  const id = data as string;
  expect((await client.rpc("issue_invoice", { p_invoice: id })).error).toBeNull();
  return id;
}

const pay = (id: string, amount: number, paidOn = TODAY, method: string | null = "BACS", reference: string | null = null, client: SupabaseClient = admin) =>
  client.rpc("record_invoice_payment", { p_request_id: crypto.randomUUID(), p_invoice: id, p_amount: amount, p_paid_on: paidOn, p_method: method, p_reference: reference });
const reverse = (paymentId: string, reason: string | null = "Cheque bounced", client: SupabaseClient = admin) =>
  client.rpc("reverse_invoice_payment", { p_payment: paymentId, p_reason: reason });

const invoice = async (id: string) => (await adminClient().from("invoices").select("*").eq("id", id).single()).data as Record<string, unknown>;
const payments = async (id: string) => ((await adminClient().from("invoice_payments").select("*").eq("invoice_id", id).order("created_at").order("id")).data ?? []) as Record<string, unknown>[];
const sum = (rows: Record<string, unknown>[]) => Math.round(rows.reduce((total, r) => total + Math.round(Number(r.amount) * 100), 0)) / 100;
const events = async (id: string, action: string) =>
  withDb(async (db) => (await db.query("select metadata from security_audit.audit_log where entity_table = 'invoices' and entity_id = $1 and action = $2 order by created_at", [id, action])).rows.map((r) => r.metadata as Record<string, unknown>));

describe("recording payments", () => {
  it("a part payment makes the invoice part paid; paying the rest makes it paid, dated by the payment that clears it", async () => {
    const id = await issuedInvoice();
    const first = await pay(id, 50, "2026-09-01", "cheque", "CHQ 001");
    expect(first.error).toBeNull();
    expect(first.data).toMatchObject({ amount_paid: 50, balance_due: 70, status: "partial" });
    expect(await invoice(id)).toMatchObject({ status: "partial", amount_paid: 50, paid_at: null });

    const second = await pay(id, 70, "2026-09-15", "BACS", "REF 2");
    expect(second.error).toBeNull();
    expect(second.data).toMatchObject({ amount_paid: 120, balance_due: 0, status: "paid" });
    const paid = await invoice(id);
    expect(paid).toMatchObject({ status: "paid", amount_paid: 120 });
    expect(String(paid.paid_at).slice(0, 10)).toBe("2026-09-15");

    const rows = await payments(id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ amount: 50, paid_on: "2026-09-01", method: "cheque", reference: "CHQ 001", source: "recorded", reverses_payment_id: null, created_by: world.tenants.alpha.users.admin.id });
    expect(sum(rows)).toBe(120);
  });

  it("one payment for the whole balance settles it", async () => {
    const id = await issuedInvoice();
    expect((await pay(id, 120)).data).toMatchObject({ status: "paid", balance_due: 0 });
  });

  it("refuses a draft, a zero or negative amount, an overpayment, a bad date or method, and records nothing", async () => {
    const { data: draftId } = await admin.rpc("create_with_lines", {
      p_parent: "invoices",
      p_header: { customer: "Draft Co", subtotal: 100, carriage: 0, vat: 20, total: 120, vat_enabled: true, carriage_vat: true, status: "draft", amount_paid: 0, due_date: "2099-01-31" },
      p_child: "invoice_line_items", p_fk: "invoice_id",
      p_lines: [{ position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20, vat_exempt: false }],
    });
    const draft = await pay(draftId as string, 10);
    expect(draft.error).toMatchObject({ code: "22023" });
    expect(draft.error!.message).toMatch(/still a draft/);

    const id = await issuedInvoice();
    expect((await pay(id, 0)).error).toMatchObject({ code: "22023", message: "The payment must be more than zero." });
    expect((await pay(id, -5)).error).toMatchObject({ code: "22023" });
    expect((await pay(id, 10.005)).error).toMatchObject({ code: "22023" });
    const over = await pay(id, 120.01);
    expect(over.error).toMatchObject({ code: "22023" });
    expect(over.error!.message).toMatch(/more than the balance due on INV-\d+ \(£120\.00 of £120\.00\)/);
    expect((await pay(id, 10, "2999-01-01")).error!.message).toMatch(/future/);
    expect((await pay(id, 10, TODAY, "bitcoin")).error!.message).toMatch(/BACS, cheque, card, cash or other/);
    expect((await pay(id, 10, TODAY, "BACS", "x".repeat(101))).error!.message).toMatch(/100 characters/);
    expect((await admin.rpc("record_invoice_payment", { p_request_id: crypto.randomUUID(), p_invoice: id, p_amount: 10, p_paid_on: null, p_method: null, p_reference: null })).error).toMatchObject({ code: "22023" });

    expect(await payments(id)).toHaveLength(0);
    expect(await invoice(id)).toMatchObject({ status: "issued", amount_paid: 0 });
    expect(await events(id, "RECORD_PAYMENT")).toHaveLength(0);
  });

  it("a cancelled invoice and one already paid in full take no payment", async () => {
    const cancelled = await issuedInvoice();
    expect((await adminClient().from("invoices").update({ status: "cancelled" }).eq("id", cancelled)).error).toBeNull();
    expect((await pay(cancelled, 10)).error!.message).toMatch(/cancelled and can't take a payment/);
    const settled = await issuedInvoice();
    expect((await pay(settled, 120)).error).toBeNull();
    expect((await pay(settled, 1)).error!.message).toMatch(/already paid in full/);
  });

  it("a receipt on an imported invoice flagged payment_unverified keeps it unverified, out of what is owed, with the payment kept", async () => {
    const id = await issuedInvoice();
    expect((await adminClient().from("invoices").update({ payment_unverified: true }).eq("id", id)).error).toBeNull();
    expect((await pay(id, 20)).error).toBeNull();
    const after = await invoice(id);
    expect(after).toMatchObject({ status: "partial", amount_paid: 20, payment_unverified: true });
    expect(owed(after as never)).toBe(0); // receivables, aging and chasers leave it out until confirmed
    expect(await payments(id)).toHaveLength(1);
    // Even a payment that clears the total doesn't settle the doubt about earlier ones.
    expect((await pay(id, 100)).error).toBeNull();
    expect(await invoice(id)).toMatchObject({ status: "paid", amount_paid: 120, payment_unverified: true });
    expect(await payments(id)).toHaveLength(2);
  });

  it("the flag is cleared only by an admin's confirm_invoice_payments, with a note, audited; never by editing it", async () => {
    const id = await issuedInvoice();
    expect((await adminClient().from("invoices").update({ payment_unverified: true }).eq("id", id)).error).toBeNull();
    expect((await pay(id, 20)).error).toBeNull();
    // Not by editing the flag, not by office/workshop/viewer, not without a note, not by another company.
    expect((await admin.from("invoices").update({ payment_unverified: false }).eq("id", id)).error).toMatchObject({ code: "42501" });
    for (const [role, client] of staff) expect((await client.rpc("confirm_invoice_payments", { p_invoice: id, p_note: "ok" })).error, role).toMatchObject({ code: "42501" });
    expect((await admin.rpc("confirm_invoice_payments", { p_invoice: id, p_note: "  " })).error).toMatchObject({ code: "22023" });
    expect((await adminBeta.rpc("confirm_invoice_payments", { p_invoice: id, p_note: "not mine" })).error).toMatchObject({ code: "P0002" });
    expect(await invoice(id)).toMatchObject({ payment_unverified: true });

    const confirmed = await admin.rpc("confirm_invoice_payments", { p_invoice: id, p_note: "Checked against the bank statement" });
    expect(confirmed.error).toBeNull();
    expect(confirmed.data).toMatchObject({ amount_paid: 20, balance_due: 100, status: "partial" });
    const after = await invoice(id);
    expect(after).toMatchObject({ payment_unverified: false, amount_paid: 20 });
    expect(owed(after as never)).toBe(100);
    expect(await events(id, "CONFIRM_PAYMENTS")).toEqual([expect.objectContaining({ note: "Checked against the bank statement", amount_paid: 20, balance_due: 100 })]);
    expect((await admin.rpc("confirm_invoice_payments", { p_invoice: id, p_note: "again" })).error!.message).toMatch(/no payment waiting/);
  });

  it("refuses when the stored amount paid doesn't match the payments, rather than overwrite it", async () => {
    const id = await issuedInvoice();
    await withDb((db) => db.query("update public.invoices set amount_paid = 30 where id = $1", [id])); // as an owner edit could
    const result = await pay(id, 10);
    expect(result.error).toMatchObject({ code: "22023" });
    expect(result.error!.message).toMatch(/shows £30\.00 paid but its payments add up to £0\.00/);
    expect(await invoice(id)).toMatchObject({ amount_paid: 30 });
  });
});

describe("duplicate submits and exact pennies", () => {
  const withId = (id: string, requestId: string, amount = 50) =>
    admin.rpc("record_invoice_payment", { p_request_id: requestId, p_invoice: id, p_amount: amount, p_paid_on: TODAY, p_method: "BACS", p_reference: null });

  it("the same request id twice records one payment and answers with the first", async () => {
    const id = await issuedInvoice();
    const requestId = crypto.randomUUID();
    const first = await withId(id, requestId);
    const again = await withId(id, requestId);
    expect(first.error).toBeNull();
    expect(again.error).toBeNull();
    expect(again.data).toMatchObject({ payment_id: first.data.payment_id, amount_paid: 50, status: "partial", repeated: true });
    expect(await payments(id)).toHaveLength(1);
    expect(await events(id, "RECORD_PAYMENT")).toHaveLength(1);
  });

  it("the same request id sent five times at once records one payment", async () => {
    const id = await issuedInvoice();
    const requestId = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => withId(id, requestId, 30)));
    for (const r of results) expect(r.error).toBeNull();
    expect(new Set(results.map((r) => r.data.payment_id)).size).toBe(1);
    expect(await payments(id)).toHaveLength(1);
    expect(await invoice(id)).toMatchObject({ amount_paid: 30 });
  });

  it("a different request id is a different payment; an id can't be reused for another invoice; one is required", async () => {
    const id = await issuedInvoice();
    const other = await issuedInvoice();
    const requestId = crypto.randomUUID();
    expect((await withId(id, requestId, 10)).error).toBeNull();
    expect((await withId(id, crypto.randomUUID(), 10)).error).toBeNull();
    expect((await withId(other, requestId, 10)).error!.message).toMatch(/another invoice/);
    expect(await payments(id)).toHaveLength(2);
    expect(await payments(other)).toHaveLength(0);
    const missing = await admin.rpc("record_invoice_payment", { p_request_id: null, p_invoice: id, p_amount: 5, p_paid_on: TODAY, p_method: null, p_reference: null });
    expect(missing.error).toMatchObject({ code: "22023" });
  });

  it("the same id in another company is a different payment (unique per company)", async () => {
    const mine = await issuedInvoice();
    const theirs = await issuedInvoice(adminBeta);
    const requestId = crypto.randomUUID();
    expect((await withId(mine, requestId, 10)).error).toBeNull();
    const result = await adminBeta.rpc("record_invoice_payment", { p_request_id: requestId, p_invoice: theirs, p_amount: 10, p_paid_on: TODAY, p_method: null, p_reference: null });
    expect(result.error).toBeNull();
    expect(result.data.repeated).toBeUndefined();
  });

  it("more than two decimal places is refused, never rounded", async () => {
    const id = await issuedInvoice();
    for (const amount of [10.001, 10.005, 10.999, 0.004, 0.1 + 0.2]) {
      const result = await pay(id, amount);
      expect(result.error, String(amount)).toMatchObject({ code: "22023" });
      expect(result.error!.message).toMatch(/two decimal places/);
    }
    expect(await payments(id)).toHaveLength(0);
    expect((await pay(id, 10.1)).error).toBeNull();
    expect((await pay(id, 0.01)).error).toBeNull();
    expect(await invoice(id)).toMatchObject({ amount_paid: 10.11 });
  });
});

describe("concurrent payments can't overpay", () => {
  it("two payments at the limit: exactly one is recorded", async () => {
    const id = await issuedInvoice();
    const results = await Promise.all([pay(id, 100), pay(id, 100)]);
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    const refused = results.filter((r) => r.error);
    expect(refused).toHaveLength(1);
    expect(refused[0].error).toMatchObject({ code: "22023" });
    expect(sum(await payments(id))).toBe(100);
    expect(await invoice(id)).toMatchObject({ status: "partial", amount_paid: 100 });
  });

  it("twelve parallel payments of £15 against £120: eight are recorded, four refused, the invoice is paid exactly", async () => {
    const id = await issuedInvoice();
    const results = await Promise.all(Array.from({ length: 12 }, () => pay(id, 15)));
    expect(results.filter((r) => !r.error)).toHaveLength(8);
    expect(results.filter((r) => r.error)).toHaveLength(4);
    expect(sum(await payments(id))).toBe(120);
    expect(await invoice(id)).toMatchObject({ status: "paid", amount_paid: 120 });
    expect(await events(id, "RECORD_PAYMENT")).toHaveLength(8);
  });

  it("a payment and a reversal at once leave amount_paid equal to the sum", async () => {
    const id = await issuedInvoice();
    const first = await pay(id, 60);
    const results = await Promise.all([pay(id, 60), reverse(first.data.payment_id), pay(id, 30)]);
    for (const r of results) if (r.error) expect(r.error.code).toBe("22023");
    expect(Number((await invoice(id)).amount_paid)).toBe(sum(await payments(id)));
  });
});

describe("reversing a payment", () => {
  it("paid goes back to part paid; the original stays, a negative row points at it with the reason; paid_at is cleared", async () => {
    const id = await issuedInvoice();
    const first = await pay(id, 50, "2026-09-01");
    const second = await pay(id, 70, "2026-09-15");
    expect(second.data.status).toBe("paid");

    const reversed = await reverse(second.data.payment_id, "Cheque bounced");
    expect(reversed.error).toBeNull();
    expect(reversed.data).toMatchObject({ amount_paid: 50, balance_due: 70, status: "partial" });
    expect(await invoice(id)).toMatchObject({ status: "partial", amount_paid: 50, paid_at: null });

    const rows = await payments(id);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.id === second.data.payment_id)).toMatchObject({ amount: 70, reverses_payment_id: null, void_reason: null });
    expect(rows.find((r) => r.reverses_payment_id === second.data.payment_id)).toMatchObject({ amount: -70, void_reason: "Cheque bounced", source: "recorded", created_by: world.tenants.alpha.users.admin.id });
    expect(sum(rows)).toBe(50);

    // Reversing the rest takes it back to issued, unpaid.
    expect((await reverse(first.data.payment_id, "Paid in error")).data).toMatchObject({ amount_paid: 0, status: "issued" });
    expect(await invoice(id)).toMatchObject({ status: "issued", amount_paid: 0, paid_at: null });
    // And the full balance can be paid again.
    expect((await pay(id, 120)).data.status).toBe("paid");
  });

  it("a payment can be reversed once, a reversal can't be reversed, and a reason is required", async () => {
    const id = await issuedInvoice();
    const p = await pay(id, 40);
    expect((await reverse(p.data.payment_id, null)).error).toMatchObject({ code: "22023" });
    expect((await reverse(p.data.payment_id, "   ")).error!.message).toMatch(/reason is required/);
    expect((await reverse(p.data.payment_id, "x".repeat(501))).error).toMatchObject({ code: "22023" });
    expect((await reverse(p.data.payment_id)).error).toBeNull();
    expect((await reverse(p.data.payment_id)).error!.message).toMatch(/already been reversed/);
    const reversal = (await payments(id)).find((r) => r.reverses_payment_id === p.data.payment_id)!;
    expect((await reverse(reversal.id as string)).error!.message).toMatch(/can't itself be reversed/);
    expect((await payments(id))).toHaveLength(2);
    expect(await events(id, "REVERSE_PAYMENT")).toHaveLength(1);
  });

  it("two reversals of the same payment at once: one wins", async () => {
    const id = await issuedInvoice();
    const p = await pay(id, 40);
    const results = await Promise.all([reverse(p.data.payment_id), reverse(p.data.payment_id)]);
    expect(results.filter((r) => !r.error)).toHaveLength(1);
    expect(sum(await payments(id))).toBe(0);
  });

  it("a legacy row (carried over from before part payments) is not reversed here", async () => {
    const id = await issuedInvoice();
    const legacy = await withDb(async (db) => {
      const row = (await db.query("insert into public.invoice_payments (organization_id, invoice_id, amount, paid_on, source) values ($1, $2, 10, null, 'legacy') returning id", [world.tenants.alpha.id, id])).rows[0].id as string;
      await db.query("update public.invoices set amount_paid = 10 where id = $1", [id]);
      return row;
    });
    expect((await reverse(legacy)).error!.message).toMatch(/carried over/);
  });
});

describe("who may do what", () => {
  it("admin and office record payments; workshop and viewer can't; only an admin reverses; admin and office read the payments, workshop and viewer don't", async () => {
    const id = await issuedInvoice();
    const p = await pay(id, 40);
    expect((await pay(id, 10, TODAY, "BACS", null, staff.get("office")!)).error).toBeNull();
    for (const role of ["workshop", "viewer"]) expect((await pay(id, 10, TODAY, "BACS", null, staff.get(role)!)).error, `${role} record`).toMatchObject({ code: "42501" });
    for (const [role, client] of staff) {
      expect((await reverse(p.data.payment_id, "No", client)).error, `${role} reverse`).toMatchObject({ code: "42501" });
      const read = await client.from("invoice_payments").select("id").eq("invoice_id", id);
      expect((read.data ?? []).length, `${role} read`).toBe(role === "office" ? 2 : 0);
    }
    expect((await admin.from("invoice_payments").select("id").eq("invoice_id", id)).data).toHaveLength(2);
    expect((await payments(id)).map((r) => r.created_by)).toContain(world.tenants.alpha.users.office.id);
    expect((await reverse(p.data.payment_id, "Admin may")).error).toBeNull();
  });

  it("another company's admin can't read, record against or reverse these payments", async () => {
    const id = await issuedInvoice();
    const p = await pay(id, 40);
    expect((await adminBeta.from("invoice_payments").select("id")).data!.filter((r) => r.id === p.data.payment_id)).toEqual([]);
    expect((await adminBeta.from("invoice_payments").select("id").eq("invoice_id", id)).data).toEqual([]);
    expect((await pay(id, 10, TODAY, "BACS", null, adminBeta)).error).toMatchObject({ code: "P0002" });
    expect((await reverse(p.data.payment_id, "Not mine", adminBeta)).error).toMatchObject({ code: "P0002" });
    expect(await payments(id)).toHaveLength(1);
    // And their own invoice is theirs alone.
    const theirs = await issuedInvoice(adminBeta);
    expect((await pay(theirs, 120, TODAY, "BACS", null, adminBeta)).data.status).toBe("paid");
    expect((await admin.from("invoice_payments").select("id").eq("invoice_id", theirs)).data).toEqual([]);
  });

  it("the payments are append-only for every API role: no insert, update or delete, even for an admin", async () => {
    const id = await issuedInvoice();
    const p = await pay(id, 40);
    for (const [name, sql] of [
      ["insert", `insert into public.invoice_payments (organization_id, invoice_id, amount, paid_on) values ('${world.tenants.alpha.id}', '${id}', 5, current_date)`],
      ["update", `update public.invoice_payments set amount = 1 where id = '${p.data.payment_id}'`],
      ["delete", `delete from public.invoice_payments where id = '${p.data.payment_id}'`],
    ] as const) {
      await withDb(async (db) => {
        await db.query("begin");
        try {
          await db.query("set local role authenticated");
          await db.query(`select set_config('request.jwt.claims', '{"sub":"${world.tenants.alpha.users.admin.id}","role":"authenticated"}', true)`);
          await expect(db.query(sql), name).rejects.toMatchObject({ code: "42501" });
        } finally {
          await db.query("rollback");
        }
      });
    }
    expect((await admin.from("invoice_payments").update({ amount: 1 }).eq("id", p.data.payment_id).select("id")).error).not.toBeNull();
    expect(await payments(id)).toHaveLength(1);
  });
});

describe("the issued-invoice lock", () => {
  it("still blocks every other edit; amount paid, paid date and the paid / part paid status change only through the functions", async () => {
    const id = await issuedInvoice();
    const attempts: [string, Record<string, unknown>][] = [
      ["total", { total: 1 }], ["customer", { customer: "Someone Else" }], ["due date", { due_date: "2099-02-01" }],
      ["amount paid", { amount_paid: 10 }], ["paid date", { paid_at: new Date().toISOString() }],
      ["status paid", { status: "paid" }], ["status partial", { status: "partial" }], ["draft", { status: "draft" }],
      ["amount paid and status together", { status: "paid", amount_paid: 120, paid_at: new Date().toISOString() }],
    ];
    for (const [name, change] of attempts) expect((await admin.from("invoices").update(change).eq("id", id)).error, name).toMatchObject({ code: "42501" });
    expect(await invoice(id)).toMatchObject({ status: "issued", amount_paid: 0, paid_at: null, total: 120, customer: "Payments Co" });
    // What was open stays open.
    expect((await admin.from("invoices").update({ sent_date: new Date().toISOString() }).eq("id", id)).error).toBeNull();
    expect((await admin.from("invoices").update({ payment_unverified: false }).eq("id", id)).error).toBeNull();
  });

  it("a payment changes exactly status, amount paid, paid date and the unverified flag on the invoice, nothing else", async () => {
    const id = await issuedInvoice();
    const before = await invoice(id);
    expect((await pay(id, 120)).error).toBeNull();
    const after = await invoice(id);
    const changed = Object.keys(after).filter((key) => JSON.stringify(after[key]) !== JSON.stringify(before[key])).sort();
    // paid_by (035) is the database recording who cleared it.
    expect(changed.filter((key) => !["updated_at", "updated_by"].includes(key))).toEqual(["amount_paid", "paid_at", "paid_by", "status"]);
    // The lock setting doesn't linger: the same session's next direct edit is refused again.
    expect((await admin.from("invoices").update({ amount_paid: 5 }).eq("id", id)).error).toMatchObject({ code: "42501" });
  });

  it("a user can't switch the lock off by sending the setting themselves", async () => {
    const id = await issuedInvoice();
    const token = (await admin.auth.getSession()).data.session!.access_token;
    const backend = isolatedBackend();
    const response = await fetch(`${backend.apiUrl}/rest/v1/invoices?id=eq.${id}`, {
      method: "PATCH",
      headers: { apikey: backend.anonKey, Authorization: `Bearer ${token}`, "Content-Type": "application/json", "quoteflow.invoice_payment": id, "x-quoteflow-invoice-payment": id },
      body: JSON.stringify({ amount_paid: 5 }),
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await invoice(id)).toMatchObject({ amount_paid: 0 });
  });
});

describe("the audit trail", () => {
  it("writes one RECORD_PAYMENT and one REVERSE_PAYMENT per payment, in the same transaction, naming the payment", async () => {
    const id = await issuedInvoice();
    const a = await pay(id, 30, "2026-09-01", "cheque", "CHQ 9");
    const b = await pay(id, 20);
    expect((await pay(id, 999)).error).not.toBeNull(); // refused: no event
    const recorded = await events(id, "RECORD_PAYMENT");
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({ source: "write_audit", payment_id: a.data.payment_id, amount: 30, paid_on: "2026-09-01", method: "cheque", reference: "CHQ 9", balance_due: 90, status: "partial" });
    expect(recorded[1]).toMatchObject({ payment_id: b.data.payment_id, amount: 20, balance_due: 70 });
    expect((await reverse(b.data.payment_id, "Wrong customer")).error).toBeNull();
    const reversed = await events(id, "REVERSE_PAYMENT");
    expect(reversed).toHaveLength(1);
    expect(reversed[0]).toMatchObject({ payment_id: b.data.payment_id, amount: 20, reason: "Wrong customer", balance_due: 90 });
    const stamped = await withDb(async (db) => (await db.query("select actor_user_id, organization_id, hash is not null as chained from security_audit.audit_log where entity_id = $1 and action = 'RECORD_PAYMENT'", [id])).rows);
    expect(stamped).toEqual(Array(2).fill({ actor_user_id: world.tenants.alpha.users.admin.id, organization_id: world.tenants.alpha.id, chained: true }));
  });

  it("shows on the invoice's history to an admin, labelled, and keeps the money-redaction rules of 024", async () => {
    const id = await issuedInvoice();
    expect((await pay(id, 30, "2026-09-01", "BACS", "REF 1")).error).toBeNull();
    const history = await admin.rpc("record_activity", { p_table: "invoices", p_id: id });
    expect(history.error).toBeNull();
    const entry = (history.data as { action: string; metadata: Record<string, unknown> }[]).find((e) => e.action === "RECORD_PAYMENT")!;
    expect(entry.metadata).toMatchObject({ amount: 30, method: "BACS", reference: "REF 1" });
    // Office opens an invoice's history too; workshop and viewer can't; and the redaction used for anyone who may not see money removes every money key.
    expect((await staff.get("office")!.rpc("record_activity", { p_table: "invoices", p_id: id })).error).toBeNull();
    for (const role of ["workshop", "viewer"]) expect((await staff.get(role)!.rpc("record_activity", { p_table: "invoices", p_id: id })).error, role).toMatchObject({ code: "42501" });
    const redacted = await withDb(async (db) => (await db.query("select security_audit.redact_money(metadata - 'source') as m from security_audit.audit_log where entity_id = $1 and action = 'RECORD_PAYMENT'", [id])).rows[0].m as Record<string, unknown>);
    expect(Object.keys(redacted).sort()).toEqual(["invoice_ref", "method", "payment_id", "reference", "status"]);
  });
});

describe("existing receipts become legacy payments (the migration's backfill)", () => {
  const migration = readFileSync(path.resolve(__dirname, "../../supabase/migrations/032_invoice_payments.sql"), "utf8");
  const backfill = migration.slice(migration.indexOf("INSERT INTO public.invoice_payments (organization_id, invoice_id, amount, paid_on, source)"), migration.indexOf(";", migration.indexOf("INSERT INTO public.invoice_payments (organization_id, invoice_id, amount, paid_on, source)")) + 1);

  it("one legacy row for exactly the stored amount; flagged invoices and unknown amounts get none; running it again adds nothing", async () => {
    expect(backfill).toMatch(/^INSERT INTO public\.invoice_payments[\s\S]*payment_unverified[\s\S]*;$/);
    const org = world.tenants.alpha.id;
    await withDb(async (db) => {
      await db.query("begin");
      try {
        const make = async (ref: string, status: string, total: number, paid: number, paidAt: string | null, unverified: boolean) =>
          (await db.query(
            "insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, amount_paid, paid_at, payment_unverified) values ($1, $2, 'Legacy Co', $3, 0, $3, $4, $5, $6, $7) returning id",
            [org, ref, total, status, paid, paidAt, unverified])).rows[0].id as string;
        const paidFull = await make("INV-LEG-1", "paid", 120, 120, "2026-03-04T10:00:00Z", false);
        const partNoDate = await make("INV-LEG-2", "sent", 200, 50, null, false);
        const unverified = await make("INV-LEG-3", "sent", 80, 0, null, true);
        const unverifiedWithAmount = await make("INV-LEG-4", "sent", 80, 30, null, true);
        const paidNoAmount = await make("INV-LEG-5", "paid", 99, 0, "2026-03-05T10:00:00Z", false);
        const unpaid = await make("INV-LEG-6", "sent", 10, 0, null, false);

        await db.query(backfill);
        const rows = (await db.query("select invoice_id, amount, paid_on::text as paid_on, method, reference, source, created_by, reverses_payment_id from public.invoice_payments where invoice_id = any($1)", [[paidFull, partNoDate, unverified, unverifiedWithAmount, paidNoAmount, unpaid]])).rows;
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.invoice_id === paidFull)).toMatchObject({ amount: "120.00", paid_on: "2026-03-04", method: null, reference: null, source: "legacy", created_by: null, reverses_payment_id: null });
        expect(rows.find((r) => r.invoice_id === partNoDate)).toMatchObject({ amount: "50.00", paid_on: null, source: "legacy" });

        await db.query(backfill); // safe to run more than once
        expect((await db.query("select count(*)::int as n from public.invoice_payments where invoice_id = any($1)", [[paidFull, partNoDate, unverified, unverifiedWithAmount, paidNoAmount, unpaid]])).rows[0].n).toBe(2);
        // The invoices themselves are untouched.
        expect((await db.query("select status, amount_paid::float as paid, payment_unverified from public.invoices where id = $1", [unverifiedWithAmount])).rows[0]).toEqual({ status: "sent", paid: 30, payment_unverified: true });
        expect((await db.query("select status, amount_paid::float as paid from public.invoices where id = $1", [paidNoAmount])).rows[0]).toEqual({ status: "paid", paid: 0 });
        // Invariant for every invoice that is not flagged.
        const broken = (await db.query(
          "select count(*)::int as n from public.invoices i where i.id = any($1) and not i.payment_unverified and i.amount_paid <> coalesce((select sum(amount) from public.invoice_payments p where p.invoice_id = i.id), 0)",
          [[paidFull, partNoDate, unverified, unverifiedWithAmount, paidNoAmount, unpaid]])).rows[0].n;
        expect(broken).toBe(0);
      } finally {
        await db.query("rollback");
      }
    });
  });

  it("the legacy invoice can then take more payments on top: balance is total minus the legacy amount", async () => {
    const org = world.tenants.alpha.id;
    const id = await withDb(async (db) => {
      const inv = await db.query("insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, amount_paid, paid_at) values ($1, 'INV-LEG-7', 'Legacy Co', 200, 0, 200, 'sent', 50, null) returning id", [org]);
      await db.query("insert into public.invoice_payments (organization_id, invoice_id, amount, paid_on, source) values ($1, $2, 50, null, 'legacy')", [org, inv.rows[0].id]);
      return inv.rows[0].id as string;
    });
    expect((await pay(id, 151)).error!.message).toMatch(/balance due on INV-LEG-7 \(£150\.00 of £200\.00\)/);
    expect((await pay(id, 150)).data).toMatchObject({ amount_paid: 200, status: "paid" });
    expect(await payments(id)).toHaveLength(2);
  });
});

describe("amount paid is always the sum of the payments", () => {
  it("holds for every invoice of the test companies after all of the above, and the hosted check says so", async () => {
    const orgs = [world.tenants.alpha.id, world.tenants.beta.id];
    const broken = await withDb(async (db) => (await db.query(
      "select i.invoice_ref, i.amount_paid::float as amount_paid, coalesce((select sum(amount) from public.invoice_payments p where p.invoice_id = i.id), 0)::float as paid from public.invoices i where i.organization_id = any($1) and not i.payment_unverified and i.amount_paid <> coalesce((select sum(amount) from public.invoice_payments p where p.invoice_id = i.id), 0)", [orgs])).rows);
    // The one exception is the invoice edited as the database owner on purpose above (amount paid 30, no payments).
    expect(broken.map((r) => [r.amount_paid, r.paid])).toEqual([[30, 0]]);

    const sql = readFileSync(path.resolve(__dirname, "../../supabase/verify/invoice_payments_032.sql"), "utf8");
    const value = (rows: { check_name: string; value: string }[], name: string) => rows.find((r) => r.check_name.startsWith(name))?.value;
    await withDb(async (db) => {
      await db.query("begin transaction read only");
      try {
        const rows = (await db.query<{ check_name: string; value: string }>(sql)).rows;
        expect(value(rows, "032 applied: invoice_payments exists")).toBe("true");
        expect(value(rows, "032 applied: record_invoice_payment exists")).toBe("true");
        expect(value(rows, "legacy rows on flagged invoices")).toBe("0");
        expect(Number(value(rows, "invoices with receipts, not flagged"))).toBeGreaterThanOrEqual(1);
      } finally {
        await db.query("rollback");
      }
    });
    // The check catches a break: an invoice with receipts and no payments raises it by one.
    await withDb(async (db) => {
      await db.query("begin");
      try {
        const count = async () => Number((await db.query<{ check_name: string; value: string }>(sql)).rows.find((r) => r.check_name.startsWith("invoices where amount_paid"))!.value);
        const baseline = await count();
        await db.query("insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, amount_paid) values ($1, 'INV-BROKEN', 'Broken Co', 10, 0, 10, 'sent', 4)", [world.tenants.alpha.id]);
        expect(await count()).toBe(baseline + 1);
      } finally {
        await db.query("rollback");
      }
    });
  });
});

describe("the invoice message in the issuer snapshot", () => {
  it("an invoice issued now records the company's invoice message (empty when none is set); earlier snapshots are untouched", async () => {
    const service = adminClient();
    const org = world.tenants.alpha.id;
    const { data: settings } = await service.from("organization_settings").select("company_profile").eq("organization_id", org).single();
    const profile = settings!.company_profile as Record<string, unknown>;
    const first = await issuedInvoice();
    expect((await invoice(first)).issuer_snapshot).toMatchObject({ defaultInvoiceMessage: [] });
    try {
      await service.from("organization_settings").update({ company_profile: { ...profile, defaultInvoiceMessage: ["Payment due in 30 days."], defaultCustomerMessage: ["Quotes are valid for 7 days."] } }).eq("organization_id", org);
      const second = await issuedInvoice();
      expect((await invoice(second)).issuer_snapshot).toMatchObject({ defaultInvoiceMessage: ["Payment due in 30 days."], defaultCustomerMessage: ["Quotes are valid for 7 days."] });
      expect((await invoice(first)).issuer_snapshot).toMatchObject({ defaultInvoiceMessage: [] });
    } finally {
      await service.from("organization_settings").update({ company_profile: profile }).eq("organization_id", org);
    }
  });
});
