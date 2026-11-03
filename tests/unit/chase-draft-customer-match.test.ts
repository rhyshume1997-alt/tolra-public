import { describe, expect, it, vi } from "vitest";

import { CHASE_TONE_TEMPLATE } from "@/lib/chasing/templates";
import { chaseCandidates, runChase, type ChaseInvoiceRow } from "@/lib/email/chase/run";
import type { ChaseTone } from "@/lib/email/chase/steps";
import { FakeDb } from "../support/fake-db";

const ORG = "company-a";
const TODAY = "2026-11-20";
const invoice = (changes: Partial<ChaseInvoiceRow> = {}) => ({
  id: "invoice", organization_id: ORG, invoice_ref: "INV-1", customer: "Shop Ltd", job_id: null,
  total: "120.00", amount_paid: "0.00", credited_amount: "0.00", refunded_amount: "0.00",
  status: "sent", due_date: "2026-11-01", payment_unverified: false, ...changes,
});

function store() {
  return Object.assign(new FakeDb({
    invoices: [invoice()],
    customers: [{ id: "first", organization_id: ORG, name: "Shop Ltd", email: "first@example.test", contact_name: "First contact" }],
    chase_steps: [{ id: "step", organization_id: ORG, offset_days: 7, tone: "friendly" }],
    chase_pauses: [], chase_sends: [], email_history: [], email_templates: [], jobs: [], purchase_orders: [],
    organizations: [{ id: ORG, name: "Our Shop" }], organization_settings: [],
  }), { rpc: vi.fn().mockResolvedValue({ data: { created: true, history_id: "new-draft" }, error: null }) });
}

