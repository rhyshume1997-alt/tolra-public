// Runs every due e-mail schedule across companies (the body of app/api/cron/email-schedules). The database and the senders are passed in
// so the loop is tested without either. One company's failure, however it fails, is caught here and counted: it never stops the others and
// never reaches the route as an exception. Counts only come out (no company names, addresses or document numbers).
import { type EmailScheduleRow, SCHEDULES_NOT_APPLIED } from "@/lib/email/schedules/store";
import { type Occurrence, dueOccurrence } from "@/lib/email/schedules/due";
import type { ExecResult } from "@/lib/email/schedules/reminders";

export type RunnerDeps = {
  list(): Promise<{ rows: EmailScheduleRow[] } | { notApplied: true }>;
  claim(scheduleId: string, periodKey: string, now: Date): Promise<"claimed" | "done" | "busy">;
  execute(schedule: EmailScheduleRow, occurrence: Occurrence, now: Date): Promise<ExecResult>;
  finish(scheduleId: string, periodKey: string, result: { sent: number; error: string | null; final: boolean }): Promise<void>;
  note(schedule: EmailScheduleRow, now: Date, succeeded: boolean): Promise<void>;
};

export type RunSummary = { skipped?: string; schedules: number; due: number; ran: number; emails: number; drafted: number; failed: number; errors: number };

export async function runDueSchedules(deps: RunnerDeps, now: Date): Promise<RunSummary> {
  const out: RunSummary = { schedules: 0, due: 0, ran: 0, emails: 0, drafted: 0, failed: 0, errors: 0 };
  const listed = await deps.list();
  if ("notApplied" in listed) return { ...out, skipped: SCHEDULES_NOT_APPLIED };
  out.schedules = listed.rows.length;
  for (const schedule of listed.rows) {
    try {
      const occurrence = dueOccurrence(schedule, now);
      if (!occurrence) continue;
      out.due += 1;
      if ((await deps.claim(schedule.id, occurrence.periodKey, now)) !== "claimed") continue;
      let result: ExecResult;
      try {
        result = await deps.execute(schedule, occurrence, now);
      } catch {
        result = { sent: 0, drafted: 0, skipped: 0, failed: 0, error: "unexpected error", retryable: true };
        out.errors += 1;
      }
      await deps.finish(schedule.id, occurrence.periodKey, { sent: result.sent, error: result.error, final: !result.retryable });
      await deps.note(schedule, now, result.error === null);
      out.ran += 1;
      out.emails += result.sent;
      out.drafted += result.drafted;
      out.failed += result.failed;
    } catch {
      // A claimed period whose result could not be written stays marked running: the next tick may try it again (after 10 minutes).
      out.errors += 1;
    }
  }
  return out;
}
