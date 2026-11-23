// BOUNDARY (module 7, shared UI, NEW; v4 adds the craft-pass checks at the end (type scale, elevation, motion rules scanned from the stylesheet, PageHeader, Tabs, PreviewBar, StackedRows, status modes); v2 adds the segmented control, sheet, form fields, stat tile and the option checks; v3 adds the danger and pressed buttons, menu hints, table variants, panel, callout, disclosure, list, form group, error summary, date range, link tile, large fields and nesting). Inputs: the files in components/ui/premium. Output: checks on their pure helpers, their server-rendered
// markup (roles, aria, names) and on the stylesheet's rules (sizes, no glass, reduced motion). Must not change: it reads no database and calls
// no network; loosening a rule here (hit areas, no gradients or blur, reduced motion) needs the same PM approval as changing the rule itself.
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Button, Callout, Checkbox, ChipGroup, DateRangeGroup, Dialog, Disclosure, EmptyState, ErrorSummary, FailedState, Field, FilterChip, FormGroup, Input, List, ListRow, LoadingState, Menu, Panel,
  ScrollTable, SegmentedControl, Select, SelectionBar, Sheet, StatTile, StatTiles, StatusBadge, Switch, Textarea,
  TOKEN_NAMES, calloutLead, cx, dataAttributes, fieldDescribedBy, nextMenuIndex, nextSegmentIndex, pickFirstEnabled, pickInvalidTarget, placeLayer, rangeError, rowClickIsForRow, scrollEdges, selectionControls,
  tabStopIndex, toastRegionStyle,
  PageHeader, PreviewBar, StackedRows, TabPanel, Tabs, isTabKey, layerOriginStyle, toneClassKey, typeScale, PREVIEW_LABEL, EXIT_MS,
} from "@/components/ui/premium";

const dir = path.resolve(__dirname, "../../components/ui/premium");
const css = fs.readFileSync(path.join(dir, "premium.module.css"), "utf8");
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const noop = () => {};

describe("nextMenuIndex", () => {
  it("moves with wrap and skips disabled items", () => {
    const d = [false, true, false, false];
    expect(nextMenuIndex(0, d, "ArrowDown")).toBe(2);
    expect(nextMenuIndex(3, d, "ArrowDown")).toBe(0);
    expect(nextMenuIndex(0, d, "ArrowUp")).toBe(3);
    expect(nextMenuIndex(2, d, "ArrowUp")).toBe(0);
  });
  it("Home and End pick the first and last enabled item; nothing enabled gives -1", () => {
    expect(nextMenuIndex(1, [true, false, false, true], "Home")).toBe(1);
    expect(nextMenuIndex(1, [true, false, false, true], "End")).toBe(2);
    expect(nextMenuIndex(0, [true, true], "ArrowDown")).toBe(-1);
    expect(nextMenuIndex(0, [], "Home")).toBe(-1);
  });
});

describe("placeLayer", () => {
  const vp = { width: 1000, height: 800 };
  it("opens below the anchor when it fits", () => {
    const p = placeLayer({ top: 100, bottom: 140, left: 50, right: 120 }, { width: 200, height: 150 }, vp);
    expect(p.top).toBe(146);
    expect(p.origin).toBe("top left");
  });
  it("flips above when there is no room below and more room above", () => {
    const p = placeLayer({ top: 600, bottom: 640, left: 50, right: 120 }, { width: 200, height: 300 }, vp);
    expect(p.origin).toBe("bottom left");
    expect(p.top).toBeLessThan(600);
  });
  it("keeps the layer inside the viewport horizontally", () => {
    expect(placeLayer({ top: 10, bottom: 40, left: 950, right: 990 }, { width: 200, height: 100 }, vp).left).toBe(792);
    expect(placeLayer({ top: 10, bottom: 40, left: -30, right: 10 }, { width: 200, height: 100 }, vp).left).toBe(8);
  });
});

describe("scrollEdges", () => {
  it("shadow only once scrolled; fade only while there is more", () => {
    expect(scrollEdges(0, 500, 900)).toEqual({ scrolled: false, more: true });
    expect(scrollEdges(120, 500, 900)).toEqual({ scrolled: true, more: true });
    expect(scrollEdges(400, 500, 900)).toEqual({ scrolled: true, more: false });
    expect(scrollEdges(0, 900, 900)).toEqual({ scrolled: false, more: false });
  });
});

describe("markup and roles", () => {
  it("Switch is a role=switch with aria-checked, a name and a written state", () => {
    const on = html(createElement(Switch, { checked: true, onChange: noop, label: "Show rework" }));
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(on).toContain("Show rework");
    expect(on).toContain(">On<");
    const off = html(createElement(Switch, { checked: false, onChange: noop, label: "Show rework", hint: "Adds a tag", disabled: true }));
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain(">Off<");
    expect(off).toContain("disabled");
    expect(off).toContain("aria-describedby");
  });
  it("FilterChip is aria-pressed and shows a check mark when selected", () => {
    const on = html(createElement(FilterChip, { selected: true, onToggle: noop, count: 3, children: "Open" }));
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain("<svg");
    expect(on).toContain("(3)");
    const off = html(createElement(FilterChip, { selected: false, children: "Open" }));
    expect(off).toContain('aria-pressed="false"');
    expect(off).not.toContain("<svg");
    expect(html(createElement(ChipGroup, { label: "Filters", children: null }))).toContain('role="group"');
  });
  it("Button defaults to type=button, blocks clicks while loading and never submits by accident", () => {
    expect(html(createElement(Button, { children: "Go" }))).toContain('type="button"');
    const l = html(createElement(Button, { loading: true, children: "Go" }));
    expect(l).toContain("disabled");
    expect(l).toContain('aria-busy="true"');
  });
  it("StatusBadge always carries the word and hides the dot from assistive technology", () => {
    const m = html(createElement(StatusBadge, { tone: "warn", children: "At risk" }));
    expect(m).toContain("At risk");
    expect(m).toContain('aria-hidden="true"');
  });
  it("Checkbox is a native checkbox", () => {
    expect(html(createElement(Checkbox, { "aria-label": "Select J-1" }))).toContain('type="checkbox"');
  });
  it("Dialog uses the native dialog element, labelled, and renders no content while closed", () => {
    const closed = html(createElement(Dialog, { open: false, title: "Pause?", confirmLabel: "Pause", onConfirm: noop, onClose: noop }));
    expect(closed).toContain("<dialog");
    expect(closed).toContain("aria-labelledby");
    expect(closed).not.toContain("Pause?");
  });
  it("SelectionBar: idle is quiet, active shows the live count and Select all only when more can be chosen", () => {
    const idle = html(createElement(SelectionBar, { count: 0, filteredTotal: 5, noun: "job", onSelectAll: noop, onClear: noop }));
    expect(idle).toContain('data-selection="idle"');
    expect(idle).not.toContain("Clear selection");
    const on = html(createElement(SelectionBar, { count: 2, filteredTotal: 5, noun: "job", onSelectAll: noop, onClear: noop }));
    expect(on).toContain("2 jobs selected");
    expect(on).toContain("Select all 5 filtered");
    expect(on).toContain('role="status"');
    const all = html(createElement(SelectionBar, { count: 5, filteredTotal: 5, noun: "job", onSelectAll: noop, onClear: noop }));
    expect(all).not.toContain("Select all");
    expect(html(createElement(SelectionBar, { count: 1, filteredTotal: 5, noun: "job", onSelectAll: noop, onClear: noop }))).toContain("1 job selected");
  });
  it("state panels: failed is an alert, loading is busy, none shows a number or claims success", () => {
    const f = html(createElement(FailedState, { title: "Could not load", detail: "Offline.", onRetry: noop }));
    expect(f).toContain('role="alert"');
    expect(f).toContain("Try again");
    expect(html(createElement(FailedState, { title: "t", detail: "d" }))).not.toContain("<button");
    const l = html(createElement(LoadingState, { label: "Loading jobs" }));
    expect(l).toContain('aria-busy="true"');
    expect(l).toContain('role="status"');
    expect(html(createElement(EmptyState, { title: "No jobs yet", detail: "Start one." }))).toContain("No jobs yet");
  });
  it("cx drops falsy parts", () => {
    expect(cx("a", false, null, undefined, "b")).toBe("a b");
  });
});

