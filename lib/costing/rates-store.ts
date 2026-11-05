/**
 * Loading and saving a company's costing rates (migration 143: public.costing_materials, public.costing_machines,
 * public.costing_defaults). Works with any Supabase client: the browser's (Settings > Costing rates, the Quote Builder's costing
 * calculation) or a server one. Row level security does the scoping: the company's admin and office read and write its rows; workshop,
 * viewer and other companies see none. organization_id is still sent on writes (the policies check it is the caller's company).
 *
 * NO RATE IS BUILT IN. Nothing here (or in 143) supplies a price, an hourly rate, a scrap allowance, an overhead or a margin: the company enters
 * every figure in Settings. A company with no defaults row, or no machine, or no material is NOT CONFIGURED: loadCostingRates answers
 * { status: "not_configured", missing, partial } (costing is off; show what is missing, never a figure worked out from guessed rates), and only a
 * complete set comes back as { status: "ok", rates } for the calculation to use.
 *
 * Money is whole pence (GBP), as stored. Percentages are as stored (a scrap of 5 means 5%; an overhead of 150 means the engine's multiplier 1.5;
 * a margin of 20 means 20%: examples of the units, not defaults). The engine works in pounds and fractions: cost_per_lb = pricePence / 100 (per kg or each), machine_rate_per_hr =
 * hourlyRatePence / 100, labor_rate_per_hr = (labourRatePence ?? defaults.labourRatePence) / 100, programming_rate_per_hr =
 * programmingRatePence / 100 (first-article inspection is charged at it too, as in the engine), scrap_factor = scrapPct / 100,
 * overhead_rate_pct = overheadPct / 100, margin_pct = marginPct / 100.
 *
 * 143 not applied yet (production applies migrations by hand after the app deploys): every read answers "not_applied" quietly (no
 * throw, no console line), so costing reads as off; every write answers notApplied.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const COSTING_NOT_APPLIED_MESSAGE = "Not available until database update 143 is applied.";
/** 143's CHECKs: whole pence 0 to 10,000,000 (GBP 100,000); names 1 to 80 characters on one line. */
export const COSTING_PENCE_MAX = 10_000_000;
export const COSTING_NAME_MAX = 80;

export type CostingPriceUnit = "kg" | "each";
export type CostingMaterial = { id: string; name: string; pricePence: number; priceUnit: CostingPriceUnit; scrapPct: number; updatedAt: string | null };
export type CostingMachine = { id: string; name: string; hourlyRatePence: number; labourRatePence: number | null; updatedAt: string | null };
export type CostingDefaults = { labourRatePence: number; programmingRatePence: number; overheadPct: number; defaultMarginPct: number; updatedAt: string | null };

export type CostingMaterialInput = { id?: string; name: string; pricePence: number; priceUnit: CostingPriceUnit; scrapPct: number };
export type CostingMachineInput = { id?: string; name: string; hourlyRatePence: number; labourRatePence: number | null };
export type CostingDefaultsInput = Omit<CostingDefaults, "updatedAt">;

/** What a company still has to enter before costing can be on. Order: the company's defaults row, a machine, a material. */
export type CostingMissing = "defaults" | "machines" | "materials";
/** Whatever the company has entered so far: defaults is null until it saves its defaults row. Fine for editing, never for calculating. */
export type CostingPartialRates = { materials: CostingMaterial[]; machines: CostingMachine[]; defaults: CostingDefaults | null };
/** A COMPLETE set: the defaults row and at least one machine and one material. The only shape the calculation may be given. */
export type CostingRates = { materials: CostingMaterial[]; machines: CostingMachine[]; defaults: CostingDefaults };
export type LoadCostingRatesResult =
  | { status: "ok"; rates: CostingRates }
  | { status: "not_configured"; missing: CostingMissing[]; partial: CostingPartialRates }
  | { status: "not_applied" }
  | { status: "error"; message: string };
