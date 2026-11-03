export type CostingMaterial = { id: string; name: string; unit: 'kg' | 'each'; price: number; scrapPct: number };
export type CostingMachine = { id: string; name: string; hourlyRate: number; labourPerHour?: number | null };
export type CostingRates = { materials: CostingMaterial[]; machines: CostingMachine[]; labourPerHour: number; programmingPerHour: number; overheadPct: number; marginPct: number };
export const defaultCostingRates: CostingRates = { materials: [], machines: [], labourPerHour: 0, programmingPerHour: 0, overheadPct: 0, marginPct: 15 };
