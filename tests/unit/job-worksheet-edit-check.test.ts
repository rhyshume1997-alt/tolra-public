// @vitest-environment jsdom
/** Module 2: loaded-row edit display policy and actual form controls; server guards remain independent. */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ role: "workshop", row: { stage: "complete", inspected_at: "2026-11-01T12:00:00Z", finished_at: "2026-11-01T11:00:00Z" } as Record<string, unknown> }));
vi.mock("@/lib/supabase", () => ({ supabase: null }));
vi.mock("@/lib/use-user", () => ({ useUser: () => ({ activeRole: h.role }) }));
vi.mock("@/lib/company", () => ({ useCompanyProfile: () => ({ profile: { name: "Worksheet test company" } }) }));
vi.mock("@/components/job-signoff", () => ({ JobSignOff: () => null }));
vi.mock("@/components/customer-signoff", () => ({ CustomerSignOff: () => null }));
vi.mock("@/components/jobs/planned-vs-actual-panel", () => ({ PlannedVsActualPanel: () => null }));
vi.mock("@/lib/job-worksheet", async (original) => {
  const actual = await original<typeof import("@/lib/job-worksheet")>();
  return { ...actual, loadWorksheet: async (job: import("@/lib/job-worksheet").WorksheetJobInfo) => ({ worksheet: actual.emptyWorksheet(job), version: 1, demo: false, row: h.row }) };
});

import { worksheetEditCheck } from "@/lib/job-worksheet";
import { JobWorksheetForm } from "@/components/job-worksheet-form";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => { if (root) act(() => root!.unmount()); host?.remove(); root = undefined; host = undefined; });

describe("worksheet edit display check", () => {
  it.each(["admin", "office"])("%s retains editing on Complete jobs", (role) => {
    expect(worksheetEditCheck(role, { stage: "complete", inspected_at: "2026-11-01T12:00:00Z" })).toEqual({ canEdit: true, completeReadOnly: false });
  });
  it("workshop reads Complete jobs without an edit offer", () => {
    expect(worksheetEditCheck("workshop", { stage: "complete", inspected_at: "2026-11-01T12:00:00Z" })).toEqual({ canEdit: false, completeReadOnly: true });
  });
  it.each(["machining", "inspection", "rework"])("workshop can edit non-complete %s jobs", (stage) => {
    expect(worksheetEditCheck("workshop", { stage, inspected_at: null, finished_at: "2026-11-01T11:00:00Z" }).canEdit).toBe(true);
  });
  it("uses the existing flow rule: rework takes precedence over a stale inspection value", () => {
    expect(worksheetEditCheck("workshop", { stage: "rework", inspected_at: "2026-11-01T12:00:00Z" }).canEdit).toBe(true);
  });
  it.each([undefined, {}, { stage: "complete" }, { stage: "machining", inspected_at: 42 }])("unverified completion state does not offer workshop editing (%j)", (row) => {
    expect(worksheetEditCheck("workshop", row)).toEqual({ canEdit: false, completeReadOnly: false });
  });
  it.each(["viewer", "unknown", null, undefined])("%s does not gain editing", (role) => {
    expect(worksheetEditCheck(role, { stage: "machining", inspected_at: null }).canEdit).toBe(false);
  });
});

describe("worksheet form controls", () => {
  it.each([
    ["workshop", "complete", "2026-11-01T12:00:00Z", false],
    ["workshop", "machining", null, true],
    ["admin", "complete", "2026-11-01T12:00:00Z", true],
    ["office", "complete", "2026-11-01T12:00:00Z", true],
    ["viewer", "complete", "2026-11-01T12:00:00Z", false],
  ] as const)("%s on %s receives the appropriate worksheet controls", async (role, stage, inspected_at, editable) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    h.role = role; h.row = { stage, inspected_at, finished_at: null };
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    await act(async () => { root!.render(createElement(JobWorksheetForm, { job: { id: "job-a", job_no: "J-TEST", customer: "Test", description: "Test job" } })); });
    await vi.waitFor(() => expect(host!.textContent).not.toContain("Loading worksheet..."));
    expect([...host.querySelectorAll("button")].some((button) => button.textContent === "Save Worksheet")).toBe(editable);
    expect([...host.querySelectorAll("textarea")].every((field) => field.readOnly)).toBe(!editable);
    expect(Boolean(host.querySelector('[data-testid="worksheet-complete-readonly"]'))).toBe(role === "workshop" && Boolean(inspected_at));
    expect([...host.querySelectorAll('input[type="checkbox"]')].every((field) => (field as HTMLInputElement).disabled)).toBe(!editable);
  });
});
