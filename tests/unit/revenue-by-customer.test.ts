/**
 * BOUNDARY: Revenue stage 1, invoiced revenue by customer (lib/reports/revenue/by-customer). Input: in-memory rows. Output: assertions.
 * Must not change: shares add to exactly 100 within the basis; unknown figures are null, never 0.
 */
import { describe, expect, it } from "vitest";

import type { NumberCredit, NumberInvoice } from "@/lib/numbers";
import { invoicedByCustomer, sharesOf } from "@/lib/reports/revenue/by-customer";
import { invoicedRevenue } from "@/lib/reports/revenue/invoiced";

const range = { from: "2026-01-01", to: "2026-03-31" };
const inv = (customer: string | null, net: number, date = "2026-01-10", status = "sent"): NumberInvoice => ({ customer, status, subtotal: net, vat: net * 0.2, total: net * 1.2, invoice_date: date });
const credit = (customer: string, net: number, date = "2026-02-01"): NumberCredit => ({ customer, status: "issued", vat: net * 0.2, total: net * 1.2, credit_date: date });

describe("invoiced by customer", () => {
  it("groups by name, takes the customer's credit notes off, and ranks biggest first", () => {
    const result = invoicedByCustomer([inv("Acme", 600), inv("Beta", 400), inv("Acme", 100, "2026-03-02"), inv("Draft", 5000, "2026-01-10", "draft")], [credit("Acme", 100)], range);
    expect(result.rows.map((r) => [r.customer, r.invoicedNet])).toEqual([["Acme", 600], ["Beta", 400]]);
    expect(result.invoicedNetTotal).toBe(1000);
    expect(result.rows.map((r) => r.invoicedShare)).toEqual([60, 40]);
  });

  it("shares sum to exactly 100 (largest remainder), also for thirds", () => {
    const result = invoicedByCustomer([inv("A", 100), inv("B", 100), inv("C", 100)], [], range);
    const shares = result.rows.map((r) => r.invoicedShare as number);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
    expect([...shares].sort()).toEqual([33, 33, 34]);
    for (const pence of [[1, 1, 1, 1, 1, 1, 1], [5, 3, 2], [1, 99999], [333, 333, 334]]) expect(sharesOf(pence)!.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("matches the invoiced total of the invoiced card for the same rows", () => {
    const invoices = [inv("Acme", 600), inv("Beta", 400), inv(null, 50)];
    const credits = [credit("Acme", 100)];
    expect(invoicedByCustomer(invoices, credits, range).invoicedNetTotal).toBe(invoicedRevenue(invoices, credits, range).invoicedTotal);
  });

  it("filters to one customer, who then has 100%", () => {
    const result = invoicedByCustomer([inv("Acme", 600), inv("Beta", 400)], [], range, "Beta");
    expect(result.rows).toEqual([{ customer: "Beta", invoicedNet: 400, invoicedShare: 100 }]);
  });

  it("a customer with no figures is null and the shares are unavailable, never zero", () => {
    const result = invoicedByCustomer([inv("Acme", 600), { customer: "Mystery", status: "sent", invoice_date: "2026-01-12" }], [], range);
    expect(result.rows.find((r) => r.customer === "Mystery")).toEqual({ customer: "Mystery", invoicedNet: null, invoicedShare: null });
    expect(result.rows.every((r) => r.invoicedShare === null)).toBe(true);
    expect(result.invoicedNetTotal).toBeNull();
  });

  it("no shares when the total is not above zero", () => {
    const result = invoicedByCustomer([inv("Acme", 100)], [credit("Acme", 100)], range);
    expect(result.invoicedNetTotal).toBe(0);
    expect(result.rows[0].invoicedShare).toBeNull();
    expect(sharesOf([])).toBeNull();
  });
});
