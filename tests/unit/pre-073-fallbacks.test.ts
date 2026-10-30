/**
 * The app goes out before migration 073 is applied (merging to main deploys it). These are the fallbacks that keep the invoice and
 * customer screens working as before and hide what 073 adds (Void, £0 text lines, the invoice note, the delivery address, the
 * customer's mobile) until the database has it; and, once it does, what is sent and shown.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.hoisted(() => ({ result: { error: null } as { error: { code?: string; message?: string } | null }, calls: 0, columns: [] as string[] }));

vi.mock("@/lib/supabase", () => {
  const chain = (table: string) => {
    const self: Record<string, unknown> = {};
    self.select = (columns: string) => { if (table === "invoices") probe.columns.push(columns); return self; };
    for (const name of ["eq", "in", "order", "limit"]) self[name] = () => self;
    self.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
      if (table === "invoices") {
        probe.calls += 1;
        return Promise.resolve(probe.result).then(resolve, reject);
      }
      return Promise.resolve({ data: [], error: null }).then(resolve, reject);
    };
    return self;
  };
  return { supabase: { from: (table: string) => chain(table) } };
});

import { computePdfTotals } from "@/components/pdf/BaseDocumentPDF";
import { databaseHas073, resetDatabaseFeatureCache } from "@/lib/db-features";
import { type CustomerReader, customerPayload, readCustomers } from "@/lib/customers";
import { buildDraftReplace, draftFormFrom, draftTotals, type DraftForm } from "@/lib/draft-invoice-edit";
import { deliveryAddressLines, invoiceNoteProblem, deliveryAddressProblem, optionalColumn } from "@/lib/invoice-fields";
import { VOID_NEEDS_UPDATE, type VoidClient, isVoid, voidInvoice, voidOffered, voidReasonProblem, voidRefusalMessage } from "@/lib/invoice-void";
import { documentTotals, isTextLine } from "@/lib/money";

describe("the 073 probe (Void and the new fields show only once it is applied)", () => {
  beforeEach(() => {
    resetDatabaseFeatureCache();
    probe.calls = 0;
    probe.columns = [];
  });

  it("asks for invoices.invoice_note (a GET of at most one row)", async () => {
    probe.result = { error: null };
    expect(await databaseHas073()).toBe(true);
    expect(probe.columns).toEqual(["invoice_note"]);
  });

  it("not applied (missing column, either code): false, asked once", async () => {
    for (const code of ["42703", "PGRST204"]) {
      resetDatabaseFeatureCache();
      probe.calls = 0;
      probe.result = { error: { code, message: "column invoices.invoice_note does not exist" } };
      expect(await databaseHas073()).toBe(false);
      expect(await databaseHas073()).toBe(false);
      expect(probe.calls).toBe(1);
    }
  });

  it("offline is no answer: hidden for now (these features write), and the next call asks again", async () => {
    probe.result = { error: { message: "Failed to fetch" } };
    expect(await databaseHas073()).toBe(false);
    probe.result = { error: null };
    expect(await databaseHas073()).toBe(true);
    expect(probe.calls).toBe(2);
  });
});

describe("Void", () => {
  const issued = { rawStatus: "issued", amountPaid: 0, credited: 0, refunded: 0 };

  it("offered only on an issued invoice with nothing paid or credited", () => {
    expect(voidOffered(issued)).toBe(true);
    expect(voidOffered({ ...issued, rawStatus: "Sent" })).toBe(true);
    for (const rawStatus of ["draft", "void", "Voided", "cancelled", "canceled", "paid", "partial", "credited", "written_off", "overdue"]) expect({ rawStatus, offered: voidOffered({ ...issued, rawStatus }) }).toEqual({ rawStatus, offered: false });
    expect(voidOffered({ ...issued, amountPaid: 10 })).toBe(false);
    expect(voidOffered({ ...issued, credited: 10 })).toBe(false);
    expect(voidOffered({ ...issued, refunded: 5 })).toBe(false);
    expect(voidOffered({ ...issued, paymentUnverified: true })).toBe(false);
    expect([isVoid("VOID"), isVoid(" cancelled "), isVoid("issued"), isVoid(null)]).toEqual([true, true, false, false]);
  });

  it("the reason is required and at most 500 characters", () => {
    expect(voidReasonProblem("")).toMatch(/reason/);
    expect(voidReasonProblem("   ")).toMatch(/reason/);
    expect(voidReasonProblem("x".repeat(501))).toMatch(/500/);
    expect(voidReasonProblem("  Raised in error ")).toBeNull();
  });

  it("each refusal reads in plain English, never the raw database text", () => {
    const hints: Record<string, RegExp> = {
      invoice_paid: /payments recorded/, invoice_payments_unconfirmed: /still to be confirmed/, invoice_credited: /credit applied/,
      invoice_has_credit_notes: /credit note/, invoice_already_void: /already void/, invoice_draft: /delete the draft/, invoice_written_off: /written off/,
      void_reason_required: /reason/, invoice_void_direct: /Void invoice/, invoice_void_final: /stays void/,
      invoice_status_not_voidable: /checked/, invoice_status_not_allowed: /status/,
    };
    for (const [hint, text] of Object.entries(hints)) expect(voidRefusalMessage({ code: "22023", message: "x", hint })).toMatch(text);
    expect(voidRefusalMessage({ code: "P0002", message: "Invoice not found" })).toMatch(/wasn't found/);
    expect(voidRefusalMessage({ code: "42501", message: "not authorised" })).toMatch(/admin and office/);
    expect(voidRefusalMessage({ code: "XX000", message: "relation \"invoices\" violates something" })).not.toMatch(/relation|violates/);
  });

  function client(answer: { data?: unknown; error: { code?: string; message?: string; hint?: string } | null } | Error) {
    const calls: Array<{ p_invoice_id: string; p_reason: string }> = [];
    const c: VoidClient = { rpc: (_fn, args) => { calls.push(args); return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ data: answer.data ?? null, error: answer.error }); } };
    return { c, calls };
  }

  it("before 073 (no such function): says the update isn't applied, nothing changed", async () => {
    for (const code of ["PGRST202", "42883"]) {
      const { c } = client({ error: { code, message: "Could not find the function public.void_invoice(p_invoice_id, p_reason) in the schema cache" } });
      expect(await voidInvoice(c, "inv-1", "Wrong customer")).toEqual({ ok: false, error: VOID_NEEDS_UPDATE });
    }
    expect(VOID_NEEDS_UPDATE).toMatch(/Nothing was changed/);
  });

  it("sends the trimmed reason once; a blank reason is never sent; a refusal or a network failure is a message, not a throw", async () => {
    const ok = client({ data: { status: "void" }, error: null });
    expect(await voidInvoice(ok.c, "inv-1", "  Wrong customer  ")).toEqual({ ok: true });
    expect(ok.calls).toEqual([{ p_invoice_id: "inv-1", p_reason: "Wrong customer" }]);
    const blank = client({ error: null });
    expect(await voidInvoice(blank.c, "inv-1", "  ")).toMatchObject({ ok: false });
    expect(blank.calls).toHaveLength(0);
    expect(await voidInvoice(client({ error: { code: "22023", message: "INV-1 has payments recorded against it", hint: "invoice_paid" } }).c, "inv-1", "x")).toMatchObject({ ok: false, error: expect.stringMatching(/payments recorded/) });
    expect(await voidInvoice(client(new Error("Failed to fetch")).c, "inv-1", "x")).toMatchObject({ ok: false, error: expect.stringMatching(/connection/) });
  });
});

describe("the invoice status allowlist (073)", () => {
  it("a refused status reads in plain English", async () => {
    const { friendlyError } = await import("@/lib/friendly-error");
    expect(friendlyError({ code: "23514", hint: "invoice_status_not_allowed", message: "An invoice's status must be exactly one of: draft, issued, sent, partial, paid, credited, void, cancelled, written_off." })).toMatch(/status must be exactly one of/);
    expect(friendlyError({ code: "23514", hint: "invoice_status_not_allowed", message: "new row violates check constraint" })).toMatch(/isn't an invoice status/);
  });
});

describe("the invoice note and delivery address", () => {
  it("a column the database doesn't have reads as undefined (not shown, not sent); empty reads as none", () => {
    expect(optionalColumn({ id: "x" }, "invoice_note")).toBeUndefined();
    expect(optionalColumn({ invoice_note: null }, "invoice_note")).toBeNull();
    expect(optionalColumn({ invoice_note: "  " }, "invoice_note")).toBeNull();
    expect(optionalColumn({ invoice_note: "Thanks" }, "invoice_note")).toBe("Thanks");
  });

  it("note: one line, 200 characters; address: 500; printed address lines", () => {
    expect(invoiceNoteProblem("two\nlines")).toMatch(/one line/);
    expect(invoiceNoteProblem("x".repeat(201))).toMatch(/200/);
    expect(invoiceNoteProblem("Thank you")).toBeNull();
    expect(deliveryAddressProblem("x".repeat(501))).toMatch(/500/);
    expect(deliveryAddressLines("Unit 4\nDock Road, Hull")).toEqual(["Unit 4", "Dock Road", "Hull"]);
    expect(deliveryAddressLines("  ")).toBeUndefined();
    expect(deliveryAddressLines(undefined)).toBeUndefined();
  });
});

describe("Edit Draft before and after 073", () => {
  const VAT = { vatEnabled: true, carriageVat: false, registered: true, standardRate: 20 };
  const stored = [{ description: "Part A", quantity: 2, unitPrice: 50, vatPct: 20 }];
  const base = { date: "2026-10-18", dueDate: "2026-11-17", terms: "30 days", carriage: 0 };

  it("before 073: no note or address in the form or the save, and a text line is not offered or sent", () => {
    const form = draftFormFrom(base, stored);
    expect("invoiceNote" in form || "deliveryAddress" in form).toBe(false);
    const built = buildDraftReplace(form, VAT);
    if (!built.ok) throw new Error(built.error);
    expect(Object.keys(built.value.header)).not.toContain("invoice_note");
    expect(Object.keys(built.value.header)).not.toContain("delivery_address");
    const withText: DraftForm = { ...form, lines: [...form.lines, { description: "Note", qty: "0", unit: "0.00", vat: "20", text: true }] };
    expect(buildDraftReplace(withText, VAT)).toMatchObject({ ok: false, error: expect.stringMatching(/database update/) });
    // The old rule for a priced line is unchanged: quantity 0 is refused.
    expect(buildDraftReplace({ ...form, lines: [{ description: "x", qty: "0", unit: "0", vat: "20" }] }, VAT, { textLines: true })).toMatchObject({ ok: false });
  });

  it("with 073: the loaded note and address are sent as edited (blank clears), text lines are sent as 0 x £0 and add nothing", () => {
    const form = draftFormFrom({ ...base, invoiceNote: "Thanks", deliveryAddress: null }, [...stored, { description: "Collected", quantity: 0, unitPrice: 0, vatPct: 20 }]);
    expect(form.invoiceNote).toBe("Thanks");
    expect(form.deliveryAddress).toBe("");
    expect(form.lines[1]).toMatchObject({ text: true, description: "Collected" });
    const built = buildDraftReplace({ ...form, invoiceNote: "  Thank you  ", deliveryAddress: "Unit 4\nDock Road" }, VAT, { textLines: true });
    if (!built.ok) throw new Error(built.error);
    expect(built.value.header).toMatchObject({ invoice_note: "Thank you", delivery_address: "Unit 4\nDock Road", subtotal: 100, vat: 20, total: 120 });
    expect(built.value.lines[1]).toEqual({ description: "Collected", quantity: 0, unit_price: 0, vat_pct: 20, vat_exempt: false });
    expect(draftTotals(form, VAT).vatBreakdown).toHaveLength(1);
    // A text line first: the header's one-line summary is the first priced line.
    const first = buildDraftReplace({ ...form, lines: [form.lines[1], form.lines[0]] }, VAT, { textLines: true });
    if (!first.ok) throw new Error(first.error);
    expect(first.value.header).toMatchObject({ description: "Part A", quantity: 2, unit_price: 50 });
    // Only text lines, a text line with no text, a note with a line break: refused before sending.
    expect(buildDraftReplace({ ...form, lines: [form.lines[1]] }, VAT, { textLines: true })).toMatchObject({ ok: false, error: expect.stringMatching(/priced line/) });
    expect(buildDraftReplace({ ...form, lines: [form.lines[0], { ...form.lines[1], description: " " }] }, VAT, { textLines: true })).toMatchObject({ ok: false });
    expect(buildDraftReplace({ ...form, invoiceNote: "a\nb" }, VAT, { textLines: true })).toMatchObject({ ok: false, error: expect.stringMatching(/one line/) });
  });
});

describe("£0 text lines in the totals and on the PDF", () => {
  it("excluded from the subtotal, the VAT and the VAT breakdown", () => {
    expect([isTextLine({ quantity: 0, unitPrice: 0 }), isTextLine({ quantity: 0 }), isTextLine({ quantity: 1, unitPrice: 0 }), isTextLine({ quantity: 0, unitPrice: 5 })]).toEqual([true, true, false, false]);
    const totals = documentTotals([{ quantity: 2, unitPrice: 50, vatPct: 20 }, { quantity: 0, unitPrice: 0, vatPct: 0 }]);
    expect(totals).toMatchObject({ subtotal: 100, vat: 20, total: 120 });
    expect(totals.vatBreakdown).toEqual([{ rate: 20, exempt: false, net: 100, vat: 20 }]);
    expect(computePdfTotals({ lineItems: [{ description: "Bush", quantity: 2, unitPrice: 50, vatPct: 20 }, { description: "Collected", quantity: 0, unitPrice: 0 }], payments: 0 })).toMatchObject({ subtotal: 100, vat: 20, total: 120, balance: 120 });
  });
});

describe("the customer's mobile before and after 073", () => {
  function reader(responses: Array<{ data: unknown[] | null; error: { code?: string; message?: string } | null }>) {
    const asked: string[] = [];
    const client: CustomerReader = { from: () => ({ select: (columns: string) => ({ order: () => { asked.push(columns); return Promise.resolve(responses.shift()!); } }) }) };
    return { client, asked };
  }
  const ROW = { id: "c1", name: "Acme", contact_name: null, email: null, phone: "01482 000000", address: "1 Road", notes: null };

  it("before 073 (the probe says so): one read without the mobile, no failing request", async () => {
    const { client, asked } = reader([{ data: [ROW], error: null }]);
    const [customer] = await readCustomers(client, false);
    expect(customer.mobile).toBeUndefined();
    expect(asked).toEqual(["id, name, contact_name, email, phone, address, notes, updated_at"]);
  });

  it("if the column is missing anyway: the list still loads (without the mobile, which stays unread)", async () => {
    for (const code of ["42703", "PGRST204"]) {
      const { client, asked } = reader([{ data: null, error: { code, message: "column customers.mobile does not exist" } }, { data: [ROW], error: null }]);
      const [customer] = await readCustomers(client);
      expect(customer).toMatchObject({ name: "Acme", phone: "01482 000000" });
      expect(customer.mobile).toBeUndefined();
      expect(asked).toEqual(["id, name, contact_name, email, phone, address, notes, updated_at, mobile", "id, name, contact_name, email, phone, address, notes, updated_at"]);
    }
  });

  it("with 073: one read, mobile included; any other failure is reported", async () => {
    const { client, asked } = reader([{ data: [{ ...ROW, mobile: "07700 900123" }], error: null }]);
    expect((await readCustomers(client))[0].mobile).toBe("07700 900123");
    expect(asked).toHaveLength(1);
    const failing = reader([{ data: null, error: { code: "42501", message: "permission denied" } }]);
    await expect(readCustomers(failing.client)).rejects.toMatchObject({ code: "42501" });
    expect(failing.asked).toHaveLength(1);
  });

  it("a save sends the mobile only when it was read: never a blank over a real number", () => {
    const customer = { name: "Acme", contactName: "", email: "", phone: "", address: "", notes: "" };
    expect(Object.keys(customerPayload(customer, "org"))).not.toContain("mobile");
    expect(customerPayload({ ...customer, mobile: " 07700 900123 " }, "org").mobile).toBe("07700 900123");
    expect(customerPayload({ ...customer, mobile: "  " }, "org").mobile).toBeNull();
  });
});
