/**
 * The app side of the company's costing rates: reading them (through lib/costing/rates-store.ts, migration 143's tables under RLS), turning them
 * into the form the Settings card edits (pounds and percentages, blank = not entered), saying what is missing, and saving them in ONE step
 * through public.save_costing_settings_atomic(p_org, p_expected, p_value) (all materials, machines and the defaults, or nothing).
 *
 * No built-in rates: a company with no rows has blank rates (blankCostingRates). rates-store's BUILT_IN_COSTING_DEFAULTS is deliberately not used.
 *
 * Saving: p_expected is the snapshot read when the card loaded; if anyone changed the rates since, the function raises 40001 and nothing is
 * written (saveRates answers kind "stale"). The function is privileged (assert_privileged_aal): an admin whose company requires the second step
 * and whose session is not at aal2 is refused with 42501 / hint mfa_required, which becomes the shared "enter a fresh code" retry (sendWithCode).
 * Admin and office only, enforced by the function and the tables' RLS; the card also hides the editor from other roles.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { blankCostingRates, type CostingMachine, type CostingMaterial, type CostingRates } from "@/components/costing/types";
import type { SendAnswer } from "@/lib/mfa-step-up";
import { MFA_RECENT_CODE } from "@/lib/mfa-policy";
import { loadCostingRates, type CostingPartialRates, type CostingRates as StoredRates } from "@/lib/costing/rates-store";

export const NOT_SET_UP_MESSAGE = "No costing rates entered yet";
export const PANEL_NOT_SET_UP_MESSAGE = "Costing is not set up: enter your rates in Settings > Costing rates";
export const NOT_APPLIED_MESSAGE = "Not available until database update 143 is applied.";
export const STALE_MESSAGE = "Someone else changed the costing rates since you opened this page. Nothing was saved. Reload to see their changes, then make yours again.";
const PENCE_MAX = 10_000_000;
const NAME_MAX = 80;

/** The rows as the database holds them (what save_costing_settings_atomic compares p_expected with). */
export type RatesSnapshot = {
  materials: { id: string; name: string; price_pence: number; price_unit: "kg" | "each"; scrap_pct: number }[];
  machines: { id: string; name: string; hourly_rate_pence: number; labour_rate_pence: number | null }[];
  defaults: { labour_rate_pence: number; programming_rate_pence: number; overhead_pct: number; default_margin_pct: number } | null;
};
export const EMPTY_SNAPSHOT: RatesSnapshot = { materials: [], machines: [], defaults: null };

export type LoadedRates = { status: "ok"; rates: CostingRates; snapshot: RatesSnapshot } | { status: "not_applied" } | { status: "error"; message: string };

const pounds = (pence: number) => pence / 100;
const toPence = (value: number) => Math.round(value * 100);

/** The stored rows as the card shows them, plus the snapshot to send back as p_expected. */
export function fromStored(stored: StoredRates | CostingPartialRates): { rates: CostingRates; snapshot: RatesSnapshot } {
  const rates: CostingRates = {
    materials: stored.materials.map((m): CostingMaterial => ({ id: m.id, name: m.name, unit: m.priceUnit, price: pounds(m.pricePence), scrapPct: m.scrapPct })),
    machines: stored.machines.map((m): CostingMachine => ({ id: m.id, name: m.name, hourlyRate: pounds(m.hourlyRatePence), labourPerHour: m.labourRatePence === null ? null : pounds(m.labourRatePence) })),
    defaults: stored.defaults
      ? { labourPerHour: pounds(stored.defaults.labourRatePence), programmingPerHour: pounds(stored.defaults.programmingRatePence), overheadPct: stored.defaults.overheadPct, marginPct: stored.defaults.defaultMarginPct }
      : blankCostingRates.defaults,
  };
  const snapshot: RatesSnapshot = {
    materials: stored.materials.map((m) => ({ id: m.id, name: m.name, price_pence: m.pricePence, price_unit: m.priceUnit, scrap_pct: m.scrapPct })),
    machines: stored.machines.map((m) => ({ id: m.id, name: m.name, hourly_rate_pence: m.hourlyRatePence, labour_rate_pence: m.labourRatePence })),
    defaults: stored.defaults
      ? { labour_rate_pence: stored.defaults.labourRatePence, programming_rate_pence: stored.defaults.programmingRatePence, overhead_pct: stored.defaults.overheadPct, default_margin_pct: stored.defaults.defaultMarginPct }
      : null,
  };
  return { rates, snapshot };
}