export type SaveCostingResult<T> = { ok: true; row: T } | { ok: false; notApplied: boolean; message: string };
export type DeleteCostingResult = { ok: true } | { ok: false; notApplied: boolean; message: string };

type DbError = { code?: string; message?: string } | null | undefined;
type Row = Record<string, unknown>;

const MATERIAL_COLUMNS = "id, name, price_pence, price_unit, scrap_pct, updated_at";
const MACHINE_COLUMNS = "id, name, hourly_rate_pence, labour_rate_pence, updated_at";
const DEFAULTS_COLUMNS = "labour_rate_pence, programming_rate_pence, overhead_pct, default_margin_pct, updated_at";

/** A costing table (or a column of it) is not there: PostgREST's schema cache answer, or Postgres's own. */
export function isCostingNotAppliedError(error: DbError): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "PGRST205" || code === "PGRST204" || code === "42P01" || code === "42703") return true;
  return /costing_(materials|machines|defaults)/.test(String(error.message ?? "")) && /(does not exist|could not find|schema cache)/i.test(String(error.message ?? ""));
}

/** What the company has still to enter (empty = configured). Costing is on only when this is empty. */
export function costingMissing(rates: CostingPartialRates): CostingMissing[] {
  const missing: CostingMissing[] = [];
  if (!rates.defaults) missing.push("defaults");
  if (rates.machines.length === 0) missing.push("machines");
  if (rates.materials.length === 0) missing.push("materials");
  return missing;
}

/** Costing is on for the company only with its defaults row, at least one machine and at least one material. */
export function costingEnabled(rates: CostingPartialRates): rates is CostingRates {
  return costingMissing(rates).length === 0;
}

/** Plain words for what is missing, for the screen that says costing is off. */
export function costingMissingMessage(missing: CostingMissing[]): string {
  const parts = missing.map((m) => (m === "defaults" ? "your default rates (labour, programming, overhead, margin)" : m === "machines" ? "at least one machine" : "at least one material"));
  if (parts.length === 0) return "";
  return `Costing is off until you enter ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`} in Settings.`;
}

/** The partial rates behind a load, for the settings screen: whatever has been entered, or null when 143 is not applied or the load failed. */
export function ratesForEditing(result: LoadCostingRatesResult): CostingPartialRates | null {
  return result.status === "ok" ? result.rates : result.status === "not_configured" ? result.partial : null;
}

/** The labour rate an operation on this machine uses: the machine's own, else the company default, else null (no rate: never a guessed one). */
export function machineLabourRatePence(machine: Pick<CostingMachine, "labourRatePence">, defaults: Pick<CostingDefaultsInput, "labourRatePence"> | null): number | null {
  return machine.labourRatePence ?? defaults?.labourRatePence ?? null;
}

const num = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

function toMaterial(row: Row): CostingMaterial | null {
  const id = text(row.id), name = text(row.name), pricePence = num(row.price_pence), scrapPct = num(row.scrap_pct);
  const priceUnit = row.price_unit === "kg" || row.price_unit === "each" ? row.price_unit : null;
  if (!id || name === null || pricePence === null || scrapPct === null || !priceUnit) return null;
  return { id, name, pricePence, priceUnit, scrapPct, updatedAt: text(row.updated_at) };
}

function toMachine(row: Row): CostingMachine | null {
  const id = text(row.id), name = text(row.name), hourlyRatePence = num(row.hourly_rate_pence);
  const labourRatePence = row.labour_rate_pence === null || row.labour_rate_pence === undefined ? null : num(row.labour_rate_pence);
  if (!id || name === null || hourlyRatePence === null || (row.labour_rate_pence != null && labourRatePence === null)) return null;
  return { id, name, hourlyRatePence, labourRatePence, updatedAt: text(row.updated_at) };
}

function toDefaults(row: Row): CostingDefaults | null {
  const labourRatePence = num(row.labour_rate_pence), programmingRatePence = num(row.programming_rate_pence);
  const overheadPct = num(row.overhead_pct), defaultMarginPct = num(row.default_margin_pct);
  if (labourRatePence === null || programmingRatePence === null || overheadPct === null || defaultMarginPct === null) return null;
  return { labourRatePence, programmingRatePence, overheadPct, defaultMarginPct, updatedAt: text(row.updated_at) };
}

/** A database refusal the person can act on, in plain words (no codes or table names). */
function saveMessage(error: DbError, what: string): string {
  const code = String(error?.code ?? "");
  if (code === "42501") return "You don't have permission to change costing rates. Ask an admin or office user.";
  if (code === "23505") return `There is already a ${what} with that name.`;
  if (code === "23514" || code === "22P02" || code === "22003") return "Check the values: whole pence up to £100,000, and percentages in range.";
  if (code === "PGRST301" || code === "401") return "Your session has ended. Sign in again.";
  return "Couldn't save the costing rates. Try again.";
}

const pence = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= COSTING_PENCE_MAX;
const pct = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && Number(value.toFixed(2)) === value;

function nameProblem(name: string, what: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return `Enter the ${what}'s name.`;
  if (/[\r\n]/.test(name)) return "The name must be one line.";
  if (trimmed.length > COSTING_NAME_MAX) return `The name can be up to ${COSTING_NAME_MAX} characters.`;
  return null;
}

