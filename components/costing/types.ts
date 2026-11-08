/**
 * The company's costing rates as the Settings card edits them and the quote panel prices with them: pounds and percentages as a person types
 * them (stored as whole pence by 143; lib/costing/app-rates.ts converts). A null is a blank box: NOTHING here has a built-in value, so a company
 * that has entered no rates has blank rates (blankCostingRates), and neither the card nor the panel invents one.
 *   overheadPct: 100 = no overhead, 150 = machine and labour time charged half as much again (the engine's multiplier x1.5).
 *   marginPct: 20 = 20% on top of cost.
 *   labourPerHour on a machine: that machine's own labour rate; null = use the company labour rate.
 */
export type CostingMaterial = { id: string; name: string; unit: 'kg' | 'each'; price: number | null; scrapPct: number | null };
export type CostingMachine = { id: string; name: string; hourlyRate: number | null; labourPerHour: number | null };
export type CostingDefaults = { labourPerHour: number | null; programmingPerHour: number | null; overheadPct: number | null; marginPct: number | null };
export type CostingRates = { materials: CostingMaterial[]; machines: CostingMachine[]; defaults: CostingDefaults };

export const blankCostingRates: CostingRates = {
  materials: [], machines: [],
  defaults: { labourPerHour: null, programmingPerHour: null, overheadPct: null, marginPct: null },
};
