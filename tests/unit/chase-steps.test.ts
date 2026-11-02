// 138: the Settings side of the chase steps (suggested steps, the form's rules, tone by day, pauses), and the CONTRACT of the step-selection
// interface lib/chasing/steps.ts dueChaseSteps. The selection algorithm itself is ChatGPT's (TODO-CHATGPT): its by-date tests come with it.
// The stub's tests below only pin what the joining-up relies on (a before-due step is offered from its day; a used step is never offered).
import { describe, expect, it } from "vitest";

import { type ChaseStep, dueChaseSteps } from "@/lib/chasing/steps";
import { CHASE_TONE_TEMPLATE } from "@/lib/chasing/templates";
import { DEFAULT_CHASE_STEPS, offsetLabel, pauseActive, stepsProblem, toneFor } from "@/lib/email/chase/steps";
import { DEFAULT_TEMPLATES } from "@/lib/email/templates/defaults";
import { daysPastDue } from "@/lib/receivables";

const STEPS: ChaseStep[] = [
  { id: "b3", offset_days: -3, tone: "before_due" }, { id: "f7", offset_days: 7, tone: "friendly" },
  { id: "m14", offset_days: 14, tone: "firm" }, { id: "x30", offset_days: 30, tone: "final" },
];
const days = (today: string) => daysPastDue("2026-11-20", today)!;

describe("dueChaseSteps: the interface's contract (stub until ChatGPT's algorithm lands)", () => {
  it("nothing before the earliest step; a before-due step from 3 days before the due date", () => {
    expect(dueChaseSteps(STEPS, days("2026-11-16"))).toEqual([]);
    expect(days("2026-11-17")).toBe(-3);
    expect(dueChaseSteps(STEPS, days("2026-11-17")).map((s) => s.id)).toEqual(["b3"]);
  });
  it("a step already used on the invoice is never offered again; only steps whose day has come", () => {
    expect(dueChaseSteps(STEPS, days("2026-11-27"), { stepIds: ["b3"], offsets: [-3] }).map((s) => s.id)).toEqual(["f7"]);
    expect(dueChaseSteps(STEPS, days("2026-11-27"), { stepIds: ["b3", "f7"], offsets: [-3, 7] })).toEqual([]);
    for (const s of dueChaseSteps(STEPS, 400)) expect(s.offset_days).toBeLessThanOrEqual(400);
  });
  it("no steps, or a non-whole day count: nothing", () => {
    expect(dueChaseSteps([], 100)).toEqual([]);
    expect(dueChaseSteps(STEPS, 7.5)).toEqual([]);
  });
});

describe("the steps' Settings rules", () => {
  it("the suggested steps are 3 before, then 7, 14 and 30 after, and pass the form's rules", () => {
    expect(DEFAULT_CHASE_STEPS.map((s) => [s.offset_days, s.tone])).toEqual([[-3, "before_due"], [7, "friendly"], [14, "firm"], [30, "final"]]);
    expect(stepsProblem(DEFAULT_CHASE_STEPS.map((s) => ({ offset: String(s.offset_days), tone: s.tone })))).toBeNull();
  });
  it.each([
    [[{ offset: "7", tone: "friendly" }, { offset: "7", tone: "firm" }], "Two steps can't have the same number of days."],
    [[{ offset: "x", tone: "friendly" }], "Each step needs a whole number of days (use a minus sign for days before the due date)."],
    [[{ offset: "400", tone: "final" }], "Days must be between -60 and 365."],
    [[{ offset: "-3", tone: "friendly" }], "A step on or before the due date is a before-due nudge."],
    [[{ offset: "5", tone: "before_due" }], "A step after the due date is friendly, firm or final."],
    [Array.from({ length: 11 }, (_, i) => ({ offset: String(i + 1), tone: "friendly" })), "At most 10 chase steps."],
  ] as const)("refuses %j", (rows, message) => {
    expect(stepsProblem(rows as never)).toBe(message);
  });
  it("tone follows the day: before_due on or before the due date, otherwise the chosen tone", () => {
    expect([toneFor(-1, "final"), toneFor(0, "firm"), toneFor(3, "before_due"), toneFor(3, "firm")]).toEqual(["before_due", "before_due", "friendly", "firm"]);
  });
  it("labels; every tone has a template with a text", () => {
    expect([offsetLabel(-3), offsetLabel(0), offsetLabel(1), offsetLabel(30)]).toEqual(["3 days before due", "On the due date", "1 day after due", "30 days after due"]);
    for (const key of Object.values(CHASE_TONE_TEMPLATE)) expect(DEFAULT_TEMPLATES[key].body.trim().length).toBeGreaterThan(0);
  });
  it("a pause is in force until the end of its last day (inclusive); no last day: until resumed", () => {
    expect([pauseActive(null, "2026-11-02"), pauseActive("2026-11-02", "2026-11-02"), pauseActive("2026-11-01", "2026-11-02")]).toEqual([true, true, false]);
  });
});