/** The same rules as 143's CHECKs. Null when fine. */
export function materialProblem(input: CostingMaterialInput): string | null {
  return nameProblem(input.name, "material")
    ?? (pence(input.pricePence) ? null : "Enter the price in whole pence, from 0 to £100,000.")
    ?? (input.priceUnit === "kg" || input.priceUnit === "each" ? null : "Choose per kg or each.")
    ?? (pct(input.scrapPct, 0, 100) ? null : "Scrap is a percentage from 0 to 100, up to 2 decimal places.");
}

/** The same rules as 143's CHECKs. Null when fine. */
export function machineProblem(input: CostingMachineInput): string | null {
  return nameProblem(input.name, "machine")
    ?? (pence(input.hourlyRatePence) ? null : "Enter the hourly rate in whole pence, from 0 to £100,000.")
    ?? (input.labourRatePence === null || pence(input.labourRatePence) ? null : "Enter the labour rate in whole pence, from 0 to £100,000, or leave it blank for the default.");
}

/** The same rules as 143's CHECKs. Null when fine. */
export function defaultsProblem(input: CostingDefaultsInput): string | null {
  if (!pence(input.labourRatePence)) return "Enter the labour rate in whole pence, from 0 to £100,000.";
  if (!pence(input.programmingRatePence)) return "Enter the programming rate in whole pence, from 0 to £100,000.";
  if (!pct(input.overheadPct, 100, 500)) return "Overhead is a percentage from 100 (none) to 500, up to 2 decimal places.";
  if (!pct(input.defaultMarginPct, 0, 95)) return "The margin is a percentage from 0 to 95, up to 2 decimal places.";
  return null;
}

/** Every material, machine and the defaults of the caller's company, names in order. "ok" only for a complete set; "not_configured" otherwise. Never throws. */
export async function loadCostingRates(client: SupabaseClient | null): Promise<LoadCostingRatesResult> {
  if (!client) return { status: "error", message: "Supabase is not configured." };
  const failed = { status: "error", message: "Couldn't load the costing rates. Try again." } as const;
  try {
    const [materials, machines, defaults] = await Promise.all([
      client.from("costing_materials").select(MATERIAL_COLUMNS).order("name"),
      client.from("costing_machines").select(MACHINE_COLUMNS).order("name"),
      client.from("costing_defaults").select(DEFAULTS_COLUMNS).maybeSingle(),
    ]);
    const errors = [materials.error, machines.error, defaults.error].filter(Boolean);
    if (errors.some(isCostingNotAppliedError)) return { status: "not_applied" };
    if (errors.length) return failed;
    const partial: CostingPartialRates = {
      materials: ((materials.data ?? []) as Row[]).map(toMaterial).filter((r): r is CostingMaterial => r !== null),
      machines: ((machines.data ?? []) as Row[]).map(toMachine).filter((r): r is CostingMachine => r !== null),
      defaults: defaults.data ? toDefaults(defaults.data as Row) : null,
    };
    // Complete = on. Anything missing = not configured: costing is off and no figure is offered for it.
    return costingEnabled(partial) ? { status: "ok", rates: partial } : { status: "not_configured", missing: costingMissing(partial), partial };
  } catch {
    return failed;
  }
}

