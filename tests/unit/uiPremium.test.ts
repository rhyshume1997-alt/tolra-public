// BOUNDARY (module 7, shared UI, NEW; v2 adds the segmented control, sheet, form fields, stat tile and the option checks). Inputs: the files in components/ui/premium. Output: checks on their pure helpers, their server-rendered
// markup (roles, aria, names) and on the stylesheet's rules (sizes, no glass, reduced motion). Must not change: it reads no database and calls
// no network; loosening a rule here (hit areas, no gradients or blur, reduced motion) needs the same PM approval as changing the rule itself.
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Button, Checkbox, ChipGroup, Dialog, EmptyState, FailedState, Field, FilterChip, Input, LoadingState, SegmentedControl, Select, SelectionBar, Sheet,
  StatTile, StatTiles, StatusBadge, Switch, Textarea,
  TOKEN_NAMES, cx, fieldDescribedBy, nextMenuIndex, nextSegmentIndex, pickFirstEnabled, placeLayer, scrollEdges, selectionControls, tabStopIndex, toastRegionStyle,
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
    expect(css).toMatch(/\.seg \{[^}]*height: var\(--ui-h-md\)/);
    expect(css).toMatch(/\.segSm \{ height: var\(--ui-h-sm\)/);
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
