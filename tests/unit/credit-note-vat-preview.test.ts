// @vitest-environment jsdom
// Exercises the credit panel's VAT preview with issued and legacy invoice tax context.
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CreditNotesPanel } from "@/components/credit-notes-panel";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from(table: string) {
      const data = table === "invoice_line_items"
        ? [{ id: "line-1", description: "Part", quantity: 1, unit_price: 100, vat_pct: 20, vat_exempt: false }]
        : [];
      const query = {
        select: () => query,
        eq: () => query,
        in: () => query,
        order: () => query,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
      };
      return query;
    },
  },
}));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("credit-note preview VAT", () => {
  it.each([
    { label: "issued while unregistered", issuerSnapshot: { vatRegistered: false }, companyVatRegistered: true, vatEnabled: true, vat: "0.00", gross: "100.00" },
    { label: "issued while registered", issuerSnapshot: { vatRegistered: true }, companyVatRegistered: false, vatEnabled: true, vat: "20.00", gross: "120.00" },
    { label: "legacy invoice without a snapshot", issuerSnapshot: null, companyVatRegistered: false, vatEnabled: true, vat: "0.00", gross: "100.00" },
    { label: "invoice with VAT switched off", issuerSnapshot: { vatRegistered: true }, companyVatRegistered: true, vatEnabled: false, vat: "0.00", gross: "100.00" },
    { label: "legacy invoice before company settings load", issuerSnapshot: null, companyVatRegistered: undefined, vatEnabled: true, vat: null, gross: null },
    { label: "snapshot missing a registration field", issuerSnapshot: {}, companyVatRegistered: false, vatEnabled: true, vat: "20.00", gross: "120.00" },
  ])("matches the server VAT rule for an $label", async ({ issuerSnapshot, companyVatRegistered, vatEnabled, vat, gross }) => {
    await act(async () => root.render(createElement(CreditNotesPanel, {
      invoice: { id: "invoice-1", reference: "INV-1", customer: "Example Ltd", vatEnabled, rawStatus: "issued", issuerSnapshot },
      companyVatRegistered,
      onChanged: vi.fn(),
    })));
    const start = [...host.querySelectorAll("button")].find((button) => button.textContent === "New credit note");
    expect(start).toBeDefined();
    await act(async () => start!.click());
    expect(host.querySelector('[data-testid="credit-preview"]')?.textContent)
      .toBe(vat === null ? "VAT preview unavailable until company VAT settings can be read." : `Net £100.00 + VAT £${vat} = £${gross}`);
  });
});
