// The database side of the e-mail schedules (migration 108), through the service-role client the cron route passes in. Every query is
// scoped by the schedule's company. Nothing here reads a document or an address into a log; errors are kept as short codes.
import type { SupabaseClient } from "@supabase/supabase-js";

import type { EmailScheduleKind, ScheduleTiming } from "@/lib/email/schedules/due";

/** What the cron route answers while migration 108 is not applied (production applies migrations by hand AFTER the app deploys). */
export const SCHEDULES_NOT_APPLIED = "database update 108 not applied";

/** PostgREST / Postgres codes for a table that is not there (yet). */
const MISSING_TABLE_CODES = new Set(["PGRST205", "PGRST200", "42P01"]);
export const isMissingTable = (error: { code?: string | null; message?: string | null } | null | undefined) =>
  !!error && ((!!error.code && MISSING_TABLE_CODES.has(error.code)) || /could not find the table|relation .* does not exist/i.test(error.message ?? ""));

export type EmailScheduleRow = ScheduleTiming & {
  id: string;
  organization_id: string;
  kind: EmailScheduleKind;
  recipients: string[] | null;
  last_run_at: string | null;
};

const COLUMNS = "id, organization_id, kind, enabled, frequency, weekday, time_of_day, run_at, timezone, recipients, last_run_at, updated_at";

export class StoreError extends Error {
  constructor(readonly step: string, readonly code?: string | null) {
    super(`${step} failed${code ? ` (${code})` : ""}`);
    this.name = "StoreError";
  }
}

/** Every enabled schedule of an active company. `notApplied` when migration 108 is not in the database. */
export async function listEnabledSchedules(admin: SupabaseClient): Promise<{ rows: EmailScheduleRow[] } | { notApplied: true }> {
  const { data, error } = await admin.from("email_schedules").select(`${COLUMNS}, organizations!inner(status)`).eq("enabled", true).eq("organizations.status", "active");
  if (isMissingTable(error)) return { notApplied: true };
  if (error) throw new StoreError("list schedules", error.code);
  return { rows: ((data ?? []) as unknown as EmailScheduleRow[]).map((row) => ({ ...row, recipients: row.recipients ?? null })) };
}

export type ClaimResult = "claimed" | "done" | "busy";
/** A claimed period that ended in an error (or never finished) is tried again, after this long, at most this many times in all. */
export const RETRY_AFTER_MS = 10 * 60_000;
export const MAX_ATTEMPTS = 3;
/** The marker a claimed run carries until it finishes: a crash leaves it behind, and that is what lets the next tick try again. */
export const RUNNING = "running";

/**
 * Takes the right to run one period of a schedule. The unique key (schedule, period) makes the insert the lock: of two overlapping cron
 * calls exactly one inserts. A period that finished is never claimed again; one that failed or died is claimed again after 10 minutes,
 * at most 3 times in all.
 */
export async function claimRun(admin: SupabaseClient, scheduleId: string, periodKey: string, now: Date): Promise<ClaimResult> {
  const inserted = await admin.from("email_schedule_runs")
    .upsert({ schedule_id: scheduleId, period_key: periodKey, ran_at: now.toISOString(), sent_count: 0, error: RUNNING, attempts: 1 }, { onConflict: "schedule_id,period_key", ignoreDuplicates: true })
    .select("period_key");
  if (inserted.error) throw new StoreError("claim run", inserted.error.code);
  if ((inserted.data ?? []).length > 0) return "claimed";

  const existing = await admin.from("email_schedule_runs").select("error, attempts, ran_at").eq("schedule_id", scheduleId).eq("period_key", periodKey).maybeSingle();
  if (existing.error) throw new StoreError("read run", existing.error.code);
  const row = existing.data as { error: string | null; attempts: number; ran_at: string } | null;
  if (!row || row.error === null || row.attempts >= MAX_ATTEMPTS) return "done";
  if (now.getTime() - Date.parse(row.ran_at) < RETRY_AFTER_MS) return "busy";
  const retaken = await admin.from("email_schedule_runs")
    .update({ attempts: row.attempts + 1, ran_at: now.toISOString(), error: RUNNING })
    .eq("schedule_id", scheduleId).eq("period_key", periodKey).eq("attempts", row.attempts).not("error", "is", null).select("period_key");
  if (retaken.error) throw new StoreError("retake run", retaken.error.code);
  return (retaken.data ?? []).length > 0 ? "claimed" : "busy";
}

/** Records how a claimed period ended. `final`: no automatic retry (attempts set to the limit). */
export async function finishRun(admin: SupabaseClient, scheduleId: string, periodKey: string, result: { sent: number; error: string | null; final: boolean }): Promise<void> {
  const patch: Record<string, unknown> = { sent_count: result.sent, error: result.error ? result.error.slice(0, 300) : null };
  if (result.error && result.final) patch.attempts = MAX_ATTEMPTS;
  const { error } = await admin.from("email_schedule_runs").update(patch).eq("schedule_id", scheduleId).eq("period_key", periodKey);
  if (error) throw new StoreError("finish run", error.code);
}

/** Notes a finished period on the schedule; a "once" schedule that ran cleanly switches itself off. */
export async function noteScheduleRan(admin: SupabaseClient, schedule: Pick<EmailScheduleRow, "id" | "frequency">, now: Date, succeeded: boolean): Promise<void> {
  const patch: Record<string, unknown> = { last_run_at: now.toISOString() };
  if (succeeded && schedule.frequency === "once") patch.enabled = false;
  const { error } = await admin.from("email_schedules").update(patch).eq("id", schedule.id);
  if (error) throw new StoreError("note schedule", error.code);
}

/** The company's own wording for a template (migration 106's email_templates), or null: none saved, or 106 not applied. */
export async function loadTemplateOverride(admin: SupabaseClient, organizationId: string, key: "invoice_reminder" | "timesheet"): Promise<{ subject: string; body: string } | null> {
  try {
    const { data, error } = await admin.from("email_templates").select("subject, body").eq("organization_id", organizationId).eq("key", key).maybeSingle();
    if (error || !data) return null;
    const row = data as { subject: string; body: string };
    return row.subject?.trim() && row.body?.trim() ? row : null;
  } catch {
    return null;
  }
}

/** The name on the company's e-mails: its profile name, else the company's name. */
export async function loadCompanyName(admin: SupabaseClient, organizationId: string): Promise<string> {
  const [settings, org] = await Promise.all([
    admin.from("organization_settings").select("company_profile").eq("organization_id", organizationId).maybeSingle(),
    admin.from("organizations").select("name").eq("id", organizationId).maybeSingle(),
  ]);
  const profile = (settings.data as { company_profile?: Record<string, unknown> | null } | null)?.company_profile ?? {};
  const fromProfile = typeof profile.name === "string" ? profile.name.trim() : "";
  const fromOrg = typeof (org.data as { name?: string } | null)?.name === "string" ? ((org.data as { name: string }).name || "").trim() : "";
  return (fromProfile || fromOrg || "Your supplier").slice(0, 120);
}

/** Reads every page of a list (1000 rows a request), capped. */
export async function readAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { code?: string | null } | null }>, max = 20_000): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; rows.length < max; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new StoreError("read list", error.code);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}
