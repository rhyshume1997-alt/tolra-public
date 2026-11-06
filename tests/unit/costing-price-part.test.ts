/**
 * Price this part (lib/costing/price-part.ts) and the company's rates (lib/costing/app-rates.ts), without a browser:
 *   - the worked example used by the browser spec, by hand and through the engine;
 *   - blank / partly set up rates give NO figures and say what is missing;
 *   - the engine takes every rate from the company's settings (nothing built in);
 *   - past records do not change: a calculation is copied into a quote line as plain values, and editing the rates later leaves the saved line as it was.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { blankCostingRates, type CostingRates } from "../../components/costing/types";
import { CONFIGURED, ENTRY } from "./costing-fixtures";
import { calcDetailedQuote } from "../../lib/costing/engine";
import { ratesGaps, ratesProblem, toRpcValue } from "../../lib/costing/app-rates";
import { appliedLine, costNote, priceThisPart } from "../../lib/costing/price-part";

describe("worked example (also the browser spec's figures)", () => {
  it("by hand: material 2.10, machine 19.50, labour 7.50, programming 8.00, overhead 13.50, cost 50.60, price 60.72, total 607.20", () => {
    const r = priceThisPart(CONFIGURED, ENTRY);
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.figures).toEqual({ materialCost: 2.1, machineCost: 19.5, labourCost: 7.5, programmingCost: 8, overheadCost: 13.5, unitCost: 50.6, unitPrice: 60.72, extendedPrice: 607.2, engineExtendedPrice: 607.2, marginPct: 20, quantity: 10 });
  });
  it("is exactly the engine's (golden-checked) answer for the same inputs", () => {
    const direct = calcDetailedQuote({ quantity: 10, stock_weight_lb: 0.5, cost_per_lb: 4, scrap_factor: 0.05, margin_pct: 0.2, programming_time_hr: 2,
      programming_rate_per_hr: 40, overhead_rate_pct: 1.5, ops: [{ name: "Mill", sequence: 1, setup_time_hr: 1, cycle_time_hr: 0.2, allowance_pct: 0, machine_rate_per_hr: 65, labor_rate_per_hr: 25 }] });
    expect(direct.summary).toMatchObject({ unit_cost: 50.6, unit_price: 60.72, extended_price: 607.2 });
  });
  it("a machine's own labour rate replaces the company one for that machine", () => {
    const own: CostingRates = { ...CONFIGURED, machines: [{ ...CONFIGURED.machines[0], labourPerHour: 35 }] };
    const r = priceThisPart(own, ENTRY);
    expect(r.status === "ok" && r.figures.labourCost).toBe(10.5);
  });
  it("a material priced each uses pieces per part", () => {
    const each: CostingRates = { ...CONFIGURED, materials: [{ ...CONFIGURED.materials[0], unit: "each", price: 3, scrapPct: 0 }] };
    const r = priceThisPart(each, { ...ENTRY, amountPerPart: 2 });
    expect(r.status === "ok" && r.figures.materialCost).toBe(6);
  });
  it("the margin and overhead come from the company's rates: change them and the price changes", () => {
    const r = priceThisPart({ ...CONFIGURED, defaults: { ...CONFIGURED.defaults, marginPct: 30, overheadPct: 100 } }, ENTRY);
    // cost 37.10, price 37.10 x 1.3 = 48.23
    expect(r.status === "ok" && r.figures.unitPrice).toBe(48.23);
  });
});

describe("blank and partly configured rates show no figures", () => {
  it("blank: not set up, nothing entered, no figures", () => {
    const r = priceThisPart(blankCostingRates, ENTRY);
    expect(r).toMatchObject({ status: "not_set_up", blank: true });
    expect(JSON.stringify(r)).not.toMatch(/Cost|Price|unit/);
    expect(ratesGaps(blankCostingRates).blank).toBe(true);
  });
  it.each([
    ["no machine", { ...CONFIGURED, machines: [] }, ["a machine"]],
    ["no material", { ...CONFIGURED, materials: [] }, ["a material"]],
    ["no company rates row", { ...CONFIGURED, defaults: blankCostingRates.defaults }, ["the labour rate", "the programming rate", "the overhead %", "the margin %"]],
    ["no margin", { ...CONFIGURED, defaults: { ...CONFIGURED.defaults, marginPct: null } }, ["the margin %"]],
    ["no programming rate", { ...CONFIGURED, defaults: { ...CONFIGURED.defaults, programmingPerHour: null } }, ["the programming rate"]],
    ["a material with no price", { ...CONFIGURED, materials: [{ ...CONFIGURED.materials[0], price: null }] }, ["the price and scrap of material Steel bar"]],
    ["a machine with no hourly rate", { ...CONFIGURED, machines: [{ ...CONFIGURED.machines[0], hourlyRate: null }] }, ["the hourly rate of machine Mill"]],
  ] as const)("%s: says what is missing, no figures", (_name, rates, missing) => {
    const r = priceThisPart(rates as CostingRates, ENTRY);
    expect(r.status).toBe("not_set_up");
    if (r.status !== "not_set_up") return;
    expect(r.blank).toBe(false);
    expect(r.missing).toEqual(missing);
  });
  it("a zero rate that was ENTERED is a rate (0 is not 'missing')", () => {
    const zero: CostingRates = { ...CONFIGURED, defaults: { labourPerHour: 0, programmingPerHour: 0, overheadPct: 100, marginPct: 0 } };
    expect(ratesGaps(zero).missing).toEqual([]);
    const r = priceThisPart(zero, ENTRY);
    expect(r.status === "ok" && r.figures.unitPrice).toBe(r.status === "ok" ? r.figures.unitCost : -1);
  });
  it("configured but the part isn't described yet: asks for the missing entries, no figures", () => {
    const r = priceThisPart(CONFIGURED, { ...ENTRY, amountPerPart: null, cycleHours: null });
    expect(r).toEqual({ status: "need_input", needs: ["the material weight per part", "the cycle time per part"] });
    expect(priceThisPart(CONFIGURED, { ...ENTRY, quantity: 0 }).status).toBe("need_input");
    expect(priceThisPart(CONFIGURED, { ...ENTRY, quantity: 1.5 }).status).toBe("need_input");
  });
});

describe("saving rates: what is sent", () => {
  it("converts pounds to whole pence and keeps stored percentages", () => {
    expect(ratesProblem(CONFIGURED)).toBeNull();
    expect(toRpcValue(CONFIGURED)).toEqual({
      materials: [{ id: CONFIGURED.materials[0].id, name: "Steel bar", price_pence: 400, price_unit: "kg", scrap_pct: 5 }],
      machines: [{ id: CONFIGURED.machines[0].id, name: "Mill", hourly_rate_pence: 6500, labour_rate_pence: null }],
      defaults: { labour_rate_pence: 2500, programming_rate_pence: 4000, overhead_pct: 150, default_margin_pct: 20 },
    });
  });
  it("pence rounding is exact (19.99 -> 1999, 1.15 -> 115)", () => {
    const r = { ...CONFIGURED, materials: [{ ...CONFIGURED.materials[0], price: 19.99 }], machines: [{ ...CONFIGURED.machines[0], hourlyRate: 1.15 }] };
    const v = toRpcValue(r);
    expect([v.materials[0].price_pence, v.machines[0].hourly_rate_pence]).toEqual([1999, 115]);
  });
  it.each([
    ["blank company rates", blankCostingRates, /labour rate/],
    ["overhead below 100", { ...CONFIGURED, defaults: { ...CONFIGURED.defaults, overheadPct: 15 } }, /overhead/],
    ["margin above 95", { ...CONFIGURED, defaults: { ...CONFIGURED.defaults, marginPct: 96 } }, /margin/],
    ["a price in fractions of a penny", { ...CONFIGURED, materials: [{ ...CONFIGURED.materials[0], price: 2.675 }] }, /pounds and pence/],
    ["a material with no name", { ...CONFIGURED, materials: [{ ...CONFIGURED.materials[0], name: "  " }] }, /name/],
    ["scrap left blank", { ...CONFIGURED, materials: [{ ...CONFIGURED.materials[0], scrapPct: null }] }, /scrap/],
    ["two materials with one name", { ...CONFIGURED, materials: [CONFIGURED.materials[0], { ...CONFIGURED.materials[0], id: "33333333-3333-4333-8333-333333333333" }] }, /same name/],
  ] as const)("refuses %s before anything is sent", (_n, rates, message) => {
    expect(ratesProblem(rates as CostingRates)).toMatch(message);
  });
});

describe("past records do not change", () => {
  /** A stand-in for quote_line_items: rows are written once, as plain values. */
  const table: Record<string, Record<string, unknown>> = {};
  const saveQuoteLine = (id: string, line: ReturnType<typeof appliedLine>) => {
    // What the quote page sends per line (app/(dashboard)/quotes/page.tsx saveQuote): description, quantity, unit_price, source (+VAT, part fields).
    table[id] = { description: line.description, quantity: line.qty, unit_price: line.unit, source: line.source };
  };
  it("apply, change the rates, reload the saved line: unchanged", () => {
    const before = priceThisPart(CONFIGURED, ENTRY);
    expect(before.status).toBe("ok");
    if (before.status !== "ok") return;
    const line = appliedLine("Bush 40mm", before.figures);
    saveQuoteLine("line-1", line);
    const stored = structuredClone(table["line-1"]);
    expect(stored).toEqual({ description: "Bush 40mm", quantity: 10, unit_price: 60.72, source: "costing_calculator" });

    // Later the rates are edited (dearer steel, dearer machine, higher margin) and the same part prices differently...
    const changed: CostingRates = { materials: [{ ...CONFIGURED.materials[0], price: 9 }], machines: [{ ...CONFIGURED.machines[0], hourlyRate: 80 }], defaults: { ...CONFIGURED.defaults, marginPct: 35 } };
    const after = priceThisPart(changed, ENTRY);
    expect(after.status === "ok" && after.figures.unitPrice).not.toBe(60.72);
    // ...the line already saved, and the object that was handed to the quote, are exactly as they were.
    expect(table["line-1"]).toEqual(stored);
    expect(line).toEqual({ description: "Bush 40mm", qty: 10, unit: 60.72, source: "costing_calculator" });
  });
  it("the applied line is only strings and numbers: nothing points back at the rates", () => {
    const r = priceThisPart(CONFIGURED, ENTRY);
    if (r.status !== "ok") throw new Error("expected figures");
    const line = appliedLine("  Bush  ", r.figures);
    expect(Object.values(line).every((v) => typeof v === "string" || typeof v === "number")).toBe(true);
    expect(Object.keys(line).sort()).toEqual(["description", "qty", "source", "unit"]);
    expect(line.description).toBe("Bush");
  });
  it("the cost note is plain text written once", () => {
    const r = priceThisPart(CONFIGURED, ENTRY);
    if (r.status !== "ok") throw new Error("expected figures");
    expect(costNote("Bush", r.figures, "2026-11-05")).toBe("Costing 2026-11-05: Bush x10. Material £2.10, machine £19.50, labour £7.50, programming £8.00, overhead £13.50. Cost per part £50.60, price per part £60.72 (margin 20%).");
  });
});

