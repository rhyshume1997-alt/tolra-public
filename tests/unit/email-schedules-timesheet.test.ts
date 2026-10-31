import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { type EmailScheduleRow, RETRY_AFTER_MS, claimRun } from "@/lib/email/schedules/store";
import { scheduleEmailKey } from "@/lib/email/schedules/keys";
import { adminEmails, weekNumber, loadPeopleHours, previousWeekStart, runTimesheets, scopedToCompany, weekLabel } from "@/lib/email/schedules/timesheet";
import { dueOccurrence } from "@/lib/email/schedules/due";
import type { CompanyEmailInput, CompanyEmailResult } from "@/lib/email/send-company-email";
import { DEFAULT_TIME_SETTINGS, type AttendanceEvent } from "@/lib/time-sheet";
import { FakeDb } from "../support/fake-db";

const ORG = "org-a";
const A = "user-a";
const B = "user-b";

// Week of Mon 19 Oct 2026 (BST until Sun 25 Oct 01:00 GMT... the clocks go back that Sunday): A works Mon-Wed 08:00-16:30 local; B works Mon 09:00-12:00.
const ev = (user: string, action: AttendanceEvent["action"], iso: string, n: number): AttendanceEvent => ({ id: `e${n}`, user_id: user, action, at: iso, source: "clock" });
const events: AttendanceEvent[] = [
  ...["19", "20", "21"].flatMap((d, i) => [ev(A, "in", `2026-10-${d}T07:00:00Z`, i * 2), ev(A, "out", `2026-10-${d}T15:30:00Z`, i * 2 + 1)]),
  ev(B, "in", "2026-10-19T08:00:00Z", 10), ev(B, "out", "2026-10-19T11:00:00Z", 11),
];

const loadTimeData = vi.fn();
vi.mock("@/lib/time-data", async (original) => ({ ...(await original<typeof import("@/lib/time-data")>()), loadTimeData: (...args: unknown[]) => loadTimeData(...args) }));

beforeEach(() => {
  loadTimeData.mockReset();
  loadTimeData.mockResolvedValue({ events, labour: [], settings: { ...DEFAULT_TIME_SETTINGS }, bankHolidays: new Map(), jobs: {} });
});

describe("which week, and how it reads", () => {
  it("the last full week before the week the schedule runs in", () => {
    expect(previousWeekStart("2026-10-26")).toBe("2026-10-19"); // run on Monday 26 Oct
    expect(previousWeekStart("2026-10-30")).toBe("2026-10-19"); // run on Friday 30 Oct
    expect(previousWeekStart("2026-11-01")).toBe("2026-10-19"); // run on Sunday 1 Nov (still that week)
    expect(previousWeekStart("2027-01-04")).toBe("2026-12-28"); // across the year end
  });
  it("labels the week", () => {
    expect(weekLabel("2026-10-19")).toBe("Mon 19 Oct to Sun 25 Oct 2026");
    expect(weekLabel("2026-12-28")).toBe("Mon 28 Dec to Sun 3 Jan 2027");
  });
});

describe("reading one company's hours", () => {
  it("narrows every company table to the company, and leaves shared ones (bank holidays) alone", async () => {
    const calls: Array<{ table: string; eq: Array<[string, string]> }> = [];
    const client = { from: (table: string) => ({ select: () => { const rec = { table, eq: [] as Array<[string, string]> }; calls.push(rec); const q = { eq: (c: string, v: string) => { rec.eq.push([c, v]); return q; } }; return q; } }) };
    const scoped = scopedToCompany(client as never, ORG);
    for (const t of ["attendance_events", "operator_sessions", "time_settings", "jobs", "bank_holidays"]) (scoped.from(t) as unknown as { select: () => unknown }).select();
    expect(calls.map((c) => [c.table, c.eq])).toEqual([
      ["attendance_events", [["organization_id", ORG]]], ["operator_sessions", [["organization_id", ORG]]], ["time_settings", [["organization_id", ORG]]],
      ["jobs", [["organization_id", ORG]]], ["bank_holidays", []],
    ]);
  });

  it("gives each person's paid and clocked minutes from the same sums the weekly review uses; nobody who didn't work", async () => {
    const people = await loadPeopleHours({} as never, ORG, "2026-10-19", new Date("2026-10-26T09:00:00Z"));
    expect(people.map((p) => p.userId)).toEqual([A, B]);
    const a = people.find((p) => p.userId === A)!;
    expect(a.clockedMinutes).toBe(3 * 8.5 * 60); // 08:00-16:30 BST, three days
    expect(a.paidMinutes).toBe(3 * (8.5 * 60 - 45)); // the unpaid lunch (30) and break (15) taken off, as the weekly review does with the default settings
    const b = people.find((p) => p.userId === B)!;
    expect(b.clockedMinutes).toBe(180);
    expect(b.paidMinutes).toBe(180); // under the 6 h minimum: no deduction
  });
});

