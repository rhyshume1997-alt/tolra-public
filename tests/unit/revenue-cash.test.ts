/**
 * BOUNDARY: Revenue stage 1, the cash basis (lib/reports/revenue/cash). Input: in-memory payment rows. Output: assertions. No database.
 * Must not change: the agreement with lib/numbers receivedByMonth; and cash is never an invoiced figure.
 */
import { describe, expect, it } from "vitest";

import { londonMonthsEnding, receivedByMonth } from "@/lib/numbers";
import { CUSTOMER_NOT_KNOWN, cashByCustomer, cashRevenue, paymentCustomer } from "@/lib/reports/revenue/cash";

const q1 = { from: "2026-01-01", to: "2026-03-31" };
const invs = [{ id: "i1", customer: "Acme" }, { id: "i2", customer: "Beta" }];
const payments = [
  { amount: 300, paid_on: "2026-01-10", invoice_id: "i1" },
  { amount: "200.50", paid_on: "2026-02-03", invoice_id: "i2" },
  { amount: -50, paid_on: "2026-02-20", invoice_id: "i1" }, // a reversal, on its own date
  { amount: 999, paid_on: "2025-12-31", invoice_id: "i1" }, // before the range
  { amount: 999, paid_on: "2026-04-01", invoice_id: "i1" }, // after the range
];

describe("cash received", () => {
  it("is payments by paid_on with reversals on their own date, equal to lib/numbers receivedByMonth", () => {
    const result = cashRevenue(payments, invs, q1);
    const expected = receivedByMonth(payments, londonMonthsEnding(new Date("2026-03-15T12:00:00Z"), 3));
    expect(result.months.map((m) => [m.key, m.received])).toEqual([...expected]);
    expect(result.months.map((m) => m.received)).toEqual([300, 150.5, 0]);
    expect(result.receivedTotal).toBe(450.5);
  });

  it("applies a range that cuts a month", () => {
    expect(cashRevenue(payments, invs, { from: "2026-02-04", to: "2026-03-31" }).receivedTotal).toBe(-50);
  });

  it("adds pence exactly", () => {
    const result = cashRevenue(Array.from({ length: 3 }, () => ({ amount: 0.1, paid_on: "2026-01-05", invoice_id: "i1" })), invs, q1);
    expect(result.receivedTotal).toBe(0.3);
  });

  it("has no invoiced field: the two bases are different types", () => {
    expect(Object.keys(cashRevenue(payments, invs, q1)).sort()).toEqual(["months", "receivedTotal"]);
  });

  it("the customer filter applies to cash: only payments on that customer's invoices, in the months and the customer table", () => {
    expect(cashRevenue(payments, invs, q1, "Acme").receivedTotal).toBe(250); // 300 less the 50 reversal; Beta's 200.50 is excluded
    expect(cashRevenue(payments, invs, q1, "Beta").receivedTotal).toBe(200.5);
    expect(cashByCustomer(payments, invs, q1, "Beta").cashRows).toEqual([{ cashCustomer: "Beta", cashReceived: 200.5, cashShare: 100 }]);
  });

  it("a payment on another customer's invoice is not in this customer's cash", () => {
    const other = [{ amount: 500, paid_on: "2026-01-10", invoice_id: "i2" }];
    expect(cashRevenue(other, invs, q1, "Acme").receivedTotal).toBe(0);
    expect(cashByCustomer(other, invs, q1, "Acme").cashRows).toEqual([]);
  });

  it("a payment whose invoice can't be read is Customer not known, never dropped", () => {
    const unread = [{ amount: 70, paid_on: "2026-01-10", invoice_id: "gone" }, { amount: 30, paid_on: "2026-01-11", invoice_id: null }, { amount: 100, paid_on: "2026-01-12", invoice_id: "i1" }];
    expect(paymentCustomer(unread[0], invs)).toBe(CUSTOMER_NOT_KNOWN);
    const result = cashByCustomer(unread, invs, q1);
    expect(result.cashRows.map((r) => [r.cashCustomer, r.cashReceived])).toEqual([["Acme", 100], [CUSTOMER_NOT_KNOWN, 100]]);
    expect(result.cashCustomerTotal).toBe(cashRevenue(unread, invs, q1).receivedTotal); // nothing lost between the two tables
    expect(cashRevenue(unread, invs, q1, CUSTOMER_NOT_KNOWN).receivedTotal).toBe(100);
  });

  it("cash shares add to exactly 100, and the customer table equals the month table", () => {
    const thirds = ["a", "b", "c"].map((id) => ({ amount: 100, paid_on: "2026-01-05", invoice_id: id }));
    const result = cashByCustomer(thirds, ["a", "b", "c"].map((id) => ({ id, customer: id })), q1);
    expect(result.cashRows.reduce((sum, r) => sum + (r.cashShare ?? 0), 0)).toBe(100);
    expect(cashByCustomer(payments, invs, q1).cashCustomerTotal).toBe(cashRevenue(payments, invs, q1).receivedTotal);
  });
});
