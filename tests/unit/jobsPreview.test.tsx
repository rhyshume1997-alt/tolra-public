// @vitest-environment jsdom
/**
 * BOUNDARY (Jobs module 2, PREVIEW ONLY). Inputs: the exports of components/jobs/preview/JobsPreview.tsx. Output: pass/fail.
 * Pins the preview's rules to values computed with Tolra's real logic (design parity fixture, as of 2026-11-20): row action sequences per
 * role and view for all 24 sample jobs, the tile/filter counts, the default order and the machine groups. Must not change: never loosen
 * these to make a change pass; the preview must keep matching the real Job Board's rules. No network, no Supabase.
 * NOTE: vitest.config.ts includes only .test.ts files under tests/unit, so this .test.tsx file needs an explicit config or path pattern to run.
 */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import JobsPreview, { DEFAULT_FILTERS, actionLine, actionsFor, applyOp, countsOf, initialJobs, initialState, machineGroups, planBulkFinish, reduce, selectionScope, visibleJobs } from "@/components/jobs/preview/JobsPreview";
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

describe("jobs preview: rendering", () => {
  let host: HTMLDivElement;
  beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); host = document.createElement("div"); document.body.appendChild(host); window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as never; });
  afterEach(() => { host.remove(); });
  it("shows the default List with 20 rows, preview labelling, and gates the Viewer", async () => {
    const root = createRoot(host);
    await act(async () => { root.render(createElement(JobsPreview)); });
    expect(host.querySelectorAll("tbody tr[data-job]")).toHaveLength(20);
    expect(host.textContent).toContain("Preview");
    expect(host.textContent).toContain("Jobs are the work in the workshop. Follow each one from start to finish.");
    expect(host.querySelector("[data-testid=new-job]")).not.toBeNull();
    expect(host.querySelector("[aria-label=View] [aria-pressed=true]")?.textContent).toBe("List");
    await act(async () => { (host.querySelector("[data-testid=dock-toggle]") as HTMLElement).click(); });
    const viewer = [...host.querySelectorAll("button")].find((b) => b.textContent === "Viewer") as HTMLElement;
    await act(async () => { viewer.click(); });
    expect(host.querySelector("[data-testid=new-job]")).toBeNull();
    expect(host.querySelector("[data-testid=finish-selected]")).toBeNull();
    expect(host.querySelector("[data-action=Start]")).toBeNull();
    await act(async () => { root.unmount(); });
  });
  it("selecting two jobs and pressing Finish Selected opens the confirm without changing anything", async () => {
    const root = createRoot(host);
    await act(async () => { root.render(createElement(JobsPreview)); });
    const ticks = host.querySelectorAll<HTMLInputElement>("[data-testid=select-row]");
    await act(async () => { ticks[0].click(); ticks[1].click(); });
    expect(host.querySelector("[data-testid=selection-status]")?.textContent).toBe("2 selected of 20 filtered jobs.");
    await act(async () => { (host.querySelector("[data-testid=finish-selected]") as HTMLElement).click(); });
    expect(document.body.textContent).toContain("Finish 2 selected jobs?");
    expect(document.body.textContent).toContain("Will be finished (2): J-0434, J-0433");
    await act(async () => { root.unmount(); });
  });
  it("grouping by machine then back to None leaves exactly one row per job (no stale duplicate rows)", async () => {
    const root = createRoot(host);
    await act(async () => { root.render(createElement(JobsPreview)); });
    const chip = (id: string) => host.querySelector(`[data-testid=${id}]`) as HTMLElement;
    await act(async () => { chip("group-machine").click(); });
    expect(host.querySelectorAll("tbody tr[data-job]").length).toBeGreaterThan(20);
    await act(async () => { chip("group-none").click(); });
    expect(host.querySelectorAll("tbody tr[data-job]")).toHaveLength(20);
    await act(async () => { root.unmount(); });
  });
});
