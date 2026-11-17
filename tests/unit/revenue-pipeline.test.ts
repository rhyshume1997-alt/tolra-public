/**
 * BOUNDARY: Revenue stage 1, the pipeline (lib/reports/revenue/pipeline): open quotes, value ex VAT, by month sent. Input: in-memory
 * rows. Output: assertions, including a compile-time check (run by `tsc --noEmit`) that the pipeline result shares no field name with
 * any revenue result. Must not change: pipeline is never revenue.
 */
import { describe, expect, expectTypeOf, it } from "vitest";

import type { CustomerResult, CustomerRow } from "@/lib/reports/revenue/by-customer";
import type { PartResult, PartRow } from "@/lib/reports/revenue/by-part";
import type { CashMonth, CashResult } from "@/lib/reports/revenue/cash";
import type { InvoicedMonth, InvoicedResult } from "@/lib/reports/revenue/invoiced";
import { pipelineQuotes, type PipelineMonth, type PipelineResult } from "@/lib/reports/revenue/pipeline";

const range = { from: "2026-01-01", to: "2026-03-31" };
const today = "2026-03-20";
const quote = (id: string, over: Record<string, unknown> = {}) => ({ id, customer: "Acme", status: "sent", valid_until: "2026-04-30", sent_at: "2026-02-10T10:00:00Z", ...over });
const lines = [
  { quote_id: "q1", quantity: 2, unit_price: 50 },
  { quote_id: "q1", quantity: 1, unit_price: 25.5 },
  { quote_id: "q2", quantity: 1, unit_price: 1000 },
  { quote_id: "q3", quantity: 1, unit_price: 70 },
  { quote_id: "q3", quantity: 1, unit_price: 30, declined: true },
  { quote_id: "q4", quantity: 1, unit_price: 40 },
  { quote_id: "q5", quantity: 1, unit_price: 50 },
];

describe("pipeline (not revenue)", () => {
  it("counts a sent, unexpired quote by the month sent, value ex VAT from its lines in pence", () => {
    const result = pipelineQuotes([quote("q1"), quote("q2", { sent_at: "2026-03-02T09:00:00Z" })], lines, today, range);
    expect(result.pipelineMonths.map((m) => [m.sentMonth, m.quoteCount, m.quotedValue])).toEqual([["2026-01", 0, 0], ["2026-02", 1, 125.5], ["2026-03", 1, 1000]]);
    expect(result.quotedTotal).toBe(1125.5);
    expect(result.openQuotes).toBe(2);
  });

  it("leaves out draft, accepted, rejected and superseded quotes, and an expired one (valid on its last day)", () => {
    const quotes = [
      quote("q1", { status: "draft" }), quote("q1", { status: "accepted" }), quote("q1", { status: "rejected" }), quote("q1", { status: "superseded" }),
      quote("q2", { valid_until: "2026-03-19" }), // expired yesterday
      quote("q3", { valid_until: "2026-03-20" }), // valid today, its last day
      quote("q4", { valid_until: null }),
    ];
    const result = pipelineQuotes(quotes, lines, today, range);
    expect(result.openQuotes).toBe(2);
    expect(result.quotedTotal).toBe(70 + 40);
  });

  it("a quote with no lines is counted apart, not valued; one with no sent date is counted apart", () => {
    const result = pipelineQuotes([quote("q-none"), quote("q5", { sent_at: null })], lines, today, range);
    expect(result.quotesWithoutLines).toBe(1);
    expect(result.undatedQuotes).toBe(1);
    expect(result.quotedTotal).toBe(0);
  });

  it("applies the range (sent day) and the customer", () => {
    const quotes = [quote("q1"), quote("q2", { customer: "Beta", sent_at: "2026-03-30T10:00:00Z" }), quote("q4", { sent_at: "2025-12-31T10:00:00Z" })];
    expect(pipelineQuotes(quotes, lines, today, range).openQuotes).toBe(2);
    expect(pipelineQuotes(quotes, lines, today, range, "Beta").quotedTotal).toBe(1000);
    expect(pipelineQuotes(quotes, lines, today, { from: "2026-03-01", to: "2026-03-31" }).openQuotes).toBe(1);
  });

  it("shares no field name with any revenue type (compile time: tsc fails if one is added)", () => {
    type RevenueKeys = keyof InvoicedResult | keyof InvoicedMonth | keyof CashResult | keyof CashMonth | keyof CustomerResult | keyof CustomerRow | keyof PartResult | keyof PartRow;
    type PipelineKeys = keyof PipelineResult | keyof PipelineMonth;
    expectTypeOf<Extract<PipelineKeys, RevenueKeys>>().toEqualTypeOf<never>();
    expectTypeOf<Extract<RevenueKeys, PipelineKeys>>().toEqualTypeOf<never>();
    // And a revenue result is not assignable where a pipeline one is expected, and the reverse.
    expectTypeOf<InvoicedResult>().not.toMatchTypeOf<PipelineResult>();
    expectTypeOf<PipelineResult>().not.toMatchTypeOf<InvoicedResult>();
    expect(Object.keys(pipelineQuotes([], [], today, range)).sort()).toEqual(["openQuotes", "pipelineMonths", "quotedTotal", "quotesWithoutLines", "undatedQuotes"]);
  });
});