describe("no built-in rates in the costing code", () => {
  const root = path.resolve(__dirname, "../..");
  const files = ["lib/costing/engine.ts", "lib/costing/price-part.ts", "lib/costing/app-rates.ts", "components/costing/types.ts", "components/costing/costing-rates-editor.tsx",
    "components/costing/costing-rates-card.tsx", "components/costing/price-this-part.tsx"];
  const code = (file: string) => readFileSync(path.join(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  it.each(files)("%s has no fallback number for a rate", (file) => {
    const source = code(file);
    expect(source).not.toMatch(/\?\?\s*[1-9]\d*(\.\d+)?/); // `?? 75`, `?? 0.15`, `?? 1.5` ...
    expect(source).not.toMatch(/\?\?\s*0\.\d*[1-9]/);
    expect(source).not.toMatch(/(scrapPct|marginPct|overheadPct|labourPerHour|programmingPerHour|hourlyRate|price)\s*:\s*[1-9]\d*/); // a rate given a starting value
    expect(source).not.toMatch(/BUILT_IN_COSTING_DEFAULTS/);
  });
  it("the Python proxy and its picker are not used by the new panel or card", () => {
    for (const file of files) {
      const source = readFileSync(path.join(root, file), "utf8");
      expect(source).not.toMatch(/api\/costing|costing-line-picker|from "@\/lib\/costing"|from '@\/lib\/costing'/);
    }
  });
});

describe("after the rates change (the browser spec's second step)", () => {
  it("machine GBP 80/h and margin 35%: cost 57.35, price 77.42; the first calculation is still 60.72", () => {
    const changed: CostingRates = { ...CONFIGURED, machines: [{ ...CONFIGURED.machines[0], hourlyRate: 80 }], defaults: { ...CONFIGURED.defaults, marginPct: 35 } };
    const r = priceThisPart(changed, ENTRY);
    expect(r.status === "ok" && [r.figures.unitCost, r.figures.unitPrice]).toEqual([57.35, 77.42]);
    const first = priceThisPart(CONFIGURED, ENTRY);
    expect(first.status === "ok" && first.figures.unitPrice).toBe(60.72);
  });
});
