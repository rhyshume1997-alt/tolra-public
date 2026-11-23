// @vitest-environment jsdom
/**
 * BOUNDARY (NCR register, Jobs module 2, PREVIEW ONLY). Inputs: the exports of components/jobs/preview/NcrRegisterPreview.tsx, the REAL lib functions it uses (lib/jobs/ncr-register,
 * lib/jobs/ncr-register-switch, lib/dates, lib/money) and the SOURCE TEXT of components/jobs/ncr-register.tsx and app/(dashboard)/jobs/ncr/page.tsx (read as files, never run). Output: pass/fail.
 * Pins the preview to today's register: the rows, tiles and filters are the real functions, the sample figures, the column list, the tile labels and order, the wording, the cell rules and the
 * role gate match the real component's text. Also checks that the sample holds no live record or address, that the preview imports nothing that could read or write, and a few interaction
 * rules (nothing downloads, nothing reports success, the role gate, the company switch, the filters) by rendering the preview.
 * Must not change: never loosen these to make a change pass. No network, no Supabase. Written with createElement (no JSX) so it is a .test.ts file and runs under the existing vitest.config.ts include pattern.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import NcrRegisterPreview, * as P from "@/components/jobs/preview/NcrRegisterPreview";
import { fmtDate } from "@/lib/dates";
import * as real from "@/lib/jobs/ncr-register";
import { NCR_REGISTER_OFF_NOTICE, NCR_REGISTER_ON_MARKER, canSeeNcrRegister } from "@/lib/jobs/ncr-register-switch";
import { gbp } from "@/lib/money";

const root = path.resolve(__dirname, "../..");
const REAL = readFileSync(path.join(root, "components/jobs/ncr-register.tsx"), "utf8");
const REAL_PAGE = readFileSync(path.join(root, "app/(dashboard)/jobs/ncr/page.tsx"), "utf8");
const PREVIEW_SRC = readFileSync(path.join(root, "components/jobs/preview/NcrRegisterPreview.tsx"), "utf8");
const ROUTE_SRC = readFileSync(path.join(root, "app/(dashboard)/jobs/ncr/preview/page.tsx"), "utf8");
const CSS_SRC = readFileSync(path.join(root, "components/jobs/preview/NcrRegisterPreview.module.css"), "utf8");

describe("ncr preview: rows, tiles and filters are the real functions", () => {
  it("re-exports lib/jobs/ncr-register itself (the same functions, not copies)", () => {
    expect(P.buildNcrRows).toBe(real.buildNcrRows);
    expect(P.filterNcrRows).toBe(real.filterNcrRows);
    expect(P.splitByClass).toBe(real.splitByClass);
    expect(P.summariseNcrRows).toBe(real.summariseNcrRows);
    expect(P.countConcessions).toBe(real.countConcessions);
    expect(P.defaultRange).toBe(real.defaultRange);
  });
  it("the default range is the last 90 days to the sample day, as the real page's defaultRange()", () => {
    expect(P.DEFAULT_FILTERS).toEqual({ from: "2026-08-25", to: "2026-11-23", type: "all", status: "all" });
    expect(P.DEFAULT_FILTERS.to).toBe(P.SAMPLE_DATE);
  });
  it("the sample gives 11 confirmed records (6 open, 5 closed), 2 legacy fails and 2 concession inspections in range", () => {
    const { rows, legacy, summary } = P.register(P.SAMPLE_SOURCES, P.DEFAULT_FILTERS);
    expect(rows).toHaveLength(11);
    expect(legacy).toHaveLength(2);
    expect(summary).toMatchObject({ total: 11, open: 6, closed: 5, notLinked: 2, quantityScrapped: 5, averageDaysToClose: 6.8, hours: 19, materialCost: 156.9 });
    expect(summary.byType).toMatchObject({ Rework: 3, "Inspection fail": 4, Concession: 1, Problem: 3 });
    expect(real.countConcessions(P.SAMPLE_SOURCES, P.DEFAULT_FILTERS)).toBe(2);
  });
  it("the tiles are the real figures in the real order and labels", () => {
    const { summary } = P.register(P.SAMPLE_SOURCES, P.DEFAULT_FILTERS);
    expect(P.tilesFor(summary, P.SAMPLE_SOURCES, P.DEFAULT_FILTERS)).toEqual([
      ["Total", "11"], ["Open", "6"], ["Closed", "5"], ["Concession inspections (by inspection date)", "2"], ["Failed inspections, no linked rework (legacy)", "2"],
      ["Rework", "3"], ["Inspection fail", "4"], ["Concession", "1"], ["Problem", "3"], ["Quantity scrapped", "5"], ["Average days to close", "6.8"],
    ]);
  });
  it("a widened range counts the older concession and the empty register reads None closed", () => {
    const wide = { ...P.DEFAULT_FILTERS, from: "2026-01-01" };
    expect(real.countConcessions(P.SAMPLE_SOURCES, wide)).toBe(3);
    const empty = P.register(P.EMPTY_SOURCES, P.DEFAULT_FILTERS);
    expect(P.tilesFor(empty.summary, P.EMPTY_SOURCES, P.DEFAULT_FILTERS).at(-1)).toEqual(["Average days to close", "None closed"]);
    expect(empty.rows).toEqual([]);
  });
  it("legacy rows follow the date range only, never the type or status filter (the real page's rule)", () => {
    const f = { ...P.DEFAULT_FILTERS, type: "Problem" as const, status: "closed" as const };
    const r = P.register(P.SAMPLE_SOURCES, f);
    expect(r.legacy).toHaveLength(2);
    expect(r.rows.every((x) => x.type === "Problem" && !x.open)).toBe(true);
    expect(r.summary.notLinked).toBe(2);
  });
  it("one chain is one record: a repeated failure and a replacement rework are folded in, a concession that closed a rework is not a separate record", () => {
    const { rows } = P.register(P.SAMPLE_SOURCES, { ...P.DEFAULT_FILTERS, from: "2026-01-01" });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("rework:r5a")?.replacements).toBe(1);
    expect(byKey.get("rework:r5a")?.open).toBe(false);
    expect(byKey.get("rework:r7a")?.open).toBe(true);
    expect(byKey.has("concession:ic1")).toBe(false);
    expect(byKey.get("rework:r6")?.closedHow).toBe("Closed on concession");
  });
});

describe("ncr preview: pinned to the real component's source text", () => {
  it("the page title, subtitle and messages are the real words", () => {
    expect(REAL).toContain(`<h1 className="page-title">${P.PAGE_TITLE}</h1>`);
    expect(REAL).toContain(P.PAGE_SUBTITLE);
    expect(REAL).toContain(P.NOT_AVAILABLE);
    expect(REAL).toContain(P.CANNOT_READ.replace("can't", "can&apos;t"));
    expect(REAL).toContain(P.NO_MATCH);
    expect(REAL).toContain(P.NOT_LISTED);
    expect(REAL).toContain(P.LEGACY_TITLE);
    expect(REAL).toContain(P.LEGACY_NOTE);
    expect(REAL).toContain("Rework hours and material cost:");
    expect(REAL).toContain("NCR_REGISTER_OFF_NOTICE");
    expect(NCR_REGISTER_OFF_NOTICE).toBe("The NCR register is switched off for your company.");
  });
  it("the 13 column headers and the 4 legacy headers are the real ones, in order", () => {
    expect(REAL).toContain(`{${JSON.stringify([...P.NCR_COLUMNS]).replace(/","/g, '", "').replace(/^\[/, "[").replace(/\]$/, "]")}.map((h) =>`);
    expect(P.NCR_COLUMNS).toHaveLength(13);
    for (const h of P.LEGACY_COLUMNS) expect(REAL).toContain(`<TableHead>${h}</TableHead>`);
  });
  it("the filter labels, the type and status choices and Download CSV are the real ones", () => {
    for (const label of ["From", "To", "Type", "Status"]) expect(REAL).toMatch(new RegExp(`<label className="text-sm">${label}`));
    expect(REAL).toContain('<option value="all">All types</option>');
    expect(REAL).toContain("NCR_CONFIRMED_TYPES.map((t) => <option");
    expect(REAL).toContain('<option value="all">All</option><option value="open">Open</option><option value="closed">Closed</option>');
    expect(REAL).toContain("Download CSV");
    expect(REAL).toContain("disabled={!rows.length && !legacy.length}");
    expect([...P.NCR_COLUMNS].length).toBe(13);
  });
  it("the tile labels, their order and their values are written the same way in the real component", () => {
    for (const label of ["Total", "Open", "Closed", "Concession inspections (by inspection date)", "Failed inspections, no linked rework (legacy)", "Quantity scrapped", "Average days to close"]) {
      expect(REAL).toContain(`["${label}", `);
    }
    expect(REAL).toContain("...NCR_CONFIRMED_TYPES.map((t): [string, string] => [t, String(summary.byType[t])]),");
    expect(REAL).toContain('summary.averageDaysToClose === null ? "None closed" : String(summary.averageDaysToClose)');
    expect(REAL).toContain("countConcessions(sources, range)");
  });
  it("the cell rules are the real ones", () => {
    expect(REAL).toContain('{r.affectsAll ? "All" : r.quantityAffected ?? ""}');
    expect(REAL).toContain('{r.scrapped ?? ""}');
    expect(REAL).toContain('{r.remade ?? ""}');
    expect(REAL).toContain('{r.closedAt ? `${fmtDate(r.closedAt)}${r.closedHow ? `, ${r.closedHow}` : ""}` : ""}');
    expect(REAL).toContain('{r.daysOpen ?? ""}');
    expect(REAL).toContain('{r.replacements || ""}');
    expect(REAL).toContain('{r.hours ?? ""}');
    expect(REAL).toContain('{r.materialCost === null ? "" : gbp(r.materialCost)}');
    expect(REAL).toContain("{r.reason}{r.action ?");
    const { rows } = P.register(P.SAMPLE_SOURCES, { ...P.DEFAULT_FILTERS, from: "2026-01-01" });
    const by = (k: string) => rows.find((r) => r.key === k)!;
    expect(P.cell(by("rework:r2"), "Qty affected")).toBe("All");
    expect(P.cell(by("rework:r1"), "Qty affected")).toBe("6");
    expect(P.cell(by("problem:p1"), "Scrapped")).toBe("");
    expect(P.cell(by("rework:r4"), "Closed")).toBe(`${fmtDate("2026-11-04T15:20:00Z")}, Passed re-inspection`);
    expect(P.cell(by("rework:r4"), "Material cost")).toBe(gbp(18.4));
    expect(P.cell(by("rework:r4"), "Rework hours")).toBe("4.75");
    expect(P.cell(by("rework:r5a"), "Replacements")).toBe("1");
    expect(P.cell(by("rework:r4"), "Replacements")).toBe("");
    expect(P.cell(by("rework:r1"), "Closed")).toBe("");
  });
  it("the legacy list shows Record, Raised, Customer and Inspection notes, outside the figures", () => {
    expect(REAL).toContain("<TableCell>{r.record}</TableCell><TableCell>{fmtDate(r.raisedAt)}</TableCell><TableCell>{r.customer}</TableCell><TableCell>{r.reason}</TableCell>");
    expect(REAL).toContain("summariseNcrRows([...rows, ...legacy])");
  });
  it("the role gate is admin and office only, as the real page and the real switch file", () => {
    expect(REAL).toContain('<RoleGate allowed={["admin", "office"]}>');
    expect(P.canUseNcr("admin")).toBe(true);
    expect(P.canUseNcr("office")).toBe(true);
    expect(P.canUseNcr("workshop")).toBe(false);
    expect(P.canUseNcr("viewer")).toBe(false);
    for (const r of ["admin", "office", "workshop", "viewer"] as const) expect(P.canUseNcr(r)).toBe(canSeeNcrRegister(r));
    expect(readFileSync(path.join(root, "components/role-gate.tsx"), "utf8")).toContain("Access Denied");
    expect(readFileSync(path.join(root, "components/role-gate.tsx"), "utf8")).toContain("Redirecting you back to the dashboard.");
  });
  it("the real page is the thin one the preview was drawn from, and the real register has no row actions", () => {
    expect(REAL_PAGE).toContain("<NcrRegister />");
    expect(REAL).not.toMatch(/onClick=\{\(\) => (open|view|edit)/i);
    expect(REAL).toContain("Read-only");
    expect(NCR_REGISTER_ON_MARKER).toBe("job-ncr-register:on");
  });
});

describe("ncr preview: safety of the files", () => {
  it("imports nothing that could read or write (no Supabase, fetch, download, storage, mail or AI)", () => {
    const imports = [...PREVIEW_SRC.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./NcrRegisterPreview.module.css", "@/components/ui/premium", "@/components/ui/premium", "@/lib/dates", "@/lib/jobs/ncr-register", "@/lib/jobs/ncr-register-switch", "@/lib/money", "react"].sort());
    const code = PREVIEW_SRC.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/supabase|fetch\(|XMLHttpRequest|downloadFile|ncrCsv|URL\.createObjectURL|localStorage|sessionStorage|navigator\.sendBeacon|mailto:|openai|anthropic/i);
    expect(ROUTE_SRC.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/supabase|fetch\(|"use server"/);
  });
  it("the sample holds only fictional names, no e-mail address and no phone number", () => {
    const text = JSON.stringify(P.SAMPLE_SOURCES);
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/\b0\d{4}\s?\d{3}\s?\d{3}\b/);
    expect(text).not.toMatch(/https?:/);
  });
  it("the CSS has no gradient, blur or global selector, and the files carry a boundary comment", () => {
    const css = CSS_SRC.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(css).not.toMatch(/gradient|backdrop-filter|blur\(/i);
    expect(css).not.toMatch(/^\s*(html|body|\*|:root)\b/m);
    for (const src of [PREVIEW_SRC, ROUTE_SRC, CSS_SRC]) expect(src).toMatch(/BOUNDARY/);
    expect(readFileSync(path.join(root, "tests/unit/ncrRegisterPreview.test.ts"), "utf8")).toMatch(/BOUNDARY/);
  });
});

let host: HTMLDivElement | null = null;
let rootEl: ReturnType<typeof createRoot> | null = null;
afterEach(() => { act(() => rootEl?.unmount()); host?.remove(); document.body.innerHTML = ""; host = null; rootEl = null; vi.restoreAllMocks(); vi.useRealTimers(); });
function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  rootEl = createRoot(host);
  act(() => rootEl!.render(createElement(NcrRegisterPreview)));
  return host;
}
const byText = (scope: ParentNode, sel: string, text: string | RegExp) => Array.from(scope.querySelectorAll<HTMLElement>(sel)).find((e) => (typeof text === "string" ? e.textContent?.trim() === text : text.test(e.textContent ?? "")));
const click = (el: Element | undefined | null) => { if (!el) throw new Error("element not found"); act(() => { (el as HTMLElement).click(); }); };
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const dock = () => { const b = byText(document.body, "button", /Preview controls/); if (b?.getAttribute("aria-expanded") !== "true") click(b); };
const pickRole = (label: string) => { dock(); click(byText(document.body, '[role="radiogroup"][aria-label="Role"] [role="radio"]', label)); };
const pickSwitch = (label: string) => { dock(); click(byText(document.body, '[role="radiogroup"][aria-label="Company switch"] [role="radio"]', label)); };
const pickScreen = (label: string) => { dock(); click(byText(document.body, '[role="group"][aria-label="Screen state"] button', label)); };
const choose = (el: HTMLSelectElement | HTMLInputElement, value: string) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => { Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true })); });
};
const rowsIn = (h: HTMLElement) => h.querySelectorAll('[aria-label="NCR register"] tbody tr').length;

describe("ncr preview: rendered behaviour", () => {
  it("labels itself, shows the title, 4 filters, 11 tiles, 13 columns and 11 rows, and calls nothing", () => {
    const fetchSpy = vi.fn(() => { throw new Error("no network in the preview"); });
    vi.stubGlobal("fetch", fetchSpy);
    const h = mount();
    expect(h.textContent).toContain("Preview, sample data, nothing is saved");
    expect(h.querySelector("h1")?.textContent).toBe("NCR register");
    expect(h.querySelectorAll('[data-testid="filters"] input, [data-testid="filters"] select')).toHaveLength(4);
    expect(h.querySelectorAll('[role="group"][aria-label="Summary"] > *')).toHaveLength(11);
    expect(Array.from(h.querySelectorAll('[aria-label="NCR register"] thead th')).map((t) => t.textContent)).toEqual([...P.NCR_COLUMNS]);
    expect(rowsIn(h)).toBe(11);
    expect(h.querySelector('[data-testid="legacy"] h2')?.textContent).toBe(P.LEGACY_TITLE);
    expect(h.querySelector('[data-testid="hours-line"]')?.textContent).toBe("Rework hours and material cost: 19 h, £156.90 in total.");
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
  it("the filters change the rows and the tiles as the real functions do", () => {
    const h = mount();
    choose(h.querySelector<HTMLSelectElement>("select[name=type]")!, "Problem");
    expect(rowsIn(h)).toBe(3);
    expect(h.querySelector('[data-testid="tile-0"]')?.textContent).toContain("3");
    choose(h.querySelector<HTMLSelectElement>("select[name=status]")!, "closed");
    expect(rowsIn(h)).toBe(1);
    choose(h.querySelector<HTMLSelectElement>("select[name=status]")!, "open");
    expect(rowsIn(h)).toBe(2);
    choose(h.querySelector<HTMLSelectElement>("select[name=type]")!, "all");
    choose(h.querySelector<HTMLSelectElement>("select[name=status]")!, "all");
    expect(rowsIn(h)).toBe(11);
  });
  it("a range with nothing in it says so, keeps Download CSV off, and a changed range shows loading for a moment", () => {
    vi.useFakeTimers();
    const h = mount();
    choose(h.querySelector<HTMLInputElement>("input[name=from]")!, "2026-11-22");
    expect(h.querySelector('[role="status"]')?.getAttribute("aria-label")).toBe("Loading the NCR register");
    act(() => { vi.advanceTimersByTime(400); });
    expect(h.querySelector('[role="status"]')).toBeNull();
    expect(h.textContent).toContain(P.NO_MATCH);
    expect(h.querySelector<HTMLButtonElement>('[data-testid="download-csv"]')?.disabled).toBe(true);
  });
  it("Download CSV downloads nothing and answers with the neutral Preview-only toast", () => {
    const create = vi.fn();
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = create;
    const h = mount();
    click(h.querySelector('[data-testid="download-csv"]'));
    const text = document.body.textContent ?? "";
    expect(text).toContain("Preview only");
    expect(text).toContain("Nothing was saved.");
    expect(text).not.toMatch(/downloaded successfully|file saved|exported/i);
    expect(create).not.toHaveBeenCalled();
  });
  it("Workshop and Viewer get Access Denied, as the real role gate", () => {
    const h = mount();
    pickRole("Workshop");
    expect(h.querySelector('[data-testid="access-denied"]')?.textContent).toContain("Access Denied");
    expect(h.querySelector('[role="group"][aria-label="Summary"]')).toBeNull();
    pickRole("Viewer");
    expect(h.querySelector('[data-testid="access-denied"]')).not.toBeNull();
    pickRole("Office");
    expect(h.querySelector('[role="group"][aria-label="Summary"]')).not.toBeNull();
  });
  it("the company switch off shows only the real notice, and not available in this mode shows only its message", () => {
    const h = mount();
    pickSwitch("Off (default)");
    expect(h.querySelector('[data-testid="switch-off"]')?.textContent).toBe(NCR_REGISTER_OFF_NOTICE);
    expect(h.querySelector("h1")).toBeNull();
    expect(h.querySelector('[data-testid="filters"]')).toBeNull();
    pickSwitch("On");
    pickScreen("Not available in this mode");
    expect(h.querySelector('[data-testid="unavailable"]')?.textContent).toBe(P.NOT_AVAILABLE);
  });
  it("the cannot-read state keeps the filters and shows the real sentence in an alert", () => {
    const h = mount();
    pickScreen("Cannot be read");
    expect(h.querySelector('[data-testid="cannot-read"]')?.textContent).toBe(P.CANNOT_READ);
    expect(h.querySelector('[data-testid="cannot-read"]')?.getAttribute("role")).toBe("alert");
    expect(h.querySelector('[data-testid="filters"]')).not.toBeNull();
    expect(h.querySelector('[role="group"][aria-label="Summary"]')).toBeNull();
  });
  it("no records at all shows zero tiles, None closed, the no-match sentence and Download CSV off; some records not listed adds its note", () => {
    const h = mount();
    pickScreen("No records at all");
    expect(h.querySelector('[data-testid="tile-0"]')?.textContent).toContain("0");
    expect(h.querySelector('[data-testid="tile-10"]')?.textContent).toContain("None closed");
    expect(h.textContent).toContain(P.NO_MATCH);
    expect(h.querySelector<HTMLButtonElement>('[data-testid="download-csv"]')?.disabled).toBe(true);
    expect(h.querySelector('[data-testid="not-listed"]')).toBeNull();
    pickScreen("Some records not listed");
    expect(h.querySelector('[data-testid="not-listed"]')?.textContent).toBe(P.NOT_LISTED);
  });
  it("statuses are drawn as the real words, with a tone that follows open, closed and not linked", () => {
    expect(P.statusTone({ open: true, notLinked: false, statusText: "Rework under way" })).toBe("warn");
    expect(P.statusTone({ open: true, notLinked: false, statusText: "Failed again" })).toBe("danger");
    expect(P.statusTone({ open: false, notLinked: false, statusText: "Closed" })).toBe("ok");
    expect(P.statusTone({ open: false, notLinked: true, statusText: "Not linked" })).toBe("neutral");
    const h = mount();
    const words = Array.from(h.querySelectorAll('[aria-label="NCR register"] tbody tr')).map((tr) => tr.querySelectorAll("td")[7]?.textContent);
    expect(words).toEqual(expect.arrayContaining(["Waiting for the workshop", "Rework under way", "Reworked: awaiting re-inspection", "Closed", "Open", "Resolved"]));
  });
});
