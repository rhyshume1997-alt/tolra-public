import { describe, expect, it } from "vitest";

import { documentTotals, fromPence, linePence, toPence } from "@/lib/money";
import { balanceDue, customerCredit, daysPastDue, owed } from "@/lib/receivables";

describe("penny boundaries and signed amounts", () => {
  it.each([
    [0, 0], [0.004999, 0], [0.005, 1], [0.005001, 1],
    [-0.004999, 0], [-0.005, -1], [-0.005001, -1],
    [1.005, 101], [-1.005, -101], [9999999.995, 1000000000],
  ])("rounds £%s to %s pence, half away from zero", (pounds, pence) => {
    expect(toPence(pounds)).toBe(pence);
    expect(fromPence(pence)).toBe(pence / 100);
  });

  it.each([
    [0.02, 7.25, 15], [-0.02, 7.25, -15], [0.02, -7.25, -15],
    [-0.02, -7.25, 15], [0, -7.25, 0], [3, 0, 0],
  ])("rounds quantity %s × £%s once to %s pence", (quantity, price, pence) => {
    expect(linePence(quantity, price)).toBe(pence);
  });

  it.each([
    [0.01, 0, 0.01], [0.03, 0.01, 0.04], [0.07, 0.01, 0.08],
    [0.13, 0.03, 0.16], [-0.03, -0.01, -0.04], [-0.13, -0.03, -0.16],
    [0, 0, 0],
  ])("charges 20 percent VAT on £%s: £%s VAT, £%s gross", (net, vat, total) => {
    expect(documentTotals([{ quantity: 1, unitPrice: net, vatPct: 20 }]))
      .toMatchObject({ subtotal: net, vat, total });
  });

  it("rounds odd-penny VAT per line, including carriage, rather than taxing the combined net", () => {
    expect(documentTotals([
      { quantity: 1, unitPrice: 0.03 }, { quantity: 1, unitPrice: 0.03 },
    ], 0.03, { carriageVat: true })).toEqual({
      subtotal: 0.06, carriage: 0.03, vat: 0.03, total: 0.12,
      vatBreakdown: [{ rate: 20, exempt: false, net: 0.09, vat: 0.03 }],
    });
  });
});

describe("receivable penny boundaries", () => {
  it("rounds each stored amount before subtracting receipts, credits and refunds", () => {
    expect(balanceDue(1.005, 0.335, 0.335, 0.005)).toBe(0.34);
    expect(owed({ status: "partial", total: 1.005, amount_paid: 0.335, credited_amount: 0.335, refunded_amount: 0.005 })).toBe(0.34);
  });

  it("keeps zero and negative balances out of money owed and retains the customer credit", () => {
    expect(balanceDue(0, 0)).toBe(0);
    expect(balanceDue(-0.03, 0)).toBe(0);
    expect(owed({ status: "issued", total: -0.03 })).toBe(0);
    expect(customerCredit({ status: "issued", total: -0.03 })).toBe(0.03);
    expect(balanceDue(0.03, -0.01)).toBe(0.04);
    expect(customerCredit({ status: "issued", total: 0.03, amount_paid: -0.01 })).toBe(0);
  });
});

describe("overdue calendar days", () => {
  it.each([
    ["2026-01-31", "2026-02-01", 1], ["2026-02-28", "2026-03-01", 1],
    ["2024-02-28", "2024-03-01", 2], ["2024-02-29", "2024-03-01", 1],
    ["2026-12-31", "2027-01-01", 1],
    ["2026-03-28", "2026-03-30", 2], ["2026-10-24", "2026-10-26", 2],
    ["2026-03-29", "2026-03-29", 0], ["2026-10-26", "2026-10-24", -2],
  ])("counts %s to %s as %s days despite month ends and UK clock changes", (due, today, days) => {
    expect(daysPastDue(due, today)).toBe(days);
  });

  it("compares date portions without changing the calendar date for time-zone offsets", () => {
    expect(daysPastDue("2026-03-29T23:30:00-02:00", "2026-03-30T00:30:00+02:00")).toBe(1);
    expect(daysPastDue(null, "2026-03-30")).toBeNull();
  });
});