describe("the numbers in the e-mail", () => {
  it("the ISO week number of the week", () => {
    expect(weekNumber("2026-10-19")).toBe(43);
    expect(weekNumber("2026-12-28")).toBe(53);
  });
});

describe("the admins' e-mail addresses", () => {
  it("the company's active admins (by role or second role), not support, not expired, not other companies", async () => {
    const db = new FakeDb({
      organization_members: [
        { organization_id: ORG, user_id: "u1", role: "admin", secondary_role: null, active: true, support: false, expires_at: null },
        { organization_id: ORG, user_id: "u2", role: "office", secondary_role: "admin", active: true, support: false, expires_at: null },
        { organization_id: ORG, user_id: "u3", role: "office", secondary_role: null, active: true, support: false, expires_at: null },
        { organization_id: ORG, user_id: "u4", role: "admin", secondary_role: null, active: false, support: false, expires_at: null },
        { organization_id: ORG, user_id: "u5", role: "admin", secondary_role: null, active: true, support: true, expires_at: "2099-01-01T00:00:00Z" },
        { organization_id: ORG, user_id: "u6", role: "admin", secondary_role: null, active: true, support: false, expires_at: "2020-01-01T00:00:00Z" },
        { organization_id: "org-b", user_id: "u7", role: "admin", secondary_role: null, active: true, support: false, expires_at: null },
      ],
      user_profiles: ["u1", "u2", "u3", "u4", "u5", "u6", "u7"].map((id) => ({ id, email: `${id}@jnr.test`, full_name: id })),
    });
    expect(await adminEmails(db as never, ORG, new Date("2026-10-26T09:00:00Z"))).toEqual(["u1@jnr.test", "u2@jnr.test"]);
  });
});

