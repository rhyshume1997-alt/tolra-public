// BOUNDARY (tests only, scratch of the Schedule / Time / Users / Portal / Admin / Workflow / Settings previews, NO SIDEWAYS SCROLLING rule). Input: the preview .module.css and .tsx files under components/*/preview and
// components/admin/*/preview. Output: fails when any of them scrolls sideways on a phone or tablet: overflow-x or overflow auto|scroll, an inline overflowX auto|scroll, or a fixed (px) min-width / width on a table cell,
// unless the rule sits inside @media (min-width: 1025px) (desktop) or is a table rule inside a (max-width: 1024px) stacked block. It also pins that the schedule timeline reflows into the agenda at 1024 px and under.
// Must not change: reads files only, no app code.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const dirs = ["components", "components/admin"].flatMap((base) => readdirSync(join(root, base), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(base, d.name, "preview")).filter((p) => existsSync(join(root, p))));
const files = dirs.flatMap((d) => readdirSync(join(root, d)).map((f) => join(d, f)));
const cssFiles = files.filter((f) => f.endsWith(".module.css"));
const tsxFiles = files.filter((f) => f.endsWith(".tsx"));
const DESKTOP = "min-width: 1025px";

type Rule = { selector: string; body: string; media: string[] };
function rules(text: string): Rule[] {
  const t = text.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: Rule[] = []; const stack: { head: string; at: boolean; start: number }[] = []; let buf = "";
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === "{") { const head = buf.trim(); buf = ""; stack.push({ head, at: head.startsWith("@"), start: i + 1 }); }
    else if (ch === "}") { const top = stack.pop(); if (top && !top.at) out.push({ selector: top.head, body: t.slice(top.start, i), media: stack.filter((x) => x.at).map((x) => x.head) }); buf = ""; }
    else if (ch === ";" && !stack.length) buf = "";
    else buf += ch;
  }
  return out;
}
const decl = (body: string, prop: string) => Array.from(body.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, "g"))).map((m) => m[1].trim().replace(/\s*!important/, ""));
const desktopOnly = (r: Rule) => r.media.some((m) => m.includes(DESKTOP));

describe("preview stylesheets: nothing scrolls sideways at 1024 px and under", () => {
  it("finds the preview folders", () => { expect(cssFiles.length).toBeGreaterThanOrEqual(15); expect(tsxFiles.length).toBeGreaterThanOrEqual(15); });
  for (const f of cssFiles) {
    const rs = rules(readFileSync(join(root, f), "utf8"));
    it(`${f}: overflow-x / overflow auto|scroll only in the desktop block`, () => {
      for (const r of rs) {
        if (desktopOnly(r)) continue;
        expect(decl(r.body, "overflow-x").some((v) => /^(auto|scroll|overlay)$/.test(v)), `${r.selector} scrolls sideways`).toBe(false);
        const sh = decl(r.body, "overflow").some((v) => /(^|\s)(auto|scroll|overlay)(\s|$)/.test(v));
        const ox = decl(r.body, "overflow-x").some((v) => /^(hidden|clip|visible)$/.test(v));
        expect(sh && !ox, `${r.selector} uses overflow: auto|scroll`).toBe(false);
        const oy = decl(r.body, "overflow-y").some((v) => /^(auto|scroll|overlay)$/.test(v));
        expect(oy && !ox, `${r.selector} scrolls vertically without overflow-x: hidden`).toBe(false);
      }
    });
    it(`${f}: no fixed pixel min-width or width on a table cell outside a stacked or desktop block`, () => {
      for (const r of rs) {
        if (desktopOnly(r) || r.media.some((m) => m.includes("max-width: 1024px") || m.includes("max-width: 1023px"))) continue;
        if (!/\b(td|th)\b|\.actCol|\.thActions|\.tdActions/.test(r.selector)) continue;
        for (const p of ["min-width", "width"]) expect(decl(r.body, p).some((v) => /^\d+px$/.test(v)), `${r.selector} sets ${p}: Npx`).toBe(false);
      }
    });
  }
  for (const f of tsxFiles) {
    it(`${f}: no inline overflowX auto|scroll`, () => {
      expect(readFileSync(join(root, f), "utf8")).not.toMatch(/overflow(X)?\s*:\s*["'](auto|scroll)["']/);
    });
  }
});

describe("schedule timeline reflows to the agenda at 1024 px and under", () => {
  const tsx = readFileSync(join(root, "components/schedule/preview/SchedulePreview.tsx"), "utf8");
  const css = readFileSync(join(root, "components/schedule/preview/SchedulePreview.module.css"), "utf8");
  it("the timeline grid is only drawn when wide (above 1024 px); the agenda otherwise, with every action reachable", () => {
    expect(tsx).toMatch(/!wide \? \(\s*<div className=\{s\.agenda\}/);
    for (const id of ["agenda-machine", "agenda-day", "agenda-booking", "agenda-run", "agenda-now"]) expect(tsx).toContain(`data-testid="${id}"`);
    expect(tsx).toMatch(/data-testid="agenda-booking"[\s\S]*onClick=\{\(\) => onSelect\(seg\.booking\)\}/);
    expect(tsx).toMatch(/data-testid="agenda-run"[\s\S]*onClick=\{\(\) => onSelectRun\(bar/);
    expect(tsx).toContain("Not normally worked");
  });
  it("the timeline scroll box exists only above 1024 px", () => {
    expect(css).toMatch(/@media \(min-width: 1025px\) \{ \.tlScroll \{ overflow-x: auto/);
    expect(css).not.toMatch(/^\.tlScroll \{[^}]*overflow-x/m);
  });
});
