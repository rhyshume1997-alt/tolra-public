import { describe, expect, it } from "vitest";
import { documentTotals, toPence } from "@/lib/money";
import { balanceDue, customerCredit, daysPastDue, owed, paidOnTime } from "@/lib/receivables";

describe("part payments, credits and refunds", () => {
  it.each([
    [120, 30, 20, 0, 70], [120, 30, 20, 5, 75], [120, 100, 20, 0, 0],
    [120, 100, 30, 0, 0], [0.03, 0.01, 0.01, 0, 0.01],
    [100.10, 33.37, 66.72, 0, 0.01], [100.10, 33.37, 66.73, 0, 0],
  ])("£%s less £%s paid and £%s credited, plus £%s refunded leaves £%s", (total, paid, credit, refund, balance) => {
    const invoice = { status: "partial", total, amount_paid: paid, credited_amount: credit, refunded_amount: refund };
    expect(balanceDue(total, paid, credit, refund)).toBe(balance);
    expect(owed(invoice)).toBe(balance);
    expect(invoice.total).toBe(total);
  });
  it("three ten-pence receipts settle thirty pence despite their floating-point sum", () => {
    let paid = 0;
    for (const expected of [0.20, 0.10, 0]) {
      paid += 0.1;
      expect(balanceDue(0.3, paid)).toBe(expected);
    }
    expect(toPence(paid)).toBe(30);
  });
  it("tracks a surplus as customer credit and reduces it when refunded", () => {
    const invoice = { status: "issued", total: 100.10, amount_paid: 90.10, credited_amount: 20, refunded_amount: 0 };
    expect(owed(invoice)).toBe(0);
    expect(customerCredit(invoice)).toBe(10);
    expect(customerCredit({ ...invoice, refunded_amount: 3.25 })).toBe(6.75);
    expect(customerCredit({ ...invoice, refunded_amount: 10 })).toBe(0);
    expect(invoice.total).toBe(100.10);
  });
  it.each(["draft", "void", "cancelled", "written_off"])("does not treat a %s invoice as money owed or customer credit", status => {
    const invoice = { status, total: 10, amount_paid: 20, credited_amount: 5 };
    expect(owed(invoice)).toBe(0);
    expect(customerCredit(invoice)).toBe(0);
  });
  it("does not count a credit as a receipt or a paid-on-time invoice", () => {
    expect(paidOnTime([{ status: "credited", due_date: "2026-02-28", paid_at: "2026-02-28" }]))
      .toEqual({ counted: 0, onTime: 0, excluded: 0, rate: null });
  });
});

describe("VAT when the value or rate is zero", () => {
  it.each([0, 5, 20])("a zero-priced item at %s percent adds no VAT or money", vatPct => {
    expect(documentTotals([{ quantity: 7, unitPrice: 0, vatPct }])).toMatchObject({ subtotal: 0, carriage: 0, vat: 0, total: 0 });
  });
  it("zero-rate and exempt items stay separate in the VAT breakdown", () => {
    expect(documentTotals([{ quantity: 1, unitPrice: 10, vatPct: 0 }, { quantity: 1, unitPrice: 20, vatExempt: true }]))
      .toEqual({ subtotal: 30, carriage: 0, vat: 0, total: 30, vatBreakdown: [
        { rate: 0, exempt: false, net: 10, vat: 0 }, { rate: 0, exempt: true, net: 20, vat: 0 },
      ] });
  });
  it("zero-rate standard VAT also leaves carriage untaxed", () => {
    expect(documentTotals([{ quantity: 1, unitPrice: 10 }], 2.35, { standardRate: 0, carriageVat: true }))
      .toMatchObject({ subtotal: 10, carriage: 2.35, vat: 0, total: 12.35 });
  });
  it("turning VAT off removes line and carriage tax, including fixed line VAT", () => {
    expect(documentTotals([{ quantity: 1, unitPrice: 10, vatPct: 20, vatAmount: 2 }], 3, { vatEnabled: false, carriageVat: true }))
      .toEqual({ subtotal: 10, carriage: 3, vat: 0, total: 13, vatBreakdown: [] });
  });
});

describe("calendar month ends for outstanding invoices", () => {
  it.each([
    ["2026-01-31", "2026-03-01", 29], ["2024-01-31", "2024-03-01", 30],
    ["1900-02-28", "1900-03-01", 1], ["2000-02-28", "2000-03-01", 2],
    ["2026-04-30", "2026-05-01", 1], ["2026-12-31", "2027-01-01", 1],
    ["2026-03-31", "2026-03-31", 0], ["2026-04-01", "2026-03-31", -1],
    ["2026-03-28", "2026-04-01", 4], ["2026-10-24", "2026-11-01", 8],
  ] as const)("%s to %s is %s calendar days", (due, today, expected) => expect(daysPastDue(due, today)).toBe(expected));
});
