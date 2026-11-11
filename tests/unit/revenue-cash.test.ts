/**
 * BOUNDARY: Revenue stage 1, the cash basis (lib/reports/revenue/cash). Input: in-memory payment rows. Output: assertions. No database.
 * Must not change: the agreement with lib/numbers receivedByMonth; and cash is never an invoiced figure.
 */
import { describe, expect, it } from "vitest";

import { londonMonthsEnding, receivedByMonth } from "@/lib/numbers";
import { cashRevenue } from "@/lib/reports/revenue/cash";

const q1 = { from: "2026-01-01", to: "2026-03-31" };
const payments = [
  { amount: 300, paid_on: "2026-01-10" },
  { amount: "200.50", paid_on: "2026-02-03" },
  { amount: -50, paid_on: "2026-02-20" }, // a reversal, on its own date
  { amount: 999, paid_on: "2025-12-31" }, // before the range
  { amount: 999, paid_on: "2026-04-01" }, // after the range
];

describe("cash received", () => {
  it("is payments by paid_on with reversals on their own date, equal to lib/numbers receivedByMonth", () => {
    const result = cashRevenue(payments, q1);
    const expected = receivedByMonth(payments, londonMonthsEnding(new Date("2026-03-15T12:00:00Z"), 3));
    expect(result.months.map((m) => [m.key, m.received])).toEqual([...expected]);
    expect(result.months.map((m) => m.received)).toEqual([300, 150.5, 0]);
    expect(result.receivedTotal).toBe(450.5);
  });

  it("applies a range that cuts a month", () => {
    expect(cashRevenue(payments, { from: "2026-02-04", to: "2026-03-31" }).receivedTotal).toBe(-50);
  });

  it("adds pence exactly", () => {
    const result = cashRevenue(Array.from({ length: 3 }, () => ({ amount: 0.1, paid_on: "2026-01-05" })), q1);
    expect(result.receivedTotal).toBe(0.3);
  });

  it("has no invoiced field: the two bases are different types", () => {
    expect(Object.keys(cashRevenue(payments, q1)).sort()).toEqual(["months", "receivedTotal"]);
  });
});
