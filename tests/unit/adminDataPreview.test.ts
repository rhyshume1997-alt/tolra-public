// @vitest-environment jsdom
/**
 * BOUNDARY (Admin > Data, PREVIEW ONLY; ownership assumed Module 1 by the coordinator, to be confirmed by the owner). Inputs: the exports of components/admin/data/preview/DataPreview.tsx,
 * the REAL pure functions it uses (import-preview, import-targets) and the SOURCE of app/(dashboard)/admin/data/page.tsx, components/data-import.tsx,
 * components/data-import-history.tsx and components/sliq-import.tsx. Output: pass/fail. Pins wording, the history labels (mirrored from a file that reaches Supabase) and the role gate to
 * the real source, and checks by rendering that no import, undo, discard or export ever happens, no import is drawn as succeeding, no file is read and the preview imports no network,
 * file or database code. Must not change: never loosen these. No network. Written with createElement (no JSX).
 */
import fs from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import DataPreview, * as P from "@/components/admin/data/preview/DataPreview";
import { isClean, totalCreated } from "@/lib/import-preview";

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
const PAGE = read("app/(dashboard)/admin/data/page.tsx");
const IMPORT = read("components/data-import.tsx");
const HIST = read("components/data-import-history.tsx");
const SLIQ = read("components/sliq-import.tsx");
const SRC = read("components/admin/data/preview/DataPreview.tsx");
const ROUTE = read("app/(dashboard)/admin/data/preview/page.tsx");
const ALL = PAGE + IMPORT + HIST + SLIQ;

describe("pinned to the real source", () => {
  it("wording", () => {
    for (const w of [P.SUBTITLE, P.UPLOAD_TITLE, P.UPLOAD_TEXT, P.IMPORT_ORDER, P.CHOOSE_FIRST, P.NOT_CHOSEN, P.CLEAN_SMALL, P.NOTHING_WRITTEN, P.MATCHED_NOTE, P.CONFIRM_NEEDS_CLEAN, P.UNDO_TITLE, P.UNDO_TEXT,
      P.DISCARD_TITLE, P.DISCARD_TEXT, P.HISTORY_EMPTY, P.HISTORY_ERROR, P.SLIQ_TITLE, ...P.SLIQ_TEXT.split(/(?<=uploaded\.) /), P.SLIQ_FILES_LABEL, P.SLIQ_FILES_HINT, P.SLIQ_GAP, "Check the file", "Confirm import", "Retry this part", "Undo this import",
      "Check files", "Preflight (writes nothing)", "Import history", "The file is clean", "The file has problems", "Large import", "Choose what it is", "This sheet is"]) expect(ALL, w).toContain(w);
    expect(PAGE).toContain(`<h1 className="page-title">${P.PAGE_TITLE}</h1>`);
    expect(PAGE).toContain('allowed={["admin"]}');
    expect(IMPORT).toContain("This is a large import: it goes in ${dry.result.parts ?? \"several\"} parts, with a progress bar, and can be undone.");
    for (const c of ["Kind", "Rows", "Created", "Matched (skipped)", "Linked", "Problems", "Warnings"]) expect(IMPORT, c).toContain(c);
    expect(IMPORT).toContain("Part ${part} of ${outcome.last?.parts ?? dry.result.parts ?? \"?\"} did not go in: ${detail} The parts before it are in. Retry this part, or undo this import to put things back as they were.");
    expect(P.FAILURE_TEXT).toBe("Part 3 of 6 did not go in: The database stopped. The parts before it are in. Retry this part, or undo this import to put things back as they were.");
    expect(IMPORT).toContain('"The database stopped."');
  });
  it("progress labels", () => {
    expect(IMPORT).toContain('{ staging: "Sending the file", checking: "Checking the whole file", committing: "Importing", undoing: "Undoing" }');
    expect(P.progressLabel("checking")).toBe("Checking the whole file");
    expect(P.progressLabel("committing")).toBe("Importing");
  });
  it("the history labels are the real runState", () => {
    for (const frag of ['label: "Checked, not imported", action: "discard"', 'label: `Stopped part way: ${run.parts_committed} of ${run.parts ?? "?"} parts are in`, action: "undo"', 'label: "Imported", action: "undo"',
      'label: `Being undone: ${run.parts_undone} of ${run.parts_committed} parts removed`, action: "undo"', 'label: "Undone", action: null', 'label: "Cancelled, nothing was imported", action: null']) {
      expect(HIST, frag).toContain(frag);
    }
    expect(P.runState({ status: "committing", parts: 6, parts_committed: 3, parts_undone: 0 })).toEqual({ label: "Stopped part way: 3 of 6 parts are in", action: "undo" });
    expect(P.runState({ status: "validated", parts: 4, parts_committed: 0, parts_undone: 0 }).action).toBe("discard");
    expect(P.runState({ status: "cancelled", parts: 3, parts_committed: 0, parts_undone: 0 }).action).toBeNull();
    expect(HIST).toContain("A small import goes in whole or not at all.");
    expect(HIST).toContain("Imported in one step (");
  });
  it("the check result figures come from the real functions", () => {
    expect(isClean(P.RESULT_CLEAN, 0)).toBe(true);
    expect(isClean(P.RESULT_PROBLEMS, 0)).toBe(false);
    expect(totalCreated(P.RESULT_CLEAN)).toBe(112 + 342 + 1190);
    for (const r of P.CLEAN_ROWS) expect(r.created + r.matched).toBeLessThanOrEqual(r.rows);
    expect(P.PROBLEM_LINES[0]).toBe("Invoices, row 4, invoice_ref: Invoice number is required.");
  });
  it("the SliQ status line is the real one for no mapping", () => { expect(SLIQ).toContain('Mapping: {mapping ? "chosen" : "not chosen"}. Files:'); expect(P.SLIQ_STATUS.startsWith("Mapping: not chosen. Files: ")).toBe(true); });
  it("admin only", () => { expect(P.canUseData("admin")).toBe(true); for (const r of ["office", "workshop", "viewer"] as const) expect(P.canUseData(r)).toBe(false); });
});

