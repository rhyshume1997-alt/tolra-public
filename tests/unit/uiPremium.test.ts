// BOUNDARY (module 7, shared UI, NEW). Inputs: the files in components/ui/premium. Output: checks on their pure helpers, their server-rendered
// markup (roles, aria, names) and on the stylesheet's rules (sizes, no glass, reduced motion). Must not change: it reads no database and calls
// no network; loosening a rule here (hit areas, no gradients or blur, reduced motion) needs the same PM approval as changing the rule itself.
import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  Button, Checkbox, ChipGroup, Dialog, EmptyState, FailedState, FilterChip, LoadingState, SelectionBar, StatusBadge, Switch,
  TOKEN_NAMES, cx, nextMenuIndex, placeLayer, scrollEdges,
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