/** Reads the company's rates (RLS scopes them). 143 not applied reads as "not_applied", quietly. */
export async function loadCompanyRates(client: SupabaseClient | null): Promise<LoadedRates> {
  const result = await loadCostingRates(client);
  if (result.status === "ok") return { status: "ok", ...fromStored(result.rates) };
  // Blank or half-entered: the rates store answers not_configured with what was entered so far; the page shows what is missing (ratesGaps), never a figure.
  if (result.status === "not_configured") return { status: "ok", ...fromStored(result.partial) };
  if (result.status === "not_applied") return { status: "not_applied" };
  return { status: "error", message: result.message };
}

export type RatesGaps = {
  /** Nothing entered at all: no material, no machine, none of the four company rates. */
  blank: boolean;
  /** Plain names of what still has to be entered; empty when pricing can work. */
  missing: string[];
};

const filled = (value: number | null) => value !== null && Number.isFinite(value);

/** What is missing before a part can be priced. Everything a price uses must have been entered by the company. */
export function ratesGaps(rates: CostingRates): RatesGaps {
  const d = rates.defaults;
  const none = !filled(d.labourPerHour) && !filled(d.programmingPerHour) && !filled(d.overheadPct) && !filled(d.marginPct);
  const blank = rates.materials.length === 0 && rates.machines.length === 0 && none;
  const missing: string[] = [];
  if (rates.materials.length === 0) missing.push("a material");
  if (rates.machines.length === 0) missing.push("a machine");
  if (!filled(d.labourPerHour)) missing.push("the labour rate");
  if (!filled(d.programmingPerHour)) missing.push("the programming rate");
  if (!filled(d.overheadPct)) missing.push("the overhead %");
  if (!filled(d.marginPct)) missing.push("the margin %");
  for (const m of rates.materials) if (!filled(m.price) || !filled(m.scrapPct) || !m.name.trim()) { missing.push(`the price and scrap of material ${m.name.trim() || "(no name)"}`); break; }
  for (const m of rates.machines) if (!filled(m.hourlyRate) || !m.name.trim()) { missing.push(`the hourly rate of machine ${m.name.trim() || "(no name)"}`); break; }
  return { blank, missing };
}

const wholePence = (value: number | null) => value !== null && Number.isFinite(value) && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6 && toPence(value) >= 0 && toPence(value) <= PENCE_MAX;
const percent = (value: number | null, min: number, max: number) => value !== null && Number.isFinite(value) && value >= min && value <= max && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
const nameOk = (name: string) => name.trim().length >= 1 && name.trim().length <= NAME_MAX && !/[\r\n]/.test(name);

/** Why these rates can't be saved yet (143's CHECKs, in words), or null. All four company rates are needed: the save writes the defaults as one row. */
export function ratesProblem(rates: CostingRates): string | null {
  for (const m of rates.materials) {
    if (!nameOk(m.name)) return `Give every material a name (up to ${NAME_MAX} characters, one line).`;
    if (!wholePence(m.price)) return `Enter the price of ${m.name.trim()} in pounds and pence, from £0 to £100,000.`;
    if (!percent(m.scrapPct, 0, 100)) return `Enter the scrap % of ${m.name.trim()}: 0 to 100 (0 if none).`;
  }
  for (const m of rates.machines) {
    if (!nameOk(m.name)) return `Give every machine a name (up to ${NAME_MAX} characters, one line).`;
    if (!wholePence(m.hourlyRate)) return `Enter the hourly rate of ${m.name.trim()} in pounds and pence, from £0 to £100,000.`;
    if (m.labourPerHour !== null && !wholePence(m.labourPerHour)) return `Enter the labour rate of ${m.name.trim()} in pounds and pence, or leave it blank to use the company labour rate.`;
  }
  const d = rates.defaults;
  if (!wholePence(d.labourPerHour)) return "Enter the labour rate per hour in pounds and pence, from £0 to £100,000.";
  if (!wholePence(d.programmingPerHour)) return "Enter the programming rate per hour in pounds and pence, from £0 to £100,000.";
  if (!percent(d.overheadPct, 100, 500)) return "Enter the overhead %: 100 means none, 150 means half as much again, up to 500.";
  if (!percent(d.marginPct, 0, 95)) return "Enter the margin %: 0 to 95.";
  const repeated = (names: string[]) => new Set(names.map((n) => n.trim())).size !== names.length;
  if (repeated(rates.materials.map((m) => m.name))) return "Two materials have the same name.";
  if (repeated(rates.machines.map((m) => m.name))) return "Two machines have the same name.";
  return null;
}

