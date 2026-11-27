/**
 * Pricing and profit, stage A1: the pure rules (lib/costing/pricing-costs.ts, costing-switch.ts, pricing-costs-form.ts).
 * Every number below is a MADE-UP EXAMPLE for the arithmetic; none is a real rate, headcount or target for any company.
 */
import { describe, expect, it } from "vitest";

import { canSwitchPricingCosts, nextPricingCostsHiddenNav, pricingCostsEnabled, PRICING_COSTS_ON_MARKER } from "@/lib/costing/costing-switch";
import {
  breakEvenRate, breakEvenMessage, businessYear, canChangeProfitViewer, canSeeProfit, checkViewerChoice, EMPTY_COSTING, ENTER_RATES_MESSAGE, hasAnyFigure,
  inBusinessYear, monthlyRunningTotal, parseFigure, rateForProfitPercent, viewerChangeClearsFigures, yearlyCapacityHours, yearlyRunningTotal, type CostingInputs,
} from "@/lib/costing/pricing-costs";
import { EMPTY_FORM, formFromInputs, inputsFromForm } from "@/lib/costing/pricing-costs-form";

// EXAMPLE figures (made up): 2 men, 40 hours, 50 weeks = 4,000 hours a year; 10.00 an hour each; running costs 1,000 a month and 2,400 a year.
const EXAMPLE: CostingInputs = {
  men: 2, hoursPerWeek: 40, weeksPerYear: 50, hourlyCost: 10, yearlyTarget: null, profitTargetPct: null,
  runningCosts: [{ name: "Example rent", amount: 1000, period: "monthly" }, { name: "Example insurance", amount: 2400, period: "yearly" }],
};

describe("the switch", () => {
  it("is off by default and on only with the marker", () => {
    expect(PRICING_COSTS_ON_MARKER).toBe("pricing-costs:on");
    for (const nav of [[], undefined, null, ["customers"], ["pricing-costs"]] as (string[] | null | undefined)[]) expect(pricingCostsEnabled(nav)).toBe(false);
    expect(pricingCostsEnabled(["customers", PRICING_COSTS_ON_MARKER])).toBe(true);
  });
  it("only an admin may switch it", () => {
    expect(canSwitchPricingCosts("admin")).toBe(true);
    for (const r of ["office", "workshop", "viewer", "", null, undefined]) expect(canSwitchPricingCosts(r)).toBe(false);
  });
  it("adds or removes only the marker, keeps the order, never mutates", () => {
    const start = Object.freeze(["customers", "iso-templates:on"]);
    const on = nextPricingCostsHiddenNav(start, true);
    expect(on).toEqual(["customers", "iso-templates:on", PRICING_COSTS_ON_MARKER]);
    expect(nextPricingCostsHiddenNav(on, true)).toEqual(on);
    expect(nextPricingCostsHiddenNav(on, false)).toEqual([...start]);
  });
});

describe("no default figure", () => {
  it("starts with every figure empty", () => {
    expect(EMPTY_COSTING).toEqual({ men: null, hoursPerWeek: null, weeksPerYear: null, hourlyCost: null, yearlyTarget: null, profitTargetPct: null, runningCosts: [] });
    expect(hasAnyFigure(EMPTY_COSTING)).toBe(false);
    expect(EMPTY_FORM).toEqual({ men: "", hoursPerWeek: "", weeksPerYear: "", hourlyCost: "", yearlyTarget: "", profitTargetPct: "", rows: [] });
    expect(formFromInputs(EMPTY_COSTING)).toMatchObject({ men: "", hoursPerWeek: "", weeksPerYear: "", hourlyCost: "" });
  });
  it("empty inputs give no number anywhere", () => {
    expect(monthlyRunningTotal([])).toBeNull();
    expect(yearlyRunningTotal([])).toBeNull();
    expect(yearlyCapacityHours(EMPTY_COSTING)).toBeNull();
    expect(breakEvenRate(EMPTY_COSTING)).toBeNull();
    expect(rateForProfitPercent(EMPTY_COSTING, 30)).toBeNull();
    expect(breakEvenMessage(EMPTY_COSTING)).toBe("Enter your rates in Settings");
    expect(ENTER_RATES_MESSAGE).toBe("Enter your rates in Settings");
  });
  it("any one missing input gives no break-even (never a zero)", () => {
    for (const key of ["men", "hoursPerWeek", "weeksPerYear", "hourlyCost"] as const) expect(breakEvenRate({ ...EXAMPLE, [key]: null })).toBeNull();
    expect(breakEvenRate({ ...EXAMPLE, runningCosts: [] })).toBeNull();
    for (const key of ["men", "hoursPerWeek", "weeksPerYear"] as const) expect(breakEvenRate({ ...EXAMPLE, [key]: 0 })).toBeNull();
  });
});

