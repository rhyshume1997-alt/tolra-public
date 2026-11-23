// @vitest-environment jsdom
/**
 * BOUNDARY (Schedule, Module 2, PREVIEW ONLY). Inputs: the exports of components/schedule/preview/SchedulePreview.tsx, the REAL pure lib functions it uses (machine-schedule,
 * schedule-live, machine-runs, org-settings) and the SOURCE of app/(dashboard)/schedule/page.tsx and components/machine-gantt.tsx for rules that live inline there. Output: pass/fail.
 * Pins the preview's role rules, validation wording, late flag, timeline floor and Show / hide list to the real page, and checks by rendering that no action reports success and that the
 * preview imports no auth, session, route or network code. Must not change: never loosen these to make a change pass; if a real rule changes, this test is the alarm. No network.
 */
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import SchedulePreview, {
  BOOKINGS, BOOK_NEEDS_HOURS, BOOK_NEEDS_JOB, BOOK_NEEDS_MACHINE, BOOK_NEEDS_START, MACHINES, MACHINE_DAYS_NEEDED, MACHINE_HOURS_RANGE, MACHINE_NAME_NEEDED, MIN_BAR_PERCENT, NOW,
  OVERRIDE_ONLY_ADMIN, OVERRIDE_REASON_MIN, ROLES, SCHEDULE_COLUMN_KEYS, SPLIT_STATUS_ONLY, STATUS_LABEL, afterRequiredDate, bookDisabled, bookingStatusLabel, canBook, canManageMachines, canOverride,
  checkFirstText, validateBooking, validateMachine,
} from "@/components/schedule/preview/SchedulePreview";
import { computeFinish, findOverlaps, machineStatus, scheduleAll } from "@/lib/machine-schedule";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const PAGE = read("app/(dashboard)/schedule/page.tsx");
const GANTT = read("components/machine-gantt.tsx");
const SRC = read("components/schedule/preview/SchedulePreview.tsx");

describe("roles mirror the real page", () => {
  it("source text", () => {
    expect(PAGE).toContain('const canManageMachines = activeRole === "admin" || activeRole === "office";');
    expect(PAGE).toContain('const canBook = canManageMachines || activeRole === "workshop";');
    expect(PAGE).toContain('allowed={["admin", "office", "workshop", "viewer"]}');
    expect(PAGE).toContain('isAdmin={activeRole === "admin"}');
  });
  it("matrix", () => {
    expect(ROLES.map((r) => [r, canManageMachines(r), canBook(r), canOverride(r)])).toEqual([
      ["admin", true, true, true], ["office", true, true, false], ["workshop", false, true, false], ["viewer", false, false, false],
    ]);
  });
});

describe("validation wording is the real wording", () => {
  it("is in the real page", () => {
    for (const m of [MACHINE_NAME_NEEDED, MACHINE_HOURS_RANGE, MACHINE_DAYS_NEEDED, BOOK_NEEDS_JOB, BOOK_NEEDS_MACHINE, BOOK_NEEDS_HOURS, BOOK_NEEDS_START, "Hours must be zero or more."]) expect(PAGE).toContain(m);
    expect(PAGE).toContain(SPLIT_STATUS_ONLY);
    expect(PAGE).toContain(OVERRIDE_ONLY_ADMIN);
    expect(PAGE).toContain("reason.trim().length < 3");
    expect(OVERRIDE_REASON_MIN).toBe(3);
    expect(PAGE).toContain("Check with ${pause?.operator_name ?? \"the operator\"} first");
  });
  it("machine form order and bounds", () => {
    const ok = { name: "Mill 3", type: "", hoursPerDay: "8", workingDays: [1], active: true };
    expect(validateMachine({ ...ok, name: " " })?.message).toBe(MACHINE_NAME_NEEDED);
    expect(validateMachine({ ...ok, hoursPerDay: "0" })?.message).toBe(MACHINE_HOURS_RANGE);
    expect(validateMachine({ ...ok, hoursPerDay: "16.5" })?.message).toBe(MACHINE_HOURS_RANGE);
    expect(validateMachine({ ...ok, hoursPerDay: "16" })).toBeNull();
    expect(validateMachine({ ...ok, workingDays: [] })?.message).toBe(MACHINE_DAYS_NEEDED);
  });
  it("booking checks in order", () => {
    const base = { jobId: "", manualJobNo: "", jobNo: "J-1", hasMachine: true, hours: 4, splitOn: false, splitOk: true, splitMessage: "", startValid: true, needsCheck: false, pauseOperator: null };
    expect(validateBooking({ ...base, jobNo: "" })).toBe(BOOK_NEEDS_JOB);
    expect(validateBooking({ ...base, hasMachine: false })).toBe(BOOK_NEEDS_MACHINE);
    expect(validateBooking({ ...base, hours: 0 })).toBe(BOOK_NEEDS_HOURS);
    expect(validateBooking({ ...base, splitOn: true, splitOk: false, splitMessage: "x" })).toBe("x");
    expect(validateBooking({ ...base, startValid: false })).toBe(BOOK_NEEDS_START);
    expect(validateBooking({ ...base, needsCheck: true, pauseOperator: "Tomas" })).toBe(checkFirstText("Tomas"));
    expect(validateBooking(base)).toBeNull();
  });
  it("book button disabled rule", () => {
    const d = { saving: false, needsCheck: false, splitOn: false, splitOk: true, overlaps: 1, isAdmin: true, override: true, reason: "ab" };
    expect(bookDisabled(d)).toBe(true);
    expect(bookDisabled({ ...d, reason: "abc" })).toBe(false);
    expect(bookDisabled({ ...d, isAdmin: false, reason: "abc" })).toBe(true);
    expect(bookDisabled({ ...d, overlaps: 0, override: false, reason: "" })).toBe(false);
  });
});

