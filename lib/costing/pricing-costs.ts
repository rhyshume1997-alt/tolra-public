/**
 * Pricing and profit, stage A1: the pure rules behind Settings > Costing. Inputs: what the designated person has entered (every figure may be
 * empty). Outputs: the monthly running-cost total, the business year, the break-even hourly rate, the rate for a chosen profit percent, text
 * parsing for the form, and who may see profit. Nothing here reads or writes anything.
 * Must not change: no built-in figure of any kind (an empty input gives NO number, never a default or a zero); profit is what is left before
 * dividends (the owner's own pay is not a cost); the business year runs 1 December to 30 November; the break-even and profit rates are
 * calculated, never stored; only the one designated admin sees the figures. Tests use made-up example numbers only.
 */

export type RunningCostPeriod = "monthly" | "yearly";
export type RunningCost = { name: string; amount: number; period: RunningCostPeriod };

/** Every figure is null (not entered) until the designated person enters it. */
export type CostingInputs = {
  men: number | null;
  hoursPerWeek: number | null;
  weeksPerYear: number | null;
  hourlyCost: number | null;
  yearlyTarget: number | null;
  profitTargetPct: number | null;
  runningCosts: RunningCost[];
};

export const EMPTY_COSTING: CostingInputs = { men: null, hoursPerWeek: null, weeksPerYear: null, hourlyCost: null, yearlyTarget: null, profitTargetPct: null, runningCosts: [] };

export const ENTER_RATES_MESSAGE = "Enter your rates in Settings";
export const PROFIT_BASIS_NOTE = "profit before dividends";

export const LIMITS = { men: 200, hoursPerWeek: 168, weeksPerYear: 53, hourlyCost: 100_000, yearlyTarget: 100_000_000_000, profitPct: 100, runningCosts: 100, runningAmount: 1_000_000_000, nameLength: 100 } as const;

const finite = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Running costs per month: yearly entries are divided by 12. Null until at least one cost is entered (no list = no figure). */
export function monthlyRunningTotal(costs: readonly RunningCost[]): number | null {
  const valid = costs.filter((c) => finite(c.amount) && c.amount >= 0);
  if (valid.length === 0) return null;
  return round2(valid.reduce((sum, c) => sum + (c.period === "yearly" ? c.amount / 12 : c.amount), 0));
}

/** Running costs per year (monthly entries times 12). Null until at least one cost is entered. */
export function yearlyRunningTotal(costs: readonly RunningCost[]): number | null {
  const monthly = monthlyRunningTotal(costs);
  if (monthly === null) return null;
  const valid = costs.filter((c) => finite(c.amount) && c.amount >= 0);
  return round2(valid.reduce((sum, c) => sum + (c.period === "yearly" ? c.amount : c.amount * 12), 0));
}

export type BusinessYear = { start: string; end: string; label: string };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The business year containing `date` (local date): 1 December to 30 November. 30 November is the last day, 1 December starts the next year. */
export function businessYear(date: Date): BusinessYear {
  const startYear = date.getMonth() === 11 ? date.getFullYear() : date.getFullYear() - 1;
  const endYear = startYear + 1;
  return { start: `${startYear}-12-01`, end: `${endYear}-11-30`, label: `1 December ${startYear} to 30 November ${endYear}` };
}

/** True when the ISO date (yyyy-mm-dd) is inside the business year. */
export function inBusinessYear(isoDate: string, year: BusinessYear): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(isoDate) && isoDate >= year.start && isoDate <= year.end;
}

export const monthName = (monthIndex: number) => MONTHS[monthIndex] ?? "";

/** Hours the shop floor can work in a year (men x hours x weeks); null unless all three are entered and above zero. */
export function yearlyCapacityHours(inputs: CostingInputs): number | null {
  const { men, hoursPerWeek, weeksPerYear } = inputs;
  if (!finite(men) || !finite(hoursPerWeek) || !finite(weeksPerYear)) return null;
  const hours = men * hoursPerWeek * weeksPerYear;
  return hours > 0 ? hours : null;
}

/**
 * The hourly rate that covers wages plus running costs: (wages + running costs) / hours, where wages = hours x the hourly cost per man.
 * Null (show "Enter your rates in Settings", no number) unless the crew, hours, weeks, hourly cost AND at least one running cost are entered.
 * John's own pay is dividends, so it is not in this figure. Never stored.
 */