describe("running costs", () => {
  it("monthly total divides yearly entries by 12", () => {
    expect(monthlyRunningTotal(EXAMPLE.runningCosts)).toBe(1200);
    expect(yearlyRunningTotal(EXAMPLE.runningCosts)).toBe(14400);
    expect(monthlyRunningTotal([{ name: "x", amount: 100, period: "yearly" }])).toBe(8.33);
  });
  it("a cost of zero is an entered cost", () => {
    expect(monthlyRunningTotal([{ name: "Example", amount: 0, period: "monthly" }])).toBe(0);
  });
});

describe("break-even and the profit rate", () => {
  it("covers wages plus running costs over the hours", () => {
    expect(yearlyCapacityHours(EXAMPLE)).toBe(4000);
    // wages 4000 x 10 = 40,000; running 14,400; total 54,400 / 4,000 hours = 13.60
    expect(breakEvenRate(EXAMPLE)).toBe(13.6);
  });
  it("the profit rate is a percent of the price: break-even / (1 - pct)", () => {
    expect(rateForProfitPercent(EXAMPLE, 0)).toBe(13.6);
    expect(rateForProfitPercent(EXAMPLE, 20)).toBe(17);
    expect(rateForProfitPercent(EXAMPLE, 50)).toBe(27.2);
  });
  it("refuses a missing or impossible percent", () => {
    for (const p of [null, -1, 100, 150, Number.NaN]) expect(rateForProfitPercent(EXAMPLE, p as number | null)).toBeNull();
  });
  it("does not count the owner's pay (no input for it) and does not mutate", () => {
    const frozen = Object.freeze({ ...EXAMPLE });
    expect(breakEvenRate(frozen)).toBe(13.6);
  });
});

describe("the business year runs 1 December to 30 November", () => {
  it("bounds", () => {
    expect(businessYear(new Date(2026, 11, 1))).toEqual({ start: "2026-12-01", end: "2027-11-30", label: "1 December 2026 to 30 November 2027" });
    expect(businessYear(new Date(2026, 10, 30))).toMatchObject({ start: "2025-12-01", end: "2026-11-30" });
    expect(businessYear(new Date(2026, 10, 26))).toMatchObject({ start: "2025-12-01", end: "2026-11-30" });
    expect(businessYear(new Date(2027, 0, 1))).toMatchObject({ start: "2026-12-01", end: "2027-11-30" });
    expect(businessYear(new Date(2028, 1, 29))).toMatchObject({ start: "2027-12-01", end: "2028-11-30" });
    expect(businessYear(new Date(2026, 11, 31))).toMatchObject({ start: "2026-12-01", end: "2027-11-30" });
  });
  it("inBusinessYear includes both ends and nothing outside", () => {
    const y = businessYear(new Date(2026, 5, 15));
    expect(inBusinessYear("2025-12-01", y)).toBe(true);
    expect(inBusinessYear("2026-11-30", y)).toBe(true);
    expect(inBusinessYear("2025-11-30", y)).toBe(false);
    expect(inBusinessYear("2026-12-01", y)).toBe(false);
    expect(inBusinessYear("not a date", y)).toBe(false);
  });
});