/** p_value: every material, every machine and the defaults, in whole pence. Only call when ratesProblem is null. */
export function toRpcValue(rates: CostingRates): RatesSnapshot & { defaults: NonNullable<RatesSnapshot["defaults"]> } {
  const d = rates.defaults;
  return {
    materials: rates.materials.map((m) => ({ id: m.id, name: m.name.trim(), price_pence: toPence(m.price ?? 0), price_unit: m.unit, scrap_pct: m.scrapPct ?? 0 })),
    machines: rates.machines.map((m) => ({ id: m.id, name: m.name.trim(), hourly_rate_pence: toPence(m.hourlyRate ?? 0), labour_rate_pence: m.labourPerHour === null ? null : toPence(m.labourPerHour) })),
    defaults: { labour_rate_pence: toPence(d.labourPerHour ?? 0), programming_rate_pence: toPence(d.programmingPerHour ?? 0), overhead_pct: d.overheadPct ?? 0, default_margin_pct: d.marginPct ?? 0 },
  };
}

export type SaveKind = "saved" | "stale" | "mfa" | "permission" | "invalid" | "not_applied" | "error";
export type SaveBody = { code?: string; kind: SaveKind; message: string };
type RpcError = { code?: string; message?: string; hint?: string; details?: string } | null | undefined;

const MESSAGES: Record<Exclude<SaveKind, "saved" | "mfa" | "stale">, string> = {
  permission: "You don't have permission to change costing rates. Ask an admin or office user.",
  invalid: "One of the rates isn't allowed. Check the values (pence up to £100,000, percentages in range, names not repeated) and try again.",
  not_applied: NOT_APPLIED_MESSAGE,
  error: "Couldn't save the costing rates. Nothing was changed. Try again.",
};

/** The database's refusal, as a kind the card can act on. */
export function classifySaveError(error: RpcError): Exclude<SaveKind, "saved"> {
  const code = String(error?.code ?? "");
  if (code === "40001") return "stale";
  if (code === "42501") return /mfa_required/.test(`${error?.hint ?? ""} ${error?.details ?? ""} ${error?.message ?? ""}`) ? "mfa" : "permission";
  if (["22023", "22P02", "22003", "23514", "23505", "23502"].includes(code)) return "invalid";
  if (code === "PGRST202" || code === "42883" || code === "42P01" || code === "PGRST205") return "not_applied";
  return "error";
}

/**
 * One atomic save. Answers in the shape sendWithCode wants: ok, or 403 {code: mfa_recent_required} when a fresh authenticator code is needed
 * (the card asks for it and sends the same save once more).
 */
export async function saveRates(client: SupabaseClient | null, organizationId: string, expected: RatesSnapshot, rates: CostingRates): Promise<SendAnswer<SaveBody>> {
  const problem = ratesProblem(rates);
  if (problem) return { ok: false, status: 400, body: { kind: "invalid", message: problem } };
  if (!client) return { ok: false, status: 503, body: { kind: "error", message: "Supabase is not configured." } };
  try {
    const { error } = await client.rpc("save_costing_settings_atomic", { p_org: organizationId, p_expected: expected, p_value: toRpcValue(rates) });
    if (!error) return { ok: true, status: 200, body: { kind: "saved", message: "Costing rates saved." } };
    const kind = classifySaveError(error);
    if (kind === "mfa") return { ok: false, status: 403, body: { kind, code: MFA_RECENT_CODE, message: "Enter a fresh authenticator code to save the costing rates." } };
    if (kind === "stale") return { ok: false, status: 409, body: { kind, message: STALE_MESSAGE } };
    return { ok: false, status: 400, body: { kind, message: MESSAGES[kind] } };
  } catch {
    return { ok: false, status: 0, body: { kind: "error", message: "Couldn't save the costing rates. Check your connection and try again." } };
  }
}