export function breakEvenRate(inputs: CostingInputs): number | null {
  const hours = yearlyCapacityHours(inputs);
  const running = yearlyRunningTotal(inputs.runningCosts);
  if (hours === null || running === null || !finite(inputs.hourlyCost) || inputs.hourlyCost < 0) return null;
  return round2((hours * inputs.hourlyCost + running) / hours);
}

/** The hourly rate that leaves `profitPct` percent of the price as profit before dividends: break-even / (1 - pct/100). Null when there is no break-even or the percent is not 0 up to (but not including) 100. */
export function rateForProfitPercent(inputs: CostingInputs, profitPct: number | null): number | null {
  const base = breakEvenRate(inputs);
  if (base === null || !finite(profitPct) || profitPct < 0 || profitPct >= 100) return null;
  return round2(base / (1 - profitPct / 100));
}

export type ParsedNumber = { value: number | null; error?: string };

/** A typed figure: blank is "not entered" (null, no error); thousands commas are allowed; otherwise it must be a plain non-negative number within [0, max]. */
export function parseFigure(text: string, max: number, opts: { whole?: boolean; label?: string } = {}): ParsedNumber {
  const label = opts.label ?? "This figure";
  const trimmed = text.trim();
  if (trimmed === "") return { value: null };
  const plain = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed) ? trimmed.replace(/,/g, "") : trimmed;
  if (!/^(\d+\.?\d*|\.\d+)$/.test(plain)) return { value: null, error: `${label} must be a number, for example 12.50.` };
  const value = Number(plain);
  if (!Number.isFinite(value)) return { value: null, error: `${label} must be a number, for example 12.50.` };
  if (opts.whole && !Number.isInteger(value)) return { value: null, error: `${label} must be a whole number.` };
  if (value > max) return { value: null, error: `${label} can't be more than ${max.toLocaleString("en-GB")}.` };
  return { value };
}

/** What a stored figure looks like in its box: empty for null, otherwise the plain number. */
export const figureText = (n: number | null | undefined): string => (finite(n) ? String(n) : "");

export type MoneyFormat = (n: number) => string;
/** Pounds with pence, UK style. */
export const formatPounds: MoneyFormat = (n) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Why the break-even cannot be shown yet, in the owner's words: always the same line, so a missing input never reads as zero. */
export function breakEvenMessage(inputs: CostingInputs): string | null {
  return breakEvenRate(inputs) === null ? ENTER_RATES_MESSAGE : null;
}

/** Whether a stored running-cost list or figure set has anything entered. */
export function hasAnyFigure(inputs: CostingInputs): boolean {
  return inputs.men !== null || inputs.hoursPerWeek !== null || inputs.weeksPerYear !== null || inputs.hourlyCost !== null
    || inputs.yearlyTarget !== null || inputs.profitTargetPct !== null || inputs.runningCosts.length > 0;
}

// ---- Who may see profit -----------------------------------------------------------------------------------------------------------

/** ONE designated admin sees and edits the figures: nobody when none is designated, and no other admin. The database enforces the same (row-level security). */
export function canSeeProfit(designatedUserId: string | null | undefined, userId: string | null | undefined, role: string | null | undefined): boolean {
  return Boolean(designatedUserId) && Boolean(userId) && designatedUserId === userId && role === "admin";
}

/** Only an admin changes who is designated. */
export function canChangeProfitViewer(role: string | null | undefined): boolean {
  return role === "admin";
}

export type ViewerCandidate = { id: string; name: string };

/** The person chosen must be one of the listed active admins; an empty choice clears the designation (nobody sees profit). */
export function checkViewerChoice(choice: string, candidates: readonly ViewerCandidate[]): { ok: true; userId: string | null } | { ok: false; error: string } {
  if (choice === "") return { ok: true, userId: null };
  if (!candidates.some((c) => c.id === choice)) return { ok: false, error: "Choose one of the admins in the list." };
  return { ok: true, userId: choice };
}

/** True when changing the designation from `current` to `next` blanks the saved figures (any change does, so a newly chosen person never inherits the previous person's numbers). */
export function viewerChangeClearsFigures(current: string | null, next: string | null): boolean {
  return (current ?? null) !== (next ?? null);
}
