// @vitest-environment jsdom
/**
 * BOUNDARY (Time / Weekly hours, Module 2, PREVIEW ONLY). Inputs: the exports of components/time/preview/TimePreview.tsx, the REAL pure functions of lib/time-sheet, lib/time-day-flags and
 * lib/time-payroll-export, and the SOURCE of components/time/day-sheet.tsx, week-review.tsx, time-dialogs.tsx and middleware.ts for rules that live inline there. Output: pass/fail.
 * Pins the figures the preview shows (hours, breaks, overtime ticks, rounding, week totals, approval snapshot) to the real functions, its role and validation rules to the real source, and checks by
 * rendering that clocking in and out is drawn locally but never reports success and that the preview imports no network, auth or storage code.
 * Must not change: never loosen these to make a change pass; if a real rule changes, this test is the alarm. No network.
 */
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import TimePreview, {
  BANK_HOLIDAYS, HOURS_COLUMN_KEYS, ME, REASON_MIN, SAVED_FLAGS, SEED, SETTINGS, SIM_START, SYNC_WARNING, TODAY, breakSub, canApprove, canEditDay, canOpenTime, clockCorrectionOk, clockTime, labourEditOk,
  localTimeProblem, seesEveryone, weeksFor,
} from "@/components/time/preview/TimePreview";
import { payrollWeeks } from "@/lib/time-payroll-export";
import { ROUNDING_NOTE, approvalSnapshot, clockStateOf, dayTotals, hm, hmSigned, localDayBounds, weekStartOf } from "@/lib/time-sheet";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const DAY_SHEET = read("components/time/day-sheet.tsx");
const WEEK = read("components/time/week-review.tsx");
const DIALOGS = read("components/time/time-dialogs.tsx");
const SHEET_LIB = read("lib/time-sheet.ts");
const SRC = read("components/time/preview/TimePreview.tsx");

const dayOf = (user: string, date: string, now = SIM_START) => dayTotals({ date, events: SEED.events.filter((e) => e.user_id === user), labour: SEED.labour.filter((l) => l.user_id === user), settings: SETTINGS, bankHolidays: BANK_HOLIDAYS, now });

describe("hours, breaks and rounding are the real functions", () => {
  it("a 07:30 to 16:00 day with a clocked 30 minute lunch takes the 45 minute allowance", () => {
    const d = dayOf(ME, "2026-11-16");
    expect([d.attendance, d.breakRule, d.breakDeduction, d.paid]).toEqual([510, "allowance", 45, 465]);
    expect(hm(d.paid)).toBe("7:45");
    expect(breakSub(d.breakRule, d.clockedBreaks)).toBe("lunch + break, unpaid");
  });
  it("a clocked lunch longer than the allowance is taken as clocked", () => {
    const d = dayOf("u-tomas", "2026-11-16");
    expect([d.breakRule, d.breakDeduction, d.paid]).toEqual(["clocked", 60, 450]);
  });
  it("a day under 6 hours only deducts clocked breaks (none here)", () => {
    const d = dayOf(ME, "2026-11-20");
    expect([d.attendance, d.breakRule, d.paid]).toEqual([300, "none", 300]);
  });
  it("a missing clock-out counts 0 and is flagged", () => {
    const d = dayOf("u-tomas", "2026-11-18");
    expect([d.paid, d.flags]).toEqual([0, expect.arrayContaining(["missing_out"])]);
  });
  it("today so far: clocked in 07:31, preview clock 10:30 gives 2:59, no break allowance on a short day", () => {
    const d = dayOf(ME, TODAY);
    expect([hm(d.attendance), hm(d.paid), hm(d.labour)]).toEqual(["2:59", "2:59", "2:50"]);
    expect(clockStateOf(d.sessions)).toMatchObject({ clockedIn: true, onBreak: false });
  });
  it("rounding is once, to the minute, and a zero never carries a sign", () => {
    expect(hm(59.5)).toBe("1:00");
    expect(hm(0)).toBe("0:00");
    expect(hmSigned(-0.4)).toBe("0:00");
    expect(hmSigned(-45)).toBe("−0:45");
    expect(ROUNDING_NOTE).toBe("Times shown to the nearest minute; Paid is worked out from exact times.");
  });
  it("clock-change days are 25 and 23 hours long", () => {
    const b = (d: string) => (localDayBounds(d).end.getTime() - localDayBounds(d).start.getTime()) / 3_600_000;
    expect([b("2026-10-25"), b("2027-03-28"), b("2026-11-16")]).toEqual([25, 23, 24]);
  });
});