describe("stylesheet rules", () => {
  it("defines every documented token on .tokens", () => {
    const block = css.slice(css.indexOf(".tokens {"), css.indexOf("}", css.indexOf(".tokens {")));
    for (const t of TOKEN_NAMES) expect(block, t).toContain(`${t}:`);
  });
  it("has no global selectors, no :root, no glass (backdrop-filter, blur)", () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/:global|:root|(^|\n)\s*(html|body)\b/);
    expect(rules).not.toMatch(/backdrop-filter|filter:\s*blur|blur\(/);
  });
  it("gradients exist only for the small functional pieces: edge fade, first-column shadow, skeleton shimmer", () => {
    const allowed = [".edgeFade", ".table td:first-child::after", ".skelRow"];
    const lines = css.split("\n").filter((l) => l.includes("gradient("));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(allowed.some((a) => l.includes(a)), l.slice(0, 80)).toBe(true);
  });
  it("uses the three step height scale and a 48 px control hit area", () => {
    expect(css).toContain("--ui-h-sm: 32px");
    expect(css).toContain("--ui-h-md: 40px");
    expect(css).toContain("--ui-h-lg: 48px");
    expect(css).toMatch(/\.sizeSm::after \{ inset: -8px 0; \}/);
    expect(css).toMatch(/\.sizeMd::after \{ inset: -4px 0; \}/);
    expect(css).toMatch(/\.check \{[^}]*width: 48px; height: 48px/);
    expect(css).toMatch(/\.switchRow \{[^}]*min-height: 48px/);
  });
  it("motion is 120 to 200 ms and fully off under prefers-reduced-motion", () => {
    expect(css).toContain("--ui-t-fast: 120ms");
    expect(css).toContain("--ui-t-slow: 200ms");
    const rm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(rm).toContain("animation: none !important");
    expect(rm).toContain("transition: none !important");
    expect(rm).toContain(".dialog::backdrop");
  });
  it("uses Archivo with tabular figures", () => {
    expect(css).toMatch(/--ui-font:[^;]*Archivo/);
    expect(css).toContain('"tnum" 1');
  });
  it("the first table column is sticky and its shadow appears only when scrolled", () => {
    expect(css).toMatch(/\.table th:first-child, \.table td:first-child \{ position: sticky; left: 0;/);
    expect(css).toMatch(/td:first-child::after[^}]*opacity: 0/);
    expect(css).toContain('.tableWrap[data-scrolled="true"]');
    expect(css).toContain('.tableWrap[data-more="true"] .edgeFade');
  });
  it("every file in the folder carries a boundary comment and imports nothing outside it", () => {
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      expect(src, f).toMatch(/BOUNDARY/);
      if (f.endsWith(".ts") || f.endsWith(".tsx")) {
        for (const m of src.matchAll(/from "([^"]+)"/g)) expect(m[1].startsWith(".") || ["react", "react-dom"].includes(m[1]), `${f}: ${m[1]}`).toBe(true);
      }
    }
  });
});

/* ---------------- v2 additions ---------------- */

describe("v2 helpers", () => {
  it("nextSegmentIndex: arrows wrap, skip disabled, Home and End pick the ends, other keys give -1", () => {
    const d = [false, true, false];
    expect(nextSegmentIndex(0, d, "ArrowRight")).toBe(2);
    expect(nextSegmentIndex(0, d, "ArrowDown")).toBe(2);
    expect(nextSegmentIndex(2, d, "ArrowRight")).toBe(0);
    expect(nextSegmentIndex(0, d, "ArrowLeft")).toBe(2);
    expect(nextSegmentIndex(2, d, "ArrowUp")).toBe(0);
    expect(nextSegmentIndex(1, [true, false, false, true], "Home")).toBe(1);
    expect(nextSegmentIndex(1, [true, false, false, true], "End")).toBe(2);
    expect(nextSegmentIndex(0, [true, true], "ArrowRight")).toBe(-1);
    expect(nextSegmentIndex(0, d, "a")).toBe(-1);
  });
  it("tabStopIndex: the selected segment, else the first enabled one", () => {
    expect(tabStopIndex(1, [false, false, false])).toBe(1);
    expect(tabStopIndex(0, [true, false, false])).toBe(1);
    expect(tabStopIndex(-1, [false, false])).toBe(0);
    expect(tabStopIndex(0, [true, true])).toBe(-1);
  });
  it("pickFirstEnabled skips disabled and aria-disabled controls", () => {
    const el = (disabled: boolean, aria?: string) => ({ disabled, getAttribute: (n: string) => (n === "aria-disabled" ? aria ?? null : null) });
    const list = [el(true), el(false, "true"), el(false)];
    expect(pickFirstEnabled(list)).toBe(list[2]);
    expect(pickFirstEnabled([el(true), el(true)])).toBeNull();
    expect(pickFirstEnabled([])).toBeNull();
  });
  it("selectionControls: defaults match v1 (buttons only while something is selected), options widen them", () => {
    expect(selectionControls(0, 5)).toEqual({ showSelectAll: false, showClear: false, clearDisabled: true });
    expect(selectionControls(2, 5)).toEqual({ showSelectAll: true, showClear: true, clearDisabled: false });
    expect(selectionControls(5, 5)).toEqual({ showSelectAll: false, showClear: true, clearDisabled: false });
    expect(selectionControls(0, 5, "always", "always")).toEqual({ showSelectAll: true, showClear: true, clearDisabled: true });
    expect(selectionControls(0, 0, "always", "active").showSelectAll).toBe(false);
    expect(selectionControls(3, 5, "never", "never")).toEqual({ showSelectAll: false, showClear: false, clearDisabled: false });
  });
  it("fieldDescribedBy lists hint then error, or nothing", () => {
    expect(fieldDescribedBy("f", {})).toBeUndefined();
    expect(fieldDescribedBy("f", { hint: true })).toBe("f-hint");
    expect(fieldDescribedBy("f", { hint: true, error: true })).toBe("f-hint f-error");
    expect(fieldDescribedBy("f", { error: true })).toBe("f-error");
  });
  it("toastRegionStyle: no offset keeps the stylesheet position; top moves top, bottom moves bottom", () => {
    expect(toastRegionStyle("top-right")).toBeUndefined();
    expect(toastRegionStyle("top-right", 130)).toEqual({ top: 130 });
    expect(toastRegionStyle("bottom-right", 24)).toEqual({ bottom: 24 });
    expect(toastRegionStyle("bottom-centre", 0)).toEqual({ bottom: 0 });
  });
});

describe("v2 markup and roles", () => {
  const opts = [{ value: "a", label: "Table" }, { value: "b", label: "Cards" }, { value: "c", label: "Board", disabled: true, disabledReason: "Not for your role" }];
  it("SegmentedControl (radio): radiogroup with a name, aria-checked, one tab stop, disabled stays visible", () => {
    const h = html(createElement(SegmentedControl<string>, { label: "View", value: "b", options: opts, onChange: noop }));
    expect(h).toContain('role="radiogroup"');
    expect(h).toContain('aria-label="View"');
    expect(h.match(/role="radio"/g)).toHaveLength(3);
    expect(h.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(h.match(/tabindex="0"/g)).toHaveLength(1);
    expect(h.match(/tabindex="-1"/g)).toHaveLength(2);
    expect(h).toContain('aria-disabled="true"');
    expect(h).toContain('title="Not for your role"');
    expect(h).toContain('type="button"');
    expect(h).toContain("Board");
  });
  it("SegmentedControl: when the selected option is disabled the first enabled one takes the tab stop; a disabled control has none", () => {
    const h = html(createElement(SegmentedControl<string>, { label: "V", value: "c", options: opts, onChange: noop }));
    expect(h.indexOf('tabindex="0"')).toBeLessThan(h.indexOf("Cards"));
    const all = html(createElement(SegmentedControl<string>, { label: "V", value: "a", options: opts, onChange: noop, disabled: true }));
    expect(all).toContain('aria-disabled="true"');
    expect(all).not.toContain('tabindex="0"');
  });
  it("SegmentedControl (tabs): tablist with tab, aria-selected and aria-controls, size sm adds the compact class", () => {
    const h = html(createElement(SegmentedControl<string>, { label: "Sections", kind: "tabs", size: "sm", value: "a", options: [{ value: "a", label: "A", controls: "p-a" }, { value: "b", label: "B", controls: "p-b" }], onChange: noop }));
    expect(h).toContain('role="tablist"');
    expect(h.match(/role="tab"/g)).toHaveLength(2);
    expect(h).toContain('aria-selected="true"');
    expect(h).toContain('aria-controls="p-a"');
    expect(h).not.toContain("aria-checked");
    expect(h).toContain("segSm");
  });
  it("Sheet: native dialog, labelled by its title, header + body + footer, Close optional; nothing rendered while closed", () => {
    const base = { title: "Edit job", footer: createElement("button", { type: "button" }, "Save"), onClose: noop, children: createElement("p", null, "Body text") };
    const on = html(createElement(Sheet, { ...base, open: true, description: "Change the job.", size: "lg" }));
    expect(on).toContain("<dialog");
    expect(on).toContain("aria-labelledby");
    expect(on).toContain("aria-describedby");
    expect(on).toContain("<header");
    expect(on).toContain("<footer");
    expect(on).toContain("Body text");
    expect(on).toContain(">Close<");
    expect(on).toContain("sheet_lg");
    expect(html(createElement(Sheet, { ...base, open: true, closeButton: false }))).not.toContain(">Close<");
    expect(html(createElement(Sheet, { ...base, open: true, dismissible: false }))).not.toContain(">Close<");
    expect(html(createElement(Sheet, { ...base, open: true, closeLabel: "Done" }))).toContain(">Done<");
    const off = html(createElement(Sheet, { ...base, open: false }));
    expect(off).toContain("<dialog");
    expect(off).not.toContain("Body text");
  });
  it("Field wires label, hint and error to the control it holds", () => {
    const h = html(createElement(Field, { label: "Quantity", hint: "Whole numbers.", error: "Must be at least 1.", required: true, children: createElement(Input, { defaultValue: "0" }) }));
    const id = /<label for="([^"]+)"/.exec(h)?.[1];
    expect(id).toBeTruthy();
    expect(h).toContain(`id="${id}"`);
    expect(h).toContain(`aria-describedby="${id}-hint ${id}-error"`);
    expect(h).toContain(`id="${id}-hint"`);
    expect(h).toContain(`id="${id}-error"`);
    expect(h).toContain('aria-invalid="true"');
    expect(h).toContain('aria-required="true"');
    expect(h).toContain("(required)");
    expect(h).toContain("Error: ");
    expect(h).toContain("Must be at least 1.");
  });
  it("Field without hint or error has no aria-describedby or aria-invalid; optional adds the word", () => {
    const h = html(createElement(Field, { label: "Due", optional: true, children: createElement(Input, { type: "date" }) }));
    expect(h).not.toContain("aria-describedby");
    expect(h).not.toContain("aria-invalid");
    expect(h).not.toContain("aria-required");
    expect(h).toContain("(optional)");
  });
  it("Textarea and Select take the same wiring; a native required stays native", () => {
    const t = html(createElement(Field, { label: "Note", error: "Too long.", children: createElement(Textarea, { rows: 3 }) }));
    expect(t).toContain("<textarea");
    expect(t).toContain('aria-invalid="true"');
    const s = html(createElement(Field, { label: "Machine", hint: "Pick one.", children: createElement(Select, { required: true, children: createElement("option", { value: "" }, "Choose") }) }));
    expect(s).toContain("<select");
    expect(s).toContain("aria-describedby");
    expect(s).toMatch(/<select[^>]*required/);
  });
  it("Input, Textarea and Select also work alone: own aria-label, own invalid, no invented ids", () => {
    const i = html(createElement(Input, { "aria-label": "Search", invalid: true }));
    expect(i).toContain('aria-label="Search"');
    expect(i).toContain('aria-invalid="true"');
    expect(i).not.toContain("aria-describedby");
    expect(html(createElement(Input, { "aria-label": "Search", id: "mine" }))).toContain('id="mine"');
    expect(html(createElement(Input, { "aria-label": "Search", "aria-invalid": true }))).toContain('aria-invalid="true"');
  });
  it("StatTile: label, one figure, optional hint and delta words; loading shows a dash and says Loading; no svg or img", () => {
    const h = html(createElement(StatTile, { label: "Late jobs", value: "2", hint: "Past due", delta: "Up 1 on last week", deltaTone: "danger" }));
    expect(h).toContain("Late jobs");
    expect(h).toContain(">2<");
    expect(h).toContain("Past due");
    expect(h).toContain("Up 1 on last week");
    expect(h).not.toMatch(/<svg|<img|<canvas/);
    expect(h).not.toContain("<button");
    const l = html(createElement(StatTile, { label: "Late jobs", value: "2", hint: "Past due", delta: "Up 1", loading: true }));
    expect(l).toContain("—");
    expect(l).toContain("Loading");
    expect(l).toContain('aria-busy="true"');
    expect(l).not.toContain(">2<");
    expect(l).not.toContain("Past due");
  });
  it("StatTile with onPress is a toggle button; a loading one is disabled; StatTiles is a named group", () => {
    const b = html(createElement(StatTile, { label: "Open", value: "7", onPress: noop, pressed: true }));
    expect(b).toContain("<button");
    expect(b).toContain('aria-pressed="true"');
    expect(html(createElement(StatTile, { label: "Open", value: "7", onPress: noop, loading: true }))).toContain("disabled");
    expect(html(createElement(StatTiles, { label: "Figures", columns: 2, children: null }))).toContain('role="group"');
  });
});