describe("running a period of timesheet e-mails", () => {
  const schedule: EmailScheduleRow = {
    id: "sch-2", organization_id: ORG, kind: "timesheet", enabled: true, frequency: "weekly", weekday: 1, time_of_day: "09:00", run_at: null,
    timezone: "Europe/London", recipients: null, last_run_at: null, updated_at: "2026-10-01T00:00:00Z",
  };
  const now = new Date("2026-10-26T09:05:00Z");
  const occurrence = dueOccurrence(schedule, now)!;
  const send = vi.fn<(input: CompanyEmailInput) => Promise<CompanyEmailResult>>();
  let db: FakeDb;
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({ ok: true, mode: "sent", provider: "mock" });
    db = new FakeDb({
      organization_members: [
        { organization_id: ORG, user_id: "boss", role: "admin", secondary_role: null, active: true, support: false, expires_at: null },
        { organization_id: ORG, user_id: "boss2", role: "admin", secondary_role: null, active: true, support: false, expires_at: null },
      ],
      user_profiles: [
        { id: "boss", email: "boss@jnr.test", full_name: "The Boss" }, { id: "boss2", email: "second@jnr.test", full_name: "Second" },
        { id: A, email: "a@jnr.test", full_name: "Alex Ames" }, { id: B, email: "b@jnr.test", full_name: null },
      ],
      organizations: [{ id: ORG, name: "JNR Engineering" }],
    });
  });

  it("sends one e-mail per person who worked, each to every admin, for the right week", async () => {
    const out = await runTimesheets(db as never, schedule, occurrence, now, { send });
    expect(out).toMatchObject({ sent: 2, failed: 0, error: null, retryable: true });
    expect(send).toHaveBeenCalledTimes(2);
    const [first, second] = send.mock.calls.map((c) => c[0]);
    expect(first).toMatchObject({ organizationId: ORG, kind: "timesheet", to: ["boss@jnr.test", "second@jnr.test"], recordType: "timesheet", recordId: `${A}:2026-10-19` });
    expect(first.subject).toBe("Timesheet for Alex Ames, week 43 (Mon 19 Oct to Sun 25 Oct 2026) from JNR Engineering");
    expect(first.text).toContain("\nRecorded hours: 23.25\n");
    expect(second.text).toContain("\nRecorded hours: 3\n");
    expect(first.idempotencyKey).toBe(scheduleEmailKey("timesheet", "sch-2", occurrence.periodKey, A));
    expect(first.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,100}$/);
    expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(first.html).toContain("<br>");
    for (const m of [first, second]) { expect(m.subject).not.toContain("{{"); expect(m.text).not.toContain("{{"); }
    expect(loadTimeData.mock.calls[0][1]).toMatchObject({ userId: null });
  });

  it("chosen recipients replace the admins", async () => {
    await runTimesheets(db as never, { ...schedule, recipients: ["accounts@jnr.test"] }, occurrence, now, { send });
    expect(send.mock.calls.every((c) => JSON.stringify(c[0].to) === JSON.stringify(["accounts@jnr.test"]))).toBe(true);
  });

  it("a company with no admin address records why instead of sending to nobody", async () => {
    db.tables.user_profiles = [];
    const out = await runTimesheets(db as never, schedule, occurrence, now, { send });
    expect(out).toMatchObject({ sent: 0, error: "no recipient: the company has no admin e-mail address" });
    expect(send).not.toHaveBeenCalled();
  });

  it("a week nobody worked sends nothing and is not an error", async () => {
    loadTimeData.mockResolvedValue({ events: [], labour: [], settings: { ...DEFAULT_TIME_SETTINGS }, bankHolidays: new Map(), jobs: {} });
    expect(await runTimesheets(db as never, schedule, occurrence, now, { send })).toMatchObject({ sent: 0, failed: 0, error: null });
  });

  it("a failure is counted by code, never with an address, and its claim is given back so a retry sends just that person", async () => {
    send.mockResolvedValueOnce({ ok: false, error: "boss@jnr.test refused", code: "recipient_refused" });
    const out = await runTimesheets(db as never, schedule, occurrence, now, { send });
    expect(out).toMatchObject({ sent: 1, failed: 1, retryable: true, error: "1 timesheet e-mail not sent (recipient_refused)" });
    expect(out.error).not.toContain("jnr.test");
    expect(db.rows("timesheet_sends").map((r) => r.user_id)).toEqual([B]); // A's claim was given back
    const again = await runTimesheets(db as never, schedule, occurrence, now, { send });
    expect(again).toMatchObject({ sent: 1, skipped: 1, failed: 0, error: null });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][0].recordId).toBe(`${A}:2026-10-19`);
    expect(db.rows("timesheet_sends").map((r) => r.user_id).sort()).toEqual([A, B]);
  });

  it("a sender that throws is counted, the claim is given back, and the other people are still e-mailed", async () => {
    send.mockRejectedValueOnce(new Error("boom: boss@jnr.test"));
    const out = await runTimesheets(db as never, schedule, occurrence, now, { send });
    expect(out).toMatchObject({ sent: 1, failed: 1, error: "1 timesheet e-mail not sent (unexpected)" });
    expect(db.rows("timesheet_sends").map((r) => r.user_id)).toEqual([B]);
  });

  it("running the same period twice e-mails each person once", async () => {
    await runTimesheets(db as never, schedule, occurrence, now, { send });
    const second = await runTimesheets(db as never, schedule, occurrence, now, { send });
    expect(second).toMatchObject({ sent: 0, skipped: 2, failed: 0, error: null });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a period retaken after a crash (the run left 'running', 10+ minutes old) e-mails only the people not yet sent", async () => {
    // First attempt: claims the run, e-mails A, then the process dies before B (A's record exists, B's does not, the run still says running).
    expect(await claimRun(db as never, schedule.id, occurrence.periodKey, now)).toBe("claimed");
    db.rows("timesheet_sends").push({ schedule_id: schedule.id, period_key: occurrence.periodKey, user_id: A });
    const later = new Date(now.getTime() + RETRY_AFTER_MS + 60_000);
    expect(await claimRun(db as never, schedule.id, occurrence.periodKey, later)).toBe("claimed"); // the retake is kept
    const out = await runTimesheets(db as never, schedule, occurrence, later, { send });
    expect(out).toMatchObject({ sent: 1, skipped: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].recordId).toBe(`${B}:2026-10-19`);
    // And a further retake sends nobody.
    const third = await runTimesheets(db as never, schedule, occurrence, later, { send });
    expect(third).toMatchObject({ sent: 0, skipped: 2 });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("another period or another schedule is its own claim", async () => {
    await runTimesheets(db as never, schedule, occurrence, now, { send });
    await runTimesheets(db as never, schedule, { at: occurrence.at, periodKey: "another-period" }, now, { send }); // same hours, a different period key
    await runTimesheets(db as never, { ...schedule, id: "sch-other" }, occurrence, now, { send });
    expect(send).toHaveBeenCalledTimes(6);
  });

  it("stops at the time limit like the reminders do, says so, and the next try carries on with the rest", async () => {
    let t = 0;
    const clock = () => (t += 1000); // each person costs a second; the limit allows the first only
    const out = await runTimesheets(db as never, schedule, occurrence, now, { send, deadline: 1500, clock });
    expect(out).toMatchObject({ sent: 1, error: "stopped at the time limit; the rest goes on the next try", retryable: true });
    expect(send).toHaveBeenCalledTimes(1);
    const rest = await runTimesheets(db as never, schedule, occurrence, now, { send });
    expect(rest).toMatchObject({ sent: 1, skipped: 1, error: null });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("a deadline already passed sends nobody and claims nobody", async () => {
    const out = await runTimesheets(db as never, schedule, occurrence, now, { send, deadline: 1, clock: () => 2 });
    expect(out.sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(db.rows("timesheet_sends")).toHaveLength(0);
  });
});