describe("typed figures", () => {
  it("blank is not entered, never zero", () => {
    expect(parseFigure("", 100)).toEqual({ value: null });
    expect(parseFigure("   ", 100)).toEqual({ value: null });
    expect(parseFigure("0", 100)).toEqual({ value: 0 });
  });
  it("accepts plain numbers and thousands commas, refuses the rest", () => {
    expect(parseFigure("12.5", 100).value).toBe(12.5);
    expect(parseFigure("1,234.50", 10000).value).toBe(1234.5);
    for (const bad of ["abc", "-1", "1e3", "1,2", "12..3", "£5", "NaN", "Infinity"]) expect(parseFigure(bad, 1e6).error, bad).toBeTruthy();
    expect(parseFigure("2.5", 10, { whole: true }).error).toBe("This figure must be a whole number.");
    expect(parseFigure("11", 10).error).toMatch(/more than 10/);
  });
  it("the form reads boxes, ignores empty rows, flags half-filled rows, and is valid only without errors", () => {
    const ok = inputsFromForm({ ...EMPTY_FORM, men: "2", hoursPerWeek: "40", rows: [{ key: "a", name: "Example rent", amount: "1,000", period: "monthly" }, { key: "b", name: "", amount: "", period: "monthly" }] });
    expect(ok.valid).toBe(true);
    expect(ok.inputs.men).toBe(2);
    expect(ok.inputs.hourlyCost).toBeNull();
    expect(ok.inputs.runningCosts).toEqual([{ name: "Example rent", amount: 1000, period: "monthly" }]);
    const bad = inputsFromForm({ ...EMPTY_FORM, men: "2.5", rows: [{ key: "a", name: "Example", amount: "", period: "yearly" }, { key: "b", name: "", amount: "5", period: "monthly" }] });
    expect(bad.valid).toBe(false);
    expect(bad.errors.men).toMatch(/whole number/);
    expect(bad.errors.rows.a?.amount).toBe("Enter the amount.");
    expect(bad.errors.rows.b?.name).toBe("Give this cost a name.");
    expect(inputsFromForm(formFromInputs(EXAMPLE)).inputs).toEqual(EXAMPLE);
  });
});

describe("who can see profit", () => {
  const JOHN = "00000000-0000-4000-8000-000000000301";
  const OTHER = "00000000-0000-4000-8000-000000000302";
  it("only the one designated admin; nobody when none is set; not other admins", () => {
    expect(canSeeProfit(JOHN, JOHN, "admin")).toBe(true);
    expect(canSeeProfit(JOHN, OTHER, "admin")).toBe(false);
    expect(canSeeProfit(null, JOHN, "admin")).toBe(false);
    expect(canSeeProfit(undefined, undefined, "admin")).toBe(false);
    expect(canSeeProfit("", "", "admin")).toBe(false);
    for (const role of ["office", "workshop", "viewer", null, undefined, ""]) expect(canSeeProfit(JOHN, JOHN, role)).toBe(false);
  });
  it("only an admin changes the designation, and only to a listed admin or nobody", () => {
    expect(canChangeProfitViewer("admin")).toBe(true);
    for (const role of ["office", "workshop", "viewer", null, undefined]) expect(canChangeProfitViewer(role)).toBe(false);
    const list = [{ id: JOHN, name: "Example John" }];
    expect(checkViewerChoice("", list)).toEqual({ ok: true, userId: null });
    expect(checkViewerChoice(JOHN, list)).toEqual({ ok: true, userId: JOHN });
    expect(checkViewerChoice(OTHER, list)).toEqual({ ok: false, error: "Choose one of the admins in the list." });
  });
  it("any change of person (or clearing) blanks the saved figures; choosing the same person does not", () => {
    expect(viewerChangeClearsFigures(JOHN, OTHER)).toBe(true);
    expect(viewerChangeClearsFigures(JOHN, null)).toBe(true);
    expect(viewerChangeClearsFigures(null, JOHN)).toBe(true);
    expect(viewerChangeClearsFigures(JOHN, JOHN)).toBe(false);
    expect(viewerChangeClearsFigures(null, null)).toBe(false);
  });
});
