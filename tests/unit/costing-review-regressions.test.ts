import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PriceThisPart, safePartEstimate, previewLineTotal } from "@/components/costing/price-this-part";
import type { CostingRates } from "@/components/costing/types";
const input = { quantity: 3, stock_weight_lb: 1, cost_per_lb: 0.29, scrap_factor: 0, margin_pct: 0.2, ops: [] };
describe("costing review regressions", () => {
  it("keeps the preview total equal to the unit price copied into the quote", () => {
    const result = safePartEstimate(input)!;
    expect(result.summary.unit_price).toBe(0.35);
    expect(result.summary.extended_price).toBe(1.04);
    expect(previewLineTotal(3, result.summary.unit_price)).toBe(1.05);
  });
  it.each([0, 1.5, 1000001, Infinity, NaN])("does not throw while rendering rejected quantity %s", (quantity) => {
    expect(safePartEstimate({ ...input, quantity })).toBeNull();
  });
  it("shows a useful message rather than crashing the page on invalid saved rates", () => {
    const rates: CostingRates = { materials: [{ id: "m", name: "Steel", unit: "each", price: Infinity, scrapPct: 0 }], machines: [{ id: "mill", name: "Mill", hourlyRate: 0 }], labourPerHour: 0, programmingPerHour: 0, overheadPct: 0, marginPct: 20 };
    const html = renderToStaticMarkup(createElement(PriceThisPart, { rates, onAdd: () => {} }));
    expect(html).toContain('role="alert"'); expect(html).toContain("Check the quantity");
    expect(html).toContain('disabled=""'); expect(html).not.toContain("£Infinity");
  });
});
