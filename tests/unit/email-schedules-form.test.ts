import { describe, expect, it } from "vitest";

import { defaultForm, formFromRow, nextRunLine, parseRecipients, patchFromForm, scheduleErrorMessage, SCHEDULE_NOT_AVAILABLE } from "@/lib/email/schedules/form";

const NOW = new Date("2026-10-23T12:00:00Z");

describe("Settings > Email schedules: the form", () => {
  it("starts Off, with a sensible default for each kind", () => {
    expect(defaultForm("invoice_reminder")).toMatchObject({ enabled: false, frequency: "daily", time: "08:00" });
    expect(defaultForm("timesheet")).toMatchObject({ enabled: false, frequency: "weekly", weekday: 1 });
  });

  it("turns a weekly form into a row, and back", () => {
    const made = patchFromForm("timesheet", { ...defaultForm("timesheet"), enabled: true, weekday: 5, time: "16:30", recipients: "boss@example.test, accounts@example.test\nboss@example.test" }, NOW);
    expect(made).toEqual({ ok: true, patch: { enabled: true, frequency: "weekly", weekday: 5, time_of_day: "16:30", run_at: null, timezone: "Europe/London", recipients: ["boss@example.test", "accounts@example.test"] } });
    if (!made.ok) throw new Error("unreachable");
    expect(formFromRow("timesheet", { ...made.patch, time_of_day: "16:30:00" })).toMatchObject({ enabled: true, frequency: "weekly", weekday: 5, time: "16:30", recipients: "boss@example.test\naccounts@example.test" });
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
    ["a frequency this kind doesn't offer", { frequency: "daily" as const }, "Choose how often it should run."],
  ])("refuses %s with a plain sentence", (_name, change, message) => {
    const kind = _name.includes("doesn't offer") ? "timesheet" : "invoice_reminder";
    expect(patchFromForm(kind, { ...defaultForm(kind), enabled: true, ...change }, NOW)).toEqual({ ok: false, error: message });
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
    expect(nextRunLine("invoice_reminder", { ...defaultForm("invoice_reminder"), enabled: true }, NOW)).toBe("Next run: Sat 24 Oct 2026 at 08:00 (BST)");
    expect(nextRunLine("timesheet", { ...defaultForm("timesheet"), enabled: true, weekday: 1, time: "09:30" }, NOW)).toBe("Next run: Mon 26 Oct 2026 at 09:30 (GMT)");
    expect(nextRunLine("invoice_reminder", { ...defaultForm("invoice_reminder"), enabled: true, frequency: "once", onceDate: "2026-10-01" }, NOW)).toBe("That date and time have passed: nothing will be sent.");
    expect(nextRunLine("invoice_reminder", { ...defaultForm("invoice_reminder"), enabled: true, time: "" }, NOW)).toBe("Choose a time of day.");
  });

  it("says friendly things, never the database's words", () => {
    expect(scheduleErrorMessage({ code: "PGRST205", message: "Could not find the table 'public.email_schedules'" })).toBe(SCHEDULE_NOT_AVAILABLE);
    expect(scheduleErrorMessage({ code: "42501", message: "new row violates row-level security policy" })).toBe("Only an admin can change e-mail schedules.");
    expect(scheduleErrorMessage({ code: "22023", hint: "bad_recipient", message: "x" })).toBe("One of the e-mail addresses isn't valid.");
    expect(scheduleErrorMessage({ code: "XX000", message: "relation foo violates constraint" })).toBe("Couldn't save the schedule. Try again.");
    expect(SCHEDULE_NOT_AVAILABLE).toBe("Not available until database update 108 is applied");
  });
});
