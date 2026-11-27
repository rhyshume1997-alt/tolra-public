/**
 * Regression tests for CR-037 (Module 4 — Invoices):
 * Failed customer_credit RPC reads must surface an unavailable warning in InvoiceNotices rather than silently showing £0 credit held.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InvoiceNotices } from "@/components/invoices/invoices-redesign";
import { INVOICE_CREDIT_HELD_UNAVAILABLE, loadInvoiceCreditHeld } from "@/lib/invoice-credit";

describe("CR-037 (Invoices): loadInvoiceCreditHeld fails closed instead of silently resetting to £0", () => {
  it("sums held customer credits in integer pence when customer_credit succeeds", async () => {
    const result = await loadInvoiceCreditHeld({
      rpc: async () => ({
        data: [{ credit: 10.1 }, { credit: 20.2 }],
        error: null,
      }),
    });
    expect(result).toEqual({ status: "loaded", total: 30.3, customers: 2 });
  });

  it("returns loaded zero when customer_credit succeeds with no credits held", async () => {
    const result = await loadInvoiceCreditHeld({ rpc: async () => ({ data: [], error: null }) });
    expect(result).toEqual({ status: "loaded", total: 0, customers: 0 });
  });

  it("returns unavailable when customer_credit returns an RPC error", async () => {
    const result = await loadInvoiceCreditHeld({
      rpc: async () => ({ data: null, error: { code: "503", message: "service unavailable" } }),
    });
    expect(result).toEqual({ status: "unavailable" });
  });

  it("returns unavailable when customer_credit throws or returns non-array / invalid credit figures", async () => {
    expect(await loadInvoiceCreditHeld({ rpc: async () => { throw new Error("Failed to fetch"); } })).toEqual({ status: "unavailable" });
    expect(await loadInvoiceCreditHeld({ rpc: async () => ({ data: null, error: null }) })).toEqual({ status: "unavailable" });
    expect(await loadInvoiceCreditHeld({ rpc: async () => ({ data: [{ credit: "bad" }], error: null }) })).toEqual({ status: "unavailable" });
  });

  it("renders customer-credit-held-unavailable notice instead of hiding held credit when unavailable", () => {
    const unavailableHtml = renderToStaticMarkup(
      createElement(InvoiceNotices, {
        draftsWaiting: 0,
        oldDrafts: 0,
        creditHeld: { status: "unavailable" },
        onRetryCredit: () => undefined,
      }),
    );
    expect(unavailableHtml).toContain('data-testid="customer-credit-held-unavailable"');
    expect(unavailableHtml).toContain("Customer credit held");
    expect(unavailableHtml).not.toContain('data-testid="customer-credit-held"');

    const loadedHtml = renderToStaticMarkup(
      createElement(InvoiceNotices, {
        draftsWaiting: 0,
        oldDrafts: 0,
        creditHeld: { status: "loaded", total: 50, customers: 2 },
      }),
    );
    expect(loadedHtml).toContain('data-testid="customer-credit-held"');
    expect(loadedHtml).toContain("£50.00");
    expect(loadedHtml).not.toContain('data-testid="customer-credit-held-unavailable"');
    expect(INVOICE_CREDIT_HELD_UNAVAILABLE).toContain("£0 credit");
  });

  it("wires loadInvoiceCreditHeld into app/(dashboard)/invoices/page.tsx", () => {
    const page = readFileSync("app/(dashboard)/invoices/page.tsx", "utf8");
    expect(page).toContain("loadInvoiceCreditHeld(supabase)");
    expect(page).not.toContain('supabase.rpc("customer_credit")');
  });
});
