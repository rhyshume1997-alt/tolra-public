import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const runInvoiceReminders = vi.fn();
const runTimesheets = vi.fn();
vi.mock("@/lib/email/schedules/reminders", () => ({ runInvoiceReminders: (...a: unknown[]) => runInvoiceReminders(...a) }));
vi.mock("@/lib/email/schedules/timesheet", () => ({ runTimesheets: (...a: unknown[]) => runTimesheets(...a) }));
vi.mock("@/lib/email/send-company-email", () => ({ sendCompanyEmail: vi.fn() }));

import { RUN_BUDGET_MS, liveRunnerDeps } from "@/lib/email/schedules/live";
import type { EmailScheduleRow } from "@/lib/email/schedules/store";

const row = (kind: EmailScheduleRow["kind"]): EmailScheduleRow => ({
  id: "s", organization_id: "o", kind, enabled: true, frequency: "daily", weekday: null, time_of_day: "08:00", run_at: null, timezone: "Europe/London", recipients: null, last_run_at: null,
});
const occurrence = { at: new Date("2026-10-26T08:00:00Z"), periodKey: "2026-10-26" };

beforeEach(() => {
  runInvoiceReminders.mockReset().mockResolvedValue({});
  runTimesheets.mockReset().mockResolvedValue({});
});

describe("the live runner gives BOTH senders the same time limit, so a big company can't use up the route's 60 s before the Xero sweep", () => {
  it("reminders and timesheets both get deadline = start + budget", async () => {
    const deps = liveRunnerDeps({} as never, 1_000_000, 30_000);
    await deps.execute(row("invoice_reminder"), occurrence, new Date());
    await deps.execute(row("timesheet"), occurrence, new Date());
    expect(runInvoiceReminders.mock.calls[0][4]).toMatchObject({ deadline: 1_030_000 });
    expect(runTimesheets.mock.calls[0][4]).toMatchObject({ deadline: 1_030_000 });
  });
  it("the default budget is the pass's 45 s", async () => {
    const deps = liveRunnerDeps({} as never, 5);
    await deps.execute(row("timesheet"), occurrence, new Date());
    expect(runTimesheets.mock.calls[0][4]).toMatchObject({ deadline: 5 + RUN_BUDGET_MS });
    expect(RUN_BUDGET_MS).toBe(45_000);
  });
});