describe("customer matching before the draft RPC writes anything", () => {
  const cases = ["second@example.test", null, "not an address", "first@example.test"].flatMap((email) =>
    [false, true].flatMap((fixed) => [false, true].map((reverse) => ({ email, fixed, reverse }))));

  it.each(cases)("refuses duplicate names: %j", async ({ email, fixed, reverse }) => {
    const db = store();
    db.rows("customers").push({ id: "second", organization_id: ORG, name: " SHOP LTD ", email, contact_name: "Second contact" });
    if (reverse) db.rows("customers").reverse();

    const result = await runChase(db as never, {
      organizationId: ORG, today: TODAY, recipients: fixed ? ["collections@our-shop.test"] : null,
    });

    expect(result).toMatchObject({ sent: 0, drafted: 0, skipped: 1, failed: 0, reasons: { ambiguous_customer: 1 } });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
    expect(db.rows("email_history")).toEqual([]);
  });

  it("checks customer records on later pages before choosing a recipient", async () => {
    const db = store();
    db.rows("customers")[0].id = "a-first";
    for (let i = 0; i < 1000; i++) {
      db.rows("customers").push({ id: `m-${String(i).padStart(4, "0")}`, organization_id: ORG, name: `Other customer ${i}`, email: null });
    }
    db.rows("customers").push({ id: "z-second", organization_id: ORG, name: "shop ltd", email: "second@example.test" });

    expect(await runChase(db as never, { organizationId: ORG, today: TODAY }))
      .toMatchObject({ drafted: 0, skipped: 1, reasons: { ambiguous_customer: 1 } });
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("does not let a third duplicate restore a mailbox; unrelated invoices still get their own draft", async () => {
    const db = store();
    db.rows("customers").push(
      { id: "second", organization_id: ORG, name: "shop ltd", email: null },
      { id: "third", organization_id: ORG, name: " Shop Ltd ", email: "third@example.test" },
      { id: "unique", organization_id: ORG, name: "Other Shop", email: "other@example.test" },
    );
    db.rows("invoices").push(invoice({ id: "unique-invoice", invoice_ref: "INV-2", customer: "Other Shop" }));

    expect(await runChase(db as never, { organizationId: ORG, today: TODAY }))
      .toMatchObject({ drafted: 1, skipped: 1, reasons: { ambiguous_customer: 1 } });
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith("chase_create_draft", expect.objectContaining({ p_invoice: "unique-invoice", p_to: "other@example.test" }));
  });

  it("matches a unique name after trimming/case folding and ignores another company's same name", async () => {
    const db = store();
    db.rows("customers")[0].name = " SHOP LTD ";
    db.rows("customers")[0].email = " first@example.test ";
    db.rows("customers").push({ id: "foreign", organization_id: "company-b", name: "Shop Ltd", email: "foreign@example.test" });

    expect(await runChase(db as never, { organizationId: ORG, today: TODAY })).toMatchObject({ drafted: 1, skipped: 0 });
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.rpc).toHaveBeenCalledWith("chase_create_draft", expect.objectContaining({ p_org: ORG, p_to: "first@example.test", p_to_name: "First contact" }));
  });

  it.each([null, "not an address"])("does not use an unusable address on a unique customer: %s", async (email) => {
    const db = store();
    db.rows("customers")[0].email = email;
    expect(await runChase(db as never, { organizationId: ORG, today: TODAY }))
      .toMatchObject({ drafted: 0, skipped: 1, reasons: { no_address: 1 } });
    expect(db.rpc).not.toHaveBeenCalled();
  });
});

describe("credits change the chase balance, never the invoice face total", () => {
  const tones: ChaseTone[] = ["before_due", "friendly", "firm", "final"];
  const amounts = [
    { total: "120.00", amount_paid: "0.00", credited_amount: "20.00", refunded_amount: "0.00", balance: "£100.00" },
    { total: "120.00", amount_paid: "30.00", credited_amount: "20.00", refunded_amount: "5.00", balance: "£75.00" },
    { total: "100.10", amount_paid: "33.37", credited_amount: "66.72", refunded_amount: "0.00", balance: "£0.01" },
  ];

  it.each(tones.flatMap((tone) => amounts.map((amount) => ({ tone, ...amount }))))
    ("keeps the original total in custom draft wording: %j", async ({ tone, balance, ...amount }) => {
      const db = store();
      const original = invoice(amount);
      db.tables.invoices = [Object.freeze(original)];
      db.tables.chase_steps = [{ id: "step", organization_id: ORG, offset_days: tone === "before_due" ? 0 : 7, tone }];
      db.rows("email_templates").push({ organization_id: ORG, key: CHASE_TONE_TEMPLATE[tone], subject: "Invoice {{document_number}}: {{total}}", body: "Original total {{total}}; still owed {{balance}}" });

      expect(await runChase(db as never, { organizationId: ORG, today: TODAY })).toMatchObject({ drafted: 1 });
      expect(db.rpc).toHaveBeenCalledTimes(1);
      expect(db.rpc).toHaveBeenCalledWith("chase_create_draft", expect.objectContaining({
        p_subject: `Invoice INV-1: £${amount.total}`,
        p_body: `Original total £${amount.total}; still owed ${balance}`,
      }));
      expect(db.rows("invoices")).toEqual([original]);
      expect(db.log).toEqual([]);
    });

  it.each(["120.00", "130.00"])("does not draft a fully credited or overcredited invoice (%s) or rewrite its total", async (credit) => {
    const db = store();
    const original = invoice({ credited_amount: credit });
    db.tables.invoices = [Object.freeze(original)];
    expect(await runChase(db as never, { organizationId: ORG, today: TODAY })).toMatchObject({ sent: 0, drafted: 0 });
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.rows("invoices")).toEqual([original]);
    expect(db.log).toEqual([]);
  });

  it("keeps the original total in the candidate and leaves the source invoice unchanged", () => {
    const original = Object.freeze(invoice({ total: "100.10", amount_paid: "33.37", credited_amount: "66.72" }));
    const [candidate] = chaseCandidates([original], TODAY, 7);
    expect(candidate).toMatchObject({ total: "100.10", amount_paid: "33.37", credited_amount: "66.72", balance: 0.01 });
    expect(original.total).toBe("100.10");
    expect(candidate).not.toBe(original);
  });
});

describe("duplicate customer names across database pages", () => {
  it.each([false, true])("refuses a first-page / third-page duplicate (fixed recipients: %s)", async (fixed) => {
    const db = store();
    db.tables.customers = Array.from({ length: 2002 }, (_, index) => ({
      id: `customer-${String(index).padStart(5, "0")}`, organization_id: ORG,
      name: `Unrelated ${index}`, email: "other@example.test", contact_name: null,
    }));
    db.rows("customers")[1].name = "Shop Ltd";
    db.rows("customers")[2001].name = " SHOP LTD ";
    const pages: Array<[number, number]> = [];
    const from = db.from.bind(db);
    vi.spyOn(db, "from").mockImplementation((table) => {
      const query = from(table);
      if (table === "customers") {
        const range = query.range.bind(query);
        vi.spyOn(query, "range").mockImplementation((start, end) => {
          pages.push([start, end]);
          return range(start, end);
        });
      }
      return query;
    });

    expect(await runChase(db as never, {
      organizationId: ORG, today: TODAY, recipients: fixed ? ["collections@our-shop.test"] : null,
    })).toMatchObject({ drafted: 0, sent: 0, skipped: 1, failed: 0, reasons: { ambiguous_customer: 1 } });
    expect(pages).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
    expect(db.rows("email_history")).toEqual([]);
  });
});
