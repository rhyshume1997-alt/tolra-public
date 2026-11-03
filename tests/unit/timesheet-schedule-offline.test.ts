// @vitest-environment node
// Pure scheduling only: no Supabase client, database credentials, fake database or mail provider.
import { describe, expect, it } from "vitest";
import { dueOccurrence, nextRun, parseTimeOfDay, type ScheduleTiming } from "@/lib/email/schedules/due";
import { defaultForm, patchFromForm } from "@/lib/email/schedules/form";

const schedule = (days: number[], patch: Partial<ScheduleTiming> = {}): ScheduleTiming => ({
  enabled: true, frequency: "daily", weekdays: days, weekday: null, time_of_day: "08:00", timezone: "Europe/London",
  run_at: null, updated_at: "2026-01-01T00:00:00Z", ...patch,
});
describe("timesheet schedules without a database", () => {
  it("is off by default and an off schedule has no occurrence or next run", () => {
    expect(defaultForm("timesheet").enabled).toBe(false);
    const off = schedule([1, 3, 5], { enabled: false });
    expect(nextRun(off, new Date("2026-11-02T09:00:00Z"))).toBeNull();
    expect(dueOccurrence(off, new Date("2026-11-02T09:00:00Z"))).toBeNull();
  });
  it.each([1, 2, 3, 4, 5, 6, 7])("chooses ISO weekday %s", day => {
    expect(nextRun(schedule([day]), new Date("2026-11-01T12:00:00Z"))?.toISOString())
      .toBe(`2026-11-${String(day + 1).padStart(2, "0")}T08:00:00.000Z`);
  });
  it.each(["08:00:99", "08:00:60", "08:60", "24:00", "08:00:-1"])("rejects impossible time %s at the parser and form boundary", time => {
    expect(parseTimeOfDay(time)).toBeNull();
    expect(patchFromForm("timesheet", { ...defaultForm("timesheet"), enabled: true, weekdays: [1], time }, new Date("2026-11-01T00:00:00Z")))
      .toMatchObject({ ok: false });
  });
  it("an enabled schedule needs selected days", () => {
    expect(nextRun(schedule([]), new Date("2026-11-01T12:00:00Z"))).toBeNull();
    expect(patchFromForm("timesheet", { ...defaultForm("timesheet"), enabled: true, weekdays: [] }, new Date("2026-11-01T00:00:00Z"))).toMatchObject({ ok: false });
  });
  it("moves a missing spring clock time forward, rather than dropping the chosen day", () => {
    expect(nextRun(schedule([7], { time_of_day: "01:30" }), new Date("2026-03-28T12:00:00Z"))?.toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });
  it("both copies of the autumn hour identify one scheduled occurrence", () => {
    const s = schedule([7], { time_of_day: "01:30" });
    const first = dueOccurrence(s, new Date("2026-10-25T00:45:00Z"));
    const second = dueOccurrence(s, new Date("2026-10-25T01:45:00Z"));
    expect(first).toEqual(second);
    expect(first?.at.toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });
});
