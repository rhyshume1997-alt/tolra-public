/**
 * lib/costing/rates-store.ts (migration 143's costing_materials, costing_machines, costing_defaults) with a minimal Supabase stand-in:
 * the columns and filters it sends, the mapping to whole pence and stored percentages, costing on only with a machine and a material,
 * the same rules as 143's CHECKs before anything is sent, plain-words refusals, and 143 not applied read quietly as "not_applied".
 */
import { describe, expect, it, vi } from "vitest";

import {
  BUILT_IN_COSTING_DEFAULTS, COSTING_NOT_APPLIED_MESSAGE, costingEnabled, defaultsProblem, deleteCostingMachine, deleteCostingMaterial,
  isCostingNotAppliedError, loadCostingRates, machineLabourRatePence, machineProblem, materialProblem, saveCostingDefaults, saveCostingMachine,
  saveCostingMaterial,
} from "@/lib/costing/rates-store";

type Answer = { data?: unknown; error?: { code?: string; message?: string } | null };

/** Per-table answers; every call recorded as [method, ...args]. */
function client(answers: Record<string, Answer>, calls: unknown[][] = []) {
  return {
    from: (table: string) => {
      calls.push(["from", table]);
      const answer = answers[table] ?? {};
      const result = { data: answer.data ?? null, error: answer.error ?? null };
      const chain: Record<string, unknown> = {};
      for (const name of ["select", "eq", "order", "insert", "update", "upsert", "delete"]) chain[name] = (...args: unknown[]) => { calls.push([name, ...args]); return chain; };
      chain.maybeSingle = async () => { calls.push(["maybeSingle"]); return result; };
      chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
      return chain;
    },
  } as never;
}

const MAT = { id: "m1", name: "Mild steel", price_pence: 235, price_unit: "kg", scrap_pct: 5, updated_at: "2026-11-02T10:00:00Z" };
const MAC = { id: "c1", name: "Haas VF-2", hourly_rate_pence: 6500, labour_rate_pence: null, updated_at: null };
const DEF = { labour_rate_pence: 3250, programming_rate_pence: 7500, overhead_pct: 150, default_margin_pct: 17.5, updated_at: null };

describe("loadCostingRates", () => {
  it("reads the three tables (RLS scopes them) with names in order, mapped to pence and stored percentages", async () => {
    const calls: unknown[][] = [];
    const result = await loadCostingRates(client({ costing_materials: { data: [MAT] }, costing_machines: { data: [MAC] }, costing_defaults: { data: DEF } }, calls));
    expect(result).toEqual({ status: "ok", rates: {
      materials: [{ id: "m1", name: "Mild steel", pricePence: 235, priceUnit: "kg", scrapPct: 5, updatedAt: "2026-11-02T10:00:00Z" }],
      machines: [{ id: "c1", name: "Haas VF-2", hourlyRatePence: 6500, labourRatePence: null, updatedAt: null }],
      defaults: { labourRatePence: 3250, programmingRatePence: 7500, overheadPct: 150, defaultMarginPct: 17.5, updatedAt: null },
      enabled: true,
    } });
    expect(calls).toContainEqual(["select", "id, name, price_pence, price_unit, scrap_pct, updated_at"]);
    expect(calls).toContainEqual(["select", "id, name, hourly_rate_pence, labour_rate_pence, updated_at"]);
    expect(calls).toContainEqual(["select", "labour_rate_pence, programming_rate_pence, overhead_pct, default_margin_pct, updated_at"]);
    expect(calls.filter((c) => c[0] === "order")).toEqual([["order", "name"], ["order", "name"]]);
  });

  it("costing is off until the company has at least one machine and one material; no defaults row reads null", async () => {
    const noMachine = await loadCostingRates(client({ costing_materials: { data: [MAT] }, costing_machines: { data: [] } }));
    expect(noMachine).toMatchObject({ status: "ok", rates: { enabled: false, defaults: null } });
    const noMaterial = await loadCostingRates(client({ costing_machines: { data: [MAC] } }));
    expect(noMaterial).toMatchObject({ status: "ok", rates: { enabled: false } });
    expect(costingEnabled({ materials: [], machines: [] })).toBe(false);
  });

  it("numeric values PostgREST sends as strings are read as numbers; a malformed row is skipped", async () => {
    const result = await loadCostingRates(client({
      costing_materials: { data: [{ ...MAT, scrap_pct: "12.50" }, { ...MAT, id: "bad", price_unit: "lb" }] },
      costing_machines: { data: [MAC, { ...MAC, id: "bad", hourly_rate_pence: null }] },
      costing_defaults: { data: { ...DEF, overhead_pct: "135.00" } },
    }));
    expect(result.status === "ok" && result.rates.materials.map((m) => [m.id, m.scrapPct])).toEqual([["m1", 12.5]]);
    expect(result.status === "ok" && result.rates.machines.map((m) => m.id)).toEqual(["c1"]);
    expect(result.status === "ok" && result.rates.defaults?.overheadPct).toBe(135);
  });

  it("143 not applied: 'not_applied', never throws, nothing on the console; other failures are 'error'", async () => {
    const log = vi.spyOn(console, "error");
    for (const error of [{ code: "PGRST205", message: "Could not find the table 'public.costing_machines' in the schema cache" }, { code: "42P01", message: "relation \"public.costing_defaults\" does not exist" }]) {
      expect(isCostingNotAppliedError(error)).toBe(true);
      expect(await loadCostingRates(client({ costing_machines: { error } }))).toEqual({ status: "not_applied" });
    }
    expect(await loadCostingRates(client({ costing_materials: { error: { code: "500", message: "boom" } } }))).toMatchObject({ status: "error" });
    expect(await loadCostingRates({ from: () => { throw new Error("Failed to fetch"); } } as never)).toMatchObject({ status: "error" });
    expect(await loadCostingRates(null)).toMatchObject({ status: "error" });
    expect(log).not.toHaveBeenCalled();
  });
});

