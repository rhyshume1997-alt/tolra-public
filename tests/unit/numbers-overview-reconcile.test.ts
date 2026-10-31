/**
 * The Numbers page and the Overview must agree: on the same invoices and credit notes, Numbers' invoiced ex VAT for each London month
 * (lib/numbers invoicedByMonth) is the Overview's (lib/overview-metrics invoicedByMonth) for the same month keys, and the twelve months
 * add up to the same total. The one difference by design (an invoice with no figures) is pinned at the end.
 */
import { describe, expect, it } from "vitest";

import { invoicedByMonth as overviewByMonth, type CreditMetricRow, type InvoiceMetricRow } from "@/lib/overview-metrics";
import { invoicedByMonth as numbersByMonth, londonMonthsEnding, sumOrNull } from "@/lib/numbers";

const periods = londonMonthsEnding(new Date("2026-10-31T12:00:00Z"), 12);
const keys = periods.map((p) => p.key);

const invoices: InvoiceMetricRow[] = [
  // Plain issued invoices, one a VAT invoice with carriage inside the total.
  { id: "a", customer: "Acme", status: "sent", invoice_date: "2026-01-15", subtotal: 1000, vat: 200, total: 1200 },
  { id: "b", customer: "Acme", status: "paid", invoice_date: "2026-01-31", subtotal: 500, carriage: 25, vat: 105, total: 630 },
  // No VAT at all.
  { id: "c", customer: "Brown", status: "overdue", invoice_date: "2026-03-02", subtotal: 800, vat: 0, total: 800 },
  // A draft and a void never count.
  { id: "d", customer: "Brown", status: "draft", invoice_date: "2026-03-10", subtotal: 9999, vat: 2000, total: 11999 },
  { id: "e", customer: "Cole", status: "void", invoice_date: "2026-03-11", subtotal: 777, vat: 155.4, total: 932.4 },
  // No invoice date: counted on the London day it was made. 23:30 UTC on 30 Sept is 00:30 on 1 Oct in London (summer time).
  { id: "f", customer: "Cole", status: "sent", invoice_date: null, created_at: "2026-09-30T23:30:00Z", subtotal: 300, vat: 60, total: 360 },
  // Lines only, no total: net is lines plus carriage.
  { id: "g", customer: "Dunn", status: "sent", invoice_date: "2026-05-20", subtotal: 400, carriage: 10 },
  // Outside the twelve months on both sides.
  { id: "h", customer: "Acme", status: "sent", invoice_date: "2025-08-31", subtotal: 100, vat: 20, total: 120 },
  { id: "i", customer: "Acme", status: "sent", invoice_date: "2026-11-01", subtotal: 100, vat: 20, total: 120 },
];

const credits: CreditMetricRow[] = [
  // Issued: comes off in its own month, not the month of the invoice it credits.
  { customer: "Acme", status: "issued", credit_date: "2026-02-10", vat: 40, total: 240 },
  // A draft credit is not a credit yet.
  { customer: "Brown", status: "draft", credit_date: "2026-03-20", vat: 20, total: 120 },
  // Outside the twelve months.
  { customer: "Acme", status: "issued", credit_date: "2025-07-01", vat: 20, total: 120 },
];

describe("Numbers and the Overview agree on invoiced ex VAT", () => {
  const overview = overviewByMonth(invoices, credits, keys);
  const numbers = numbersByMonth(invoices, credits, periods);

  it("the Overview has figures for every row here", () => {
    expect(overview).not.toBeNull();
  });

  it("every month is the same figure", () => {
    for (const key of keys) expect(numbers.get(key), key).toBe(overview!.get(key));
  });

  it("both cover the same twelve months", () => {
    expect([...numbers.keys()]).toEqual(keys);
    expect([...overview!.keys()]).toEqual(keys);
  });

  it("the twelve-month total is the same, and is the figure worked out by hand", () => {
    const numbersTotal = sumOrNull([...numbers.values()]);
    const overviewTotal = [...overview!.values()].reduce((sum, v) => sum + Math.round(v * 100), 0) / 100;
    expect(numbersTotal).toBe(overviewTotal);
    // 1000 + 500 + 25 + 800 + 300 + 410 = 3035, less the issued credit of 200 net; the draft, void, draft credit and out-of-range rows are off.
    expect(numbersTotal).toBe(2835);
  });

  it("the dated-by-created_at invoice lands in October (London), and the credit lowers February not January", () => {
    expect(numbers.get("2026-10")).toBe(300);
    expect(overview!.get("2026-10")).toBe(300);
    expect(numbers.get("2026-01")).toBe(1525);
    expect(numbers.get("2026-02")).toBe(-200);
  });
});

describe("The one difference by design: an invoice with no figures", () => {
  const withBlank: InvoiceMetricRow[] = [...invoices, { id: "j", customer: "Evans", status: "sent", invoice_date: "2026-06-05" }];

  it("the Overview shows nothing at all, Numbers blanks only that month, and every other month still agrees", () => {
    const overview = overviewByMonth(withBlank, credits, keys);
    const numbers = numbersByMonth(withBlank, credits, periods);
    expect(overview).toBeNull();
    expect(numbers.get("2026-06")).toBeNull();
    const clean = overviewByMonth(invoices, credits, keys)!;
    for (const key of keys.filter((k) => k !== "2026-06")) expect(numbers.get(key), key).toBe(clean.get(key));
    expect(sumOrNull([...numbers.values()])).toBeNull();
  });
});
