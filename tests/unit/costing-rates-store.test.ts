/**
 * lib/costing/rates-store.ts (migration 143's costing_materials, costing_machines, costing_defaults) with a minimal Supabase stand-in:
 * the columns and filters it sends, the mapping to whole pence and stored percentages, NO BUILT-IN RATE (a blank or half-entered company reads
 * as "not_configured" with what is missing, never as numbers), the same rules as 143's CHECKs before anything is sent, plain-words refusals,
 * the whole-set atomic save, and 143 not applied read quietly as "not_applied".
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import * as store from "@/lib/costing/rates-store";

import {
  COSTING_NOT_APPLIED_MESSAGE, COSTING_ROWS_MAX, COSTING_STALE_MESSAGE, costingEnabled, costingMissing, costingMissingMessage, costingSettingsJson, defaultsProblem,
  deleteCostingMachine, deleteCostingMaterial, isCostingNotAppliedError, loadCostingRates, machineLabourRatePence, machineProblem, materialProblem, newCostingId,
  ratesForEditing, saveCostingDefaults, saveCostingMachine, saveCostingMaterial, saveCostingSettingsAtomic, settingsProblem,
} from "@/lib/costing/rates-store";

type Answer = { data?: unknown; error?: { code?: string; message?: string } | null };
/** Figures a test company "enters" (inputs for the cases below: the store supplies none of its own). */
const ENTERED = { labourRatePence: 3250, programmingRatePence: 7500, overheadPct: 150, defaultMarginPct: 20 };

/** Per-table answers; every call recorded as [method, ...args]. */
function client(answers: Record<string, Answer>, calls: unknown[][] = []) {
  return {
    rpc: async (name: string, args: unknown) => {
      calls.push(["rpc", name, args]);
      const answer = answers[`rpc:${name}`] ?? {};
      return { data: answer.data ?? null, error: answer.error ?? null };
    },
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
    } });
    expect(calls).toContainEqual(["select", "id, name, price_pence, price_unit, scrap_pct, updated_at"]);
    expect(calls).toContainEqual(["select", "id, name, hourly_rate_pence, labour_rate_pence, updated_at"]);
    expect(calls).toContainEqual(["select", "labour_rate_pence, programming_rate_pence, overhead_pct, default_margin_pct, updated_at"]);
    expect(calls.filter((c) => c[0] === "order")).toEqual([["order", "name"], ["order", "name"]]);
  });

  it("a blank company is NOT CONFIGURED: no numbers at all, and it says what is missing (defaults, machines, materials)", async () => {
    const blank = await loadCostingRates(client({}));
    expect(blank).toEqual({ status: "not_configured", missing: ["defaults", "machines", "materials"], partial: { materials: [], machines: [], defaults: null } });
    expect(blank).not.toHaveProperty("rates");
    expect(costingMissingMessage(["defaults", "machines", "materials"])).toBe("Costing is off until you enter your default rates (labour, programming, overhead, margin), at least one machine and at least one material in Settings.");
  });

  it("half-entered is still not configured: every missing piece is named, what was entered is kept for the settings screen, and only a complete set is 'ok'", async () => {
    const noMachine = await loadCostingRates(client({ costing_materials: { data: [MAT] }, costing_machines: { data: [] }, costing_defaults: { data: DEF } }));
    expect(noMachine).toMatchObject({ status: "not_configured", missing: ["machines"], partial: { defaults: { labourRatePence: 3250 } } });
    expect(noMachine.status === "not_configured" && noMachine.partial.materials).toHaveLength(1);
    const noMaterial = await loadCostingRates(client({ costing_machines: { data: [MAC] }, costing_defaults: { data: DEF } }));
    expect(noMaterial).toMatchObject({ status: "not_configured", missing: ["materials"] });
    const noDefaults = await loadCostingRates(client({ costing_materials: { data: [MAT] }, costing_machines: { data: [MAC] } }));
    expect(noDefaults).toMatchObject({ status: "not_configured", missing: ["defaults"], partial: { defaults: null } });
    expect(noDefaults).not.toHaveProperty("rates");
    expect(costingMissingMessage(["defaults"])).toBe("Costing is off until you enter your default rates (labour, programming, overhead, margin) in Settings.");
    expect(costingMissingMessage(["machines", "materials"])).toBe("Costing is off until you enter at least one machine and at least one material in Settings.");
    expect(costingMissingMessage([])).toBe("");
    const complete = await loadCostingRates(client({ costing_materials: { data: [MAT] }, costing_machines: { data: [MAC] }, costing_defaults: { data: DEF } }));
    expect(complete.status).toBe("ok");
    expect(costingEnabled({ materials: [], machines: [], defaults: null })).toBe(false);
    expect(costingMissing({ materials: [], machines: [], defaults: null })).toEqual(["defaults", "machines", "materials"]);
    expect(ratesForEditing(noMachine)).toMatchObject({ defaults: { labourRatePence: 3250 } });
    expect(ratesForEditing(complete)).not.toBeNull();
    expect(ratesForEditing({ status: "not_applied" })).toBeNull();
  });

  it("a stored defaults row that cannot be read as numbers counts as no defaults (not configured), never as zeros", async () => {
    const result = await loadCostingRates(client({ costing_materials: { data: [MAT] }, costing_machines: { data: [MAC] }, costing_defaults: { data: { ...DEF, overhead_pct: null } } }));
    expect(result).toMatchObject({ status: "not_configured", missing: ["defaults"] });
  });

  it("no rate is built in: the module exports no default-rates constant and its code holds no rate figure", () => {
    expect(Object.keys(store).filter((k) => /BUILT_IN|DEFAULT_RATES|DEFAULTS_?CONST/i.test(k))).toEqual([]);
    const source = readFileSync(path.resolve(__dirname, "../../lib/costing/rates-store.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/\b7500\b|\b7_500\b|BUILT_IN/);
    expect(source).not.toMatch(/(overheadPct|overhead_pct|defaultMarginPct|default_margin_pct|labourRatePence|programmingRatePence|scrapPct|scrap_pct)\s*[:=]\s*[1-9]/);
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
    expect(await saveCostingDefaults(null, "org-1", ENTERED)).toMatchObject({ ok: false, notApplied: false });
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
    expect(defaultsProblem(ENTERED)).toBeNull();
    expect(defaultsProblem({ ...ENTERED, overheadPct: 500, defaultMarginPct: 95 })).toBeNull();
    for (const bad of [{ labourRatePence: -1 }, { programmingRatePence: 10_000_001 }, { overheadPct: 99.99 }, { overheadPct: 500.01 }, { defaultMarginPct: 95.01 }, { defaultMarginPct: 12.345 }]) {
      expect(defaultsProblem({ ...ENTERED, ...bad }), JSON.stringify(bad)).not.toBeNull();
    }
  });

  it("a rejected input sends nothing", async () => {
    const calls: unknown[][] = [];
    expect(await saveCostingMaterial(client({}, calls), "org-1", { ...material, pricePence: -1 })).toMatchObject({ ok: false, notApplied: false });
    expect(await saveCostingMachine(client({}, calls), "org-1", { ...machine, name: "" })).toMatchObject({ ok: false });
    expect(await saveCostingDefaults(client({}, calls), "org-1", { ...ENTERED, overheadPct: 50 })).toMatchObject({ ok: false });
    expect(calls).toEqual([]);
  });

  it("a machine's labour rate: its own, else the company default, else NONE (null: never a guessed rate, and never 0)", () => {
    expect(machineLabourRatePence({ labourRatePence: 3500 }, { labourRatePence: 3250 })).toBe(3500);
    expect(machineLabourRatePence({ labourRatePence: 0 }, { labourRatePence: 3250 })).toBe(0);
    expect(machineLabourRatePence({ labourRatePence: null }, { labourRatePence: 3250 })).toBe(3250);
    expect(machineLabourRatePence({ labourRatePence: null }, null)).toBeNull();
  });
});

