import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const loadTimeData = vi.hoisted(() => vi.fn());
vi.mock("@/lib/time-data", async (original) => ({ ...(await original<typeof import("@/lib/time-data")>()), loadTimeData }));
import { dueOccurrence, nextRun, parseTimeOfDay, type ScheduleTiming } from "@/lib/email/schedules/due";
import { defaultForm, patchFromForm } from "@/lib/email/schedules/form";
import { runTimesheets } from "@/lib/email/schedules/timesheet";
import { DEFAULT_TIME_SETTINGS } from "@/lib/time-sheet";
import type { EmailScheduleRow } from "@/lib/email/schedules/store";
import { FakeDb } from "../support/fake-db";
const at = (s: string) => new Date(s);
const schedule = (days: number[], extra: Partial<ScheduleTiming> = {}): ScheduleTiming => ({ enabled: true, frequency: "daily", weekdays: days, weekday: null, time_of_day: "09:00", timezone: "Europe/London", run_at: null, updated_at: "2026-01-01T00:00:00Z", ...extra });

describe("extra chosen-day timesheet schedule maths", () => {
  it.each([1, 2, 3, 4, 5, 6, 7])("finds ISO weekday %s after Sunday", (day) => {
    expect(nextRun(schedule([day]), at("2026-11-01T12:00:00Z"))?.toISOString()).toBe(`2026-11-${String(day + 1).padStart(2, "0")}T09:00:00.000Z`);
  });
  it("chooses the earliest day from an unsorted repeated list", () => {
    expect(nextRun(schedule([5, 3, 1, 3]), at("2026-11-01T12:00:00Z"))?.toISOString()).toBe("2026-11-02T09:00:00.000Z");
  });
  it("off or no selected days has no next run", () => {
    expect(nextRun(schedule([], {}), at("2026-11-02T12:00:00Z"))).toBeNull();
    expect(nextRun(schedule([1], { enabled: false }), at("2026-11-02T12:00:00Z"))).toBeNull();
  });
  it.each([["2026-03-29T00:59:59Z", null], ["2026-03-29T01:30:00Z", "2026-03-29"]])("handles the spring gap at %s", (now, key) => {
    expect(dueOccurrence(schedule([7], { time_of_day: "01:30", updated_at: "2026-03-01T00:00:00Z" }), at(now))?.periodKey ?? null).toBe(key);
  });
  it("uses one occurrence through both copies of the autumn hour", () => {
    const s = schedule([7], { time_of_day: "01:30" });
    const first = dueOccurrence(s, at("2026-10-25T00:45:00Z"));
    const second = dueOccurrence(s, at("2026-10-25T01:45:00Z"));
    expect(first).toEqual(second); expect(first?.at.toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });
  it("does not send an occurrence at or before the last settings save", () => {
    expect(dueOccurrence(schedule([1], { updated_at: "2026-11-02T09:00:00Z" }), at("2026-11-02T09:00:01Z"))).toBeNull();
  });
  it.each(["24:00", "09:60", "noon", "", "09:0"])("rejects invalid time %j", (time) => expect(parseTimeOfDay(time)).toBeNull());
  it("allows empty addresses in the form for the documented admin fallback", () => {
    const result = patchFromForm("timesheet", { ...defaultForm("timesheet"), enabled: true, weekdays: [5, 1, 5], recipients: "" }, at("2026-11-02T00:00:00Z"));
    expect(result).toMatchObject({ ok: true, patch: { weekdays: [1, 5], recipients: null, frequency: "daily" } });
  });
  it("rejects an enabled timesheet with no selected days", () => {
    expect(patchFromForm("timesheet", { ...defaultForm("timesheet"), enabled: true, weekdays: [] }, at("2026-11-02T00:00:00Z"))).toMatchObject({ ok: false });
  });
});

describe("missing addresses and repeated timesheet sends", () => {
  const row: EmailScheduleRow = { ...schedule([1, 3, 5]), id: "schedule", organization_id: "company", kind: "timesheet", recipients: ["payroll@example.test"], last_run_at: null, updated_at: "2026-01-01T00:00:00Z" };
  const now = at("2026-11-02T09:05:00Z");
  const occurrence = dueOccurrence(row, now)!;
  const send = vi.fn();
  let db: FakeDb;
  beforeEach(() => {
    send.mockReset().mockResolvedValue({ ok: true, mode: "sent", provider: "mock" });
    loadTimeData.mockReset().mockResolvedValue({ events: [
      { id: "in", user_id: "person", action: "in", at: "2026-10-26T09:00:00Z", source: "clock" },
      { id: "out", user_id: "person", action: "out", at: "2026-10-26T17:00:00Z", source: "clock" },
    ], labour: [], settings: { ...DEFAULT_TIME_SETTINGS }, bankHolidays: new Map(), jobs: {} });
    db = new FakeDb({ organization_members: [], user_profiles: [{ id: "person", email: "person@example.test", full_name: "Test Person" }], organizations: [{ id: "company", name: "Test Shop" }] });
  });
  const run = (s = row) => runTimesheets(db as never, s, occurrence, now, { send });
  it("does not send or reserve a person's email when there is no recipient and no admin", async () => {
    const result = await run({ ...row, recipients: null });
    expect(result).toMatchObject({ sent: 0, error: expect.stringContaining("no recipient") });
    expect(send).not.toHaveBeenCalled(); expect(db.rows("timesheet_sends")).toEqual([]);
  });
  it("does not send to invalid explicit addresses or invalid admin addresses", async () => {
    db.rows("organization_members").push({ organization_id: "company", user_id: "boss", role: "admin", active: true, support: false, expires_at: null });
    db.rows("user_profiles").push({ id: "boss", email: "not-an-address" });
    const result = await run({ ...row, recipients: ["not-an-address", ""] });
    expect(result.sent).toBe(0); expect(send).not.toHaveBeenCalled();
  });
  it("reserves the person before sending so concurrent attempts send only once", async () => {
    const results = await Promise.all([run(), run()]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(results.reduce((n, r) => n + r.sent, 0)).toBe(1);
    expect(results.reduce((n, r) => n + r.skipped, 0)).toBe(1);
    expect(db.rows("timesheet_sends")).toHaveLength(1);
  });
  it("a completed period does not send again on a later retry", async () => {
    await run(); await run(); expect(send).toHaveBeenCalledTimes(1);
  });
  it("releases a failed claim so retry can deliver once", async () => {
    send.mockResolvedValueOnce({ ok: false, code: "provider_error", error: "failed" });
    expect((await run()).failed).toBe(1); expect(db.rows("timesheet_sends")).toEqual([]);
    expect((await run()).sent).toBe(1); expect(send).toHaveBeenCalledTimes(2);
  });
});
