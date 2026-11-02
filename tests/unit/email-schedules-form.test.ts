import { describe, expect, it } from "vitest";

import {
  DAILY_RUN_NOTE, EXACT_TIME_SENDING, TIMESHEET_DAYS_NOT_AVAILABLE, cleanDays, defaultForm, formFromRow, nextRunLine, parseRecipients, patchFromForm, scheduleErrorMessage, SCHEDULE_NOT_AVAILABLE,
} from "@/lib/email/schedules/form";

const NOW = new Date("2026-10-23T12:00:00Z");

describe("Settings > Email schedules: the form", () => {
  it("starts Off, with a sensible default for each kind", () => {
    expect(defaultForm("invoice_reminder")).toMatchObject({ enabled: false, frequency: "daily", time: "08:00" });
    // Timesheet e-mails (142): Off, and when switched on the end of the week is offered: Friday, at the default time.
    expect(defaultForm("timesheet")).toMatchObject({ enabled: false, weekdays: [5], time: "08:00" });
    expect(defaultForm("invoice_reminder").weekdays).toEqual([]);
  });

  it("an invoice reminder turns a weekly form into a row, and back (unchanged by 142: no weekdays)", () => {
    const made = patchFromForm("invoice_reminder", { ...defaultForm("invoice_reminder"), enabled: true, frequency: "weekly", weekday: 5, time: "16:30" }, NOW);
    expect(made).toEqual({ ok: true, patch: { enabled: true, frequency: "weekly", weekday: 5, time_of_day: "16:30", run_at: null, timezone: "Europe/London", recipients: null } });
    if (!made.ok) throw new Error("unreachable");
    expect(made.patch).not.toHaveProperty("weekdays");
    expect(formFromRow("invoice_reminder", { ...made.patch, time_of_day: "16:30:00" })).toMatchObject({ enabled: true, frequency: "weekly", weekday: 5, time: "16:30" });
  });

  it("a timesheet form is the days, the time and the addresses: saved as daily on those days, and back", () => {
    const made = patchFromForm("timesheet", { ...defaultForm("timesheet"), enabled: true, weekdays: [5, 1, 3, 3], time: "16:30", recipients: "boss@example.test, accounts@example.test\nboss@example.test" }, NOW);
    expect(made).toEqual({ ok: true, patch: { enabled: true, frequency: "daily", weekday: null, weekdays: [1, 3, 5], time_of_day: "16:30", run_at: null, timezone: "Europe/London", recipients: ["boss@example.test", "accounts@example.test"] } });
    if (!made.ok) throw new Error("unreachable");
    expect(formFromRow("timesheet", { ...made.patch, time_of_day: "16:30:00" })).toMatchObject({ enabled: true, weekdays: [1, 3, 5], time: "16:30", recipients: "boss@example.test\naccounts@example.test", legacyOnceAt: null });
    // Every day, and one day.
    expect(patchFromForm("timesheet", { ...defaultForm("timesheet"), enabled: true, weekdays: [7, 6, 5, 4, 3, 2, 1] }, NOW)).toMatchObject({ ok: true, patch: { weekdays: [1, 2, 3, 4, 5, 6, 7] } });
    expect(patchFromForm("timesheet", { ...defaultForm("timesheet"), enabled: true, weekdays: [7] }, NOW)).toMatchObject({ ok: true, patch: { weekdays: [7] } });
    // The form's frequency is not a timesheet choice any more: whatever it says, the row is daily on the days.
    expect(patchFromForm("timesheet", { ...defaultForm("timesheet"), enabled: true, frequency: "once", onceDate: "2026-10-01" }, NOW)).toMatchObject({ ok: true, patch: { frequency: "daily", run_at: null, weekdays: [5] } });
  });

  it("a timesheet switched on needs at least one day; switched off it may have none", () => {
    expect(patchFromForm("timesheet", { ...defaultForm("timesheet"), enabled: true, weekdays: [] }, NOW)).toEqual({ ok: false, error: "Choose at least one day." });
    expect(patchFromForm("timesheet", { ...defaultForm("timesheet"), enabled: false, weekdays: [] }, NOW)).toMatchObject({ ok: true, patch: { enabled: false, weekdays: [] } });
    expect(nextRunLine("timesheet", { ...defaultForm("timesheet"), enabled: true, weekdays: [] }, NOW)).toBe("Choose at least one day.");
    expect(cleanDays([0, 8, 2.5, 3, 3, 1, "4" as unknown as number])).toEqual([1, 3]);
  });

  it("old timesheet rows read as days: daily (before 142) is every day, weekly is that day, once keeps its moment for the note", () => {
    const old = { enabled: true, weekday: null, time_of_day: "09:00", run_at: null, timezone: "Europe/London", recipients: null };
    expect(formFromRow("timesheet", { ...old, frequency: "daily" }).weekdays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(formFromRow("timesheet", { ...old, frequency: "weekly", weekday: 0 }).weekdays).toEqual([7]);
    expect(formFromRow("timesheet", { ...old, frequency: "weekly", weekday: 3 }).weekdays).toEqual([3]);
    const once = formFromRow("timesheet", { ...old, frequency: "once", run_at: "2027-07-01T13:30:00.000Z" });
    expect(once).toMatchObject({ enabled: true, weekdays: [5], time: "14:30", legacyOnceAt: "2027-07-01T13:30:00.000Z" });
    expect(formFromRow("timesheet", { ...old, frequency: "daily", weekdays: [2, 4] }).weekdays).toEqual([2, 4]);
  });

  it("turns a picked date and time into the moment in UK time, and back (winter and summer)", () => {
    const winter = patchFromForm("invoice_reminder", { ...defaultForm("invoice_reminder"), enabled: true, frequency: "once", onceDate: "2026-11-03", time: "14:30" }, NOW);
    expect(winter).toMatchObject({ ok: true, patch: { frequency: "once", run_at: "2026-11-03T14:30:00.000Z", weekday: null } });
    const summer = patchFromForm("invoice_reminder", { ...defaultForm("invoice_reminder"), enabled: true, frequency: "once", onceDate: "2027-07-01", time: "14:30" }, NOW);
    expect(summer).toMatchObject({ ok: true, patch: { run_at: "2027-07-01T13:30:00.000Z" } });
    if (!summer.ok) throw new Error("unreachable");
    expect(formFromRow("invoice_reminder", summer.patch)).toMatchObject({ frequency: "once", onceDate: "2027-07-01", time: "14:30" });
  });

  it.each([
    ["no time", { time: "" }, "Choose a time of day."],
    ["a once without a date", { frequency: "once" as const, onceDate: "" }, "Choose the date it should run."],
    ["a once that has passed", { frequency: "once" as const, onceDate: "2026-10-01", time: "08:00" }, "Choose a date and time that haven't passed yet."],
  ])("refuses %s with a plain sentence", (_name, change, message) => {
    expect(patchFromForm("invoice_reminder", { ...defaultForm("invoice_reminder"), enabled: true, ...change }, NOW)).toEqual({ ok: false, error: message });
  });

  it("an Off form with a passed once date still saves (so it can be switched off)", () => {
    expect(patchFromForm("invoice_reminder", { ...defaultForm("invoice_reminder"), enabled: false, frequency: "once", onceDate: "2026-10-01" }, NOW).ok).toBe(true);
  });

  it("checks the recipients", () => {
    expect(parseRecipients("")).toEqual({ ok: true, list: [] });
    expect(parseRecipients("a@b.co; c@d.co")).toEqual({ ok: true, list: ["a@b.co", "c@d.co"] });
    expect(parseRecipients("nope")).toEqual({ ok: false, error: '"nope" isn\'t a valid e-mail address.' });
    expect(parseRecipients(Array.from({ length: 21 }, (_, i) => `p${i}@x.co`).join(","))).toEqual({ ok: false, error: "Enter at most 20 e-mail addresses." });
    const made = patchFromForm("timesheet", { ...defaultForm("timesheet"), enabled: true, recipients: "bad" }, NOW);
    expect(made).toMatchObject({ ok: false });
  });

  it("an empty recipients box means every admin (null), and reminders never carry recipients", () => {
    expect(patchFromForm("timesheet", { ...defaultForm("timesheet"), enabled: true }, NOW)).toMatchObject({ ok: true, patch: { recipients: null } });
    expect(patchFromForm("invoice_reminder", { ...defaultForm("invoice_reminder"), enabled: true, recipients: "x@y.co" }, NOW)).toMatchObject({ ok: true, patch: { recipients: null } });
  });

  it("the Next run line comes from the same nextRun the cron uses", () => {
    expect(nextRunLine("invoice_reminder", defaultForm("invoice_reminder"), NOW)).toBe("Off: nothing will be sent.");
    expect(nextRunLine("invoice_reminder", { ...defaultForm("invoice_reminder"), enabled: true }, NOW)).toBe("Chosen time: Sat 24 Oct 2026 at 08:00 (BST). Sent at the next daily run after it: Sun 25 Oct 2026 at 05:00 (GMT).");
    expect(nextRunLine("timesheet", { ...defaultForm("timesheet"), enabled: true, weekdays: [1], time: "09:30" }, NOW)).toBe("Chosen time: Mon 26 Oct 2026 at 09:30 (GMT). Sent at the next daily run after it: Tue 27 Oct 2026 at 05:00 (GMT).");
    // Friday 23 Oct 2026 at noon: with Mon + Wed + Fri at 09:30, Friday's time has passed, so the next is Monday.
    expect(nextRunLine("timesheet", { ...defaultForm("timesheet"), enabled: true, weekdays: [1, 3, 5], time: "09:30" }, NOW)).toBe("Chosen time: Mon 26 Oct 2026 at 09:30 (GMT). Sent at the next daily run after it: Tue 27 Oct 2026 at 05:00 (GMT).");
    expect(nextRunLine("timesheet", { ...defaultForm("timesheet"), enabled: true, weekdays: [1, 3, 5], time: "16:00" }, NOW)).toBe("Chosen time: Fri 23 Oct 2026 at 16:00 (BST). Sent at the next daily run after it: Sat 24 Oct 2026 at 06:00 (BST).");
    // In summer the daily run (05:00 UTC) is 06:00 UK time, and the line says so.
    expect(nextRunLine("invoice_reminder", { ...defaultForm("invoice_reminder"), enabled: true }, new Date("2027-07-05T12:00:00Z"))).toBe("Chosen time: Tue 6 Jul 2027 at 08:00 (BST). Sent at the next daily run after it: Wed 7 Jul 2027 at 06:00 (BST).");
    expect(nextRunLine("invoice_reminder", { ...defaultForm("invoice_reminder"), enabled: true, frequency: "once", onceDate: "2026-10-01" }, NOW)).toBe("That date and time have passed: nothing will be sent.");
    expect(nextRunLine("invoice_reminder", { ...defaultForm("invoice_reminder"), enabled: true, time: "" }, NOW)).toBe("Choose a time of day.");
  });

  it("says plainly that sending waits for the daily run (Hobby), until exact-time sending is switched on (Pro)", () => {
    expect(EXACT_TIME_SENDING).toBe(false);
    expect(DAILY_RUN_NOTE).toBe("Sent at the next daily run (about 05:00 UK) after the chosen time; exact-time sending needs the Pro plan.");
  });

  it("says friendly things, never the database's words", () => {
    expect(scheduleErrorMessage({ code: "PGRST205", message: "Could not find the table 'public.email_schedules'" })).toBe(SCHEDULE_NOT_AVAILABLE);
    expect(scheduleErrorMessage({ code: "42501", message: "new row violates row-level security policy" })).toBe("Only an admin can change e-mail schedules.");
    expect(scheduleErrorMessage({ code: "22023", hint: "bad_recipient", message: "x" })).toBe("One of the e-mail addresses isn't valid.");
    expect(scheduleErrorMessage({ code: "XX000", message: "relation foo violates constraint" })).toBe("Couldn't save the schedule. Try again.");
    expect(SCHEDULE_NOT_AVAILABLE).toBe("Not available until database update 108 is applied");
    expect(TIMESHEET_DAYS_NOT_AVAILABLE).toBe("Not available until database update 142 is applied");
  });
});
