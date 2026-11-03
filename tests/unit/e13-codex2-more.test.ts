import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const loadTimeData = vi.hoisted(() => vi.fn());
vi.mock("@/lib/time-data", async (original) => ({ ...(await original<typeof import("@/lib/time-data")>()), loadTimeData }));
import { dueOccurrence, nextRun, parseTimeOfDay, type ScheduleTiming } from "@/lib/email/schedules/due";
import { defaultForm, patchFromForm } from "@/lib/email/schedules/form";
import { runTimesheets } from "@/lib/email/schedules/timesheet";
import type { EmailScheduleRow } from "@/lib/email/schedules/store";
import { DEFAULT_TIME_SETTINGS } from "@/lib/time-sheet";
import { FakeDb } from "../support/fake-db";
const at = (value: string) => new Date(value);
const timing = (days: number[], changes: Partial<ScheduleTiming> = {}): ScheduleTiming => ({
  enabled: true, frequency: "daily", weekday: null, weekdays: days, time_of_day: "09:00",
  run_at: null, timezone: "Europe/London", updated_at: "2026-01-01T00:00:00Z", ...changes,
});

describe("selected-day calendar boundaries", () => {
  it.each([
    ["2026-01-30T10:00:00Z", [1], "2026-02-02T09:00:00.000Z"],
    ["2026-12-31T10:00:00Z", [1], "2027-01-04T09:00:00.000Z"],
    ["2024-02-28T10:00:00Z", [4], "2024-02-29T09:00:00.000Z"],
    ["2026-03-27T10:00:00Z", [1], "2026-03-30T08:00:00.000Z"],
    ["2026-10-23T10:00:00Z", [1], "2026-10-26T09:00:00.000Z"],
  ] as const)("finds the next selected day after %s", (now, days, expected) => {
    expect(nextRun(timing([...days]), at(now))?.toISOString()).toBe(expected);
  });
  it("does not mutate or duplicate a chosen-day list", () => {
    const days = [5, 1, 3, 1];
    const before = [...days];
    expect(nextRun(timing(days), at("2026-11-01T12:00:00Z"))?.toISOString()).toBe("2026-11-02T09:00:00.000Z");
    expect(days).toEqual(before);
  });
  it("uses a single date key for both autumn copies of 01:30", () => {
    const row = timing([7], { time_of_day: "01:30" });
    const first = dueOccurrence(row, at("2026-10-25T00:31:00Z"));
    const second = dueOccurrence(row, at("2026-10-25T01:31:00Z"));
    expect(first).toEqual(second);
    expect(first?.periodKey).toBe("2026-10-25");
    expect(first?.at.toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });
  it("moves a missing spring 01:30 to 02:30 local, once", () => {
    const row = timing([7], { time_of_day: "01:30" });
    expect(dueOccurrence(row, at("2026-03-29T01:29:59Z"))?.periodKey).not.toBe("2026-03-29");
    expect(dueOccurrence(row, at("2026-03-29T01:30:00Z")))
      .toEqual({ at: at("2026-03-29T01:30:00Z"), periodKey: "2026-03-29" });
  });
  it.each(["08:00:60", "08:00:99", "08:00:60.1", "23:59:99"])("refuses impossible seconds: %s", (value) => {
    expect(parseTimeOfDay(value)).toBeNull();
    expect(patchFromForm("timesheet", { ...defaultForm("timesheet"), enabled: true, time: value }, at("2026-11-01T00:00:00Z"))).toMatchObject({ ok: false });
  });
  it.each(["08:00:00", "08:00:59", "08:00:59.999"])("keeps valid stored second precision: %s", (value) => {
    expect(parseTimeOfDay(value)).toEqual([8, 0]);
  });
});

describe("timesheet recipient and send claims", () => {
  const row: EmailScheduleRow = { ...timing([1, 3, 5]), id: "timesheet", organization_id: "company", kind: "timesheet", recipients: ["payroll@example.test"], last_run_at: null };
  const now = at("2026-11-02T09:05:00Z");
  const occurrence = dueOccurrence(row, now)!;
  let db: FakeDb;
  const send = vi.fn();
  beforeEach(() => {
    send.mockReset().mockResolvedValue({ ok: true, mode: "sent", provider: "mock" });
    loadTimeData.mockReset().mockResolvedValue({ events: [
      { id: "in", user_id: "person", action: "in", at: "2026-10-26T09:00:00Z", source: "clock" },
      { id: "out", user_id: "person", action: "out", at: "2026-10-26T10:00:00Z", source: "clock" },
    ], labour: [], settings: { ...DEFAULT_TIME_SETTINGS }, bankHolidays: new Map(), jobs: {} });
    db = new FakeDb({ organization_members: [], user_profiles: [{ id: "person", email: "person@example.test", full_name: "Person" }], organizations: [{ id: "company", name: "Our Shop" }] });
  });
  it.each([null, [], ["invalid", ""]])("does not claim or send without usable recipient addresses: %j", async (recipients) => {
    expect(await runTimesheets(db as never, { ...row, recipients }, occurrence, now, { send }))
      .toMatchObject({ sent: 0, error: expect.stringContaining("no recipient") });
    expect(send).not.toHaveBeenCalled();
    expect(loadTimeData).not.toHaveBeenCalled();
    expect(db.rows("timesheet_sends")).toEqual([]);
  });
  it("a second pass while the first send is pending cannot send the same person's email", async () => {
    let entered!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    send.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ ok: true, mode: "sent", provider: "mock" }); entered(); }));
    const first = runTimesheets(db as never, row, occurrence, now, { send });
    await started;
    try {
      expect(await runTimesheets(db as never, row, occurrence, now, { send })).toMatchObject({ sent: 0, skipped: 1 });
      expect(send).toHaveBeenCalledTimes(1);
    } finally { finish(); }
    expect(await first).toMatchObject({ sent: 1, failed: 0 });
    expect(db.rows("timesheet_sends")).toHaveLength(1);
  });
  it("a refused send releases its claim and a retry keeps the same idempotency key", async () => {
    send.mockResolvedValueOnce({ ok: false, code: "provider_error", error: "Refused" });
    expect(await runTimesheets(db as never, row, occurrence, now, { send })).toMatchObject({ sent: 0, failed: 1 });
    expect(db.rows("timesheet_sends")).toEqual([]);
    expect(await runTimesheets(db as never, row, occurrence, now, { send })).toMatchObject({ sent: 1, failed: 0 });
    expect(send.mock.calls[0][0].idempotencyKey).toBe(send.mock.calls[1][0].idempotencyKey);
  });
});
