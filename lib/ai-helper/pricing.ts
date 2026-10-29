import type { CostingBreakdown, CostingPart } from "@/lib/costing";
import { fromPence, toPence } from "@/lib/money";

/**
 * Prices for a reviewed RFQ suggestion, from the EXISTING fixed calculation only: the costing engine the Quote Builder's costing
 * picker uses (the company's rates, material prices and machine hours), never the model. The panel's preview reaches it through
 * /api/costing (browser deps); the Approve route prices again on the server for the caller's company (lib/server/costing-engine.ts),
 * and only that server price is saved. A line is priced only when its part number is exactly one of the engine's parts (case and
 * spaces aside) and its quantity is known; anything else is saved at £0.00 and flagged "Needs human review: price", and the person
 * types the price in the saved draft. With the engine not configured, every price is blank.
 */
/** The margin the Quote Builder's costing picker starts at (components/costing-line-picker.tsx), as a percentage. */
export const COSTING_MARGIN_PCT = 20;

export type CostingDeps = {
  configured: () => Promise<boolean>;
  parts: () => Promise<CostingPart[]>;
  calculate: (partId: number, quantity: number, marginPct: number) => Promise<CostingBreakdown>;
};

const key = (value: string) => value.replace(/\s+/g, "").toUpperCase();

/** One unit price per line (pounds, to the penny), or null where the calculation can't price it. Never throws. */
export async function costingPrices(lines: { partNumber: string | null; quantity: number | null }[], deps: CostingDeps): Promise<(number | null)[]> {
  const blank = lines.map(() => null);
  try {
    if (!lines.some((l) => l.partNumber && l.quantity) || !(await deps.configured())) return blank;
    const parts = new Map((await deps.parts()).map((part) => [key(part.part_number), part]));
    return await Promise.all(lines.map(async (line) => {
      const part = line.partNumber ? parts.get(key(line.partNumber)) : undefined;
      if (!part || !line.quantity) return null;
      try {
        const result = await deps.calculate(part.id, line.quantity, COSTING_MARGIN_PCT / 100);
        const unit = result.summary?.unit_price;
        return typeof unit === "number" && Number.isFinite(unit) && unit >= 0 ? fromPence(toPence(unit)) : null;
      } catch {
        return null;
      }
    }));
  } catch {
    return blank;
  }
}
