import type { CostingRates } from "../../components/costing/types";
import type { PartEntry } from "../../lib/costing/price-part";

/** The worked example: steel bar GBP 4.00/kg, 5% scrap; Mill GBP 65/h; labour 25, programming 40, overhead 150 (x1.5), margin 20%. */
export const CONFIGURED: CostingRates = {
  materials: [{ id: "11111111-1111-4111-8111-111111111111", name: "Steel bar", unit: "kg", price: 4, scrapPct: 5 }],
  machines: [{ id: "22222222-2222-4222-8222-222222222222", name: "Mill", hourlyRate: 65, labourPerHour: null }],
  defaults: { labourPerHour: 25, programmingPerHour: 40, overheadPct: 150, marginPct: 20 },
};
export const ENTRY: PartEntry = { materialId: "", machineId: "", quantity: 10, amountPerPart: 0.5, setupHours: 1, cycleHours: 0.2, programmingHours: 2 };