describe("the whole-set atomic save (143's save_costing_settings_atomic)", () => {
  const ID1 = "11111111-1111-4111-8111-111111111111", ID2 = "22222222-2222-4222-8222-222222222222", ID3 = "33333333-3333-4333-8333-333333333333";
  const loaded = {
    materials: [{ id: ID1, name: "Mild steel", pricePence: 235, priceUnit: "kg" as const, scrapPct: 5, updatedAt: "x" }],
    machines: [{ id: ID2, name: "Haas VF-2", hourlyRatePence: 6500, labourRatePence: null, updatedAt: null }],
    defaults: { ...ENTERED, updatedAt: null },
  };
  const value = {
    materials: [{ id: ID1, name: " Mild steel ", pricePence: 250, priceUnit: "kg" as const, scrapPct: 5 }],
    machines: [{ id: ID2, name: "Haas VF-2", hourlyRatePence: 6500, labourRatePence: null }, { id: ID3, name: "Lathe", hourlyRatePence: 4000, labourRatePence: 2800 }],
    defaults: ENTERED,
  };

  it("sends the company, what was loaded and the new whole set (snake_case, names trimmed, no timestamps) in ONE rpc call and nothing else", async () => {
    const calls: unknown[][] = [];
    expect(await saveCostingSettingsAtomic(client({}, calls), "org-1", loaded, value)).toEqual({ ok: true });
    expect(calls).toEqual([["rpc", "save_costing_settings_atomic", {
      p_org: "org-1",
      p_expected: {
        materials: [{ id: ID1, name: "Mild steel", price_pence: 235, price_unit: "kg", scrap_pct: 5 }],
        machines: [{ id: ID2, name: "Haas VF-2", hourly_rate_pence: 6500, labour_rate_pence: null }],
        defaults: { labour_rate_pence: 3250, programming_rate_pence: 7500, overhead_pct: 150, default_margin_pct: 20 },
      },
      p_value: {
        materials: [{ id: ID1, name: "Mild steel", price_pence: 250, price_unit: "kg", scrap_pct: 5 }],
        machines: [{ id: ID2, name: "Haas VF-2", hourly_rate_pence: 6500, labour_rate_pence: null }, { id: ID3, name: "Lathe", hourly_rate_pence: 4000, labour_rate_pence: 2800 }],
        defaults: { labour_rate_pence: 3250, programming_rate_pence: 7500, overhead_pct: 150, default_margin_pct: 20 },
      },
    }]]);
  });

  it("a company that has entered nothing yet saves from a blank: expected is empty with defaults null", async () => {
    const calls: unknown[][] = [];
    const blank = { materials: [], machines: [], defaults: null };
    expect(costingSettingsJson(blank)).toEqual({ materials: [], machines: [], defaults: null });
    expect(await saveCostingSettingsAtomic(client({}, calls), "org-1", blank, value)).toEqual({ ok: true });
    expect((calls[0][2] as { p_expected: unknown }).p_expected).toEqual({ materials: [], machines: [], defaults: null });
  });

  it("stale (40001) is its own answer with the reload message; permission, values, a name clash and 143 not applied are told apart", async () => {
    const refuse = (code: string, message = "x") => saveCostingSettingsAtomic(client({ "rpc:save_costing_settings_atomic": { error: { code, message } } }), "org-1", loaded, value);
    expect(await refuse("40001", "Settings changed; reload")).toEqual({ ok: false, reason: "stale", notApplied: false, message: COSTING_STALE_MESSAGE });
    expect(await refuse("42501")).toMatchObject({ ok: false, reason: "refused", message: expect.stringMatching(/permission/) });
    expect(await refuse("22023")).toMatchObject({ ok: false, reason: "refused", message: expect.stringMatching(/Check the values/) });
    expect(await refuse("23505")).toMatchObject({ ok: false, reason: "refused", message: "A material or machine already has that name." });
    expect(await refuse("PGRST202", "Could not find the function public.save_costing_settings_atomic")).toEqual({ ok: false, reason: "not_applied", notApplied: true, message: COSTING_NOT_APPLIED_MESSAGE });
    expect(await refuse("42883", "function public.save_costing_settings_atomic(uuid, jsonb, jsonb) does not exist")).toMatchObject({ reason: "not_applied" });
    expect(await refuse("XX000")).toMatchObject({ ok: false, reason: "refused", notApplied: false });
    expect(await saveCostingSettingsAtomic({ rpc: () => { throw new Error("Failed to fetch"); } } as never, "org-1", loaded, value)).toMatchObject({ ok: false, reason: "refused" });
    expect(await saveCostingSettingsAtomic(null, "org-1", loaded, value)).toMatchObject({ ok: false, reason: "refused" });
  });

  it("the same rules as 143's function, before anything is sent: nothing reaches the database when the set is bad", async () => {
    const calls: unknown[][] = [];
    const m = value.materials[0], k = value.machines[0];
    const bad: Array<[string, typeof value]> = [
      ["a price in fractions of a penny", { ...value, materials: [{ ...m, pricePence: 2.5 }] }],
      ["a blank name", { ...value, machines: [{ ...k, name: " " }, value.machines[1]] }],
      ["overhead under 100", { ...value, defaults: { ...ENTERED, overheadPct: 99 } }],
      ["an id that is not a UUID", { ...value, materials: [{ ...m, id: "m1" }] }],
      ["the same id twice", { ...value, machines: [k, { ...value.machines[1], id: k.id }] }],
      ["the same material name twice (case, spaces)", { ...value, materials: [m, { ...m, id: ID3, name: "MILD STEEL" }] }],
      ["the same machine name twice", { ...value, machines: [k, { ...value.machines[1], name: " haas vf-2" }] }],
      ["501 materials", { ...value, materials: Array.from({ length: COSTING_ROWS_MAX + 1 }, (_, i) => ({ ...m, id: newCostingId(), name: `M${i}` })) }],
    ];
    for (const [label, v] of bad) {
      expect(settingsProblem(v), label).not.toBeNull();
      expect(await saveCostingSettingsAtomic(client({}, calls), "org-1", loaded, v), label).toMatchObject({ ok: false, reason: "refused", notApplied: false });
    }
    expect(calls).toEqual([]);
    expect(settingsProblem(value)).toBeNull();
    expect(newCostingId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