describe("v2 backward compatibility of changed APIs", () => {
  it("Dialog without a secondary action is exactly Cancel + primary (two buttons, Cancel outlined)", () => {
    const h = html(createElement(Dialog, { open: true, title: "Pause?", confirmLabel: "Pause", onConfirm: noop, onClose: noop }));
    expect(h.match(/<button/g)).toHaveLength(2);
    expect(h.indexOf("Cancel")).toBeLessThan(h.indexOf("Pause</button>"));
    expect(h).toContain("secondary");
    expect(h).not.toContain("quiet");
  });
  it("Dialog with a secondary action shows Cancel, secondary, primary in that order; a label alone draws nothing extra", () => {
    const h = html(createElement(Dialog, { open: true, title: "Leave?", confirmLabel: "Save and leave", secondaryLabel: "Leave without saving", onSecondary: noop, onConfirm: noop, onClose: noop }));
    expect(h.match(/<button/g)).toHaveLength(3);
    expect(h.indexOf("Cancel")).toBeLessThan(h.indexOf("Leave without saving"));
    expect(h.indexOf("Leave without saving")).toBeLessThan(h.indexOf("Save and leave</button>"));
    const half = html(createElement(Dialog, { open: true, title: "Leave?", confirmLabel: "Save", secondaryLabel: "Other", onConfirm: noop, onClose: noop }));
    expect(half.match(/<button/g)).toHaveLength(2);
    const busy = html(createElement(Dialog, { open: true, title: "t", confirmLabel: "c", secondaryLabel: "s", onSecondary: noop, busy: true, onConfirm: noop, onClose: noop }));
    expect(busy.match(/disabled/g)!.length).toBeGreaterThanOrEqual(3);
  });
  it("StatePanels keep their h3 by default and take headingLevel 2 to 6", () => {
    expect(html(createElement(EmptyState, { title: "No jobs" }))).toContain("<h3");
    expect(html(createElement(FailedState, { title: "Down", detail: "d" }))).toContain("<h3");
    expect(html(createElement(EmptyState, { title: "No jobs", headingLevel: 2 }))).toContain("<h2");
    expect(html(createElement(EmptyState, { title: "No jobs", headingLevel: 2 }))).not.toContain("<h3");
    expect(html(createElement(FailedState, { title: "Down", detail: "d", headingLevel: 4 }))).toContain("<h4");
    expect(html(createElement(FailedState, { title: "Down", detail: "d", headingLevel: 4 }))).toContain('role="alert"');
    expect(html(createElement(LoadingState, { label: "Loading" }))).not.toMatch(/<h[1-6]/);
  });
  it("SelectionBar defaults draw exactly v1; selectAll, clear and statusText change only what they name", () => {
    const idle = html(createElement(SelectionBar, { count: 0, filteredTotal: 5, noun: "job", onSelectAll: noop, onClear: noop }));
    expect(idle).not.toContain("Select all");
    expect(idle).not.toContain("Clear selection");
    const always = html(createElement(SelectionBar, { count: 0, filteredTotal: 5, noun: "job", onSelectAll: noop, onClear: noop, selectAll: "always", clear: "always" }));
    expect(always).toContain("Select all 5 filtered");
    expect(always).toMatch(/Clear selection/);
    expect(always).toMatch(/disabled=""[^>]*>Clear selection|Clear selection<\/button>/);
    expect(always).toContain('data-selection="idle"');
    const txt = html(createElement(SelectionBar, { count: 2, filteredTotal: 5, noun: "job", onSelectAll: noop, onClear: noop, statusText: ({ count, filteredTotal }: { count: number; filteredTotal: number }) => `${count} of ${filteredTotal} ticked` }));
    expect(txt).toContain("2 of 5 ticked");
    expect(txt).not.toContain("2 jobs selected");
    expect(html(createElement(SelectionBar, { count: 2, filteredTotal: 5, noun: "job", onSelectAll: noop, onClear: noop, statusText: "Custom words" }))).toContain("Custom words");
    expect(html(createElement(SelectionBar, { count: 2, filteredTotal: 5, noun: "job", onSelectAll: noop, onClear: noop, selectAll: "never", clear: "never" }))).not.toContain("Select all");
  });
  it("the v1 exports still exist with the same names", async () => {
    const m = await import("@/components/ui/premium");
    for (const n of ["Button", "Switch", "Checkbox", "FilterChip", "ChipGroup", "StatusBadge", "Menu", "Popover", "nextMenuIndex", "placeLayer", "Dialog", "ToastProvider", "useToast", "TOAST_MS", "SelectionBar", "ScrollTable", "scrollEdges", "EmptyState", "LoadingState", "FailedState", "premiumTokens", "tabularNumbers", "srOnly", "TOKEN_NAMES", "cx", "OnDarkContext"]) expect(m, n).toHaveProperty(n);
    expect(m.TOAST_MS).toBe(5000);
  });
});

