import { describe, expect, it } from "vitest";

import { DEFAULT_WORKING_HOURS, JNR_PROFILE, hoursForDay, parseCompanyProfile, parseWorkingHours, storedProfile, workStartOn, workingHoursOf, workingHoursToSave } from "@/lib/company";

const base = { documentName: "Test Ltd", addressLines: ["1 Street"], vatRegistered: false };

describe("company working hours", () => {
  it("default to 08:00 to 16:00, Monday to Friday, when the keys are absent", () => {
    expect(DEFAULT_WORKING_HOURS).toEqual({ workStart: "08:00", workEnd: "16:00", workDays: [1, 2, 3, 4, 5] });
    expect(parseCompanyProfile(base)).toMatchObject(DEFAULT_WORKING_HOURS);
    expect(workingHoursOf(null)).toEqual(DEFAULT_WORKING_HOURS);
    expect(JNR_PROFILE).toMatchObject(DEFAULT_WORKING_HOURS);
  });

  it("read the company's own hours and days", () => {
    expect(parseCompanyProfile({ ...base, workStart: "07:00", workEnd: "15:30", workDays: [6, 1, 2, 3, 4, 5] })).toMatchObject({ workStart: "07:00", workEnd: "15:30", workDays: [1, 2, 3, 4, 5, 6] });
    expect(parseWorkingHours({ workStart: "00:00", workEnd: "24:00", workDays: [7] })).toEqual({ workStart: "00:00", workEnd: "24:00", workDays: [7] });
  });

  it("fall back leniently: bad times use the default pair, bad or empty days the default days", () => {
    const def = DEFAULT_WORKING_HOURS;
    expect(parseWorkingHours({ workStart: "8:00", workEnd: "16:00" })).toMatchObject({ workStart: def.workStart, workEnd: def.workEnd });
    expect(parseWorkingHours({ workStart: "16:00", workEnd: "08:00" })).toMatchObject({ workStart: "08:00", workEnd: "16:00" });
    expect(parseWorkingHours({ workStart: "09:00", workEnd: "09:00" })).toMatchObject({ workStart: "08:00", workEnd: "16:00" });
    expect(parseWorkingHours({ workStart: "25:00", workEnd: "26:00" })).toMatchObject({ workStart: "08:00" });
    expect(parseWorkingHours({ workStart: 8, workEnd: 16 })).toMatchObject({ workStart: "08:00" });
    expect(parseWorkingHours({ workDays: [] }).workDays).toEqual(def.workDays);
    expect(parseWorkingHours({ workDays: [0, 1] }).workDays).toEqual(def.workDays);
    expect(parseWorkingHours({ workDays: ["1"] }).workDays).toEqual(def.workDays);
    expect(parseWorkingHours({ workDays: "Mon" }).workDays).toEqual(def.workDays);
    expect(parseWorkingHours({ workDays: [2, 2, 1] }).workDays).toEqual([1, 2]);
    expect(parseWorkingHours(null)).toEqual(def);
  });
});

describe("per-day working hours (workHoursByDay)", () => {
  const byDay = { 1: { start: "08:00", end: "16:00" }, 2: { start: "08:00", end: "16:00" }, 3: { start: "08:00", end: "16:00" }, 4: { start: "08:00", end: "16:00" }, 5: { start: "08:00", end: "14:30" } };
  const stored = { workStart: "08:00", workEnd: "16:00", workDays: [1, 2, 3, 4, 5], workHoursByDay: byDay };

  it("reads each worked day's own hours", () => {
    expect(parseWorkingHours(stored)).toEqual(stored);
    expect(hoursForDay(parseWorkingHours(stored), 5)).toEqual({ start: "08:00", end: "14:30" });
    expect(hoursForDay(parseWorkingHours(stored), 1)).toEqual({ start: "08:00", end: "16:00" });
  });

  it("an old profile with no per-day field gives every work day workStart..workEnd, and has no per-day field", () => {
    const old = parseWorkingHours({ workStart: "07:00", workEnd: "15:30", workDays: [1, 2, 3] });
    expect(old).toEqual({ workStart: "07:00", workEnd: "15:30", workDays: [1, 2, 3] });
    expect(hoursForDay(old, 2)).toEqual({ start: "07:00", end: "15:30" });
    expect(hoursForDay(DEFAULT_WORKING_HOURS, 5)).toEqual({ start: "08:00", end: "16:00" });
  });

  it("an invalid entry falls back to workStart..workEnd for that day only", () => {
    const bad = parseWorkingHours({ ...stored, workHoursByDay: { ...byDay, 5: { start: "16:00", end: "08:00" }, 2: { start: "9", end: "x" }, 3: null, 4: { start: "09:00", end: "13:00" } } });
    expect(bad.workHoursByDay).toEqual({ 1: byDay[1], 2: byDay[1], 3: byDay[1], 4: { start: "09:00", end: "13:00" }, 5: byDay[1] });
    // A non-object per-day field reads as none.
    expect(parseWorkingHours({ ...stored, workHoursByDay: "Fri" })).not.toHaveProperty("workHoursByDay");
    expect(parseWorkingHours({ ...stored, workHoursByDay: [] })).not.toHaveProperty("workHoursByDay");
  });

  it("only worked days are read, and a worked day with no entry uses workStart..workEnd", () => {
    const parsed = parseWorkingHours({ workStart: "08:00", workEnd: "16:00", workDays: [1, 6], workHoursByDay: { 1: byDay[5], 2: byDay[5] } });
    expect(parsed.workHoursByDay).toEqual({ 1: byDay[5], 6: { start: "08:00", end: "16:00" } });
    expect(hoursForDay(parsed, 2)).toBeNull();
  });

  it("a midnight end is kept, a non-work day and a missing day are null", () => {
    expect(parseWorkingHours({ workDays: [5], workHoursByDay: { 5: { start: "14:00", end: "24:00" } } }).workHoursByDay).toEqual({ 5: { start: "14:00", end: "24:00" } });
    expect(hoursForDay(parseWorkingHours(stored), 6)).toBeNull();
    expect(hoursForDay(parseWorkingHours(stored), null)).toBeNull();
    expect(workStartOn(parseWorkingHours(stored), 6)).toBe("08:00");
  });

  it("survives a trip through the stored profile", () => {
    const profile = parseCompanyProfile({ documentName: "Test Ltd", addressLines: ["1 Street"], vatRegistered: false, ...stored })!;
    expect(profile).toMatchObject(stored);
    expect(parseCompanyProfile(JSON.parse(JSON.stringify(storedProfile(profile))))).toMatchObject(stored);
  });

  it("workingHoursToSave derives the older fields: worked days, earliest start, latest end", () => {
    expect(workingHoursToSave(byDay)).toEqual({ workStart: "08:00", workEnd: "16:00", workDays: [1, 2, 3, 4, 5], workHoursByDay: byDay });
    expect(workingHoursToSave({ 5: { start: "09:00", end: "12:00" }, 2: { start: "07:30", end: "11:00" }, 4: { start: "10:00", end: "24:00" } }))
      .toMatchObject({ workStart: "07:30", workEnd: "24:00", workDays: [2, 4, 5] });
    expect(workingHoursToSave({})).toBeNull();
  });
});
