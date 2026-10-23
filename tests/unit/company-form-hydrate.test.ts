import { describe, expect, it } from "vitest";

import { DEFAULT_WORKING_HOURS, parseCompanyProfile } from "@/lib/company";
import { companyFormToHydrate, EMPTY_COMPANY, toForm, workingHoursFromForm } from "@/lib/company-form";

const profile = parseCompanyProfile({ documentName: "Test Ltd", addressLines: ["1 Street"], vatRegistered: false, workStart: "07:00", workEnd: "15:30", workDays: [1, 2, 3, 4, 5, 6] });

describe("Company details form hydrate", () => {
  it("does nothing while the profile is still loading, so the form stays on its pre-load defaults", () => {
    expect(companyFormToHydrate(true, false, null)).toBeNull();
    expect(companyFormToHydrate(true, false, profile)).toBeNull();
    expect(EMPTY_COMPANY.workDays).toEqual(DEFAULT_WORKING_HOURS.workDays);
    expect(EMPTY_COMPANY.workHours[1]).toEqual({ start: DEFAULT_WORKING_HOURS.workStart, end: DEFAULT_WORKING_HOURS.workEnd });
  });

  it("loads the profile into the form once loading has finished", () => {
    expect(companyFormToHydrate(false, false, profile)).toMatchObject({ documentName: "Test Ltd", addressLines: "1 Street", workDays: [1, 2, 3, 4, 5, 6] });
    // An old profile with one start and end: every day of the form (worked or not) shows them.
    for (const day of [1, 6, 7]) expect(companyFormToHydrate(false, false, profile)!.workHours[day]).toEqual({ start: "07:00", end: "15:30" });
  });

  it("loads the empty form when the company has no profile yet", () => {
    expect(companyFormToHydrate(false, false, null)).toEqual(EMPTY_COMPANY);
  });

  it("never loads again after the first time, so a later profile change can't overwrite what was typed", () => {
    expect(companyFormToHydrate(false, true, profile)).toBeNull();
    expect(companyFormToHydrate(false, true, null)).toBeNull();
  });
});

describe("Company details form: working hours to save", () => {
  const form = (workDays: number[], workHours: Record<number, { start: string; end: string }>) => ({ workDays, workHours });
  const week = { 1: { start: "08:00", end: "16:00" }, 2: { start: "08:00", end: "16:00" }, 3: { start: "08:00", end: "16:00" }, 4: { start: "08:00", end: "16:00" }, 5: { start: "08:00", end: "14:30" }, 6: { start: "08:00", end: "16:00" }, 7: { start: "08:00", end: "16:00" } };

  it("saves only the ticked days, and the older fields from them", () => {
    expect(workingHoursFromForm(form([5, 4, 3, 2, 1], week))).toEqual({ fields: {
      workStart: "08:00", workEnd: "16:00", workDays: [1, 2, 3, 4, 5],
      workHoursByDay: { 1: week[1], 2: week[2], 3: week[3], 4: week[4], 5: { start: "08:00", end: "14:30" } },
    } });
  });

  it("an end of 00:00 is saved as midnight (24:00), and is the latest end", () => {
    expect(workingHoursFromForm(form([1, 2], { ...week, 2: { start: "16:00", end: "00:00" } }))).toMatchObject({ fields: { workEnd: "24:00", workHoursByDay: { 2: { start: "16:00", end: "24:00" } } } });
  });

  it("refuses no worked day, a missing time and a finish that is not after the start, naming the day", () => {
    expect(workingHoursFromForm(form([], week))).toEqual({ error: "Tick at least one working day." });
    expect(workingHoursFromForm(form([5], { ...week, 5: { start: "08:00", end: "" } }))).toEqual({ error: "Enter Friday's start and finish times." });
    expect(workingHoursFromForm(form([2], { ...week, 2: { start: "", end: "16:00" } }))).toEqual({ error: "Enter Tuesday's start and finish times." });
    expect(workingHoursFromForm(form([5], { ...week, 5: { start: "15:00", end: "14:30" } }))).toEqual({ error: "Friday must finish after it starts." });
    expect(workingHoursFromForm(form([1], { ...week, 1: { start: "08:00", end: "08:00" } }))).toEqual({ error: "Monday must finish after it starts." });
    expect(workingHoursFromForm(form([3], { ...week, 3: { start: "00:00", end: "00:00" } }))).toEqual({ error: "Wednesday must finish after it starts." });
  });

  it("round trips: a saved per-day profile loads back into the same form", () => {
    const saved = workingHoursFromForm(form([1, 2, 3, 4, 5], week)) as { fields: Record<string, unknown> };
    const loaded = toForm(parseCompanyProfile({ documentName: "T", addressLines: ["1"], vatRegistered: false, ...saved.fields }));
    expect(loaded.workDays).toEqual([1, 2, 3, 4, 5]);
    expect(loaded.workHours[5]).toEqual({ start: "08:00", end: "14:30" });
    expect(loaded.workHours[1]).toEqual({ start: "08:00", end: "16:00" });
  });
});
