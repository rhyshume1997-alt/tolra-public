/**
 * Pricing and profit, stage A1: turns the Costing form's typed text into the figures (and back), with one plain-English error per box.
 * Inputs: the text in each box. Outputs: CostingInputs plus errors keyed by box. Must not change: a blank box is "not entered" (null), never zero
 * and never a default; a running-cost row with both name and amount blank is ignored; a half-filled row is an error. Pure: no React, no I/O.
 */
import { figureText, LIMITS, parseFigure, type CostingInputs, type RunningCost, type RunningCostPeriod } from "@/lib/costing/pricing-costs";

export type RunningCostRow = { key: string; name: string; amount: string; period: RunningCostPeriod };
export type CostingForm = {
  men: string; hoursPerWeek: string; weeksPerYear: string; hourlyCost: string; yearlyTarget: string; profitTargetPct: string;
  rows: RunningCostRow[];
};
export type FormErrors = Partial<Record<"men" | "hoursPerWeek" | "weeksPerYear" | "hourlyCost" | "yearlyTarget" | "profitTargetPct", string>> & { rows: Record<string, { name?: string; amount?: string }> };

export const EMPTY_FORM: CostingForm = { men: "", hoursPerWeek: "", weeksPerYear: "", hourlyCost: "", yearlyTarget: "", profitTargetPct: "", rows: [] };

let counter = 0;
export const newRowKey = (): string => `row-${Date.now().toString(36)}-${(counter += 1)}`;
export const blankRow = (): RunningCostRow => ({ key: newRowKey(), name: "", amount: "", period: "monthly" });

export function formFromInputs(inputs: CostingInputs): CostingForm {
  return {
    men: figureText(inputs.men), hoursPerWeek: figureText(inputs.hoursPerWeek), weeksPerYear: figureText(inputs.weeksPerYear), hourlyCost: figureText(inputs.hourlyCost),
    yearlyTarget: figureText(inputs.yearlyTarget), profitTargetPct: figureText(inputs.profitTargetPct),
    rows: inputs.runningCosts.map((c) => ({ key: newRowKey(), name: c.name, amount: figureText(c.amount), period: c.period })),
  };
}

export type FormResult = { inputs: CostingInputs; errors: FormErrors; valid: boolean };

/** Reads the boxes. `inputs` holds every box that parsed (so the break-even can update live); `valid` is true only when no box has an error. */
export function inputsFromForm(form: CostingForm): FormResult {
  const errors: FormErrors = { rows: {} };
  const figure = (key: "men" | "hoursPerWeek" | "weeksPerYear" | "hourlyCost" | "yearlyTarget" | "profitTargetPct", max: number, label: string, whole = false) => {
    const parsed = parseFigure(form[key], max, { whole, label });
    if (parsed.error) errors[key] = parsed.error;
    return parsed.value;
  };
  const men = figure("men", LIMITS.men, "Men on the shop floor", true);
  const hoursPerWeek = figure("hoursPerWeek", LIMITS.hoursPerWeek, "Hours per week per man");
  const weeksPerYear = figure("weeksPerYear", LIMITS.weeksPerYear, "Working weeks per year");
  const hourlyCost = figure("hourlyCost", LIMITS.hourlyCost, "Hourly cost per man");
  const yearlyTarget = figure("yearlyTarget", LIMITS.yearlyTarget, "Yearly target");
  const profitTargetPct = figure("profitTargetPct", LIMITS.profitPct, "Profit percent target");

  const runningCosts: RunningCost[] = [];
  const used = form.rows.filter((r) => r.name.trim() !== "" || r.amount.trim() !== "");
  if (used.length > LIMITS.runningCosts) errors.rows["*"] = { name: `Keep the list to ${LIMITS.runningCosts} running costs or fewer.` };
  for (const row of used) {
    const rowErrors: { name?: string; amount?: string } = {};
    const name = row.name.trim();
    if (name === "") rowErrors.name = "Give this cost a name.";
    else if (name.length > LIMITS.nameLength) rowErrors.name = `Keep the name to ${LIMITS.nameLength} characters or fewer.`;
    const amount = parseFigure(row.amount, LIMITS.runningAmount, { label: "The amount" });
    if (amount.error) rowErrors.amount = amount.error;
    else if (amount.value === null) rowErrors.amount = "Enter the amount.";
    if (rowErrors.name || rowErrors.amount) errors.rows[row.key] = rowErrors;
    else runningCosts.push({ name, amount: amount.value as number, period: row.period });
  }
  const valid = Object.keys(errors.rows).length === 0 && !(["men", "hoursPerWeek", "weeksPerYear", "hourlyCost", "yearlyTarget", "profitTargetPct"] as const).some((k) => errors[k]);
  return { inputs: { men, hoursPerWeek, weeksPerYear, hourlyCost, yearlyTarget, profitTargetPct, runningCosts }, errors, valid };
}
