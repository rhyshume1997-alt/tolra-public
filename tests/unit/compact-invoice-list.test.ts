import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CompactInvoiceList, type CompactInvoice } from "@/components/invoices/compact-invoice-list";
import { compactListKey, readCompactList, writeCompactList } from "@/lib/compact-list-pref";
import { compactInvoiceTotals, netAndVat } from "@/lib/invoice-list-totals";
import { viewModeKey } from "@/lib/view-mode";

const row = (over: Partial<CompactInvoice>): CompactInvoice => ({
  id: "i", reference: "INV-1", customer: "Acme", date: "2026-10-01", dueDate: "2026-10-31", rawStatus: "issued", status: "outstanding", daysOverdue: -5, partPaid: false,
  amount: 120, subtotal: 100, vatAmount: 20, amountPaid: 0, balance: 120, ...over,
});

const open = row({ id: "a", reference: "INV-0001", customer: "Acme Ltd", amount: 120, subtotal: 100, vatAmount: 20, amountPaid: 0, balance: 120 });
const part = row({ id: "b", reference: "INV-0002", customer: "Brown & Sons", amount: 600, subtotal: 500, vatAmount: 100, amountPaid: 250, balance: 350, partPaid: true });
const voided = row({ id: "c", reference: "INV-0003", customer: "Cole", amount: 240, subtotal: 200, vatAmount: 40, amountPaid: 0, balance: 0, rawStatus: "void", status: "closed", daysOverdue: 0 });

describe("compact invoice totals", () => {
  it("sums net, VAT, gross, paid and outstanding across the rows given", () => {
    expect(compactInvoiceTotals([open, part])).toEqual({ count: 2, net: 600, vat: 120, gross: 720, paid: 250, outstanding: 470 });
  });

  it("counts a part payment as paid and leaves only the balance outstanding", () => {
    const t = compactInvoiceTotals([part]);
    expect(t.paid).toBe(250);
    expect(t.outstanding).toBe(350);
  });

  it("a void or cancelled invoice adds nothing to any figure, but is still counted as a row shown", () => {
    expect(compactInvoiceTotals([open, voided])).toEqual({ count: 2, net: 100, vat: 20, gross: 120, paid: 0, outstanding: 120 });
    expect(compactInvoiceTotals([voided])).toEqual({ count: 1, net: 0, vat: 0, gross: 0, paid: 0, outstanding: 0 });
    const cancelled = row({ rawStatus: "cancelled", status: "closed", amount: 90, subtotal: 75, vatAmount: 15, amountPaid: 90, balance: 0 });
    expect(compactInvoiceTotals([open, cancelled])).toEqual({ count: 2, net: 100, vat: 20, gross: 120, paid: 0, outstanding: 120 });
  });

  it("adds in whole pence (no floating point drift)", () => {
    const tenth = Array.from({ length: 10 }, () => row({ amount: 0.1, subtotal: 0.1, vatAmount: 0, amountPaid: 0.1, balance: 0 }));
    const t = compactInvoiceTotals(tenth);
    expect(t.gross).toBe(1);
    expect(t.paid).toBe(1);
  });

  it("falls back to total less VAT, then to all net, when no subtotal is stored", () => {
    expect(netAndVat({ amount: 120, vatAmount: 20 })).toEqual({ net: 100, vat: 20 });
    expect(netAndVat({ amount: 120 })).toEqual({ net: 120, vat: 0 });
  });

  it("is empty-safe", () => {
    expect(compactInvoiceTotals([])).toEqual({ count: 0, net: 0, vat: 0, gross: 0, paid: 0, outstanding: 0 });
  });
});

describe("compact list preference", () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is keyed per person and page, on the view-mode key", () => {
    expect(compactListKey("u1", "invoices")).toBe(viewModeKey("u1", "invoices-compact"));
    expect(compactListKey("u1", "invoices")).not.toBe(compactListKey("u2", "invoices"));
    expect(compactListKey("u1", "invoices")).not.toBe(viewModeKey("u1", "invoices"));
  });

  it("is off until chosen, then remembered, and one person's choice is not another's", () => {
    const k1 = compactListKey("u1", "invoices");
    const k2 = compactListKey("u2", "invoices");
    expect(readCompactList(k1)).toBe(false);
    writeCompactList(k1, true);
    expect(readCompactList(k1)).toBe(true);
    expect(readCompactList(k2)).toBe(false);
    writeCompactList(k1, false);
    expect(readCompactList(k1)).toBe(false);
  });

  it("copes with storage that throws", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } });
    expect(readCompactList("k")).toBe(false);
    expect(() => writeCompactList("k", true)).not.toThrow();
  });
});

describe("CompactInvoiceList render", () => {
  const html = renderToStaticMarkup(createElement(CompactInvoiceList, { rows: [open, part, voided], onOpen: () => {} }));

  it("shows a row per invoice with its figures and dates", () => {
    expect(html.match(/data-testid="compact-invoice-row"/g)).toHaveLength(3);
    for (const text of ["INV-0001", "Acme Ltd", "INV-0002", "Brown &amp; Sons", "INV-0003", "£500.00", "£100.00", "£600.00", "£240.00", "£250.00", "£350.00", "01/10/2026", "31/10/2026", "PART PAID", "VOID"]) expect(html).toContain(text);
  });

  it("has the ten columns", () => {
    for (const head of ["Invoice", "Date", "Customer", "Net", "VAT", "Gross", "Paid", "Outstanding", "Status", "Due"]) expect(html).toContain(`>${head}</th>`);
  });

  it("puts the totals of the rows shown at the foot", () => {
    const foot = html.slice(html.indexOf("<tfoot"));
    expect(foot).toContain("Totals (3 invoices)");
    expect(foot).toContain('data-total="net">£600.00<');
    expect(foot).toContain('data-total="vat">£120.00<');
    expect(foot).toContain('data-total="gross">£720.00<');
    expect(foot).toContain('data-total="paid">£250.00<');
    expect(foot).toContain('data-total="outstanding">£470.00<');
  });

  it("scrolls sideways inside its own box so the page does not", () => {
    expect(html).toMatch(/data-testid="compact-invoice-list" class="[^"]*overflow-x-auto/);
    expect(html).toMatch(/<table class="[^"]*min-w-\[/);
  });
});

describe("Invoices page wiring", () => {
  const page = readFileSync(path.resolve(__dirname, "../../app/(dashboard)/invoices/page.tsx"), "utf8");
  it("renders the compact list from the same filtered rows, opening the same invoice dialog", () => {
    expect(page).toContain("<CompactInvoiceList rows={visibleInvoices} onOpen={setViewingInvoice} />");
    expect(page).toContain("useCompactList(\"invoices\")");
    expect(page).toContain("Compact list");
  });
});
