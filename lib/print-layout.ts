/**
 * Which layout the job worksheet prints in (P1 print pack, D30-4: "The JNR print pack looks like the sheet JNR use today. Marpet gets
 * a basic template version, with the JNR layout available as an option").
 *
 * - "jnr": the sheet JNR use today (components/job-worksheet-print.tsx, components/job-worksheet-pack-print.tsx), unchanged.
 * - "basic": a plain job sheet with the same data and no JNR fields or wording (components/job-worksheet-basic-print.tsx).
 *
 * The company's choice is stored in organization_settings.company_profile under "printLayout" (no migration: the profile is already
 * the per-company jsonb the print pages read, and only an admin can change it, enforced by organization_settings_guard_nav, 006).
 * A company that has never chosen gets the default for its company: the JNR sheet for JNR's organisation (slug "jnr-engineering",
 * created by supabase/setup/03_create_organizations.sql and unique), Basic for every other company. When the setting cannot be read
 * at all (offline, an old database, no connection) the print falls back to the JNR sheet, which is what every company printed
 * before this change. A per-print override on the print page lets any company print the other layout.
 */
import { useEffect, useState } from "react";

import { DEMO_MODE } from "@/lib/demo";
import { supabase } from "@/lib/supabase";

export type PrintLayout = "jnr" | "basic";

/** The Settings and print-page choices, in the order they are listed. */
export const PRINT_LAYOUT_OPTIONS: { value: PrintLayout; label: string }[] = [
  { value: "basic", label: "Basic" },
  { value: "jnr", label: "JNR sheet" },
];

export const printLayoutLabel = (layout: PrintLayout) => PRINT_LAYOUT_OPTIONS.find((option) => option.value === layout)?.label ?? layout;

/** The key inside organization_settings.company_profile. */
export const PRINT_LAYOUT_KEY = "printLayout";

/** JNR's organisation (supabase/setup/03_create_organizations.sql). Slugs are unique and are not edited in the app. */
export const JNR_ORG_SLUG = "jnr-engineering";

/** What prints when the company's setting cannot be read: the JNR sheet, as before this change. */
export const FALLBACK_PRINT_LAYOUT: PrintLayout = "jnr";

export function parsePrintLayout(value: unknown): PrintLayout | null {
  return value === "jnr" || value === "basic" ? value : null;
}

/** The layout for a company that has not chosen one: the JNR sheet for JNR, Basic for every other company. */
export function defaultPrintLayout(slug: string): PrintLayout {
  return slug === JNR_ORG_SLUG ? "jnr" : "basic";
}

/**
 * The company's layout. `source`: "saved" (an admin chose it), "default" (never chosen: decided by the company) or "fallback" (the
 * setting could not be read, so the JNR sheet prints, as before).
 */
export type CompanyPrintLayout = { layout: PrintLayout; saved: PrintLayout | null; source: "saved" | "default" | "fallback" };

/** stored: company_profile.printLayout as read (anything); slug: the company's slug, or null when it could not be read. */
export function resolvePrintLayout(read: { stored: unknown; slug: string | null } | null): CompanyPrintLayout {
  const saved = read ? parsePrintLayout(read.stored) : null;
  if (saved) return { layout: saved, saved, source: "saved" };
  if (read && read.slug) return { layout: defaultPrintLayout(read.slug), saved: null, source: "default" };
  return { layout: FALLBACK_PRINT_LAYOUT, saved: null, source: "fallback" };
}

/** The layout this print uses: the person's choice on the print page, else the company's. */
export function chosenPrintLayout(company: CompanyPrintLayout | null, override: PrintLayout | null): PrintLayout | null {
  return override ?? company?.layout ?? null;
}

type Row = { organization_id?: string | null; company_profile?: Record<string, unknown> | null };

async function readSettingsRow(): Promise<Row | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.from("organization_settings").select("organization_id, company_profile").maybeSingle();
  if (error) throw error;
  return (data as Row | null) ?? null;
}

/** Reads the signed-in company's layout. Never throws: anything unreadable is the fallback. */
export async function loadCompanyPrintLayout(): Promise<CompanyPrintLayout> {
  if (!supabase) return resolvePrintLayout(DEMO_MODE ? { stored: null, slug: JNR_ORG_SLUG } : null);
  let row: Row | null;
  try {
    row = await readSettingsRow();
  } catch {
    return resolvePrintLayout(null);
  }
  const stored = row?.company_profile?.[PRINT_LAYOUT_KEY] ?? null;
  if (parsePrintLayout(stored)) return resolvePrintLayout({ stored, slug: null });
  let slug: string | null = null;
  try {
    // RLS shows only the session's own company (organizations select own).
    let query = supabase.from("organizations").select("slug");
    if (row?.organization_id) query = query.eq("id", row.organization_id);
    const { data, error } = await query.maybeSingle();
    if (!error && typeof (data as { slug?: unknown } | null)?.slug === "string") slug = (data as { slug: string }).slug;
  } catch {
    slug = null;
  }
  return resolvePrintLayout({ stored, slug });
}

/**
 * Saves the company's layout (Settings, admins only: the 006 trigger refuses anyone else). Re-reads the profile and writes it back
 * with only "printLayout" changed, so nothing else in Company details is touched. The caller reloads the company profile.
 */
export async function saveCompanyPrintLayout(layout: PrintLayout, organizationId: string): Promise<void> {
  if (!supabase) throw new Error("Supabase is not configured.");
  if (!parsePrintLayout(layout)) throw new Error("Unknown print layout.");
  const { data, error } = await supabase.from("organization_settings").select("company_profile").eq("organization_id", organizationId).maybeSingle();
  if (error) throw error;
  const current = (data as Row | null)?.company_profile;
  const next = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}), [PRINT_LAYOUT_KEY]: layout };
  const { error: saveError } = await supabase
    .from("organization_settings")
    .upsert({ organization_id: organizationId, company_profile: next, updated_at: new Date().toISOString() }, { onConflict: "organization_id" });
  if (saveError) throw saveError;
}

/** The signed-in company's layout for the print pages: null while it loads. */
export function useCompanyPrintLayout(): CompanyPrintLayout | null {
  const [layout, setLayout] = useState<CompanyPrintLayout | null>(null);
  useEffect(() => {
    let active = true;
    void loadCompanyPrintLayout().then((value) => { if (active) setLayout(value); });
    return () => { active = false; };
  }, []);
  return layout;
}
