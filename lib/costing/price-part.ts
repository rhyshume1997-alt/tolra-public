/**
 * "Price this part": the company's rates plus what the person typed about one part, through the engine (lib/costing/engine.ts).
 * Rates come ONLY from the company's costing settings (CostingRates). Nothing here has a rate of its own: if one is missing the answer is
 * "not set up" / "missing", with no figures at all.
 *
 * Units: the engine multiplies a weight by a price per unit of weight; its field names say "lb" but the arithmetic is unit-free, so a price per
 * kg and a weight in kg go straight in (no conversion, so no float noise). A material priced "each" uses pieces per part the same way.
 * Money out is pounds to 2 decimal places (the engine's own rounding). The result is plain numbers: nothing links it back to the rates.
 */
import { fromPence, linePence } from "@/lib/money";
import { calcDetailedQuote } from "@/lib/costing/engine";
import { ratesGaps, ratesProblem } from "@/lib/costing/app-rates";
import type { CostingRates } from "@/components/costing/types";

export type PartEntry = {
  materialId: string; machineId: string; quantity: number;
  /** kg per part for a material priced per kg; pieces per part for one priced each. */
  amountPerPart: number | null;
  setupHours: number | null; cycleHours: number | null; programmingHours: number | null;
};

export type PartFigures = {
  materialCost: number; machineCost: number; labourCost: number; programmingCost: number; overheadCost: number;
  unitCost: number; unitPrice: number; extendedPrice: number; marginPct: number; quantity: number;
};

export type PartPricing =
  | { status: "not_set_up"; blank: boolean; missing: string[] }
  | { status: "need_input"; needs: string[] }
  | { status: "ok"; figures: PartFigures };

export function priceThisPart(rates: CostingRates, entry: PartEntry): PartPricing {
  const gaps = ratesGaps(rates);
  if (gaps.missing.length > 0) return { status: "not_set_up", blank: gaps.blank, missing: gaps.missing };
  const rateProblem = ratesProblem(rates);
  if (rateProblem) return { status: "not_set_up", blank: false, missing: [rateProblem] };
  const material = rates.materials.find((m) => m.id === entry.materialId) ?? rates.materials[0];
  const machine = rates.machines.find((m) => m.id === entry.machineId) ?? rates.machines[0];
  const d = rates.defaults;
  const needs: string[] = [];
  if (entry.materialId && !rates.materials.some(m => m.id === entry.materialId)) needs.push("a material still in the current rate list");
  if (entry.machineId && !rates.machines.some(m => m.id === entry.machineId)) needs.push("a machine still in the current rate list");
  if (!Number.isSafeInteger(entry.quantity) || entry.quantity < 1 || entry.quantity > 1_000_000) needs.push("a whole quantity from 1 to 1,000,000");
  if (entry.amountPerPart === null || !Number.isFinite(entry.amountPerPart) || !(entry.amountPerPart > 0)) needs.push(material.unit === "kg" ? "the material weight per part" : "the pieces per part");
  if (entry.cycleHours === null || !Number.isFinite(entry.cycleHours) || !(entry.cycleHours > 0)) needs.push("the cycle time per part");
  if (entry.setupHours !== null && (!Number.isFinite(entry.setupHours) || entry.setupHours < 0)) needs.push("a setup time of zero or more");
  if (entry.programmingHours !== null && (!Number.isFinite(entry.programmingHours) || entry.programmingHours < 0)) needs.push("a programming time of zero or more");
  if (needs.length > 0) return { status: "need_input", needs };
  const labour = machine.labourPerHour ?? d.labourPerHour!;
  let result: ReturnType<typeof calcDetailedQuote>;
  try { result = calcDetailedQuote({
    quantity: entry.quantity, stock_weight_lb: entry.amountPerPart!, cost_per_lb: material.price!, scrap_factor: material.scrapPct! / 100,
    margin_pct: d.marginPct! / 100, programming_rate_per_hr: d.programmingPerHour!, overhead_rate_pct: d.overheadPct! / 100,
    programming_time_hr: entry.programmingHours ?? 0,
    ops: [{ name: machine.name, sequence: 1, setup_time_hr: entry.setupHours ?? 0, cycle_time_hr: entry.cycleHours!, allowance_pct: 0,
      machine_rate_per_hr: machine.hourlyRate!, labor_rate_per_hr: labour }],
  }); } catch (error) {
    if (error instanceof RangeError) return { status: "need_input", needs: ["smaller cost or time values (the calculation is too large)"] };
    throw error;
  }
  const c = result.cost_breakdown;
  return { status: "ok", figures: {
    materialCost: c.material.total, machineCost: c.machine_cost, labourCost: c.labor_cost, programmingCost: c.programming_cost, overheadCost: c.overhead_cost,
    unitCost: result.summary.unit_cost, unitPrice: result.summary.unit_price, extendedPrice: fromPence(linePence(entry.quantity, result.summary.unit_price)),
    marginPct: result.summary.margin_pct, quantity: entry.quantity,
  } };
}

/** The values copied into a quote line when the person applies a calculation: plain numbers and text, a snapshot. */
export type AppliedLine = { description: string; qty: number; unit: number; source: "costing_calculator" };

export function appliedLine(description: string, figures: PartFigures): AppliedLine {
  return { description: description.trim(), qty: figures.quantity, unit: figures.unitPrice, source: "costing_calculator" };
}

/** A one-paragraph record of the cost, for the quote's internal notes (never shown to the customer). Plain text, written once. */
export function costNote(description: string, figures: PartFigures, on: string): string {
  const f = (n: number) => `£${n.toFixed(2)}`;
  return `Costing ${on}: ${description.trim()} x${figures.quantity}. Material ${f(figures.materialCost)}, machine ${f(figures.machineCost)}, labour ${f(figures.labourCost)}, programming ${f(figures.programmingCost)}, overhead ${f(figures.overheadCost)}. Cost per part ${f(figures.unitCost)}, price per part ${f(figures.unitPrice)} (margin ${figures.marginPct}%).`;
}
