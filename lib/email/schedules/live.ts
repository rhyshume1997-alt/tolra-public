// The real dependencies of the schedule runner: the service-role database and the two senders. Server only.
import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

import { runInvoiceReminders } from "@/lib/email/schedules/reminders";
import type { RunnerDeps } from "@/lib/email/schedules/run";
import { claimRun, finishRun, listEnabledSchedules, noteScheduleRan } from "@/lib/email/schedules/store";
import { runTimesheets } from "@/lib/email/schedules/timesheet";
import { sendCompanyEmail } from "@/lib/email/send-company-email";

/** One cron call stops sending after this long (the route's maxDuration is 60 s); what is left goes on the next try. */
export const RUN_BUDGET_MS = 45_000;

export function liveRunnerDeps(admin: SupabaseClient, startedAt = Date.now(), budgetMs = RUN_BUDGET_MS): RunnerDeps {
  return {
    list: () => listEnabledSchedules(admin),
    claim: (id, key, now) => claimRun(admin, id, key, now),
    execute: (schedule, occurrence, now) => schedule.kind === "invoice_reminder"
      ? runInvoiceReminders(admin, schedule, occurrence, now, { send: sendCompanyEmail, deadline: startedAt + budgetMs })
      : runTimesheets(admin, schedule, occurrence, now, { send: sendCompanyEmail, deadline: startedAt + budgetMs }),
    finish: (id, key, result) => finishRun(admin, id, key, result),
    note: (schedule, now, succeeded) => noteScheduleRan(admin, schedule, now, succeeded),
  };
}
