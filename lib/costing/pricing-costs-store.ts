/**
 * Pricing and profit, stage A1: the app side of public.company_pricing_costs (proposal p172). Inputs: a Supabase client under the signed-in
 * person's own session. Outputs: the designated person's figures, the admin's designation overview, and save / designate calls with plain-English
 * results. READS go through the table (row-level security shows the row only to the designated person); WRITES go only through the p172
 * functions (save_pricing_costs, set_pricing_profit_viewer), which check the role, the second step and the designation themselves.
 * Must not change: never a service role, never an API route; a missing table or function reads as "not_applied" quietly (no error loop, no
 * toast); nothing here invents a figure (a blank row gives EMPTY inputs); database messages are never shown, only the fixed words below.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { type CostingInputs, type RunningCost, type ViewerCandidate } from "@/lib/costing/pricing-costs";

export const NOT_AVAILABLE_MESSAGE = "Costing is not available yet. It needs a database update first.";
export const STALE_MESSAGE = "These figures changed since you opened them. Nothing was saved. Reload to see the latest, then make your change again.";
export const MFA_MESSAGE = "Confirm your authenticator code first (the second step of sign-in), then try again.";
export const REFUSED_MESSAGE = "You can't change these figures.";
export const GENERIC_SAVE_MESSAGE = "Couldn't save. Nothing was changed. Try again.";

type DbError = { code?: string; message?: string; hint?: string; details?: string } | null | undefined;
type Client = Pick<SupabaseClient, "from" | "rpc">;

/** True when the table or function is not there yet (migration not applied). */
export function isNotApplied(error: DbError): boolean {
  const code = String(error?.code ?? "");
  const text = String(error?.message ?? "");
  return code === "PGRST205" || code === "PGRST202" || code === "PGRST204" || code === "42P01" || code === "42883" || code === "42703"
    || (/(company_pricing_costs|save_pricing_costs|set_pricing_profit_viewer|pricing_costs_overview)/.test(text) && /(does not exist|could not find|schema cache)/i.test(text));
}

export type SaveKind = "saved" | "stale" | "mfa" | "refused" | "invalid" | "not_applied" | "error";
export type WriteResult = { kind: SaveKind; message: string; version?: number };

function classify(error: DbError): WriteResult {
  if (isNotApplied(error)) return { kind: "not_applied", message: NOT_AVAILABLE_MESSAGE };
  const code = String(error?.code ?? "");
  const hint = String(error?.hint ?? "");
  if (code === "40001" || hint === "stale_version") return { kind: "stale", message: STALE_MESSAGE };
  if (code === "42501" && hint === "mfa_required") return { kind: "mfa", message: MFA_MESSAGE };
  if (code === "42501") return { kind: "refused", message: REFUSED_MESSAGE };
  if (code === "22023" || code === "23514") return { kind: "invalid", message: "Check the figures and try again. Nothing was saved." };
  return { kind: "error", message: GENERIC_SAVE_MESSAGE };
}

export type StoredCosting = { version: number; inputs: CostingInputs };
export type LoadResult = { status: "ok"; stored: StoredCosting | null } | { status: "not_applied" } | { status: "error"; message: string };

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The table row as the app's inputs. Anything unusable in a stored running cost is dropped. */
export function inputsFromRow(row: Record<string, unknown>): CostingInputs {
  const raw = Array.isArray(row.running_costs) ? row.running_costs : [];
  const runningCosts: RunningCost[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const e = item as Record<string, unknown>;
    const amount = num(e.amount);
    if (typeof e.name !== "string" || amount === null || (e.period !== "monthly" && e.period !== "yearly")) continue;
    runningCosts.push({ name: e.name, amount, period: e.period });
  }
  return {
    men: num(row.men), hoursPerWeek: num(row.hours_per_week), weeksPerYear: num(row.weeks_per_year), hourlyCost: num(row.hourly_cost),
    yearlyTarget: num(row.yearly_target), profitTargetPct: num(row.profit_target_pct), runningCosts,
  };
}

