/**
 * Pricing and profit, stage A1: the app side of the p172 table and functions, against a fake client (no network). Proves: a missing table or
 * function reads as "not available" quietly; no row reads as "not designated"; rows become inputs without inventing figures; errors become fixed
 * words (never the database text); writes go only through the two functions with the exact argument names. Example numbers are made up.
 */
import { describe, expect, it } from "vitest";

import { inputsFromRow, isNotApplied, loadOverview, loadPricingCosts, NOT_AVAILABLE_MESSAGE, savePricingCosts, setProfitViewer, valuesBody } from "@/lib/costing/pricing-costs-store";
import { EMPTY_COSTING } from "@/lib/costing/pricing-costs";

type Reply = { data?: unknown; error?: { code?: string; message?: string; hint?: string } | null };
function fake(reply: Reply) {
  const calls: { kind: "from" | "rpc"; name: string; args?: unknown }[] = [];
  const client = {
    from(name: string) { calls.push({ kind: "from", name }); return { select: () => ({ limit: async () => ({ data: reply.data ?? null, error: reply.error ?? null }) }) }; },
    rpc: async (name: string, args?: unknown) => { calls.push({ kind: "rpc", name, args }); return { data: reply.data ?? null, error: reply.error ?? null }; },
  };
  return { client: client as never, calls };
}

describe("not applied", () => {
  it("recognises a missing table or function", () => {
    for (const code of ["PGRST205", "PGRST202", "42P01", "42883"]) expect(isNotApplied({ code })).toBe(true);
    expect(isNotApplied({ message: "Could not find the function public.save_pricing_costs in the schema cache" })).toBe(true);
    expect(isNotApplied({ code: "42501" })).toBe(false);
    expect(isNotApplied(null)).toBe(false);
  });
  it("load, overview, save and designate all answer not available without throwing", async () => {
    const missing = { error: { code: "PGRST205", message: "x" } };
    expect(await loadPricingCosts(fake(missing).client)).toEqual({ status: "not_applied" });
    expect(await loadOverview(fake({ error: { code: "PGRST202" } }).client)).toEqual({ status: "not_applied" });
    expect(await savePricingCosts(fake({ error: { code: "PGRST202" } }).client, EMPTY_COSTING, 1)).toMatchObject({ kind: "not_applied", message: NOT_AVAILABLE_MESSAGE });
    expect(await setProfitViewer(fake({ error: { code: "42883" } }).client, null)).toMatchObject({ kind: "not_applied" });
  });
});

describe("load", () => {
  it("no row means not designated (stored null), not an error", async () => {
    expect(await loadPricingCosts(fake({ data: [] }).client)).toEqual({ status: "ok", stored: null });
  });
  it("a blank row gives empty inputs, never defaults", async () => {
    const row = { version: 1, men: null, hours_per_week: null, weeks_per_year: null, hourly_cost: null, yearly_target: null, profit_target_pct: null, running_costs: [] };
    expect(await loadPricingCosts(fake({ data: [row] }).client)).toEqual({ status: "ok", stored: { version: 1, inputs: EMPTY_COSTING } });
  });
  it("numeric strings from the database become numbers; unusable running costs are dropped", () => {
    const inputs = inputsFromRow({ men: 2, hours_per_week: "40.00", weeks_per_year: "50.00", hourly_cost: "10.00", yearly_target: null, profit_target_pct: "25.50",
      running_costs: [{ name: "Example rent", amount: 1000, period: "monthly" }, { name: "bad", amount: "x", period: "monthly" }, { name: "bad2", amount: 5, period: "weekly" }, null] });
    expect(inputs).toEqual({ men: 2, hoursPerWeek: 40, weeksPerYear: 50, hourlyCost: 10, yearlyTarget: null, profitTargetPct: 25.5, runningCosts: [{ name: "Example rent", amount: 1000, period: "monthly" }] });
  });
  it("another error is a fixed sentence, not the database text", async () => {
    const r = await loadPricingCosts(fake({ error: { code: "XX000", message: "secret internal detail" } }).client);
    expect(r).toEqual({ status: "error", message: "Couldn't load the costing figures. Try again." });
  });
});

describe("overview", () => {
  it("reads the designated person and the admins", async () => {
    const r = await loadOverview(fake({ data: { viewer: { id: "u1", name: "Example John" }, candidates: [{ id: "u1", name: "Example John" }, { id: "u2", name: "Example Admin" }, { bad: 1 }] } }).client);
    expect(r).toEqual({ status: "ok", overview: { viewer: { id: "u1", name: "Example John" }, candidates: [{ id: "u1", name: "Example John" }, { id: "u2", name: "Example Admin" }] } });
  });
  it("nobody designated, and a refusal", async () => {
    expect(await loadOverview(fake({ data: { viewer: null, candidates: [] } }).client)).toEqual({ status: "ok", overview: { viewer: null, candidates: [] } });
    expect(await loadOverview(fake({ error: { code: "42501" } }).client)).toEqual({ status: "refused" });
  });
});

describe("writes", () => {
  it("save goes only through save_pricing_costs with the version and every empty figure as null", async () => {
    const f = fake({ data: { version: 4 } });
    const r = await savePricingCosts(f.client, { ...EMPTY_COSTING, men: 2, runningCosts: [{ name: " Example rent ", amount: 100, period: "monthly" }] }, 3);
    expect(r).toEqual({ kind: "saved", message: "Costing figures saved.", version: 4 });
    expect(f.calls).toEqual([{ kind: "rpc", name: "save_pricing_costs", args: { p_values: { men: 2, hoursPerWeek: null, weeksPerYear: null, hourlyCost: null, yearlyTarget: null, profitTargetPct: null, runningCosts: [{ name: "Example rent", amount: 100, period: "monthly" }] }, p_base_version: 3 } }]);
  });
  it("designate goes only through set_pricing_profit_viewer", async () => {
    const f = fake({ data: { figures_cleared: true } });
    expect(await setProfitViewer(f.client, "u1")).toMatchObject({ kind: "saved", figuresCleared: true });
    expect(f.calls).toEqual([{ kind: "rpc", name: "set_pricing_profit_viewer", args: { p_user_id: "u1" } }]);
  });
  it("maps errors to fixed words", async () => {
    const kind = async (error: { code?: string; hint?: string; message?: string }) => (await savePricingCosts(fake({ error }).client, EMPTY_COSTING, 1)).kind;
    expect(await kind({ code: "40001", hint: "stale_version" })).toBe("stale");
    expect(await kind({ code: "42501", hint: "mfa_required" })).toBe("mfa");
    expect(await kind({ code: "42501" })).toBe("refused");
    expect(await kind({ code: "22023" })).toBe("invalid");
    expect(await kind({ code: "XX000", message: "boom" })).toBe("error");
    const shown = await savePricingCosts(fake({ error: { code: "XX000", message: "leaky database words" } }).client, EMPTY_COSTING, 1);
    expect(shown.message).not.toContain("leaky");
  });
  it("valuesBody never invents a figure", () => {
    expect(valuesBody(EMPTY_COSTING)).toEqual({ men: null, hoursPerWeek: null, weeksPerYear: null, hourlyCost: null, yearlyTarget: null, profitTargetPct: null, runningCosts: [] });
  });
});