describe("safety", () => {
  it("imports no network, file, auth or database code; not drawn on purpose", () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const bad of ["supabase", "fetch(", "FileReader", "localStorage", "use-user", "sonner", "XMLHttpRequest", "sendBeacon", "data-import\"", "from \"xlsx\"", "type=\"file\"", "createObjectURL", "download"]) expect(code.toLowerCase(), bad).not.toContain(bad.toLowerCase());
    expect(SRC).toContain("PREVIEW ONLY");
    expect(SRC).toContain("OWNERSHIP ASSUMPTION");
    expect(ROUTE).toContain("OWNERSHIP ASSUMPTION");
    expect(ROUTE).toContain("robots: { index: false, follow: false }");
    expect(code).not.toContain("Imported{");
    expect(code).not.toContain('"Undone: what this import added');
    for (const m of JSON.stringify([P.RUNS, P.SMALL_RUNS, P.initialPlans(true)]).match(/[\w.-]+@[\w.-]+/g) ?? []) expect(m.endsWith(".example"), m).toBe(true);
  });
});

describe("rendering", () => {
  let host: HTMLDivElement;
  beforeAll(() => {
    (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
    const d = HTMLDialogElement.prototype as unknown as { showModal: () => void; close: () => void };
    d.showModal = function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
    d.close = function (this: HTMLDialogElement) { this.removeAttribute("open"); };
  });
  afterEach(() => { host?.remove(); });
  const mount = async () => { host = document.createElement("div"); document.body.appendChild(host); await act(async () => { createRoot(host).render(createElement(DataPreview)); }); };
  const click = async (sel: string) => { await act(async () => { (host.querySelector(sel) as HTMLElement).click(); }); };
  it("choosing a file reads nothing, draws the sample sheets and toasts", async () => {
    await mount();
    expect(host.querySelector('input[type="file"]')).toBeNull();
    await click('[data-testid="import-file"]');
    expect(document.body.textContent).toContain("No file was read.");
    expect(host.querySelectorAll('[data-testid="import-sheet"]').length).toBe(3);
    const check = host.querySelector('[data-testid="check-file"]') as HTMLButtonElement;
    expect(check.disabled).toBe(true);
  });
  it("Undo asks first with the real wording and never says it is undone", async () => {
    await mount();
    const undo = [...host.querySelectorAll("button")].find((b) => b.textContent === "Undo") as HTMLButtonElement;
    await act(async () => { undo.click(); });
    expect(document.body.textContent).toContain(P.UNDO_TITLE);
    const confirm = [...document.querySelectorAll("dialog button")].find((b) => b.textContent === "Undo import") as HTMLButtonElement;
    await act(async () => { confirm.click(); });
    expect(document.body.textContent).toContain("Preview only");
    expect(document.body.textContent).not.toMatch(/Undone: what this import added/);
    expect(host.querySelector('[data-status="committed"]')?.textContent).toContain("Imported");
  });
  it("no control exports or downloads", async () => {
    await mount();
    for (const b of host.querySelectorAll("button")) expect(b.textContent ?? "").not.toMatch(/export|download/i);
  });
});