describe("v2 stylesheet rules", () => {
  it("new tokens live on .tokens and the old names are all still there", () => {
    for (const t of ["--ui-hit: 48px", "--ui-sheet-sm: 520px", "--ui-sheet-md: 680px", "--ui-sheet-lg: 860px", "--ui-toast-top: 76px", "--ui-toast-edge: 16px"]) expect(css).toContain(t);
    expect(TOKEN_NAMES).toContain("--ui-brand");
    expect(TOKEN_NAMES).toContain("--ui-hit");
  });
  it("segmented control: 40 and 32 px tracks, 48 px hit area for both, focus ring, disabled look", () => {
    expect(css).toMatch(/\.seg \{[^}]*min-height: var\(--ui-h-md\)/); // v3: min-height so a wrapped track can grow (was height)
    expect(css).toMatch(/\.segSm \{ height: auto; min-height: var\(--ui-h-sm\)/); // v3: min-height so a wrapped track can grow (was height)
    expect(css).toMatch(/\.segBtn \{[^}]*height: 32px/);
    expect(css).toMatch(/\.segBtn::after \{ content: ""; position: absolute; inset: -8px -1px; \}/);
    expect(css).toMatch(/\.segSm \.segBtn \{ height: 24px/);
    expect(css).toMatch(/\.segSm \.segBtn::after \{ inset: -12px -1px; \}/);
    expect(css).toContain(".segBtn:focus-visible");
    expect(css).toContain('.segBtn[aria-disabled="true"]');
  });
  it("form fields: 48 px box (40 px visible via a 4 px transparent border), error, disabled and focus states, no outer overflow", () => {
    expect(css).toMatch(/\.input \{[^}]*height: var\(--ui-hit\)/);
    expect(css).toMatch(/\.input \{[^}]*border-block-width: 4px/);
    expect(css).toMatch(/\.input \{[^}]*background-clip: padding-box/);
    expect(css).toMatch(/\.input \{[^}]*width: 100%/);
    expect(css).toContain('.input[aria-invalid="true"]');
    expect(css).toContain(".input:disabled");
    expect(css).toContain(".input:focus-visible");
    expect(css).toContain(".fieldError");
  });
  it("sheet: three widths from tokens, the body scrolls on its own, footer and header are fixed, backdrop animation is off under reduced motion", () => {
    expect(css).toMatch(/\.sheet_lg \{ width: min\(var\(--ui-sheet-lg\)/);
    expect(css).toMatch(/\.sheetBody \{[^}]*overflow-y: auto/);
    expect(css).toMatch(/\.sheet \{[^}]*overflow: hidden/);
    const rm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(rm).toContain(".sheet::backdrop");
    expect(rm).toContain(".segBtn:active");
  });
  it("stat tile: tabular figure, no chart or icon styling, loading and pressed states", () => {
    expect(css).toContain(".tileValue");
    expect(css).toContain('.tilePress[aria-pressed="true"]');
    expect(css).toContain(".tileDelta_danger");
    expect(css).not.toMatch(/sparkline|\.chart/);
  });
  it("toast placement classes exist and the default stays top 76 px right 16 px", () => {
    expect(css).toMatch(/\.toastRegion \{[^}]*top: var\(--ui-toast-top\); right: var\(--ui-toast-edge\)/);
    expect(css).toContain(".toastBottom");
    expect(css).toContain(".toastLeft");
    expect(css).toContain(".toastCentre");
  });
  it("v2 adds no gradients, no glass and no global selectors (the rules above still hold)", () => {
    const added = css.slice(css.indexOf("segmented control: one choice"));
    expect(added).not.toMatch(/gradient\(|backdrop-filter|blur\(|:root|:global/);
  });
});

/* ---------------- v3 additions ---------------- */

const cssAfter = (marker: string) => css.slice(css.indexOf(marker));
const v3css = cssAfter("v3 additions. Everything below");

describe("v3 helpers", () => {
  it("rangeError: only From after To is an error; empty ends and equal dates are fine; custom names are used", () => {
    expect(rangeError("2026-11-10", "2026-11-01")).toBe("From must be on or before To.");
    expect(rangeError("2026-11-01", "2026-11-01")).toBeUndefined();
    expect(rangeError("", "2026-11-01")).toBeUndefined();
    expect(rangeError("2026-11-10", "")).toBeUndefined();
    expect(rangeError("2026-12-01", "2026-11-01", { from: "Start", to: "End" })).toBe("Start must be on or before End.");
  });
  it("pickInvalidTarget: the first control that exists and is enabled, in the order given", () => {
    expect(pickInvalidTarget([null, { disabled: true }, { disabled: false, n: 3 }, { n: 4 }])).toEqual({ disabled: false, n: 3 });
    expect(pickInvalidTarget([null, { disabled: true }])).toBeNull();
    expect(pickInvalidTarget([])).toBeNull();
  });
  it("calloutLead: the tone's word, none for neutral, an explicit lead (even empty) wins", () => {
    expect(calloutLead("info")).toBe("Note");
    expect(calloutLead("warn")).toBe("Warning");
    expect(calloutLead("error")).toBe("Problem");
    expect(calloutLead("neutral")).toBe("");
    expect(calloutLead("warn", "Heads up")).toBe("Heads up");
    expect(calloutLead("error", "")).toBe("");
  });
  it("dataAttributes keeps only data-* strings, numbers and booleans", () => {
    expect(dataAttributes({ "data-testid": "a", "data-n": 2, "data-b": true, label: "x", "data-o": {}, onChange: noop })).toEqual({ "data-testid": "a", "data-n": 2, "data-b": true });
  });
  it("rowClickIsForRow: a click on plain cell text is for the row, a click on a control inside the row is not", () => {
    const row = { contains: (n: unknown) => n === btn || n === link } as unknown as Element;
    const btn = {}; const link = {};
    const target = (control: unknown) => ({ closest: () => control });
    expect(rowClickIsForRow(target(null) as unknown as EventTarget, row)).toBe(true);
    expect(rowClickIsForRow(target(btn) as unknown as EventTarget, row)).toBe(false);
    expect(rowClickIsForRow(target(link) as unknown as EventTarget, row)).toBe(false);
    expect(rowClickIsForRow(target({}) as unknown as EventTarget, row)).toBe(true); // a control outside this row (nested table, portal) does not count
    expect(rowClickIsForRow(null, row)).toBe(true);
  });
});

describe("v3 markup and roles", () => {
  it("Button: danger variants use their own class, fullWidth adds the block class, defaults are unchanged", () => {
    const d = html(createElement(Button, { variant: "danger" }, "Delete"));
    expect(d).toContain("danger");
    expect(d).toContain('type="button"');
    expect(html(createElement(Button, { variant: "dangerSolid" }, "Delete"))).toContain("dangerSolid");
    expect(html(createElement(Button, { variant: "dangerQuiet" }, "Delete"))).toContain("dangerQuiet");
    expect(html(createElement(Button, { fullWidth: true, size: "lg", variant: "primary" }, "Save"))).toContain("btnBlock");
    const plain = html(createElement(Button, null, "Plain"));
    expect(plain).toContain("secondary");
    expect(plain).not.toMatch(/btnBlock|danger/);
    expect(html(createElement(Button, { "aria-pressed": true, variant: "secondary" }, "Compact"))).toContain('aria-pressed="true"');
  });
  it("Menu: the trigger takes aria-label, fullWidth and className; without them it is the v2 trigger", () => {
    const h = html(createElement(Menu, { label: "More", "aria-label": "More actions for Tomas", fullWidth: true, className: "mine", items: [{ id: "a", label: "Edit", onSelect: noop }] }));
    expect(h).toContain('aria-label="More actions for Tomas"');
    expect(h).toContain("menuBlock");
    expect(h).toContain("btnBlock");
    expect(h).toContain("mine");
    expect(h).toContain('aria-haspopup="menu"');
    const v2 = html(createElement(Menu, { label: "Export", items: [] }));
    expect(v2).not.toContain("aria-label");
    expect(v2).not.toContain("btnBlock");
  });
  it("ScrollTable: dense and pinLast are opt in; the default output has neither", () => {
    const plain = html(createElement(ScrollTable, { label: "Jobs", children: createElement("tbody") }));
    expect(plain).not.toContain("data-pin-last");
    expect(plain).not.toContain("tableDense");
    const on = html(createElement(ScrollTable, { label: "Jobs", dense: true, pinLast: true, children: createElement("tbody") }));
    expect(on).toContain('data-pin-last="true"');
    expect(on).toContain("tableDense");
    expect(on).toContain('role="region"');
    expect(on).toContain('aria-label="Jobs"');
  });
  it("Panel: a section named by a heading whose level you choose (default h2); no title, no heading", () => {
    const h = html(createElement(Panel, { title: "Lines", headingLevel: 3, actions: createElement("button", { type: "button" }, "Add"), children: "Body" }));
    expect(h).toContain("<section");
    expect(h).toMatch(/<h3[^>]*>Lines<\/h3>/);
    expect(h).toContain("aria-labelledby");
    expect(h).toContain(">Add<");
    expect(html(createElement(Panel, { title: "T", children: "x" }))).toContain("<h2");
    const none = html(createElement(Panel, { children: "x" }));
    expect(none).not.toMatch(/<h[1-6]/);
    expect(none).not.toContain("aria-labelledby");
    expect(html(createElement(Panel, { title: "T", bare: true, children: "x" }))).toContain("panelBare");
    const named = html(createElement(Panel, { label: "Filters", busy: true, children: "x" }));
    expect(named).toContain('aria-label="Filters"');
    expect(named).toContain('aria-busy="true"');
    expect(html(createElement(Panel, { title: "T", label: "Ignored", children: "x" }))).not.toContain("Ignored");
  });
  it("Callout: words as well as a bar; error is an alert, others are not live unless asked; no icon", () => {
    const e = html(createElement(Callout, { tone: "error", children: "Quantity must be at least 1." }));
    expect(e).toContain('role="alert"');
    expect(e).toContain("Problem: ");
    expect(e).toContain("callout_error");
    expect(e).not.toMatch(/<svg|<img/);
    const w = html(createElement(Callout, { tone: "warn", children: "Paused" }));
    expect(w).toContain("Warning: ");
    expect(w).not.toContain("role=");
    expect(html(createElement(Callout, { tone: "warn", role: "status", children: "Paused" }))).toContain('role="status"');
    expect(html(createElement(Callout, { tone: "neutral", children: "Quiet" }))).not.toContain("<strong");
    expect(html(createElement(Callout, { children: "Default is info" }))).toContain("Note: ");
    expect(html(createElement(Callout, { tone: "info", action: createElement("button", { type: "button" }, "Show all"), children: "x" }))).toContain(">Show all<");
  });
  it("Disclosure is the native details and summary, closed by default, open with defaultOpen", () => {
    const c = html(createElement(Disclosure, { summary: "More detail", children: "Inside" }));
    expect(c).toContain("<details");
    expect(c).toContain("<summary");
    expect(c).not.toMatch(/<details[^>]*\sopen/);
    expect(html(createElement(Disclosure, { summary: "More detail", defaultOpen: true, children: "Inside" }))).toMatch(/<details[^>]*\sopen/);
    expect(c).toContain('aria-hidden="true"');
  });
  it("List and ListRow: a list of items; href makes the title a link; trailing and meta are optional", () => {
    const h = html(createElement(List, { label: "Customers", children: [
      createElement(ListRow, { key: "a", title: "Hartley", meta: "3 jobs", href: "/customers/1", trailing: createElement("button", { type: "button" }, "Edit") }),
      createElement(ListRow, { key: "b", title: "Calder" }),
    ] }));
    expect(h).toContain("<ul");
    expect(h).toContain('aria-label="Customers"');
    expect(h.match(/<li/g)).toHaveLength(2);
    expect(h).toContain('href="/customers/1"');
    expect(h.match(/<a /g)).toHaveLength(1);
    expect(h).toContain("3 jobs");
    expect(h).toContain(">Edit<");
  });
  it("FormGroup: role=group named by a heading, or a fieldset with a legend; the hint is its description", () => {
    const g = html(createElement(FormGroup, { title: "Job details", hint: "What and for whom.", children: "fields" }));
    expect(g).toContain('role="group"');
    expect(g).toMatch(/<h3[^>]*>Job details<\/h3>/);
    expect(g).toContain("aria-labelledby");
    expect(g).toContain("aria-describedby");
    const f = html(createElement(FormGroup, { title: "Dates", as: "fieldset", headingLevel: 4, children: "fields" }));
    expect(f).toContain("<fieldset");
    expect(f).toContain("<legend");
    expect(f).not.toContain("<h4");
    expect(html(createElement(FormGroup, { title: "G", headingLevel: 2, children: "x" }))).toContain("<h2");
  });
  it("ErrorSummary: a named section listing each problem as a link to its field; nothing when there are none", () => {
    const h = html(createElement(ErrorSummary, { errors: [{ fieldId: "g-name", label: "Job name", message: "Enter a job name." }, { fieldId: "g-qty", message: "Quantity must be at least 1." }] }));
    expect(h).toContain("<section");
    expect(h).toContain("aria-labelledby");
    expect(h).toContain("Fix these before saving");
    expect(h).toContain('href="#g-name"');
    expect(h).toContain('href="#g-qty"');
    expect(h).toContain("Job name");
    expect(h).toContain("Enter a job name.");
    expect(h.match(/<li/g)).toHaveLength(2);
    expect(html(createElement(ErrorSummary, { errors: [] }))).toBe("");
    expect(html(createElement(ErrorSummary, { errors: [{ fieldId: "x", message: "m" }], headingLevel: 2, title: "Problems" }))).toMatch(/<h2[^>]*>Problems<\/h2>/);
  });
  it("DateRangeGroup: From, To and Apply in a named group; From after To marks both inputs invalid with one described error; no error otherwise", () => {
    const base = { label: "Report period", onFromChange: noop, onToChange: noop, onApply: noop };
    const bad = html(createElement(DateRangeGroup, { ...base, from: "2026-11-10", to: "2026-11-01" }));
    expect(bad).toContain('role="group"');
    expect(bad).toContain('aria-label="Report period"');
    expect(bad.match(/type="date"/g)).toHaveLength(2);
    expect(bad.match(/aria-invalid="true"/g)).toHaveLength(2);
    const errId = /aria-describedby="([^"]+)"/.exec(bad)?.[1];
    expect(errId).toBeTruthy();
    expect(bad.match(new RegExp(`aria-describedby="${errId}"`, "g"))).toHaveLength(2);
    expect(bad).toContain(`id="${errId}"`);
    expect(bad).toContain("From must be on or before To.");
    expect(bad).toContain(">Apply<");
    const ok = html(createElement(DateRangeGroup, { ...base, from: "2026-11-01", to: "2026-11-10", applyLabel: "Show" }));
    expect(ok).not.toContain("aria-invalid");
    expect(ok).not.toContain("aria-describedby");
    expect(ok).toContain(">Show<");
    expect(html(createElement(DateRangeGroup, { ...base, from: "2026-11-01", to: "2026-11-10", error: "The server refused this range." }))).toContain("The server refused this range.");
  });
  it("StatTile v3: href makes a link, status is dot plus word, definition is a title and a described-by text; no new props = v2 markup", () => {
    const h = html(createElement(StatTile, { label: "Needs attention", value: "3", href: "/jobs?filter=late", status: "Act now", statusTone: "danger", definition: "Jobs past their due date." }));
    expect(h).toContain("<a ");
    expect(h).toContain('href="/jobs?filter=late"');
    expect(h).toContain('title="Jobs past their due date."');
    expect(h).toMatch(/aria-describedby="([^"]+)"/);
    const id = /aria-describedby="([^"]+)"/.exec(h)![1];
    expect(h).toContain(`id="${id}"`);
    expect(h).toContain("Act now");
    expect(h).not.toContain("<button");
    const v2 = html(createElement(StatTile, { label: "Open", value: "7" }));
    expect(v2).not.toContain("title=");
    expect(v2).not.toContain("aria-describedby");
    expect(v2).not.toContain("<a ");
    const dot = html(createElement(StatTile, { label: createElement("span", { className: "dot" }, "•"), value: "4" }));
    expect(dot).toContain("dot");
  });
  it("Switch passes every data-* attribute to the button and still shows state in words", () => {
    const h = html(createElement(Switch, { checked: true, onChange: noop, label: "Machine", "data-testid": "sw", "data-col": "machine" }));
    expect(h).toContain('data-testid="sw"');
    expect(h).toContain('data-col="machine"');
    expect(h).toContain('role="switch"');
    expect(h).toContain(">On<");
  });
  it("Field v3: own id, and large puts the large class on Input, Select and Textarea; without it nothing changes", () => {
    const own = html(createElement(Field, { label: "Name", id: "g-name", children: createElement(Input, null) }));
    expect(own).toContain('for="g-name"');
    expect(own).toContain('id="g-name"');
    const big = html(createElement(Field, { label: "Name", large: true, children: createElement(Input, null) }));
    expect(big).toContain("inputLg");
    expect(html(createElement(Input, { large: true, "aria-label": "x" }))).toContain("inputLg");
    expect(html(createElement(Select, { large: true, "aria-label": "x" }))).toContain("inputLg");
    expect(html(createElement(Textarea, { large: true, "aria-label": "x" }))).toContain("inputLg");
    expect(html(createElement(Field, { label: "Name", children: createElement(Input, null) }))).not.toContain("inputLg");
  });
  it("EmptyState compact adds the compact class and nothing else; the default stays h3 and uncompacted", () => {
    expect(html(createElement(EmptyState, { title: "None", compact: true }))).toContain("stateCompact");
    const d = html(createElement(EmptyState, { title: "None" }));
    expect(d).not.toContain("stateCompact");
    expect(d).toContain("<h3");
  });
});

describe("v3 stylesheet rules", () => {
  it("v3 CSS has no gradients, no glass, no global selectors and no !important outside the reduced-motion block", () => {
    const body = v3css.slice(0, v3css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(body).not.toMatch(/gradient\(|backdrop-filter|blur\(|:root|:global/);
    expect(body).not.toContain("!important");
  });
  it("danger: three classes with hover, active and a red that keeps 4.5:1 on white (#b32d2d)", () => {
    for (const c of [".danger ", ".dangerSolid ", ".dangerQuiet "]) expect(v3css).toContain(c);
    expect(v3css).toContain(".danger:hover");
    expect(v3css).toContain(".dangerSolid:hover");
    expect(v3css).toContain("--ui-danger");
  });
  it("pressed buttons are styled by the stylesheet with a selector heavier than the hover rules (no !important for consumers)", () => {
    expect(v3css).toContain('.btn[aria-pressed="true"]:is(.secondary, .quiet)');
    expect(v3css).toContain('.btn[aria-pressed="true"]:is(.secondary, .quiet):hover:not([disabled])'); // v4: the hover half sits in the hover-gated block
    expect(v3css).toContain('.btn[aria-pressed="true"]:is(.secondary, .quiet):active:not([disabled])');
    expect(v3css).toContain(".onDark.btn[aria-pressed=");
  });
  it("hit areas: chips 48 with 16 px wrapped gap, segmented rows 16 px apart and no scroll box, selection bar rows 16 px apart", () => {
    expect(css).toMatch(/\.chips \{[^}]*gap: 16px 6px/);
    expect(css).toMatch(/\.chip::after \{ content: ""; position: absolute; inset: -8px 0; \}/);
    expect(css).toMatch(/\.seg \{[^}]*flex-wrap: wrap[^}]*gap: 16px 2px/);
    expect(css).not.toMatch(/\.seg \{ overflow-x/);
    expect(css).not.toMatch(/max-width: 640px\) \{ \.seg/);
    expect(css).toMatch(/\.bar \{[^}]*gap: 16px 10px/);
    expect(css).toMatch(/\.barActions \{[^}]*gap: 16px 8px/);
  });
  it("the Switch hit area does not reach past its row (it made the page scroll 2 px sideways at 390 px)", () => {
    expect(css).toMatch(/\.switch::after \{ content: ""; position: absolute; inset: -12px 0; \}/);
    expect(css).not.toContain("inset: -12px -4px");
  });
  it("tables: dense, totals row, clickable rows, record groups, pinned last column with a shadow that shows only while more is hidden, colspan cells never draw the first-column shadow", () => {
    expect(v3css).toContain(".tableDense td");
    expect(v3css).toContain(".table tfoot td");
    expect(v3css).toContain('tr[data-clickable="true"]');
    expect(v3css).toContain('tbody[data-record="true"]');
    expect(v3css).toContain('tr[data-sub="true"]');
    expect(v3css).toMatch(/\.table td\[colspan\]:first-child::after[^}]*content: none/);
    expect(v3css).toMatch(/tr\[data-sub="true"\] td\[colspan\] > \* \{ position: sticky; left: 14px; max-width: calc\(var\(--ui-scroll-w, 100%\) - 28px\)/);
    expect(v3css).toMatch(/data-pin-last="true"\] \.table :is\(th, td\):last-child:not\(\[colspan\]\) \{ position: sticky; right: 0;/);
    expect(v3css).toMatch(/data-pin-last="true"\]\[data-more="true"\][^{]*::before \{ opacity: 1; \}/);
    expect(v3css).toMatch(/data-pin-last="true"\] \.edgeFade \{ display: none; \}/);
  });
  it("new surfaces exist: panel, callout tones with a left bar, disclosure, list rows, form group, error summary, range, link tile, large field, compact state", () => {
    expect(v3css).toContain(".panelBare.panelNoTitle .panelBody { padding: 0; }"); // an untitled bare panel has no padding at all
    for (const c of [".panel ", ".panelHead", ".callout_neutral", ".callout_info", ".callout_warn", ".callout_error", "inset 3px 0 0 var(--tone-bar)", ".discSummary", ".discChevron", ".listRow", ".rowLink::after", ".group ", ".errLink", ".range ", ".tileLink", ".tileStatus", ".inputLg", ".stateCompact"]) expect(v3css, c).toContain(c);
    expect(v3css).toMatch(/\.discSummary \{[^}]*min-height: 48px/);
    expect(v3css).toMatch(/\.errLink \{[^}]*min-height: 48px/);
    expect(v3css).toMatch(/\.inputLg \{[^}]*height: var\(--ui-h-lg\)[^}]*border-block-width: 0[^}]*font-size: 16px/);
    expect(v3css).toMatch(/\.stateCompact \{ min-height: 0;/);
  });
  it("reduced motion also stops the disclosure chevron and row transitions", () => {
    const rm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(rm).toContain(".discChevron");
    expect(rm).toContain("transition: none !important");
  });
});

describe("v3 nesting and focus (source level: the browser run proves the behaviour)", () => {
  const sheet = fs.readFileSync(path.join(dir, "Sheet.tsx"), "utf8");
  const dialog = fs.readFileSync(path.join(dir, "Dialog.tsx"), "utf8");
  it("Sheet and Dialog act only on their own cancel and Tab events, and trap only their own controls", () => {
    for (const src of [sheet, dialog]) {
      expect(src).toContain("e.target !== e.currentTarget");
      expect(src).toContain('closest("dialog") !== self');
      expect(src).toContain('el.closest("dialog") === self');
    }
  });
  it("the v3 exports exist and no v1 or v2 name went away", async () => {
    const m = await import("@/components/ui/premium");
    for (const n of ["Panel", "Callout", "Disclosure", "List", "ListRow", "FormGroup", "ErrorSummary", "DateRangeGroup", "focusFirstInvalid", "pickInvalidTarget", "rangeError", "rowClickIsForRow", "dataAttributes", "calloutLead",
      "SegmentedControl", "Sheet", "Field", "Input", "Textarea", "Select", "StatTile", "StatTiles", "fieldDescribedBy", "nextSegmentIndex", "tabStopIndex", "pickFirstEnabled", "selectionControls", "toastRegionStyle"]) expect(m, n).toHaveProperty(n);
  });
  it("every v3 file carries a boundary comment", () => {
    for (const f of ["Surface.tsx", "Disclosure.tsx", "List.tsx", "FormParts.tsx"]) expect(fs.readFileSync(path.join(dir, f), "utf8"), f).toMatch(/BOUNDARY/);
  });
});

/* ---------------- v4 additions (craft pass) ---------------- */

const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Splits a stylesheet into its top-level statements (rules and at-rules) by brace depth. */
function topLevel(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { out.push(src.slice(start, i + 1).trim()); start = i + 1; } }
  }
  return out.filter(Boolean);
}
const GATE = "@media (hover: hover) and (pointer: fine)";

