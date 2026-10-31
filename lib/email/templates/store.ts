/**
 * Loading and saving a company's own e-mail texts (public.email_templates, migration 106). Works with any Supabase client: the
 * browser's (Settings, the send dialog) or a server one. Row level security does the scoping: members read their company's rows,
 * office and admin write them; organization_id is still sent on writes (the policy checks it is the caller's company).
 *
 * 106 not applied yet (production applies migrations by hand after the app deploys): every read answers "not applied" or "no
 * override" quietly (no throw, no console line), so the senders use the default texts and the Settings card says so.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { BODY_MAX, SUBJECT_MAX, type TemplateKey, type TemplateText, isTemplateKey } from "@/lib/email/templates/defaults";

export const TEMPLATES_NOT_APPLIED_MESSAGE = "Not available until database update 106 is applied.";

export type TemplateOverride = TemplateText & { updatedAt: string | null };
export type TemplateOverrides = Partial<Record<TemplateKey, TemplateOverride>>;
export type LoadTemplatesResult = { status: "ok"; overrides: TemplateOverrides } | { status: "not_applied" } | { status: "error"; message: string };
export type SaveTemplateResult = { ok: true } | { ok: false; notApplied: boolean; message: string };

type DbError = { code?: string; message?: string } | null | undefined;

/** The table (or a column of it) is not there: PostgREST's schema cache answer, or Postgres's own. */
export function isMissingTableError(error: DbError): boolean {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "PGRST205" || code === "PGRST204" || code === "42P01" || code === "42703") return true;
  return /email_templates/.test(String(error.message ?? "")) && /(does not exist|could not find|schema cache)/i.test(String(error.message ?? ""));
}

/** A database refusal the person can act on, in plain words (no codes or table names). */
function saveMessage(error: DbError): string {
  const code = String(error?.code ?? "");
  if (code === "42501") return "You don't have permission to change e-mail templates. Ask an admin or office user.";
  if (code === "23514") return `Check the text: the subject must be one line of up to ${SUBJECT_MAX} characters and the body up to ${BODY_MAX} characters, neither blank.`;
  if (code === "PGRST301" || code === "401") return "Your session has ended. Sign in again.";
  return "Couldn't save the template. Try again.";
}

/** Every saved template of the caller's company. Never throws. */
export async function loadTemplateOverrides(client: SupabaseClient | null): Promise<LoadTemplatesResult> {
  if (!client) return { status: "error", message: "Supabase is not configured." };
  try {
    const { data, error } = await client.from("email_templates").select("key, subject, body, updated_at");
    if (error) return isMissingTableError(error) ? { status: "not_applied" } : { status: "error", message: "Couldn't load the e-mail templates. Try again." };
    const overrides: TemplateOverrides = {};
    for (const row of (data ?? []) as Array<{ key: unknown; subject: unknown; body: unknown; updated_at: unknown }>) {
      if (!isTemplateKey(row.key) || typeof row.subject !== "string" || typeof row.body !== "string") continue;
      overrides[row.key] = { subject: row.subject, body: row.body, updatedAt: typeof row.updated_at === "string" ? row.updated_at : null };
    }
    return { status: "ok", overrides };
  } catch {
    return { status: "error", message: "Couldn't load the e-mail templates. Try again." };
  }
}

/** The company's own text for one key, or null (none saved, 106 not applied, or any failure: the default is used). Never throws. */
export async function loadTemplateOverride(client: SupabaseClient | null, key: TemplateKey, organizationId?: string): Promise<TemplateText | null> {
  if (!client) return null;
  try {
    let query = client.from("email_templates").select("subject, body").eq("key", key);
    if (organizationId) query = query.eq("organization_id", organizationId);
    const { data, error } = await query.maybeSingle();
    if (error || !data) return null;
    const row = data as { subject?: unknown; body?: unknown };
    return typeof row.subject === "string" && typeof row.body === "string" ? { subject: row.subject, body: row.body } : null;
  } catch {
    return null;
  }
}

/** Checks the text before it is sent to the database (the same rules as 106's checks). Null when fine. */
export function templateProblem(text: TemplateText): string | null {
  const subject = text.subject.trim();
  const body = text.body.trim();
  if (!subject) return "Enter a subject.";
  if (/[\r\n]/.test(text.subject)) return "The subject must be one line.";
  if (subject.length > SUBJECT_MAX) return `The subject can be up to ${SUBJECT_MAX} characters.`;
  if (!body) return "Enter the e-mail text.";
  if (body.length > BODY_MAX) return `The e-mail text can be up to ${BODY_MAX} characters.`;
  return null;
}

/** Saves the company's own text for `key` (one row per company per key). */
export async function saveTemplateOverride(client: SupabaseClient | null, organizationId: string, key: TemplateKey, text: TemplateText): Promise<SaveTemplateResult> {
  if (!client) return { ok: false, notApplied: false, message: "Supabase is not configured." };
  const problem = templateProblem(text);
  if (problem) return { ok: false, notApplied: false, message: problem };
  try {
    const { error } = await client
      .from("email_templates")
      .upsert({ organization_id: organizationId, key, subject: text.subject.trim(), body: text.body.trim() }, { onConflict: "organization_id,key" });
    if (!error) return { ok: true };
    if (isMissingTableError(error)) return { ok: false, notApplied: true, message: TEMPLATES_NOT_APPLIED_MESSAGE };
    return { ok: false, notApplied: false, message: saveMessage(error) };
  } catch {
    return { ok: false, notApplied: false, message: "Couldn't save the template. Check your connection and try again." };
  }
}

/** Reset to default: removes the company's own text for `key`. */
export async function resetTemplateOverride(client: SupabaseClient | null, organizationId: string, key: TemplateKey): Promise<SaveTemplateResult> {
  if (!client) return { ok: false, notApplied: false, message: "Supabase is not configured." };
  try {
    const { error } = await client.from("email_templates").delete().eq("organization_id", organizationId).eq("key", key);
    if (!error) return { ok: true };
    if (isMissingTableError(error)) return { ok: false, notApplied: true, message: TEMPLATES_NOT_APPLIED_MESSAGE };
    return { ok: false, notApplied: false, message: saveMessage(error) };
  } catch {
    return { ok: false, notApplied: false, message: "Couldn't reset the template. Check your connection and try again." };
  }
}