/** Inserts or updates one row (by id, in the caller's company) and returns it as saved. */
async function saveRow<T>(client: SupabaseClient | null, table: string, organizationId: string, id: string | undefined, values: Row,
  columns: string, map: (row: Row) => T | null, what: string): Promise<SaveCostingResult<T>> {
  if (!client) return { ok: false, notApplied: false, message: "Supabase is not configured." };
  try {
    const query = id
      ? client.from(table).update(values).eq("id", id).eq("organization_id", organizationId).select(columns).maybeSingle()
      : client.from(table).insert({ ...values, organization_id: organizationId }).select(columns).maybeSingle();
    const { data, error } = await query;
    if (error) return isCostingNotAppliedError(error) ? { ok: false, notApplied: true, message: COSTING_NOT_APPLIED_MESSAGE } : { ok: false, notApplied: false, message: saveMessage(error, what) };
    const row = data ? map(data as unknown as Row) : null;
    if (!row) return { ok: false, notApplied: false, message: id ? `That ${what} is no longer there, or you can't change it. Reload and try again.` : "Couldn't save the costing rates. Try again." };
    return { ok: true, row };
  } catch {
    return { ok: false, notApplied: false, message: "Couldn't save the costing rates. Check your connection and try again." };
  }
}

/** Adds a material (no id) or changes one (id). The name is trimmed. */
export function saveCostingMaterial(client: SupabaseClient | null, organizationId: string, input: CostingMaterialInput): Promise<SaveCostingResult<CostingMaterial>> {
  const problem = materialProblem(input);
  if (problem) return Promise.resolve({ ok: false, notApplied: false, message: problem });
  return saveRow(client, "costing_materials", organizationId, input.id,
    { name: input.name.trim(), price_pence: input.pricePence, price_unit: input.priceUnit, scrap_pct: input.scrapPct }, MATERIAL_COLUMNS, toMaterial, "material");
}

/** Adds a machine (no id) or changes one (id). labourRatePence null = the company default labour rate. */
export function saveCostingMachine(client: SupabaseClient | null, organizationId: string, input: CostingMachineInput): Promise<SaveCostingResult<CostingMachine>> {
  const problem = machineProblem(input);
  if (problem) return Promise.resolve({ ok: false, notApplied: false, message: problem });
  return saveRow(client, "costing_machines", organizationId, input.id,
    { name: input.name.trim(), hourly_rate_pence: input.hourlyRatePence, labour_rate_pence: input.labourRatePence }, MACHINE_COLUMNS, toMachine, "machine");
}

