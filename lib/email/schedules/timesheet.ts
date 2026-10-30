// Timesheet e-mails (E13): for one schedule period, one e-mail per person who worked in the last full week (Monday to Sunday before the
// week the schedule runs in), sent to the company's admin recipients. The hours are the weekly review's own figures: the same loader
// (lib/time-data loadTimeData) and the same sum (lib/time-sheet weekTotals) lib/time-week loadWeek uses, here read with the service role
// and scoped to the company by hand (loadWeek itself asks the database as the signed-in person). Hours only: no rates, no pay.
import type { SupabaseClient } from "@supabase/supabase-js";

import { type EmailScheduleRow, StoreError, loadCompanyName, loadTemplateOverride } from "@/lib/email/schedules/store";
import { type Occurrence, addDaysToDate, isoWeekKey, localDate, mondayOf } from "@/lib/email/schedules/due";
import type { ExecResult } from "@/lib/email/schedules/reminders";
import { scheduleEmailKey } from "@/lib/email/schedules/keys";
import { renderTimesheet } from "@/lib/email/schedules/render";
import { sendCompanyEmail } from "@/lib/email/send-company-email";
import { type TimeData, loadTimeData } from "@/lib/time-data";
import { addDays, startOfLocalDay, weekTotals } from "@/lib/time-sheet";

/** Tables that hold a company's rows and must be read for one company only (the rest, bank holidays, are shared). */
const COMPANY_TABLES = new Set(["attendance_events", "operator_sessions", "time_settings", "jobs"]);

/** The client loadTimeData reads from, with every company table narrowed to `organizationId` (the service role sees all companies). */
export function scopedToCompany(client: Pick<SupabaseClient, "from">, organizationId: string): Pick<SupabaseClient, "from"> {
  return {
    // loadTimeData only ever calls .from(table).select(...): that is the one call narrowed here.
    from: ((table: string) => {
      const query = client.from(table);
      return COMPANY_TABLES.has(table) ? { select: (...args: Parameters<typeof query.select>) => query.select(...args).eq("organization_id", organizationId) } : query;
    }) as SupabaseClient["from"],
  };
}

/** The Monday of the last full week before the week of `date`. */
export const previousWeekStart = (date: string) => addDaysToDate(mondayOf(date), -7);

const SHORT = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short" });
/** "Mon 19 Oct to Sun 25 Oct 2026". */
export function weekLabel(weekStart: string): string {
  const d = (date: string) => new Date(`${date}T00:00:00Z`);
  const end = addDaysToDate(weekStart, 6);
  const day = (date: string) => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" }).format(d(date));
  return `${day(weekStart)} ${SHORT.format(d(weekStart))} to ${day(end)} ${SHORT.format(d(end))} ${end.slice(0, 4)}`;
}

/** The ISO week number of the week starting Monday `weekStart` ("2026-W43" gives 43). */
export const weekNumber = (weekStart: string) => Number(isoWeekKey(weekStart).slice(-2));

export type PersonHours = { userId: string; paidMinutes: number; clockedMinutes: number };

/** Each person's paid and clocked minutes for the week starting Monday `weekStart`; people with no time are left out. */
export async function loadPeopleHours(client: Pick<SupabaseClient, "from">, organizationId: string, weekStart: string, now: Date): Promise<PersonHours[]> {
  const data: TimeData = await loadTimeData(scopedToCompany(client, organizationId), { userId: null, from: startOfLocalDay(weekStart), to: startOfLocalDay(addDays(weekStart, 7)) });
  const ids = new Set<string>([...data.events.map((e) => e.user_id), ...data.labour.map((l) => l.user_id)]);
  const people: PersonHours[] = [];
  for (const userId of [...ids].sort()) {
    const week = weekTotals({ weekStart, events: data.events.filter((e) => e.user_id === userId), labour: data.labour.filter((l) => l.user_id === userId), settings: data.settings, bankHolidays: data.bankHolidays, now: now.getTime() });
    if (week.paid > 0 || week.attendance > 0) people.push({ userId, paidMinutes: week.paid, clockedMinutes: week.attendance });
  }
  return people;
}

const looksLikeEmail = (value: string) => /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(value) && value.length <= 254;

/** The company's active admins' e-mail addresses (shared support logins are not members of the company, so never included). */
export async function adminEmails(admin: Pick<SupabaseClient, "from">, organizationId: string, now: Date): Promise<string[]> {
  const { data, error } = await admin.from("organization_members").select("user_id, expires_at").eq("organization_id", organizationId).eq("active", true).eq("support", false)
    .or("role.eq.admin,secondary_role.eq.admin");
  if (error) throw new StoreError("read admins", error.code);
  const ids = ((data ?? []) as Array<{ user_id: string; expires_at: string | null }>).filter((m) => !m.expires_at || Date.parse(m.expires_at) > now.getTime()).map((m) => m.user_id);
  if (!ids.length) return [];
  const profiles = await admin.from("user_profiles").select("id, email").in("id", ids);
  if (profiles.error) throw new StoreError("read admin e-mails", profiles.error.code);
  return [...new Set(((profiles.data ?? []) as Array<{ email: string | null }>).map((p) => (p.email ?? "").trim()).filter(looksLikeEmail))].sort();
}

