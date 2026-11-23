// @vitest-environment jsdom
/**
 * BOUNDARY (Jobs module 2, PREVIEW ONLY). Inputs: the exports of components/jobs/preview/JobsPreview.tsx. Output: pass/fail.
 * Pins the preview's rules to values computed with Tolra's real logic (design parity fixture, as of 2026-11-20): row action sequences per
 * role and view for all 24 sample jobs, the tile/filter counts, the default order and the machine groups. Must not change: never loosen
 * these to make a change pass; the preview must keep matching the real Job Board's rules. No network, no Supabase.
 * v2 (shared premium set, owner-approved structure): also pins the Filters popover and chips, the bulk bar that exists only with a selection, the one-primary-plus-More row split and that every control, action and filter is still reachable.
 * Written with createElement (no JSX) so it is a .test.ts file and runs under the existing vitest.config.ts include pattern.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import JobsPreview, { DEFAULT_FILTERS, JOBS_INTRO, DUE_NOTE, REWORK_NOTE, activeChips, isFiltered, popoverFilterCount, reachableActionLabels, splitRowActions, actionLine, actionsFor, applyOp, countsOf, initialJobs, initialState, machineGroups, planBulkFinish, primaryLabel, reduce, selectionScope, visibleJobs } from "@/components/jobs/preview/JobsPreview";
import type { Role, ViewMode } from "@/components/jobs/preview/JobsPreview";

const PARITY: Record<string, Record<string, { list: string; table: string }>> = {"J-0434":{"admin":{"list":"Pick a machine|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pick a machine|Finish|Worksheet|Machines|Print|Send"},"office":{"list":"Pick a machine|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pick a machine|Finish|Worksheet|Machines|Print|Send"},"workshop":{"list":"Pick a machine|Finish|Inspected (disabled)|Worksheet|Machines|Print","table":"Pick a machine|Finish|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0433":{"admin":{"list":"Start|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Start|Finish|Worksheet|Machines|Print|Send"},"office":{"list":"Start|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Start|Finish|Worksheet|Machines|Print|Send"},"workshop":{"list":"Start|Finish|Inspected (disabled)|Worksheet|Machines|Print","table":"Start|Finish|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0432":{"admin":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pause|Finish|Worksheet|Machines|Print|Send"},"office":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pause|Finish|Worksheet|Machines|Print|Send"},"workshop":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print","table":"Pause|Finish|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0431":{"admin":{"list":"Start|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Start|Finish|Worksheet|Machines|Print|Send"},"office":{"list":"Start|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Start|Finish|Worksheet|Machines|Print|Send"},"workshop":{"list":"Start|Finish|Inspected (disabled)|Worksheet|Machines|Print","table":"Start|Finish|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0430":{"admin":{"list":"Pick a machine|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pick a machine|Finish|Worksheet|Machines|Print|Send"},"office":{"list":"Pick a machine|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pick a machine|Finish|Worksheet|Machines|Print|Send"},"workshop":{"list":"Pick a machine|Finish|Inspected (disabled)|Worksheet|Machines|Print","table":"Pick a machine|Finish|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0429":{"admin":{"list":"Inspected|Rework|Worksheet|Machines|Print|Delivery note|Send","table":"Inspected|Release early|Rework|Worksheet|Machines|Print|Delivery note|Send"},"office":{"list":"Inspected (disabled)|Rework|Worksheet|Machines|Print|Delivery note|Send","table":"Rework|Worksheet|Machines|Print|Delivery note|Send"},"workshop":{"list":"Inspected (disabled)|Rework|Worksheet|Machines|Print","table":"Rework|Worksheet|Machines|Print"},"viewer":{"list":"Rework|Worksheet|Print","table":"Rework|Worksheet|Print"}},"J-0428":{"admin":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pause|Finish|Worksheet|Machines|Print|Send"},"office":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pause|Finish|Worksheet|Machines|Print|Send"},"workshop":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print","table":"Pause|Finish|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0427":{"admin":{"list":"Resume|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Resume|Finish|Worksheet|Machines|Print|Send"},"office":{"list":"Resume|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Resume|Finish|Worksheet|Machines|Print|Send"},"workshop":{"list":"Resume|Finish|Inspected (disabled)|Worksheet|Machines|Print","table":"Resume|Finish|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0426":{"admin":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pause|Finish|Worksheet|Machines|Print|Send"},"office":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pause|Finish|Worksheet|Machines|Print|Send"},"workshop":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print","table":"Pause|Finish|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0425":{"admin":{"list":"Finished|Inspected|Reopen|Worksheet|Machines|Print|Delivery note|Send","table":"Finished|Inspected|Reopen|Release early|Worksheet|Machines|Print|Delivery note|Send"},"office":{"list":"Finished|Inspected|Reopen|Worksheet|Machines|Print|Delivery note|Send","table":"Finished|Inspected|Reopen|Worksheet|Machines|Print|Delivery note|Send"},"workshop":{"list":"Finished|Inspected|Worksheet|Machines|Print","table":"Finished|Inspected|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0424":{"admin":{"list":"Finished|Inspected|Reopen|Worksheet|Machines|Print|Delivery note|Send","table":"Finished|Inspected|Reopen|Release early|Worksheet|Machines|Print|Delivery note|Send"},"office":{"list":"Finished|Inspected|Reopen|Worksheet|Machines|Print|Delivery note|Send","table":"Finished|Inspected|Reopen|Worksheet|Machines|Print|Delivery note|Send"},"workshop":{"list":"Finished|Inspected|Worksheet|Machines|Print","table":"Finished|Inspected|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0423":{"admin":{"list":"Finished|Inspected|Reopen|Worksheet|Machines|Print|Delivery note|Send","table":"Finished|Inspected|Reopen|Release early|Worksheet|Machines|Print|Delivery note|Send"},"office":{"list":"Finished|Inspected|Reopen|Worksheet|Machines|Print|Delivery note|Send","table":"Finished|Inspected|Reopen|Worksheet|Machines|Print|Delivery note|Send"},"workshop":{"list":"Finished|Inspected|Worksheet|Machines|Print","table":"Finished|Inspected|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0422":{"admin":{"list":"Start|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Start|Finish|Worksheet|Machines|Print|Send"},"office":{"list":"Start|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Start|Finish|Worksheet|Machines|Print|Send"},"workshop":{"list":"Start|Finish|Inspected (disabled)|Worksheet|Machines|Print","table":"Start|Finish|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0421":{"admin":{"list":"Pick a machine|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pick a machine|Finish|Worksheet|Machines|Print|Send"},"office":{"list":"Pick a machine|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pick a machine|Finish|Worksheet|Machines|Print|Send"},"workshop":{"list":"Pick a machine|Finish|Inspected (disabled)|Worksheet|Machines|Print","table":"Pick a machine|Finish|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0420":{"admin":{"list":"Start|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Start|Finish|Worksheet|Machines|Print|Send"},"office":{"list":"Start|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Start|Finish|Worksheet|Machines|Print|Send"},"workshop":{"list":"Start|Finish|Inspected (disabled)|Worksheet|Machines|Print","table":"Start|Finish|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0419":{"admin":{"list":"Start timer|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Start timer|Finish|Worksheet|Machines|Print|Send"},"office":{"list":"Start timer|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Start timer|Finish|Worksheet|Machines|Print|Send"},"workshop":{"list":"Start timer|Finish|Inspected (disabled)|Worksheet|Machines|Print","table":"Start timer|Finish|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0418":{"admin":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pause|Finish|Worksheet|Machines|Print|Send"},"office":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pause|Finish|Worksheet|Machines|Print|Send"},"workshop":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print","table":"Pause|Finish|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0415":{"admin":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pause|Finish|Worksheet|Machines|Print|Send"},"office":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pause|Finish|Worksheet|Machines|Print|Send"},"workshop":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print","table":"Pause|Finish|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0412":{"admin":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pause|Finish|Worksheet|Machines|Print|Send"},"office":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print|Send","table":"Pause|Finish|Worksheet|Machines|Print|Send"},"workshop":{"list":"Pause|Finish|Inspected (disabled)|Worksheet|Machines|Print","table":"Pause|Finish|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0411":{"admin":{"list":"Finished|Inspected (disabled)|Reopen|Worksheet|Machines|Print|Delivery note|Send","table":"Finished|Reopen|Worksheet|Machines|Print|Delivery note|Send|Archive"},"office":{"list":"Finished|Inspected (disabled)|Reopen|Worksheet|Machines|Print|Delivery note|Send","table":"Finished|Reopen|Worksheet|Machines|Print|Delivery note|Send|Archive"},"workshop":{"list":"Finished|Inspected (disabled)|Worksheet|Machines|Print","table":"Finished|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0410":{"admin":{"list":"Finished|Inspected (disabled)|Reopen|Worksheet|Machines|Print|Delivery note|Send","table":"Finished|Reopen|Worksheet|Machines|Print|Delivery note|Send|Archive"},"office":{"list":"Finished|Inspected (disabled)|Reopen|Worksheet|Machines|Print|Delivery note|Send","table":"Finished|Reopen|Worksheet|Machines|Print|Delivery note|Send|Archive"},"workshop":{"list":"Finished|Inspected (disabled)|Worksheet|Machines|Print","table":"Finished|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0409":{"admin":{"list":"Finished|Inspected (disabled)|Reopen|Worksheet|Machines|Print|Delivery note|Send","table":"Finished|Reopen|Worksheet|Machines|Print|Delivery note|Send|Archive"},"office":{"list":"Finished|Inspected (disabled)|Reopen|Worksheet|Machines|Print|Delivery note|Send","table":"Finished|Reopen|Worksheet|Machines|Print|Delivery note|Send|Archive"},"workshop":{"list":"Finished|Inspected (disabled)|Worksheet|Machines|Print","table":"Finished|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0408":{"admin":{"list":"Finished|Inspected (disabled)|Reopen|Worksheet|Machines|Print|Delivery note|Send","table":"Finished|Reopen|Worksheet|Machines|Print|Delivery note|Send|Archive"},"office":{"list":"Finished|Inspected (disabled)|Reopen|Worksheet|Machines|Print|Delivery note|Send","table":"Finished|Reopen|Worksheet|Machines|Print|Delivery note|Send|Archive"},"workshop":{"list":"Finished|Inspected (disabled)|Worksheet|Machines|Print","table":"Finished|Worksheet|Machines|Print"},"viewer":{"list":"Worksheet|Print","table":"Worksheet|Print"}},"J-0398":{"admin":{"list":"Inspected|Rework|Worksheet|Machines|Print|Delivery note|Send","table":"Inspected|Release early|Rework|Worksheet|Machines|Print|Delivery note|Send"},"office":{"list":"Inspected (disabled)|Rework|Worksheet|Machines|Print|Delivery note|Send","table":"Rework|Worksheet|Machines|Print|Delivery note|Send"},"workshop":{"list":"Inspected (disabled)|Rework|Worksheet|Machines|Print","table":"Rework|Worksheet|Machines|Print"},"viewer":{"list":"Rework|Worksheet|Print","table":"Rework|Worksheet|Print"}}};

const jobs = initialJobs();
const refs = (list: Array<{ ref: string }>) => list.map((j) => j.ref);

describe("jobs preview: rules match the real board (fixture computed with Tolra's logic)", () => {
  it("has 24 sample jobs, 20 open, newest first", () => {
    expect(jobs).toHaveLength(24);
    expect(refs(visibleJobs(jobs, DEFAULT_FILTERS))).toEqual(["J-0434","J-0433","J-0432","J-0431","J-0430","J-0429","J-0428","J-0427","J-0426","J-0425","J-0424","J-0423","J-0422","J-0421","J-0420","J-0419","J-0418","J-0415","J-0412","J-0398"]);
  });
  it("row actions equal the fixture for every job, role and view (cards use the table sequence)", () => {
    const roles: Role[] = ["admin", "office", "workshop", "viewer"];
    for (const j of jobs) for (const r of roles) for (const v of ["list", "table", "cards"] as ViewMode[]) {
      const want = PARITY[j.ref][r][v === "list" ? "list" : "table"];
      expect(actionLine(actionsFor(j, r, v)), `${j.ref} ${r} ${v}`).toBe(want);
    }
  });
  it("tile and chip counts", () => {
    const c = countsOf(jobs);
    expect([c.open, c.notStarted, c.running, c.waiting, c.complete, c.archived, c.internal, c.rework]).toEqual([20, 7, 10, 3, 4, 0, 2, 2]);
    expect(c.due).toEqual({ "On time": 9, "At risk": 4, Late: 3, "No due date": 1 });
  });
  it("filters: due applies to unfinished jobs, rework tag, stage, dashboard overdue", () => {
    expect(refs(visibleJobs(jobs, { ...DEFAULT_FILTERS, due: "Late" }))).toEqual(["J-0415", "J-0412", "J-0398"]);
    expect(refs(visibleJobs(jobs, { ...DEFAULT_FILTERS, rework: true }))).toEqual(["J-0429", "J-0398"]);
    expect(refs(visibleJobs(jobs, { ...DEFAULT_FILTERS, stages: ["Inspection"] }))).toEqual(["J-0425", "J-0424", "J-0423"]);
    expect(refs(visibleJobs(jobs, { ...DEFAULT_FILTERS, listFilter: "overdue" }))).toEqual(["J-0415", "J-0412"]);
    expect(refs(visibleJobs(jobs, { ...DEFAULT_FILTERS, show: "complete" }))).toEqual(["J-0411", "J-0410", "J-0409", "J-0408"]);
    expect(visibleJobs(jobs, { ...DEFAULT_FILTERS, show: "archived" })).toEqual([]);
  });
  it("machine groups for open jobs", () => {
    const g = machineGroups(visibleJobs(jobs, DEFAULT_FILTERS)).map((x) => x.heading);
    expect(g).toEqual(["On Lathe 1 (2)", "On Lathe 2 (3)", "On Press brake (3)", "On VMC 1 (5)", "On VMC 2 (4)", "On Waterjet (1)", "On Weld bay 1 (3)", "On Weld bay 2 (1)", "No machine (1)"]);
  });
  it("bulk finish plan names what will and will not change", () => {
    const plan = planBulkFinish(jobs.filter((j) => ["J-0434", "J-0433", "J-0425"].includes(j.ref)));
    expect(refs(plan.targets)).toEqual(["J-0434", "J-0433"]);
    expect(plan.skipped.map((x) => x.job.ref)).toEqual(["J-0425"]);
  });
  it("scope wording", () => {
    expect(selectionScope(0, 20)).toBe("Exports all 20 jobs in the current filter (nothing is selected)");
    expect(selectionScope(2, 20)).toBe("Exports the 2 jobs selected");
  });
});

describe("jobs preview: local state only", () => {
  it("pause then finish then inspect changes the copy in memory and nothing else", () => {
    const before = jobs.find((j) => j.ref === "J-0412")!;
    const paused = applyOp(before, { type: "pause" });
    expect(paused.status).toBe("paused");
    expect(actionLine(actionsFor(paused, "admin", "table")).startsWith("Resume|Finish")).toBe(true);
    const done = applyOp(applyOp(paused, { type: "finish" }), { type: "inspect", result: "pass" });
    expect(done.status).toBe("complete");
    expect(before.status).toBe("running");
  });
  it("reducer: tile, view, role, selection and bulk finish", () => {
    let st = initialState();
    expect(st.view).toBe("list");
    st = reduce(st, { t: "tile", v: "waiting" });
    expect(refs(visibleJobs(st.jobs, st.filters))).toEqual(["J-0425", "J-0424", "J-0423"]);
    st = reduce(reduce(initialState(), { t: "select", ref: "J-0434" }), { t: "select", ref: "J-0433" });
    st = reduce(st, { t: "bulkFinish", refs: ["J-0434", "J-0433"] });
    expect(st.jobs.filter((j) => j.status === "waiting")).toHaveLength(5);
    expect(st.selected).toEqual([]);
    expect(reduce(initialState(), { t: "toggleColumn", v: "ref" }).hidden).toEqual([]);
  });
});


const setup = () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const dlg = HTMLDialogElement.prototype as unknown as { showModal?: () => void; close?: () => void };
  dlg.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  dlg.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  const host = document.createElement("div");
  document.body.appendChild(host);
  window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never;
  return host;
};
const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;
const buttonWith = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === text) as HTMLElement;

describe("jobs preview v2: pure structure (filters, chips, one primary per row)", () => {
  it("Filters (n) counts only the filters under the popover; chips are removable and match the real labels", () => {
    expect(popoverFilterCount(DEFAULT_FILTERS)).toBe(0);
    expect(isFiltered(DEFAULT_FILTERS)).toBe(false);
    const f = { ...DEFAULT_FILTERS, type: "internal" as const, group: "machine" as const, rework: true, stages: ["Setup" as const, "Inspection" as const] };
    expect(activeChips(f).map((c) => c.label)).toEqual(["Type: Internal", "Group: Machine", "Tag: Rework", "Stage: Setup", "Stage: Inspection"]);
    expect(popoverFilterCount(f)).toBe(5);
    for (const c of activeChips(f)) {
      const st = reduce({ ...initialState(), filters: f }, c.remove);
      expect(activeChips(st.filters).length).toBe(4);
    }
    expect(isFiltered({ ...DEFAULT_FILTERS, show: "complete" })).toBe(true);
    expect(isFiltered({ ...DEFAULT_FILTERS, due: "Late" })).toBe(true);
    expect(reduce({ ...initialState(), filters: f }, { t: "clearFilters" }).filters).toEqual(DEFAULT_FILTERS);
  });
  it("every action the real board offers a row is reachable: one primary (or none) plus More, nothing dropped, for every job, role and view", () => {
    const roles: Role[] = ["admin", "office", "workshop", "viewer"];
    for (const j of jobs) for (const r of roles) for (const v of ["list", "table", "cards"] as ViewMode[]) {
      const all = actionsFor(j, r, v);
      const { primary, more } = splitRowActions(all);
      expect([...(primary ? [primary] : []), ...more].map((a) => a.label).sort(), `${j.ref} ${r} ${v}`).toEqual(all.map((a) => a.label).sort());
      expect(reachableActionLabels(j, r, v)).toHaveLength(all.length);
      if (primary) expect(more.includes(primary)).toBe(false);
    }
  });
  it("the title sentence and the filter notes keep their exact wording", () => {
    expect(JOBS_INTRO).toBe("Jobs are the work in the workshop. Follow each one from start to finish.");
    expect(DUE_NOTE).toBe("Not started and Running jobs only");
    expect(REWORK_NOTE).toBe("Running jobs put back after a failed inspection (or for replacements)");
  });
});

describe("jobs preview v2: rendering", () => {
  let host: HTMLDivElement;
  beforeEach(() => { host = setup(); });
  afterEach(() => { host.remove(); document.body.innerHTML = ""; });
  const mount = async () => { const root = createRoot(host); await act(async () => { root.render(createElement(JobsPreview)); }); return root; };

  it("shows the default List with 20 rows, the PreviewBar, the title sentence as a description, and gates the Viewer", async () => {
    const root = await mount();
    expect(host.querySelectorAll("tbody tr[data-job]")).toHaveLength(20);
    expect(host.querySelector("[data-testid=preview-bar]")?.textContent).toContain("Preview");
    expect(host.querySelector("h1")?.textContent).toBe("Job Board");
    expect(host.querySelector("h1 [title]")?.getAttribute("title")).toBe(JOBS_INTRO);
    expect(host.textContent).toContain(JOBS_INTRO);
    expect(host.querySelector("[data-testid=new-job]")).not.toBeNull();
    expect(host.querySelector("[aria-label=View] [aria-checked=true]")?.textContent).toBe("List");
    expect(host.querySelectorAll("thead th")).toHaveLength(15);
    await act(async () => { byTestId("dock-toggle").click(); });
    await act(async () => { buttonWith("Viewer").click(); });
    expect(host.querySelector("[data-testid=new-job]")).toBeNull();
    expect(host.querySelector("[data-action=Start]")).toBeNull();
    await act(async () => { host.querySelector<HTMLInputElement>("[data-testid=select-row]")!.click(); });
    expect(byTestId("finish-selected")).toBeNull();
    expect(byTestId("print-pack")).not.toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("bulk actions exist only while a row is ticked; Select all and Export stay reachable without a selection", async () => {
    const root = await mount();
    expect(byTestId("print-pack")).toBeNull();
    expect(byTestId("finish-selected")).toBeNull();
    expect(document.querySelector("[data-selection=idle]")?.textContent).toContain("20 jobs shown");
    expect(byTestId("select-all-header")).not.toBeNull();
    expect(byTestId("export-trigger")).not.toBeNull();
    const ticks = host.querySelectorAll<HTMLInputElement>("[data-testid=select-row]");
    await act(async () => { ticks[0].click(); ticks[1].click(); });
    expect(document.querySelector("[data-selection=active] [role=status]")?.textContent).toBe("2 selected of 20 filtered jobs.");
    for (const id of ["print-pack", "export-selected-trigger", "finish-selected"]) expect(byTestId(id), id).not.toBeNull();
    expect(buttonWith("Select all 20 filtered")).toBeTruthy();
    expect(buttonWith("Clear selection")).toBeTruthy();
    await act(async () => { buttonWith("Select all 20 filtered").click(); });
    expect(document.querySelector("[data-selection=active] [role=status]")?.textContent).toBe("20 selected of 20 filtered jobs.");
    await act(async () => { buttonWith("Clear selection").click(); });
    expect(byTestId("print-pack")).toBeNull();
    await act(async () => { byTestId("select-all-header").click(); });
    expect(document.querySelector("[data-selection=active] [role=status]")?.textContent).toBe("20 selected of 20 filtered jobs.");
    await act(async () => { root.unmount(); });
  });

  it("selecting two jobs and pressing Finish Selected opens the confirm without changing anything", async () => {
    const root = await mount();
    const ticks = host.querySelectorAll<HTMLInputElement>("[data-testid=select-row]");
    await act(async () => { ticks[0].click(); ticks[1].click(); });
    await act(async () => { byTestId("finish-selected").click(); });
    expect(document.body.textContent).toContain("Finish 2 selected jobs?");
    expect(document.body.textContent).toContain("Will be finished (2): J-0434, J-0433");
    expect(host.querySelectorAll("tbody tr[data-status=waiting]")).toHaveLength(3);
    await act(async () => { root.unmount(); });
  });

  it("every real filter is reachable: Show and Due inline, Type, Group, Rework and Stage in the Filters popover with a count and removable chips", async () => {
    const root = await mount();
    for (const id of ["show-open", "show-complete", "show-archived", "show-all", "due-all", "due-On time", "due-At risk", "due-Late", "due-No due date"]) expect(byTestId(id), id).not.toBeNull();
    expect(byTestId("filters-trigger").textContent?.trim()).toBe("Filters");
    expect(byTestId("clear-filters")).toBeNull();
    expect(byTestId("active-chips")).toBeNull();
    await act(async () => { byTestId("filters-trigger").click(); });
    for (const id of ["type-all", "type-customer", "type-internal", "group-none", "group-machine", "tag-rework", "stage-material", "stage-setup", "stage-machining", "stage-inspection"]) expect(byTestId(id), id).not.toBeNull();
    expect(document.body.textContent).toContain(REWORK_NOTE);
    await act(async () => { byTestId("type-internal").click(); byTestId("stage-setup").click(); });
    expect(byTestId("filters-trigger").textContent?.trim()).toBe("Filters (2)");
    expect(host.querySelectorAll("tbody tr[data-job]")).toHaveLength(1);
    expect([...byTestId("active-chips").querySelectorAll("li")].map((l) => l.textContent)).toEqual(["Type: Internal", "Stage: Setup"]);
    await act(async () => { host.querySelector<HTMLElement>("[data-chip=stage-Setup]")!.click(); });
    expect(byTestId("filters-trigger").textContent?.trim()).toBe("Filters (1)");
    expect(host.querySelectorAll("tbody tr[data-job]")).toHaveLength(2);
    await act(async () => { byTestId("clear-filters").click(); });
    expect(host.querySelectorAll("tbody tr[data-job]")).toHaveLength(20);
    expect(byTestId("clear-filters")).toBeNull();
    await act(async () => { byTestId("due-Late").click(); });
    expect(host.querySelectorAll("tbody tr[data-job]")).toHaveLength(3);
    await act(async () => { root.unmount(); });
  });

  it("each row shows one primary action and a More menu that holds the rest, including a disabled action with its reason", async () => {
    const root = await mount();
    for (const tr of host.querySelectorAll("tbody tr[data-job]")) expect(tr.querySelectorAll("[data-testid=row-primary]").length).toBeLessThanOrEqual(1);
    const row = host.querySelector("tr[data-job='J-0412']")!;
    expect(row.querySelector("[data-testid=row-primary]")?.textContent).toBe("Pause");
    expect(row.querySelector("[data-action=Finish]")).toBeNull();
    await act(async () => { row.querySelector<HTMLElement>("[data-testid=row-more]")!.click(); });
    const items = [...document.querySelectorAll("[role=menuitem]")].map((e) => e.textContent);
    expect(items.some((t) => t?.startsWith("Finish"))).toBe(true);
    expect(items.some((t) => t?.startsWith("Inspected") && t.includes("J-0412: finish the job first, then record the inspection"))).toBe(true);
    const finish = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((e) => e.textContent?.startsWith("Finish"))!;
    await act(async () => { finish.click(); });
    await new Promise((r) => setTimeout(r, 0));
    expect(document.body.textContent).toContain("Finish J-0412?");
    await act(async () => { root.unmount(); });
  });

  it("grouping by machine then back to None leaves exactly one row per job", async () => {
    const root = await mount();
    await act(async () => { byTestId("filters-trigger").click(); });
    await act(async () => { byTestId("group-machine").click(); });
    expect(host.querySelectorAll("tbody tr[data-job]").length).toBeGreaterThan(20);
    await act(async () => { byTestId("group-none").click(); });
    expect(host.querySelectorAll("tbody tr[data-job]")).toHaveLength(20);
    await act(async () => { root.unmount(); });
  });

  it("the No jobs state zeroes the counters and loading shows dashes, never live-looking numbers", async () => {
    const root = await mount();
    await act(async () => { byTestId("dock-toggle").click(); });
    await act(async () => { buttonWith("No jobs").click(); });
    expect(byTestId("tile-open").textContent).toContain("0");
    expect(byTestId("state-empty")).not.toBeNull();
    await act(async () => { buttonWith("Loading").click(); });
    expect(byTestId("tile-open").textContent).toContain("—");
    expect(byTestId("show-open").textContent).toContain("(—)");
    await act(async () => { root.unmount(); });
  });

  it("Columns lists all 14 as real switches (the three locked ones disabled), local state only", async () => {
    const root = await mount();
    await act(async () => { byTestId("columns-trigger").click(); });
    expect(document.querySelectorAll("[data-testid=columns-panel] [role=switch]")).toHaveLength(14);
    const sw = (id: string) => byTestId(id);
    for (const k of ["ref", "due", "actions"]) { expect(sw(`col-${k}`).getAttribute("aria-checked")).toBe("true"); expect((sw(`col-${k}`) as HTMLButtonElement).disabled).toBe(true); }
    const before = host.querySelectorAll("thead th").length;
    await act(async () => { sw("col-specification").click(); });
    expect(sw("col-specification").getAttribute("aria-checked")).toBe("false");
    expect(host.querySelectorAll("thead th").length).toBe(before - 1);
    await act(async () => { buttonWith("Reset to default (show all columns)").click(); });
    expect(host.querySelectorAll("thead th").length).toBe(before);
    expect(window.localStorage.getItem("jobs-preview:columns")).toBeNull();
    await act(async () => { root.unmount(); });
  });

  it("an action that commits says preview only and nothing is saved", async () => {
    const root = await mount();
    await act(async () => { host.querySelector<HTMLElement>("tr[data-job='J-0433'] [data-action=Start]")!.click(); });
    expect(document.body.textContent).toContain("J-0433 started on Press brake.");
    expect(document.body.textContent).toContain("Preview only, nothing was saved.");
    await act(async () => { root.unmount(); });
  });
});