/** Reads the signed-in person's row. Row-level security returns it only to the designated person: no row means "you are not designated" (or nobody is). */
export async function loadPricingCosts(client: Client | null): Promise<LoadResult> {
  if (!client) return { status: "error", message: "Couldn't load the costing figures. Try again." };
  try {
    const { data, error } = await client.from("company_pricing_costs").select("version, men, hours_per_week, weeks_per_year, hourly_cost, yearly_target, profit_target_pct, running_costs").limit(1);
    if (error) return isNotApplied(error) ? { status: "not_applied" } : { status: "error", message: "Couldn't load the costing figures. Try again." };
    const row = Array.isArray(data) ? data[0] : null;
    if (!row) return { status: "ok", stored: null };
    const r = row as Record<string, unknown>;
    return { status: "ok", stored: { version: Number(r.version) || 0, inputs: inputsFromRow(r) } };
  } catch {
    return { status: "error", message: "Couldn't load the costing figures. Try again." };
  }
}

export type Overview = { viewer: ViewerCandidate | null; candidates: ViewerCandidate[] };
export type OverviewResult = { status: "ok"; overview: Overview } | { status: "not_applied" } | { status: "refused" } | { status: "error"; message: string };

const candidate = (v: unknown): ViewerCandidate | null => {
  if (!v || typeof v !== "object") return null;
  const e = v as Record<string, unknown>;
  return typeof e.id === "string" && typeof e.name === "string" ? { id: e.id, name: e.name } : null;
};

/** Admin only: who is designated now and who can be chosen. A non-admin is refused by the database (status "refused"). */
export async function loadOverview(client: Client | null): Promise<OverviewResult> {
  if (!client) return { status: "error", message: "Couldn't load who can see profit. Try again." };
  try {
    const { data, error } = await client.rpc("pricing_costs_overview");
    if (error) {
      if (isNotApplied(error)) return { status: "not_applied" };
      if (String(error.code) === "42501") return { status: "refused" };
      return { status: "error", message: "Couldn't load who can see profit. Try again." };
    }
    const d = (data ?? {}) as Record<string, unknown>;
    const candidates = (Array.isArray(d.candidates) ? d.candidates : []).map(candidate).filter((c): c is ViewerCandidate => c !== null);
    return { status: "ok", overview: { viewer: candidate(d.viewer), candidates } };
  } catch {
    return { status: "error", message: "Couldn't load who can see profit. Try again." };
  }
}

/** Designates the one person who can see profit (null = nobody). Any change blanks the saved figures (the database does this). */
export async function setProfitViewer(client: Client | null, userId: string | null): Promise<WriteResult & { figuresCleared?: boolean }> {
  if (!client) return { kind: "error", message: GENERIC_SAVE_MESSAGE };
  try {
    const { data, error } = await client.rpc("set_pricing_profit_viewer", { p_user_id: userId });
    if (error) return classify(error);
    return { kind: "saved", message: "Saved.", figuresCleared: Boolean((data as Record<string, unknown> | null)?.figures_cleared) };
  } catch {
    return { kind: "error", message: GENERIC_SAVE_MESSAGE };
  }
}

/** The body the database function takes: null for an empty figure. Entered numbers only; never a default. */
export function valuesBody(inputs: CostingInputs) {
  return {
    men: inputs.men, hoursPerWeek: inputs.hoursPerWeek, weeksPerYear: inputs.weeksPerYear, hourlyCost: inputs.hourlyCost,
    yearlyTarget: inputs.yearlyTarget, profitTargetPct: inputs.profitTargetPct,
    runningCosts: inputs.runningCosts.map((c) => ({ name: c.name.trim(), amount: c.amount, period: c.period })),
  };
}

/** Saves all the figures in one call; `baseVersion` is the version read when the form opened (a newer one is refused as stale). */
export async function savePricingCosts(client: Client | null, inputs: CostingInputs, baseVersion: number): Promise<WriteResult> {
  if (!client) return { kind: "error", message: GENERIC_SAVE_MESSAGE };
  try {
    const { data, error } = await client.rpc("save_pricing_costs", { p_values: valuesBody(inputs), p_base_version: baseVersion });
    if (error) return classify(error);
    return { kind: "saved", message: "Costing figures saved.", version: Number((data as Record<string, unknown> | null)?.version) || baseVersion + 1 };
  } catch {
    return { kind: "error", message: GENERIC_SAVE_MESSAGE };
  }
}