describe("week totals and overtime", () => {
  const week = weeksFor("2026-11-16", SEED.events, SEED.labour, SIM_START);
  const by = (id: string) => week.find((p) => p.userId === id)!;
  it("weeks run Monday to Sunday", () => { expect(weekStartOf("2026-11-22")).toBe("2026-11-16"); expect(weekStartOf("2026-11-23")).toBe("2026-11-23"); });
  it("Callum's week is exactly 40:00 over six days", () => {
    expect(by(ME).week.days.map((d) => d.paid)).toEqual([465, 495, 465, 435, 300, 240, 0]);
    expect([hm(by(ME).week.paid), by(ME).week.daysWorked]).toEqual(["40:00", 6]);
  });
  it("the others", () => {
    expect(hm(by("u-tomas").week.paid)).toBe("30:00");
    expect(hm(by("u-ngozi").week.paid)).toBe("41:45");
    expect(hm(by("u-harvey").week.paid)).toBe("37:00");
  });
  it("overtime is never worked out: it is the saved Overtime tick only", () => {
    expect(SHEET_LIB).toContain("NO COMPUTED OVERTIME");
    expect(by("u-harvey").week.paid).toBe(2220); // four 10 h days, nothing split into overtime
    expect(by("u-harvey").dayFlags.totals.overtime).toEqual({ days: 1, paidMinutes: 555 });
    expect(by(ME).dayFlags.totals.overtime).toEqual({ days: 1, paidMinutes: 240 });
    expect(approvalSnapshot(by("u-harvey").week, { overtime: { days: 1, paid_minutes: 555 } }).overtime_minutes).toBe(555);
    expect(approvalSnapshot(by("u-harvey").week).overtime_minutes).toBe(0);
  });
  it("an unsaved weekend day is a starred suggestion that is not counted", () => {
    const n = by("u-ngozi").dayFlags;
    expect([n.anySuggested, n.suggestedDays, n.totals.saturday.days]).toEqual([true, 1, 0]);
    expect(SAVED_FLAGS.some((f) => f.user_id === "u-ngozi")).toBe(false);
  });
  it("payroll weeks: 1 to 5, from the Monday on or before", () => {
    expect(payrollWeeks("2026-11-18", 2)).toEqual({ weekStarts: ["2026-11-16", "2026-11-23"], start: "2026-11-16", end: "2026-11-29" });
    expect(payrollWeeks("2026-11-18", 9).weekStarts).toHaveLength(5);
  });
});

describe("roles and rules mirror the real source", () => {
  it("source text", () => {
    expect(read("middleware.ts")).toContain('["/time", ["admin", "office", "workshop"]]');
    expect(DAY_SHEET).toContain("const canEdit = own || isAdmin;");
    expect(DAY_SHEET).toContain('const seesEveryone = hasAnyRole(["admin", "office"]);');
    expect(WEEK).toContain("hasAnyRole(settings.approverRoles");
    expect(SHEET_LIB).toContain('approverRoles: ["admin"],');
    expect(DIALOGS).toContain("reason.trim().length >= 3");
    expect(DIALOGS).toContain("to.at >= from.at");
    expect(WEEK.replace(/&lsquo;/g, "\u2018").replace(/&rsquo;/g, "\u2019")).toContain(SYNC_WARNING);
    expect(DAY_SHEET).toContain("Overtime is not worked out from the hours: it is the Overtime tick below.");
  });
  it("matrix", () => {
    expect((["admin", "office", "workshop", "viewer"] as const).map((r) => [r, canOpenTime(r), seesEveryone(r), canApprove(r), canEditDay(r, false), canEditDay(r, true)])).toEqual([
      ["admin", true, true, true, true, true], ["office", true, true, false, false, true], ["workshop", true, false, false, false, true], ["viewer", false, false, false, false, true],
    ]);
  });
  it("Show / hide list is the real one", () => {
    expect(HOURS_COLUMN_KEYS).toEqual(["days", "clocked", "breaks", "jobs", "unallocated", "ticks", "check", "approval"]);
  });
  it("time entry checks", () => {
    expect(REASON_MIN).toBe(3);
    const at = new Date();
    expect(clockCorrectionOk({ removing: false, at, reason: "ab" })).toBe(false);
    expect(clockCorrectionOk({ removing: true, at: null, reason: "abc" })).toBe(true);
    expect(labourEditOk({ jobId: "j", from: new Date(2026, 0, 1, 9), to: new Date(2026, 0, 1, 8), toNeeded: true, reason: "abc" })).toBe(false);
    expect(localTimeProblem("2026-10-25", "01:30", "").error).toBe("That time happens twice tonight: choose BST or GMT.");
    expect(localTimeProblem("2026-10-25", "01:30", "GMT").error).toBeNull();
    expect(localTimeProblem("2027-03-28", "01:30", "").error).toBe("That time doesn't exist that night (the clocks went forward).");
    expect(clockTime("2026-10-25T01:30:00Z", "2026-10-25")).toBe("01:30 GMT");
  });
});

describe("boundary: no network, auth or storage", () => {
  it("imports and calls", () => {
    expect(SRC).not.toMatch(/from "@\/lib\/(supabase|use-user|offline|friendly-error|machine-runs|time-data")/);
    expect(SRC).not.toMatch(/\bfetch\(|localStorage|sessionStorage|XMLHttpRequest|next\/navigation|\.rpc\(|queueOffline|syncNow|loadWeek|exportSpreadsheet|window\.print/);
  });
});

describe("rendering", () => {
  let host: HTMLDivElement;
  beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); }; HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); }; (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never; });
  afterEach(() => { host?.remove(); });
  it("clock out is drawn locally, the totals move, and the toast never says saved", async () => {
    host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(createElement(TimePreview)); });
    expect(host.textContent).toContain("Preview, sample data, nothing is saved");
    expect(host.querySelector("[data-testid=clock-state]")?.textContent).toBe("Clocked in since 07:31");
    await act(async () => { (host.querySelector("[data-testid=clock-out]") as HTMLButtonElement).click(); });
    expect(host.querySelector("[data-testid=clock-state]")?.textContent).toBe("Not clocked in");
    const t = document.body.textContent ?? "";
    expect(t).toContain("Preview only");
    expect(t).toContain("Nothing was saved.");
    expect(t).not.toMatch(/\bsaved successfully|recorded successfully/i);
    await act(async () => { root.unmount(); });
  });
});