/** Saves the company's one defaults row (insert or update on organization_id). */
export async function saveCostingDefaults(client: SupabaseClient | null, organizationId: string, input: CostingDefaultsInput): Promise<SaveCostingResult<CostingDefaults>> {
  const problem = defaultsProblem(input);
  if (problem) return { ok: false, notApplied: false, message: problem };
  if (!client) return { ok: false, notApplied: false, message: "Supabase is not configured." };
  try {
    const { data, error } = await client
      .from("costing_defaults")
      .upsert({ organization_id: organizationId, labour_rate_pence: input.labourRatePence, programming_rate_pence: input.programmingRatePence,
        overhead_pct: input.overheadPct, default_margin_pct: input.defaultMarginPct }, { onConflict: "organization_id" })
      .select(DEFAULTS_COLUMNS)
      .maybeSingle();
    if (error) return isCostingNotAppliedError(error) ? { ok: false, notApplied: true, message: COSTING_NOT_APPLIED_MESSAGE } : { ok: false, notApplied: false, message: saveMessage(error, "defaults row") };
    const row = data ? toDefaults(data as unknown as Row) : null;
    return row ? { ok: true, row } : { ok: false, notApplied: false, message: "Couldn't save the costing rates. Try again." };
  } catch {
    return { ok: false, notApplied: false, message: "Couldn't save the costing rates. Check your connection and try again." };
  }
}

async function deleteRow(client: SupabaseClient | null, table: string, organizationId: string, id: string, what: string): Promise<DeleteCostingResult> {
  if (!client) return { ok: false, notApplied: false, message: "Supabase is not configured." };
  try {
    const { data, error } = await client.from(table).delete().eq("id", id).eq("organization_id", organizationId).select("id");
    if (error) return isCostingNotAppliedError(error) ? { ok: false, notApplied: true, message: COSTING_NOT_APPLIED_MESSAGE } : { ok: false, notApplied: false, message: saveMessage(error, what) };
    if (!Array.isArray(data) || data.length === 0) return { ok: false, notApplied: false, message: `That ${what} is no longer there, or you can't change it. Reload and try again.` };
    return { ok: true };
  } catch {
    return { ok: false, notApplied: false, message: "Couldn't delete it. Check your connection and try again." };
  }
}

/** Deletes one of the company's materials. Quote lines already priced with it are not changed. */
export function deleteCostingMaterial(client: SupabaseClient | null, organizationId: string, id: string): Promise<DeleteCostingResult> {
  return deleteRow(client, "costing_materials", organizationId, id, "material");
}

/** Deletes one of the company's machines. Quote lines already priced with it are not changed. */
export function deleteCostingMachine(client: SupabaseClient | null, organizationId: string, id: string): Promise<DeleteCostingResult> {
  return deleteRow(client, "costing_machines", organizationId, id, "machine");
}

// ---- Saving the whole set at once (143's public.save_costing_settings_txn): all or nothing, company-scoped, and refused when stale. ----

/** 143's limit: this many materials and this many machines at most in one save. */
export const COSTING_ROWS_MAX = 500;
export const COSTING_STALE_MESSAGE = "Someone else changed the costing rates while you were editing. Reload to see their changes, then make yours again.";

/** A material or machine in a whole-set save always has an id (new rows: newCostingId()), because the save matches rows by id. */
export type CostingSettingsInput = {
  materials: Array<CostingMaterialInput & { id: string }>;
  machines: Array<CostingMachineInput & { id: string }>;
  defaults: CostingDefaultsInput;
};
export type SaveCostingSettingsResult = { ok: true } | { ok: false; reason: "stale" | "not_applied" | "refused"; notApplied: boolean; message: string };