describe("v4 motion rules (scanned from premium.module.css)", () => {
  it("no `transition: all` anywhere", () => {
    expect(rules).not.toMatch(/transition(-property)?:\s*all\b/);
  });
  it("no ease-in curve (ease-out and ease-in-out only), and the two custom curves are tokens", () => {
    expect(rules).not.toMatch(/\bease-in\b(?!-out)/);
    expect(rules).not.toMatch(/cubic-bezier\(\s*0?\.4\d*\s*,\s*0\s*,\s*1\s*,\s*1\s*\)/);
    expect(css).toContain("--ui-ease-out: cubic-bezier(0.23, 1, 0.32, 1)");
    expect(css).toContain("--ui-ease-in-out: cubic-bezier(0.77, 0, 0.175, 1)");
    expect(css).toMatch(/--ui-ease: var\(--ui-ease-out\)/);
  });
  it("nothing scales from zero (entrances start at 0.95, presses are 0.97)", () => {
    expect(rules).not.toMatch(/scale\(\s*0\s*[,)]/);
    expect(rules).not.toMatch(/scale\(\s*0?\.[0-4]\d*\s*[,)]/); // nothing below 0.5 (0.95 for layers, 0.6 for the check mark)
    expect(css).toContain("--ui-press: 0.97");
  });
  it("every :hover rule sits inside @media (hover: hover) and (pointer: fine)", () => {
    const bad: string[] = [];
    for (const st of topLevel(rules)) {
      if (st.startsWith(GATE)) continue;
      if (st.includes(":hover")) bad.push(st.slice(0, 90));
    }
    expect(bad).toEqual([]);
    expect(topLevel(rules).filter((st) => st.startsWith(GATE)).length).toBeGreaterThan(10);
  });
  it("UI durations are 120 to 200 ms (dialog 200, sheet 240), exits 120, and only the spinner and the skeleton run longer", () => {
    for (const m of ["--ui-t-fast: 120ms", "--ui-t-base: 160ms", "--ui-t-slow: 200ms", "--ui-t-sheet: 240ms", "--ui-t-exit: 120ms"]) expect(css).toContain(m);
    for (const line of rules.split("\n")) {
      if (line.includes("infinite")) continue; // busyDot (700 ms spin) and skelRow (1.4 s shimmer) are functional loops
      for (const m of line.matchAll(/(\d+(?:\.\d+)?)(ms|s)\b/g)) {
        const ms = m[2] === "s" ? Number(m[1]) * 1000 : Number(m[1]);
        expect(ms, line.trim().slice(0, 80)).toBeLessThanOrEqual(240);
      }
    }
    expect(EXIT_MS).toBe(120);
  });
  it("press feedback is a scale on buttons, chips, switch rows, segments and tiles", () => {
    for (const re of [/\.btn:active \{ transform: scale\(var\(--ui-press\)\)/, /\.chip:active:not\(\[disabled\]\) \{ transform: scale\(var\(--ui-press\)\)/, /\.switchRow:active:not\(\[data-disabled="true"\]\) \.switch \{ transform: scale\(var\(--ui-press\)\)/,
      /\.segBtn:active:not\(\[aria-disabled="true"\]\):not\(\[disabled\]\) \{ transform: scale\(var\(--ui-press\)\)/, /\.tilePress:active:not\(\[disabled\]\) \{ transform: scale\(var\(--ui-press-lg\)\)/]) expect(css).toMatch(re);
  });
  it("layers, dialog, sheet and toast animate by transition with a closed state (not keyframes), centred modals, 0.95 entrance, faster exit", () => {
    for (const sel of [".layer", ".dialog", ".sheet", ".toast"]) {
      expect(css, sel).toContain(`${sel}[data-state="closed"]`);
    }
    expect(css).toMatch(/\.layer\[data-state="closed"\] \{ opacity: 0; transform: scale\(0\.95\)/);
    expect(css).toMatch(/\.dialog\[data-state="closed"\] \{ opacity: 0; transform: scale\(0\.95\); transition-duration: var\(--ui-t-exit\)/);
    expect(css).toMatch(/\.sheet\[data-state="closed"\] \{ opacity: 0; transform: scale\(0\.95\); transition-duration: var\(--ui-t-exit\)/);
    expect(css).toContain('.layer[data-instant="true"] { transition: none; }'); // keyboard open: no animation
    expect(css).toMatch(/\.layer \{[^}]*transform-origin: var\(--origin-x, 0px\) var\(--origin-y, 0%\)/);
    expect(rules).not.toMatch(/@keyframes (layerIn|dialogIn|sheetIn|toastIn|toastInUp|fadeIn)/);
    expect(css).toMatch(/\.dialog \{[^}]*inset: 0; margin: auto/);
    expect(css).toMatch(/\.sheet \{[^}]*inset: 0; margin: auto/);
  });
  it("reduced motion removes movement and keeps only a short opacity fade on the layers", () => {
    const rm = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(rm).toContain("animation: none !important");
    expect(rm).toMatch(/\.layer, \.dialog, \.sheet, \.toast[^{]*\{ transform: none !important; transition: opacity var\(--ui-t-exit\) linear !important; \}/);
    expect(rm).toContain(".switchRow:active .switch");
    expect(rm).toContain(".tabBar");
  });
  it("the presence hooks and layers carry the state the CSS needs", () => {
    const layer = fs.readFileSync(path.join(dir, "useAnchoredLayer.tsx"), "utf8");
    const menu = fs.readFileSync(path.join(dir, "Menu.tsx"), "utf8");
    expect(layer).toContain("usePresence");
    expect(menu).toContain('data-state={state}');
    expect(menu).toContain("e.detail === 0"); // a keyboard click has detail 0: no animation
    const dialog = fs.readFileSync(path.join(dir, "Dialog.tsx"), "utf8");
    expect(dialog).toContain("useModalPresence");
    expect(dialog).toContain("data-state={state}");
    expect(fs.readFileSync(path.join(dir, "Toast.tsx"), "utf8")).toContain("data-state=");
  });
});

describe("v4 type scale", () => {
  const block = css.slice(css.indexOf(".tokens {"), css.indexOf("}", css.indexOf(".tokens {")));
  it("defines the nine styles with size, line height and weight tokens", () => {
    for (const t of ["--ui-fs-page: 26px", "--ui-lh-page: 32px", "--ui-fw-page: 650", "--ui-fs-section: 18px", "--ui-fw-section: 600", "--ui-fs-card: 15px", "--ui-lh-card: 22px", "--ui-fw-card: 600",
      "--ui-fs-label: 13px", "--ui-fs-body: 14px", "--ui-lh-body: 20px", "--ui-fw-body: 400", "--ui-fs-secondary: 13px", "--ui-fw-secondary: 400", "--ui-fs-caption: 12px", "--ui-fw-caption: 500",
      "--ui-fs-thead: 12px", "--ui-fw-thead: 600", "--ui-ls-thead: 0.04em", "--ui-fs-numeral: 28px", "--ui-fw-numeral: 600", "--ui-fw-name: 600"]) expect(block, t).toContain(t);
  });
  it("body and secondary text are never under 13 px; 12 px is only the table header, caption and badge styles", () => {
    expect(css).not.toMatch(/font-size: 1[01](\.\d+)?px/);
    expect(css).not.toMatch(/font-size: 12\.5px/);
    const lines = rules.split("\n").filter((l) => /font-size: (12px|var\(--ui-fs-caption\)|var\(--ui-fs-thead\))/.test(l));
    const allowed = [".tCaption", ".tTableHead", ".badge ", ".switchState", ".menuHint", ".table th", ".pbar", "--ui-fs-caption", "--ui-fs-thead"];
    for (const l of lines) expect(allowed.some((a) => l.includes(a)), l.trim().slice(0, 80)).toBe(true);
  });
  it("table headers are 12 px uppercase, tracked, weight 600; body cells are weight 400; a row header is a plain name", () => {
    expect(css).toMatch(/\.table th \{[^}]*font-size: var\(--ui-fs-thead\)[^}]*text-transform: uppercase[^}]*\}/);
    expect(css).toMatch(/\.table th \{[^}]*letter-spacing: var\(--ui-ls-thead\)/);
    expect(css).toMatch(/\.table \{[^}]*font-weight: 400/);
    expect(css).toMatch(/\.table :is\(tbody, tfoot\) th \{[^}]*text-transform: none/);
  });
  it("is applied across the components: titles use the section, card and name tokens, hints the secondary token, the KPI the numeral token", () => {
    for (const re of [/\.panelTitle \{[^}]*var\(--ui-fs-card\)[^}]*var\(--ui-fw-card\)/, /\.dialogTitle \{[^}]*var\(--ui-fs-section\)/, /\.sheetTitle \{[^}]*var\(--ui-fs-section\)/, /\.stateTitle \{[^}]*var\(--ui-fs-card\)/,
      /\.tileValue \{[^}]*var\(--ui-fs-numeral\)[^}]*var\(--ui-fw-numeral\)/, /\.fieldLabel \{[^}]*var\(--ui-fs-label\)/, /\.fieldHint \{[^}]*var\(--ui-fs-secondary\)/, /\.rowTitle \{[^}]*var\(--ui-fw-name\)/,
      /\.callout \{[^}]*var\(--ui-fs-body\)/, /\.phTitle \{[^}]*var\(--ui-fs-page\)/]) expect(css).toMatch(re);
  });
  it("the classes are exported for a screen's own text, and the page size shrinks under 640 px", () => {
    for (const k of ["page", "section", "card", "label", "body", "name", "secondary", "caption", "tableHead", "numeral"] as const) expect(typeof typeScale[k], k).toBe("string");
    expect(css).toMatch(/@media \(max-width: 640px\) \{ \.tokens \{ --ui-fs-page: 22px/);
  });
});

describe("v4 font tokens", () => {
  it("the family is defined once in the tokens: --ui-font (Archivo by default), --ui-font-heading and --ui-font-numeric follow it, each with an optional override variable", () => {
    expect(css).toMatch(/--ui-font: var\(--ui-font-override, var\(--font-archivo, "Archivo"/);
    expect(css).toContain("--ui-font-heading: var(--ui-font-heading-override, var(--ui-font));");
    expect(css).toContain("--ui-font-numeric: var(--ui-font-numeric-override, var(--ui-font));");
    expect(css).toContain('--ui-numeric-features: "tnum" 1, "lnum" 1;');
    for (const t of ["--ui-font-heading", "--ui-font-numeric", "--ui-numeric-features"]) expect(TOKEN_NAMES).toContain(t);
  });
  it("no component names a font family of its own: every font-family comes from a token", () => {
    const fams = rules.split("\n").filter((l) => /font-family:/.test(l) && !/^\s*--ui-font/.test(l));
    for (const l of fams) expect(l, l.trim().slice(0, 80)).toMatch(/font-family: var\(--ui-font(-heading|-numeric)?\)/);
    expect(fams.length).toBeGreaterThan(8);
  });
  it("numerals use the numeric font and the shared tabular feature setting; titles use the heading font", () => {
    expect(css).toMatch(/\.num \{ font-family: var\(--ui-font-numeric\)[^}]*var\(--ui-numeric-features\)/);
    expect(css).toMatch(/\.tileValue \{ font-family: var\(--ui-font-numeric\)/);
    expect(css).toMatch(/\.phTitle \{ font-family: var\(--ui-font-heading\)/);
    expect(css).toMatch(/\.dialogTitle \{ font-family: var\(--ui-font-heading\)/);
  });
});

describe("v4 elevation", () => {
  it("defines four levels with a soft shadow and an inner highlight (flat has the hairline only)", () => {
    for (const t of ["--ui-elev-flat:", "--ui-elev-raised:", "--ui-elev-overlay:", "--ui-elev-modal:"]) expect(css).toContain(t);
    expect(css).toMatch(/--ui-elev-raised:[^;]*inset 0 1px 0 rgba\(255, 255, 255/);
    expect(css).toMatch(/--ui-elev-flat: 0 0 0 1px var\(--ui-line\);/);
  });
  it("applies them consistently: cards raised, menus and toasts overlay, dialogs and sheets modal", () => {
    for (const re of [/\.panel \{[^}]*var\(--ui-elev-raised\)/, /\.tile \{[^}]*var\(--ui-elev-raised\)/, /\.tableWrap \{[^}]*var\(--ui-elev-raised\)/, /\.list \{[^}]*var\(--ui-elev-raised\)/, /\.state \{[^}]*var\(--ui-elev-raised\)/,
      /\.layer \{[^}]*var\(--ui-elev-overlay\)/, /\.toast \{[^}]*var\(--ui-elev-overlay\)/, /\.dialog \{[^}]*var\(--ui-elev-modal\)/, /\.sheet \{[^}]*var\(--ui-elev-modal\)/]) expect(css).toMatch(re);
  });
  it("Panel: raised by default, flat or nested by prop; nested is no card (no background, no shadow beyond the hairline above)", () => {
    const raised = html(createElement(Panel, { title: "A", children: "x" }));
    expect(raised).not.toContain("panelFlat");
    expect(raised).not.toContain("panelNested");
    expect(html(createElement(Panel, { title: "A", variant: "flat", children: "x" }))).toContain("panelFlat");
    expect(html(createElement(Panel, { title: "A", variant: "nested", children: "x" }))).toContain("panelNested");
    expect(html(createElement(Panel, { title: "A", nested: true, children: "x" }))).toContain("panelNested");
    expect(css).toMatch(/\.panelNested \{ border-radius: 0; background: transparent; box-shadow: inset 0 1px 0 var\(--ui-line\); \}/);
  });
  it("StatTile flat and ScrollTable flush are opt in; the defaults are the v3 markup", () => {
    expect(html(createElement(StatTile, { label: "A", value: "1" }))).not.toContain("tileFlat");
    expect(html(createElement(StatTile, { label: "A", value: "1", flat: true }))).toContain("tileFlat");
    expect(html(createElement(ScrollTable, { label: "T", children: createElement("tbody") }))).not.toContain("tableFlush");
    const flush = html(createElement(ScrollTable, { label: "T", flush: true, narrowHidden: true, children: createElement("tbody") }));
    expect(flush).toContain("tableFlush");
    expect(flush).toContain("tableNarrowHidden");
  });
});

describe("v4 status grammar", () => {
  it("info-neutral is its own tone (not the neutral grey, not green, not amber)", () => {
    expect(toneClassKey("info-neutral")).toBe("t_infoNeutral");
    expect(toneClassKey("warn")).toBe("t_warn");
    const h = html(createElement(StatusBadge, { tone: "info-neutral", children: "3 linked" }));
    expect(h).toContain("t_infoNeutral");
    expect(h).toContain("3 linked");
    expect(h).toContain('aria-hidden="true"');
    expect(css).toMatch(/\.t_infoNeutral \{ --fg: #2d3f5e;/);
    expect(css).toMatch(/\.t_infoNeutral \.badgeDot \{ background: transparent; box-shadow: inset 0 0 0 1\.5px var\(--dot\); \}/); // a ring, so it is not colour alone either
  });
  it("pill is the default; text mode drops the chip but keeps dot and word; the old plain prop still works", () => {
    const pill = html(createElement(StatusBadge, { tone: "ok", children: "On time" }));
    expect(pill).not.toContain("badgeText");
    const text = html(createElement(StatusBadge, { tone: "ok", mode: "text", children: "On time" }));
    expect(text).toContain("badgeText");
    expect(text).toContain("badgeDot");
    expect(text).toContain("On time");
    expect(html(createElement(StatusBadge, { plain: true, children: "x" }))).toContain("badgePlain");
    expect(css).toMatch(/\.badgeText \{[^}]*box-shadow: none[^}]*font-size: var\(--ui-fs-secondary\)/);
  });
});

describe("v4 PageHeader, Tabs, PreviewBar, StackedRows", () => {
  it("PageHeader: one h1 by default (the level is yours), a description paragraph and an actions slot only when given", () => {
    const full = html(createElement(PageHeader, { title: "Quotes", description: "Prices we offered.", actions: createElement("button", null, "New") }));
    expect(full).toContain("<h1");
    expect(full).toContain("Quotes");
    expect(full).toContain("<p");
    expect(full).toContain("phActions");
    const bare = html(createElement(PageHeader, { title: "Quotes", headingLevel: 2 }));
    expect(bare).toContain("<h2");
    expect(bare).not.toContain("<p");
    expect(bare).not.toContain("phActions");
    expect(bare.match(/<h\d/g)?.length).toBe(1);
  });
  it("Tabs: tablist with tab, aria-selected, aria-controls, one tab stop, disabled stays visible, counts tabular; only the horizontal keys", () => {
    const h = html(createElement(Tabs, { label: "Sections", value: "b", onChange: noop, tabs: [{ value: "a", label: "Today", count: 29, controls: "pa", id: "ta" }, { value: "b", label: "Overdue", controls: "pb" }, { value: "c", label: "Old", disabled: true, disabledReason: "Not now" }] }));
    expect(h).toContain('role="tablist"');
    expect(h).toContain('aria-label="Sections"');
    expect(h.match(/role="tab"/g)?.length).toBe(3);
    expect(h).toContain('aria-selected="true"');
    expect(h.match(/aria-selected="false"/g)?.length).toBe(2);
    expect(h).toContain('aria-controls="pa"');
    expect(h).toContain('id="ta"');
    expect(h.match(/tabindex="0"/g)?.length).toBe(1);
    expect(h).toContain('aria-disabled="true"');
    expect(h).toContain('data-text="Today"');
    expect(h).toContain(">29<");
    for (const k of ["ArrowLeft", "ArrowRight", "Home", "End"]) expect(isTabKey(k)).toBe(true);
    for (const k of ["ArrowUp", "ArrowDown", "Enter", "a"]) expect(isTabKey(k)).toBe(false);
    const panel = html(createElement(TabPanel, { id: "pa", tabId: "ta", hidden: true, children: "x" }));
    expect(panel).toContain('role="tabpanel"');
    expect(panel).toContain('aria-labelledby="ta"');
  });
  it("Tabs CSS: 44 px, a 2 px navy bar, the first label on the content edge, 48 px hit area, bold width reserved, focus ring", () => {
    expect(css).toMatch(/\.tab \{[^}]*height: 44px/);
    expect(css).toMatch(/\.tabBar \{[^}]*height: 2px[^}]*background: var\(--ui-brand\)/);
    expect(css).toMatch(/\.tab:first-child \{ padding-left: 0;/);
    expect(css).toMatch(/\.tab::after \{ content: ""; position: absolute; inset: -2px 0; \}/);
    expect(css).toMatch(/\.tabLabel::after \{ content: attr\(data-text\)[^}]*font-weight: 600/);
    expect(css).toContain(".tab:focus-visible");
  });
  it("PreviewBar: one group with the preview words and an optional controls slot, 28 px, a button in the slot becomes a 24 px text button with a 48 px hit area", () => {
    expect(PREVIEW_LABEL).toBe("Preview, sample data, nothing is saved");
    const h = html(createElement(PreviewBar, { controls: createElement("button", null, "Preview controls") }));
    expect(h).toContain('role="group"');
    expect(h).toContain("Preview</span>, sample data, nothing is saved");
    expect(h).toContain("Preview controls");
    expect(html(createElement(PreviewBar, {}))).not.toContain("pbarSlot");
    expect(css).toMatch(/\.pbar \{[^}]*height: 28px/);
    expect(css).toMatch(/\.pbar \.btn \{ height: 24px/);
    expect(css).toMatch(/\.pbar \.btn::after \{ inset: -12px 0; \}/);
    expect(css).not.toMatch(/\.pbar[^{]*\{[^}]*(#fff6dd|--ui-warn)/); // not the yellow pill
  });
  it("StackedRows: a named list, one item per record, label and value pairs as a definition list, a link title with href, actions only when given", () => {
    const h = html(createElement(StackedRows, { label: "Jobs", narrowOnly: true, rows: [
      { id: "1", title: "J-0431", status: "Running", fields: [{ label: "Customer", value: "Hartley" }, { label: "Due", value: "Friday" }], actions: createElement("button", null, "View"), href: "/j/1" },
      { id: "2", title: "J-0432", fields: [{ label: "Customer", value: "Calder" }] },
    ] }));
    expect(h).toContain('<ul aria-label="Jobs"');
    expect(h.match(/<li/g)?.length).toBe(2);
    expect(h).toContain("<dl");
    expect(h.match(/<dt>/g)?.length).toBe(3);
    expect(h.match(/<dd>/g)?.length).toBe(3);
    expect(h).toContain('href="/j/1"');
    expect(h.match(/stackActions/g)?.length).toBe(1);
    expect(h).toContain("stackNarrow");
    expect(html(createElement(StackedRows, { label: "Jobs", rows: [] }))).not.toContain("stackNarrow");
    expect(css).toMatch(/@media \(max-width: 640px\) \{ \.stackNarrow \{ display: block; \} \.tableNarrowHidden \{ display: none; \} \}/);
    expect(css).toMatch(/\.stackActions \{[^}]*gap: 16px 8px/);
  });
  it("layers scale from their trigger: placeLayer gives the trigger's centre as the origin, and the old origin string is unchanged", () => {
    const below = placeLayer({ top: 100, bottom: 140, left: 50, right: 150 }, { width: 200, height: 150 }, { width: 1000, height: 800 });
    expect(below.origin).toBe("top left");
    expect(below.originY).toBe("0%");
    expect(below.originX).toBe(100 - 50);
    const above = placeLayer({ top: 600, bottom: 640, left: 50, right: 150 }, { width: 200, height: 300 }, { width: 1000, height: 800 });
    expect(above.originY).toBe("100%");
    const style = layerOriginStyle(below) as Record<string, unknown>;
    expect(style["--origin-x"]).toBe("50px");
    expect(style["--origin-y"]).toBe("0%");
    expect(style["--origin"]).toBe("top left");
  });
  it("Dialog and Sheet render closed with data-state closed and no content (v3 markup plus the state)", () => {
    const d = html(createElement(Dialog, { open: false, title: "T", confirmLabel: "OK", onConfirm: noop, onClose: noop }));
    expect(d).toContain('data-state="closed"');
    expect(d).not.toContain("<h2");
  });
});

describe("v4 exports and boundaries", () => {
  it("the v4 names exist and no v1 to v3 name went away", async () => {
    const m = await import("@/components/ui/premium");
    for (const n of ["PageHeader", "Tabs", "TabPanel", "PreviewBar", "StackedRows", "typeScale", "usePresence", "useEntered", "useModalPresence", "layerOriginStyle", "toneClassKey", "isTabKey",
      "Button", "Switch", "Checkbox", "FilterChip", "ChipGroup", "StatusBadge", "Menu", "Popover", "Dialog", "ToastProvider", "useToast", "SelectionBar", "ScrollTable", "EmptyState", "LoadingState", "FailedState",
      "SegmentedControl", "Sheet", "Field", "Input", "Textarea", "Select", "StatTile", "StatTiles", "Panel", "Callout", "Disclosure", "List", "ListRow", "FormGroup", "ErrorSummary", "DateRangeGroup", "placeLayer", "premiumTokens", "tabularNumbers", "srOnly", "TOKEN_NAMES", "cx"]) expect(m, n).toHaveProperty(n);
  });
  it("every v4 file carries a boundary comment and the old tokens are all still there", () => {
    for (const f of ["usePresence.ts", "PageHeader.tsx", "Tabs.tsx", "PreviewBar.tsx", "StackedRows.tsx"]) expect(fs.readFileSync(path.join(dir, f), "utf8"), f).toMatch(/BOUNDARY/);
    for (const t of ["--ui-shadow-1", "--ui-shadow-pop", "--ui-shadow-dialog", "--ui-ease", "--ui-t-fast", "--ui-t-base", "--ui-t-slow"]) expect(TOKEN_NAMES).toContain(t);
  });
  it("v4 CSS has no gradients, no glass and no global selectors", () => {
    const added = css.slice(css.indexOf("v4 additions (craft pass)"));
    expect(added).not.toMatch(/gradient\(|backdrop-filter|blur\(|:root|:global/);
  });
});