describe("real schedule rules drive the sample", () => {
  const sched = scheduleAll(BOOKINGS, MACHINES, NOW);
  it("late flag rule is the page's", () => {
    expect(PAGE).toContain('b.finish > new Date(`${req}T23:59:59`)');
    const b = sched.find((x) => x.jobNo === "J-0438")!;
    expect(afterRequiredDate(b, "2026-11-25")).toBe(true);
    expect(afterRequiredDate(b, "2026-11-26")).toBe(false);
    expect(afterRequiredDate({ ...b, status: "complete" }, "2026-11-01")).toBe(false);
  });
  it("20 h on an 8 h Mon-Fri machine from Tue 08:00 ends Thu 12:00", () => {
    const e = computeFinish(new Date(2026, 10, 24, 8), 20, { hoursPerDay: 8, workingDays: [1, 2, 3, 4, 5] });
    expect([e.getDate(), e.getHours()]).toEqual([26, 12]);
  });
  it("status words and not-started rule", () => {
    expect(STATUS_LABEL).toEqual({ booked: "Booked", running: "Running", complete: "Complete" });
    expect(bookingStatusLabel(sched.find((x) => x.jobNo === "J-0433")!, NOW)).toBe("Booked, not started");
    expect(bookingStatusLabel(sched.find((x) => x.jobNo === "J-0430")!, NOW)).toBe("Booked");
  });
  it("overlap and status", () => {
    const mill2 = MACHINES.find((m) => m.id === "m-mill2")!;
    expect(findOverlaps(mill2, sched, new Date(2026, 10, 23, 11), new Date(2026, 10, 23, 12)).map((b) => b.jobNo)).toContain("J-0433");
    expect(machineStatus(MACHINES[0], sched.filter((b) => b.status !== "complete"), NOW).busy).toBe(true);
  });
  it("bar floor and Show / hide list are the real ones", () => {
    expect(GANTT).toContain(`const MIN_BAR_PERCENT = ${MIN_BAR_PERCENT};`);
    expect(SCHEDULE_COLUMN_KEYS).toEqual(["machine", "days", "status-cards", "next-free", "machine-type", "bar-labels", "running-badge", "now-marker", "legend", "jobs-table", "hours-left", "machines-table"]);
  });
  it("the real page has no drag and drop", () => {
    expect(GANTT).not.toMatch(/draggable|onDrag|onPointerDown|onDrop/);
    expect(PAGE).not.toMatch(/draggable|onDrag|onDrop/);
  });
});

describe("boundary: no network, auth or storage in the preview", () => {
  it("imports and calls", () => {
    expect(SRC).not.toMatch(/from "@\/lib\/(supabase|use-user|audit|offline|friendly-error)/);
    expect(SRC).not.toMatch(/\bfetch\(|localStorage|sessionStorage|XMLHttpRequest|next\/navigation|\.rpc\(/);
    expect(SRC).not.toMatch(/\bsaveBooking|saveMachine|deleteBooking|fetchSchedule|loadRunPlan\b/);
  });
});

describe("rendering", () => {
  let host: HTMLDivElement;
  beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); }; HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); }; (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never; });
  afterEach(() => { host?.remove(); });
  it("shows the label and never says saved", async () => {
    host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(createElement(SchedulePreview)); });
    const text = host.textContent ?? "";
    expect(text).toContain("Preview, sample data, nothing is saved");
    expect(text).toContain("Machine Schedule");
    expect(host.querySelectorAll("[data-testid=booking-bar]").length).toBeGreaterThan(5);
    expect(host.querySelectorAll("[data-testid=run-bar]").length).toBe(4);
    await act(async () => { (host.querySelector("[data-testid=job-row] button") as HTMLButtonElement).click(); });
    await act(async () => { (document.querySelector("[data-testid=mark-complete]") as HTMLButtonElement).click(); });
    const toast = document.body.textContent ?? "";
    expect(toast).toContain("Preview only");
    expect(toast).toContain("Nothing was saved.");
    expect(toast).not.toMatch(/\bsaved successfully|booked successfully|updated successfully\b/i);
    await act(async () => { root.unmount(); });
  });
});
