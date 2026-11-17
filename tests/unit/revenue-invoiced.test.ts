/**
 * BOUNDARY: Revenue stage 1, the invoiced basis (lib/reports/revenue/invoiced). Input: in-memory rows. Output: assertions. No database.
 * Must not change: the agreement with lib/numbers invoicedByMonth (the Numbers page), which is what keeps the two pages one set of rules.
 */
import { describe, expect, it } from "vitest";

import { invoicedByMonth, londonMonthsEnding, type NumberCredit, type NumberInvoice } from "@/lib/numbers";
import { dayAfter, invoicedRevenue, periodsForRange } from "@/lib/reports/revenue/invoiced";

const q1 = { from: "2026-01-01", to: "2026-03-31" };

const invoices: NumberInvoice[] = [
  { customer: "Acme", status: "sent", subtotal: 1000, vat: 200, total: 1200, invoice_date: "2026-01-10" },
  { customer: "Beta", status: "paid", subtotal: 400, vat: 80, total: 480, invoice_date: "2026-01-31" },
  { customer: "Acme", status: "overdue", subtotal: 250, vat: 50, total: 300, invoice_date: "2026-02-01" },
  { customer: "Acme", status: "sent", subtotal: 100, vat: 20, total: 120, invoice_date: null, created_at: "2026-03-31T23:30:00Z" }, // 00:30 on 1 Apr in London (summer time)
  { customer: "Draft Co", status: "draft", subtotal: 9000, vat: 1800, total: 10800, invoice_date: "2026-02-10" },
  { customer: "Void Co", status: "void", subtotal: 9000, vat: 1800, total: 10800, invoice_date: "2026-02-10" },
  { customer: "Cancelled Co", status: "cancelled", subtotal: 9000, vat: 1800, total: 10800, invoice_date: "2026-02-10" },
];
const credits: NumberCredit[] = [
  { customer: "Acme", status: "issued", vat: 20, total: 120, credit_date: "2026-02-15" },
  { customer: "Acme", status: "draft", vat: 200, total: 1200, credit_date: "2026-02-15" },
];

describe("invoiced revenue", () => {
  it("equals lib/numbers invoicedByMonth for the same rows, month by month and in total", () => {
    const periods = londonMonthsEnding(new Date("2026-03-15T12:00:00Z"), 3);
    const expected = invoicedByMonth(invoices, credits, periods);
    const result = invoicedRevenue(invoices, credits, q1);
    expect(result.months.map((m) => [m.key, m.invoiced])).toEqual([...expected]);
    expect(result.months.map((m) => m.key)).toEqual(["2026-01", "2026-02", "2026-03"]);
    // 1000 + 400 in January; 250 less the 100 credit in February; March has only the 00:30 1 April invoice, which is April in London.
    expect(result.months.map((m) => m.invoiced)).toEqual([1400, 150, 0]);
    expect(result.invoicedTotal).toBe(1550);
  });

  it("never counts draft, void or cancelled invoices, nor a draft credit note", () => {
    const only = invoicedRevenue(invoices.slice(4), credits, q1);
    expect(only.invoicedTotal).toBe(-100);
  });

  it("an invoice with no figures makes its month and the total null, never 0", () => {
    const result = invoicedRevenue([...invoices, { customer: "Acme", status: "sent", invoice_date: "2026-02-20" }], credits, q1);
    expect(result.months.map((m) => m.invoiced)).toEqual([1400, null, 0]);
    expect(result.invoicedTotal).toBeNull();
  });

  it("leaves out days before the start and after the end of the range, inside a month", () => {
    const result = invoicedRevenue(invoices, credits, { from: "2026-01-11", to: "2026-02-14" });
    expect(result.months.map((m) => m.invoiced)).toEqual([400, 250]); // the 10 Jan invoice and the 15 Feb credit are outside
  });

  it("filters by customer name, credit notes included, and treats a blank name as No customer", () => {
    expect(invoicedRevenue(invoices, credits, q1, "Acme").invoicedTotal).toBe(1000 + 250 - 100);
    expect(invoicedRevenue(invoices, credits, q1, "Beta").invoicedTotal).toBe(400);
    const blank = invoicedRevenue([{ customer: " ", status: "sent", subtotal: 10, vat: 2, total: 12, invoice_date: "2026-01-05" }], [], q1, "No customer");
    expect(blank.invoicedTotal).toBe(10);
  });

  it("works in integer pence: no penny drift", () => {
    const rows: NumberInvoice[] = Array.from({ length: 10 }, () => ({ customer: "A", status: "sent", subtotal: 0.1, vat: 0, total: 0.1, invoice_date: "2026-01-05" }));
    expect(invoicedRevenue(rows, [], q1).invoicedTotal).toBe(1);
  });

  it("builds London months from the dates, and the day after a date", () => {
    expect(periodsForRange({ from: "2025-11-20", to: "2026-02-02" }).map((p) => p.key)).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(dayAfter("2026-02-28")).toBe("2026-03-01");
    expect(dayAfter("2026-12-31")).toBe("2027-01-01");
  });
});
