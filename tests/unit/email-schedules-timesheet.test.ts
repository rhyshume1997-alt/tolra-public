import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { type EmailScheduleRow } from "@/lib/email/schedules/store";
import { adminEmails, loadPeopleHours, previousWeekStart, runTimesheets, scopedToCompany, weekLabel } from "@/lib/email/schedules/timesheet";
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
    expect(out).toMatchObject({ sent: 2, failed: 0, error: null, retryable: false });
    expect(send).toHaveBeenCalledTimes(2);
    const [first, second] = send.mock.calls.map((c) => c[0]);
    expect(first).toMatchObject({ organizationId: ORG, kind: "timesheet", to: ["boss@jnr.test", "second@jnr.test"], recordType: "timesheet", recordId: `${A}:2026-10-19` });
    expect(first.subject).toContain("Alex Ames");
    expect(first.subject).toContain("Mon 19 Oct to Sun 25 Oct 2026");
    expect(first.text).toContain("23:15 paid (25:30 clocked)");
    expect(second.subject).toContain("b@jnr.test"); // no name: the e-mail address stands in
    expect(second.text).toContain("3:00 paid");
    expect(first.idempotencyKey).toBe(`timesheet:sch-2:${occurrence.periodKey}:${A}`);
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

  it("a failure is counted by code, never with an address, and is not retried automatically", async () => {
    send.mockResolvedValueOnce({ ok: false, error: "boss@jnr.test refused", code: "recipient_refused" });
    const out = await runTimesheets(db as never, schedule, occurrence, now, { send });
    expect(out).toMatchObject({ sent: 1, failed: 1, retryable: false, error: "1 timesheet e-mail not sent (recipient_refused)" });
    expect(out.error).not.toContain("jnr.test");
  });
});
