/**
 * Module K (worksheet builder): the per-job values of a company's custom fields (custom tick boxes, custom text fields and checklist items
 * that are not one of the six standard items).
 *
 * Inputs: jobs.worksheet_custom (release 170; a jsonb object, default {}), read from the job row the worksheet already loads. Outputs: parsed
 * values, and a save that writes ONLY that column. Existing job data is never changed: nothing here touches checklist, signed_off_*,
 * worksheet_version or any other column, and a value for a field that is later removed from a layout is kept on the job, just not shown.
 * Rules: once a job has a current sign-off its custom values are read-only in the app, and the database refuses the change too (release 170).
 * Before release 170 is applied the column is missing: reads give {} and a save says so plainly (it never pretends to save).
 * Must not change: the stored shape { v: 1, ticks, texts } or the column name.
 */
import { supabase } from "@/lib/supabase";

export type CustomValues = { ticks: Record<string, boolean>; texts: Record<string, string> };

export const EMPTY_CUSTOM_VALUES: CustomValues = { ticks: {}, texts: {} };
export const MAX_CUSTOM_TEXT = 500;
const MAX_ENTRIES = 100;
const KEY_PATTERN = /^[A-Za-z0-9_:-]{1,40}$/;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function parseCustomValues(raw: unknown): CustomValues {
  if (!isRecord(raw)) return EMPTY_CUSTOM_VALUES;
  const ticks: Record<string, boolean> = {};
  const texts: Record<string, string> = {};
  if (isRecord(raw.ticks)) for (const [key, value] of Object.entries(raw.ticks).slice(0, MAX_ENTRIES)) if (KEY_PATTERN.test(key) && typeof value === "boolean") ticks[key] = value;
  if (isRecord(raw.texts)) for (const [key, value] of Object.entries(raw.texts).slice(0, MAX_ENTRIES)) if (KEY_PATTERN.test(key) && typeof value === "string") texts[key] = value.slice(0, MAX_CUSTOM_TEXT);
  return { ticks, texts };
}

/** What is written to jobs.worksheet_custom: empty values are dropped so a job nobody filled in stays {}. */
export function toStoredCustomValues(values: CustomValues): Record<string, unknown> {
  const ticks = Object.fromEntries(Object.entries(values.ticks).filter(([key, value]) => KEY_PATTERN.test(key) && value === true));
  const texts = Object.fromEntries(Object.entries(values.texts).filter(([key, value]) => KEY_PATTERN.test(key) && value.trim() !== "").map(([key, value]) => [key, value.slice(0, MAX_CUSTOM_TEXT)]));
  return Object.keys(ticks).length || Object.keys(texts).length ? { v: 1, ticks, texts } : {};
}

/** Custom values are editable only while the job has no current sign-off (a signed worksheet never changes) and the person can edit it. */
export function canEditCustomValues(args: { canEditWorksheet: boolean; signedOff: boolean }): boolean {
  return args.canEditWorksheet && !args.signedOff;
}

export class CustomValuesUnavailableError extends Error {
  constructor() {
    super("Custom worksheet fields can't be saved yet: the database update for them hasn't been applied.");
  }
}

/** 42703: the column does not exist (release 170 not applied). */
const isMissingColumn = (error: { code?: string; message?: string } | null) => Boolean(error && (error.code === "42703" || error.code === "PGRST204" || /worksheet_custom/.test(error.message ?? "")));

export async function saveCustomValues(jobId: string, values: CustomValues): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { error } = await supabase.from("jobs").update({ worksheet_custom: toStoredCustomValues(values) }).eq("id", jobId);
  if (error) {
    if (isMissingColumn(error)) throw new CustomValuesUnavailableError();
    throw error;
  }
}