describe("saving and deleting", () => {
  it("a new material is inserted for the company (name trimmed) and returned as saved", async () => {
    const calls: unknown[][] = [];
    const saved = await saveCostingMaterial(client({ costing_materials: { data: MAT } }, calls), "org-1", { name: "  Mild steel ", pricePence: 235, priceUnit: "kg", scrapPct: 5 });
    expect(saved).toMatchObject({ ok: true, row: { id: "m1", pricePence: 235 } });
    expect(calls).toContainEqual(["insert", { name: "Mild steel", price_pence: 235, price_unit: "kg", scrap_pct: 5, organization_id: "org-1" }]);
  });

  it("an existing machine is updated by id within the company; a hidden or vanished row is a plain refusal", async () => {
    const calls: unknown[][] = [];
    const input = { id: "c1", name: "Haas VF-2", hourlyRatePence: 7000, labourRatePence: 3500 };
    expect(await saveCostingMachine(client({ costing_machines: { data: { ...MAC, hourly_rate_pence: 7000, labour_rate_pence: 3500 } } }, calls), "org-1", input))
      .toMatchObject({ ok: true, row: { hourlyRatePence: 7000, labourRatePence: 3500 } });
    expect(calls).toContainEqual(["update", { name: "Haas VF-2", hourly_rate_pence: 7000, labour_rate_pence: 3500 }]);
    expect(calls).toContainEqual(["eq", "id", "c1"]);
    expect(calls).toContainEqual(["eq", "organization_id", "org-1"]);
    expect(await saveCostingMachine(client({ costing_machines: { data: null } }), "org-1", input)).toMatchObject({ ok: false, notApplied: false, message: expect.stringMatching(/no longer there/) });
  });

  it("defaults are upserted on organization_id", async () => {
    const calls: unknown[][] = [];
    const input = { labourRatePence: 3250, programmingRatePence: 7500, overheadPct: 150, defaultMarginPct: 17.5 };
    expect(await saveCostingDefaults(client({ costing_defaults: { data: DEF } }, calls), "org-1", input)).toMatchObject({ ok: true, row: { defaultMarginPct: 17.5 } });
    expect(calls).toContainEqual(["upsert", { organization_id: "org-1", labour_rate_pence: 3250, programming_rate_pence: 7500, overhead_pct: 150, default_margin_pct: 17.5 }, { onConflict: "organization_id" }]);
  });

  it("deletes by id within the company; nothing deleted (RLS hid it) is a refusal", async () => {
    const calls: unknown[][] = [];
    expect(await deleteCostingMaterial(client({ costing_materials: { data: [{ id: "m1" }] } }, calls), "org-1", "m1")).toEqual({ ok: true });
    expect(calls).toEqual([["from", "costing_materials"], ["delete"], ["eq", "id", "m1"], ["eq", "organization_id", "org-1"], ["select", "id"]]);
    expect(await deleteCostingMachine(client({ costing_machines: { data: [] } }), "org-1", "c1")).toMatchObject({ ok: false, notApplied: false });
  });

  it("database refusals in plain words; 143 not applied is notApplied", async () => {
    const material = { name: "Steel", pricePence: 1, priceUnit: "kg" as const, scrapPct: 0 };
    const refuse = async (code: string) => saveCostingMaterial(client({ costing_materials: { error: { code, message: "x" } } }), "org-1", material);
    expect(await refuse("42501")).toMatchObject({ ok: false, message: expect.stringMatching(/permission/) });
    expect(await refuse("23505")).toMatchObject({ ok: false, message: "There is already a material with that name." });
    expect(await refuse("23514")).toMatchObject({ ok: false, message: expect.stringMatching(/Check the values/) });
    expect(await refuse("PGRST205")).toEqual({ ok: false, notApplied: true, message: COSTING_NOT_APPLIED_MESSAGE });
    expect(await deleteCostingMachine(client({ costing_machines: { error: { code: "42P01" } } }), "org-1", "c1")).toEqual({ ok: false, notApplied: true, message: COSTING_NOT_APPLIED_MESSAGE });
    expect(await saveCostingDefaults(null, "org-1", BUILT_IN_COSTING_DEFAULTS)).toMatchObject({ ok: false, notApplied: false });
  });
});