/** A new row's id (the database keeps it). */
export function newCostingId(): string {
  return globalThis.crypto.randomUUID();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nameKey = (name: string) => name.trim().toLowerCase();

/** The same rules as 143's function, before anything is sent: every row to the tables' ranges, no repeated id or name, 500 of each at most. Null when fine. */
export function settingsProblem(value: CostingSettingsInput): string | null {
  if (value.materials.length > COSTING_ROWS_MAX || value.machines.length > COSTING_ROWS_MAX) return `There can be up to ${COSTING_ROWS_MAX} materials and ${COSTING_ROWS_MAX} machines.`;
  for (const m of value.materials) {
    const problem = materialProblem(m);
    if (problem) return problem;
    if (!UUID.test(m.id)) return "A material has no valid id. Reload and try again.";
  }
  for (const m of value.machines) {
    const problem = machineProblem(m);
    if (problem) return problem;
    if (!UUID.test(m.id)) return "A machine has no valid id. Reload and try again.";
  }
  const problem = defaultsProblem(value.defaults);
  if (problem) return problem;
  if (new Set(value.materials.map((m) => m.id.toLowerCase())).size !== value.materials.length || new Set(value.machines.map((m) => m.id.toLowerCase())).size !== value.machines.length) return "A row appears twice. Reload and try again.";
  if (new Set(value.materials.map((m) => nameKey(m.name))).size !== value.materials.length) return "Two materials have the same name.";
  if (new Set(value.machines.map((m) => nameKey(m.name))).size !== value.machines.length) return "Two machines have the same name.";
  return null;
}

/** The JSON the function takes for p_expected (what was loaded) and p_value (what to save). defaults null = the company had none. */
export function costingSettingsJson(set: { materials: Array<CostingMaterialInput & { id?: string }>; machines: Array<CostingMachineInput & { id?: string }>; defaults: CostingDefaultsInput | null }) {
  return {
    materials: set.materials.map((m) => ({ id: m.id, name: m.name.trim(), price_pence: m.pricePence, price_unit: m.priceUnit, scrap_pct: m.scrapPct })),
    machines: set.machines.map((m) => ({ id: m.id, name: m.name.trim(), hourly_rate_pence: m.hourlyRatePence, labour_rate_pence: m.labourRatePence })),
    defaults: set.defaults
      ? { labour_rate_pence: set.defaults.labourRatePence, programming_rate_pence: set.defaults.programmingRatePence, overhead_pct: set.defaults.overheadPct, default_margin_pct: set.defaults.defaultMarginPct }
      : null,
  };
}

/** The save function itself is not there (143 not applied, or the schema cache has not seen it). */
export function isCostingSaveFunctionMissing(error: DbError): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  return code === "PGRST202" || code === "42883" || (/save_costing_settings_txn/.test(String(error.message ?? "")) && /(does not exist|could not find|schema cache)/i.test(String(error.message ?? "")));
}

/**
 * Saves the company's WHOLE rate set (every material, every machine, the defaults) in one transaction. `loaded` is what the person loaded
 * (loadCostingRates' rates or partial): if anyone changed the company's rates since, the save is refused as "stale" and nothing is written.
 * Materials and machines left out of `value` are deleted; unchanged rows are not touched. The company is the caller's own (checked again by 143).
 */
export async function saveCostingSettingsAtomic(client: SupabaseClient | null, organizationId: string, loaded: CostingPartialRates, value: CostingSettingsInput): Promise<SaveCostingSettingsResult> {
  const refuse = (message: string, reason: "refused" | "stale" | "not_applied" = "refused"): SaveCostingSettingsResult => ({ ok: false, reason, notApplied: reason === "not_applied", message });
  const problem = settingsProblem(value);
  if (problem) return refuse(problem);
  if (!client) return refuse("Supabase is not configured.");
  try {
    const { error } = await client.rpc("save_costing_settings_txn", {
      p_org: organizationId,
      p_expected: costingSettingsJson(loaded),
      p_value: costingSettingsJson(value),
    });
    if (!error) return { ok: true };
    const code = String(error.code ?? "");
    if (isCostingSaveFunctionMissing(error) || isCostingNotAppliedError(error)) return refuse(COSTING_NOT_APPLIED_MESSAGE, "not_applied");
    if (code === "40001") return refuse(COSTING_STALE_MESSAGE, "stale");
    if (code === "22023") return refuse("Check the values: whole pence up to £100,000, percentages in range, no repeated names.");
    if (code === "23505") return refuse("A material or machine already has that name.");
    return refuse(saveMessage(error, "rate"));
  } catch {
    return refuse("Couldn't save the costing rates. Check your connection and try again.");
  }
}
