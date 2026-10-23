"use client";

// Client for the CNC costing engine, reached through the /api/costing proxy.

export type CostingOperation = {
  id: number;
  machine_id: number;
  name: string;
  sequence: number;
};

export type CostingPart = {
  id: number;
  part_number: string;
  description: string | null;
  material_id: number;
  operations: CostingOperation[];
};

export type CostingBreakdown = {
  cost_breakdown: {
    material: { base: number; scrap: number; total: number };
    machine_cost: number;
    labor_cost: number;
    tooling_cost: number;
    programming_cost: number;
    inspection_cost: number;
    consumables_cost: number;
    overhead_cost: number;
    subtotal_cost: number;
    unit_cost: number;
    margin_amount: number;
    unit_price: number;
  };
  summary: {
    quantity: number;
    unit_cost: number;
    unit_price: number;
    margin_pct: number;
    extended_cost: number;
    extended_price: number;
    profit_amount: number;
  };
  part_info: {
    part_number: string;
    description: string | null;
    material_name: string;
  };
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/costing/${path}`, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // The engine's own message can expose internals; callers show friendlyError() text instead.
    const detail = (payload as { error?: string; detail?: unknown }).error || (payload as { detail?: unknown }).detail;
    throw new Error(`Costing engine request failed (${response.status})${typeof detail === "string" ? `: ${detail}` : ""}`);
  }
  return payload as T;
}

/** False when the server has no COSTING_ENGINE_URL / COSTING_ENGINE_TOKEN, or the caller may not use it. */
export async function isCostingEngineConfigured() {
  try {
    const { configured } = await request<{ configured: boolean }>("status");
    return configured === true;
  } catch {
    return false;
  }
}

export function fetchCostingParts() {
  return request<CostingPart[]>("parts");
}

/** marginPct is a fraction, e.g. 0.2 for 20%. */
export function calculatePartCost(partId: number, quantity: number, marginPct: number) {
  return request<CostingBreakdown>("quotes/calculate-detailed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ part_id: partId, quantity, margin_pct: marginPct }),
  });
}
