/**
 * Module K (worksheet builder): reads and saves a company's builder state. The state lives in organization_settings.company_profile under
 * "worksheetBuilder" (no migration: the profile is already the per-company jsonb; only an admin can change it, enforced by the 006 trigger),
 * and the on/off switch in hidden_nav (switch.ts).
 *
 * Inputs: the signed-in company's settings row. Outputs: BuilderConfig. loadWorksheetBuilder NEVER throws: anything unreadable is "off", which
 * is the same as a company that never used the builder (Basic or JNR sheet print as before).
 * Saving re-reads the profile and writes it back with only "worksheetBuilder" changed, so nothing else in Company details is touched;
 * lib/print-layout withStoredPrintLayout keeps the key when Company details is saved.
 * Must not change: the key name, or the "unreadable means off" rule.
 */
import { useEffect, useState } from "react";

import { DEMO_MODE } from "@/lib/demo";
import { supabase } from "@/lib/supabase";
import { type WorksheetBuilderState, EMPTY_BUILDER_STATE, WORKSHEET_BUILDER_KEY, parseWorksheetBuilder, serialiseWorksheetBuilder } from "@/lib/worksheet-builder/layouts";
import { type CompanyRequirements, STRICT_REQUIREMENTS } from "@/lib/worksheet-builder/requirements";
import { worksheetBuilderEnabled } from "@/lib/worksheet-builder/switch";

export type BuilderConfig = { enabled: boolean; state: WorksheetBuilderState; requirements: CompanyRequirements };

/** Builder off: what a company that never used it has. */
export const BUILDER_OFF: BuilderConfig = { enabled: false, state: EMPTY_BUILDER_STATE, requirements: STRICT_REQUIREMENTS };

type Row = { organization_id?: string | null; company_profile?: Record<string, unknown> | null; hidden_nav?: string[] | null; customer_signoff_enabled?: boolean | null };

export function builderConfigFromRow(row: Row | null): BuilderConfig {
  if (!row) return BUILDER_OFF;
  const enabled = worksheetBuilderEnabled(Array.isArray(row.hidden_nav) ? row.hidden_nav : []);
  const profile = row.company_profile && typeof row.company_profile === "object" && !Array.isArray(row.company_profile) ? row.company_profile : {};
  return { enabled, state: parseWorksheetBuilder(profile[WORKSHEET_BUILDER_KEY]), requirements: { customerSignOff: row.customer_signoff_enabled === true } };
}

/** Reads the builder config and says so when it cannot (the Settings card must never edit from a failed read: a save would overwrite layouts it could not see). */
export async function loadWorksheetBuilderStrict(): Promise<BuilderConfig> {
  if (!supabase) return BUILDER_OFF;
  const { data, error } = await supabase.from("organization_settings").select("organization_id, company_profile, hidden_nav, customer_signoff_enabled").maybeSingle();
  if (error) throw error;
  return builderConfigFromRow((data as Row | null) ?? null);
}

/** For printing: never throws, and anything unreadable is "off" (Basic or JNR sheet, as before). */
export async function loadWorksheetBuilder(): Promise<BuilderConfig> {
  if (DEMO_MODE) return BUILDER_OFF;
  try {
    return await loadWorksheetBuilderStrict();
  } catch {
    return BUILDER_OFF;
  }
}

/**
 * Changes the company's builder state (Settings, admins only). Re-reads the stored state first and applies `change` to THAT, so a layout
 * another admin saved meanwhile is kept; writes the profile back with only "worksheetBuilder" changed. Returns the state as saved.
 */
export async function updateWorksheetBuilderState(organizationId: string, change: (current: WorksheetBuilderState) => WorksheetBuilderState): Promise<WorksheetBuilderState> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.from("organization_settings").select("company_profile").eq("organization_id", organizationId).maybeSingle();
  if (error) throw error;
  const current = (data as Row | null)?.company_profile;
  const profile = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  const clean = serialiseWorksheetBuilder(change(parseWorksheetBuilder(profile[WORKSHEET_BUILDER_KEY])));
  const { error: saveError } = await supabase.from("organization_settings").upsert({ organization_id: organizationId, company_profile: { ...profile, [WORKSHEET_BUILDER_KEY]: clean }, updated_at: new Date().toISOString() }, { onConflict: "organization_id" });
  if (saveError) throw saveError;
  return clean;
}

const CHANGED_EVENT = "tolra:worksheet-builder-changed";

/** Tells the other Settings cards on the page (Print layout) that the builder switch or layouts changed, so they reload. */
export function announceBuilderChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGED_EVENT));
}

/** Calls `listener` whenever announceBuilderChanged runs on this page; returns the unsubscribe. */
export function onBuilderChanged(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(CHANGED_EVENT, listener);
  return () => window.removeEventListener(CHANGED_EVENT, listener);
}

/** The signed-in company's builder state for the print pages: null while it loads (the page then prints the legacy sheet, as before). */
export function useWorksheetBuilder(): BuilderConfig | null {
  const [config, setConfig] = useState<BuilderConfig | null>(null);
  useEffect(() => {
    let active = true;
    void loadWorksheetBuilder().then((value) => { if (active) setConfig(value); });
    return () => { active = false; };
  }, []);
  return config;
}
