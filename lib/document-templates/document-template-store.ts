/**
 * Module J: reads and saves the company's document template settings (lib/document-templates/document-template-settings.ts).
 *
 * Inputs: the signed-in company's organization_settings row. Outputs: the parsed settings, or a saved change.
 * A save re-reads the stored profile and writes it back with ONLY "documentTemplates" changed, so nothing else in Company details is touched
 * (the same approach as lib/print-layout saveCompanyPrintLayout). Only an admin can write: trigger 006 refuses anyone else.
 * Must not change: it never reads or writes any other key, and a failed read is "off" (classic), never an error shown on a document.
 */
import { supabase } from "@/lib/supabase";
import {
  DOCUMENT_TEMPLATES_KEY, type DocumentTemplateSettings, NO_DOCUMENT_TEMPLATES, parseDocumentTemplates,
} from "@/lib/document-templates/document-template-settings";

type Row = { company_profile?: Record<string, unknown> | null };

/** Reads the signed-in company's settings. Never throws: anything unreadable is the default (off, classic). */
export async function loadDocumentTemplates(): Promise<DocumentTemplateSettings> {
  if (!supabase) return { ...NO_DOCUMENT_TEMPLATES };
  try {
    const { data, error } = await supabase.from("organization_settings").select("company_profile").maybeSingle();
    if (error) return { ...NO_DOCUMENT_TEMPLATES };
    return parseDocumentTemplates((data as Row | null)?.company_profile?.[DOCUMENT_TEMPLATES_KEY]);
  } catch {
    return { ...NO_DOCUMENT_TEMPLATES };
  }
}

/**
 * Applies `change` to the stored settings (read fresh, so two admins never overwrite each other's earlier history) and saves them.
 * Returns what was saved. The caller reloads the company profile (loadCompanyProfile(true)) so documents made next use it.
 */
export async function saveDocumentTemplates(organizationId: string, change: (current: DocumentTemplateSettings) => DocumentTemplateSettings): Promise<DocumentTemplateSettings> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.from("organization_settings").select("company_profile").eq("organization_id", organizationId).maybeSingle();
  if (error) throw error;
  const current = (data as Row | null)?.company_profile;
  const profile = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  const next = change(parseDocumentTemplates(profile[DOCUMENT_TEMPLATES_KEY]));
  const { error: saveError } = await supabase
    .from("organization_settings")
    .upsert({ organization_id: organizationId, company_profile: { ...profile, [DOCUMENT_TEMPLATES_KEY]: next }, updated_at: new Date().toISOString() }, { onConflict: "organization_id" });
  if (saveError) throw saveError;
  return next;
}