async function personNames(admin: Pick<SupabaseClient, "from">, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!ids.length) return out;
  const { data, error } = await admin.from("user_profiles").select("id, full_name, email").in("id", ids);
  if (error) throw new StoreError("read names", error.code);
  for (const p of (data ?? []) as Array<{ id: string; full_name: string | null; email: string | null }>) out.set(p.id, (p.full_name ?? "").trim() || (p.email ?? "").trim() || "Unknown");
  return out;
}

export type TimesheetDeps = { send: typeof sendCompanyEmail; deadline?: number; clock?: () => number };

/**
 * Sends one period of timesheet e-mails: one per person, to every recipient. A person is claimed in timesheet_sends BEFORE their e-mail is
 * sent and the claim is given back if the send fails, so a period that is tried again (after a failure, a crash or the time limit) e-mails
 * only the people not yet sent, never the same person twice.
 */
export async function runTimesheets(admin: SupabaseClient, schedule: EmailScheduleRow, occurrence: Occurrence, now: Date, deps: TimesheetDeps = { send: sendCompanyEmail }): Promise<ExecResult> {
  const result: ExecResult = { sent: 0, drafted: 0, skipped: 0, failed: 0, error: null, retryable: true };
  const org = schedule.organization_id;
  const weekStart = previousWeekStart(localDate(occurrence.at, schedule.timezone ?? "Europe/London"));
  const to = (schedule.recipients ?? []).filter(looksLikeEmail);
  const recipients = to.length ? to : await adminEmails(admin, org, now);
  if (!recipients.length) {
    result.error = "no recipient: the company has no admin e-mail address";
    return result;
  }
  const people = await loadPeopleHours(admin, org, weekStart, now);
  if (!people.length) return result;
  const [names, companyName, override] = await Promise.all([personNames(admin, people.map((p) => p.userId)), loadCompanyName(admin, org), loadTemplateOverride(admin, org, "timesheet")]);
  const site = (process.env.NEXT_PUBLIC_SITE_URL ?? "").replace(/\/+$/, "");
  const failureCodes = new Set<string>();
  const clock = deps.clock ?? Date.now;
  let stoppedEarly = false;

  for (const person of people) {
    if (deps.deadline !== undefined && clock() > deps.deadline) {
      stoppedEarly = true;
      break;
    }
    const claim = await admin.from("timesheet_sends").upsert({ schedule_id: schedule.id, period_key: occurrence.periodKey, user_id: person.userId },
      { onConflict: "schedule_id,period_key,user_id", ignoreDuplicates: true }).select("user_id");
    if (claim.error) throw new StoreError("claim timesheet", claim.error.code);
    if ((claim.data ?? []).length === 0) {
      result.skipped += 1; // already e-mailed in this period
      continue;
    }
    const release = () => admin.from("timesheet_sends").delete().eq("schedule_id", schedule.id).eq("period_key", occurrence.periodKey).eq("user_id", person.userId);
    try {
      const name = names.get(person.userId) ?? "Unknown";
      const mail = renderTimesheet({
        personName: name, week: `${weekNumber(weekStart)} (${weekLabel(weekStart)})`, hours: person.paidMinutes / 60,
        companyName, link: site ? `${site}/time` : "",
      }, override);
      const sent = await deps.send({
        organizationId: org, userId: null, kind: "timesheet", to: recipients, subject: mail.subject, text: mail.text, html: mail.html,
        recordType: "timesheet", recordId: `${person.userId}:${weekStart}`, idempotencyKey: scheduleEmailKey("timesheet", schedule.id, occurrence.periodKey, person.userId),
      });
      if (sent.ok) {
        result.sent += 1;
        if (sent.mode === "drafted") result.drafted += 1;
      } else {
        await release();
        result.failed += 1;
        failureCodes.add(sent.code);
      }
    } catch {
      await Promise.resolve(release()).catch(() => undefined);
      result.failed += 1;
      failureCodes.add("unexpected");
    }
  }
  const problems = [
    result.failed ? `${result.failed} timesheet e-mail${result.failed === 1 ? "" : "s"} not sent (${[...failureCodes].sort().join(", ")})` : "",
    stoppedEarly ? "stopped at the time limit; the rest goes on the next try" : "",
  ].filter(Boolean);
  result.error = problems.length ? problems.join("; ") : null;
  return result;
}
