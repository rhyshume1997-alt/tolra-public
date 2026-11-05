import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

import { pyRound } from "@/lib/costing/engine";
import { PANEL_NOT_SET_UP_MESSAGE } from "@/lib/costing/app-rates";
import { actualJobProfit, NO_RECORD_REASON, NOT_INVOICED_REASON, roundHalfEven, type ActualCostInputs, type CostFigures } from "@/lib/job-profitability-actuals";

const costs = (over: Partial<CostFigures> = {}): CostFigures => ({ state: "complete", reasons: [], labour_us: 5_400_000_000, machine_us: 1_800_000_000,
  labour_pence: 3300, machine_pence: 2250, overhead_pence: 2775, supplier_pence: 1000, ...over });
const base = (over: Partial<ActualCostInputs> = {}): ActualCostInputs => ({ organizationId: "org", jobId: "job", configured: true, open: true, canConfigure: false,
  config: { enabled: true, revision: 1, approved_at: "2026-11-04T10:00:00Z" }, machineChoices: [], costingMachines: [], links: [],
  declarations: { labour_not_required: false, machines_not_required: false }, snapshot: null, live: costs(),
  invoices: [{ id: "i", status: "sent", subtotal: "200.00" }], credits: [{ invoice_id: "i", status: "issued", subtotal: "10.00" }], quoteLines: [{ quantity: 1, unit_price: 200 }], ...over });

it("the one rounding rule is lib/costing's half to even, on exact ratios", () => {
  for (const [n, d] of [[5, 2], [7, 2], [1, 2], [3, 2], [10, 4], [-5, 2], [1001 * 1800, 3600], [1001 * 1200, 3600]] as const) {
    expect(Number(roundHalfEven(BigInt(n), BigInt(d)))).toBe(pyRound(n / d, 0));
  }
  expect(() => roundHalfEven(BigInt(1), BigInt(0))).toThrow();
});

it("open job: costs at today's rates, labelled, with issued net revenue and margin; nothing is recomputed here", () => {
  const f = actualJobProfit(base());
  expect(f).toMatchObject({ state: "complete", basis: "todays_rates", invoicedPence: 19000, quotedPence: 20000, labourPence: 3300, machinePence: 2250,
    overheadPence: 2775, supplierPence: 1000, costPence: 9325, actualProfitPence: 9675, labourHours: "1.50", machineHours: "0.50" });
  expect(f.basisLabel).toMatch(/today's rates/);
  expect(f.marginPct).toBe(50.9); // 9675 / 19000 = 50.92..%
});

it("closed job: only its record, at the rates of that day; a closed job with no record is never costed at today's rates", () => {
  const snap = { ...costs({ labour_pence: 1111 }), taken_on: "finished" as const, taken_at: "2026-10-01T09:00:00Z", refreshed_at: null, rates_read_at: "2026-10-01T09:00:00Z" };
  const recorded = actualJobProfit(base({ open: false, snapshot: snap, live: costs({ labour_pence: 9999 }) }));
  expect(recorded).toMatchObject({ state: "complete", basis: "recorded", labourPence: 1111 });
  expect(recorded.basisLabel).toContain("2026-10-01");
  const none = actualJobProfit(base({ open: false, snapshot: null, live: null }));
  expect(none).toMatchObject({ state: "incomplete", basis: null, labourPence: null, costPence: null, actualProfitPence: null });
  expect(none.reasons).toContain(NO_RECORD_REASON);
});

it("incomplete costs show no figure at all (never a zero), with the database's reasons", () => {
  const f = actualJobProfit(base({ live: costs({ state: "incomplete", reasons: ['Machine "Mill 1" has no costing rate linked'], labour_pence: null, machine_pence: null, overhead_pence: null, supplier_pence: null }) }));
  expect(f).toMatchObject({ state: "incomplete", labourPence: null, machinePence: null, overheadPence: null, supplierPence: null, costPence: null, actualProfitPence: null, marginPct: null, labourHours: null });
  expect(f.reasons).toEqual(['Machine "Mill 1" has no costing rate linked']);
  // A "complete" answer missing a figure is still treated as incomplete.
  expect(actualJobProfit(base({ live: costs({ overhead_pence: null }) }))).toMatchObject({ state: "incomplete", costPence: null, labourPence: null });
  // Costs complete but nothing invoiced: costs are shown, profit is not.
  const uninvoiced = actualJobProfit(base({ invoices: [{ id: "i", status: "draft", subtotal: "200.00" }] }));
  expect(uninvoiced).toMatchObject({ state: "incomplete", costPence: 9325, actualProfitPence: null });
  expect(uninvoiced.reasons).toEqual([NOT_INVOICED_REASON]);
});

it("not configured in 143: 143's own message and no figure; switched off: off and no figure", () => {
  expect(actualJobProfit(base({ configured: false }))).toMatchObject({ state: "not_configured", reasons: [PANEL_NOT_SET_UP_MESSAGE], costPence: null, actualProfitPence: null });
  expect(actualJobProfit(base({ config: { enabled: false, revision: 2, approved_at: null } }))).toMatchObject({ state: "off", costPence: null, labourPence: null });
});

it("reads no rate itself and has no rate editor (143 is the only source)", () => {
  const lib = readFileSync("lib/job-profitability-actuals.ts", "utf8"), ui = readFileSync("components/job-profitability-actuals.tsx", "utf8");
  for (const src of [lib, ui]) expect(src).not.toMatch(/save_job_costing_rates|job_machine_cost_rates|labour_rate_pence|overhead_rate_pence|hourly_rate_pence|from\(["']costing_/);
  expect(readFileSync("components/bought-in-profit.tsx", "utf8")).not.toMatch(/costing_defaults|costing_machines|job_profitability_actual_inputs/);
});