describe("the same rules as 143's CHECKs, before anything is sent", () => {
  const material = { name: "Steel", pricePence: 235, priceUnit: "kg" as const, scrapPct: 5 };
  const machine = { name: "Mill", hourlyRatePence: 6500, labourRatePence: null };

  it("materials: one-line name of 1 to 80, whole pence 0 to 10,000,000, kg or each, scrap 0 to 100 (2 places)", () => {
    expect(materialProblem(material)).toBeNull();
    expect(materialProblem({ ...material, name: "x".repeat(80), pricePence: 10_000_000, scrapPct: 100, priceUnit: "each" })).toBeNull();
    for (const bad of [{ name: "  " }, { name: "a\nb" }, { name: "x".repeat(81) }, { pricePence: -1 }, { pricePence: 2.5 }, { pricePence: 10_000_001 },
      { priceUnit: "lb" }, { scrapPct: -0.01 }, { scrapPct: 100.01 }, { scrapPct: 1.005 }, { scrapPct: Number.NaN }]) {
      expect(materialProblem({ ...material, ...bad } as never), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it("machines: hourly rate whole pence; labour rate whole pence or blank (the default)", () => {
    expect(machineProblem(machine)).toBeNull();
    expect(machineProblem({ ...machine, labourRatePence: 0 })).toBeNull();
    for (const bad of [{ name: "" }, { hourlyRatePence: -1 }, { hourlyRatePence: 65.5 }, { labourRatePence: -1 }, { labourRatePence: 1.5 }]) {
      expect(machineProblem({ ...machine, ...bad } as never), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it("defaults: rates whole pence; overhead 100 to 500; margin 0 to 95 (2 places)", () => {
    expect(defaultsProblem(BUILT_IN_COSTING_DEFAULTS)).toBeNull();
    expect(defaultsProblem({ ...BUILT_IN_COSTING_DEFAULTS, overheadPct: 500, defaultMarginPct: 95 })).toBeNull();
    for (const bad of [{ labourRatePence: -1 }, { programmingRatePence: 10_000_001 }, { overheadPct: 99.99 }, { overheadPct: 500.01 }, { defaultMarginPct: 95.01 }, { defaultMarginPct: 12.345 }]) {
      expect(defaultsProblem({ ...BUILT_IN_COSTING_DEFAULTS, ...bad }), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it("a rejected input sends nothing", async () => {
    const calls: unknown[][] = [];
    expect(await saveCostingMaterial(client({}, calls), "org-1", { ...material, pricePence: -1 })).toMatchObject({ ok: false, notApplied: false });
    expect(await saveCostingMachine(client({}, calls), "org-1", { ...machine, name: "" })).toMatchObject({ ok: false });
    expect(await saveCostingDefaults(client({}, calls), "org-1", { ...BUILT_IN_COSTING_DEFAULTS, overheadPct: 50 })).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it("a machine's labour rate: its own, else the company default, else none", () => {
    expect(machineLabourRatePence({ labourRatePence: 3500 }, { labourRatePence: 3250 })).toBe(3500);
    expect(machineLabourRatePence({ labourRatePence: null }, { labourRatePence: 3250 })).toBe(3250);
    expect(machineLabourRatePence({ labourRatePence: null }, null)).toBe(0);
  });
});
