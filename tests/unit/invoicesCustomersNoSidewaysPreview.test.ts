/**
 * BOUNDARY (Invoices, Delivery Notes, Purchase Orders, Customers, Suppliers, Dashboard, Numbers, Reports previews, v3 NO SIDEWAYS SCROLLING, PREVIEW ONLY).
 * Inputs: the .module.css and .tsx files of the eight preview components (read as text). Output: pass/fail. Enforces the owner's rule: on a phone or tablet (1024 px and under) nothing
 * scrolls sideways, so a sideways scroll box, a fixed table width or a px minimum in a grid may exist ONLY inside @media (min-width: 1025px); every table goes through the shared ScrollTable
 * (stacked records at 1024 px and under); every chart svg has a viewBox so it scales to its container.
 * Must not change: never loosen these to make a change pass. The shared set has its own scan (tests/unit/uiPremium.test.ts); this one covers the module files only.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const MODULES = [
  "invoices/preview/InvoicesPreview", "delivery-notes/preview/DeliveryNotesPreview", "purchase-orders/preview/PurchaseOrdersPreview", "customers/preview/CustomersPreview",
  "suppliers/preview/SuppliersPreview", "dashboard/preview/DashboardPreview", "numbers/preview/NumbersPreview", "reports/preview/ReportsPreview",
];
const read = (f: string) => fs.readFileSync(path.join(process.cwd(), "components", f), "utf8");

interface CssRule { selector: string; body: string; media: string[] }
function readRules(src: string): CssRule[] {
  const text = src.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: CssRule[] = [];
  const stack: Array<{ head: string; at: boolean }> = [];
  let buf = "";
  let bodyStart = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") {
      const head = buf.trim();
      buf = "";
      const at = head.startsWith("@");
      stack.push({ head, at });
      if (!at) bodyStart = i + 1;
    } else if (ch === "}") {
      const top = stack.pop();
      if (top && !top.at) out.push({ selector: top.head, body: text.slice(bodyStart, i), media: stack.filter((x) => x.at).map((x) => x.head) });
      buf = "";
    } else buf += ch;
  }
  return out;
}
const DESKTOP_ONLY = "@media (min-width: 1025px)";
const decl = (body: string, prop: string) => Array.from(body.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, "g"))).map((m) => m[1].trim().replace(/\s*!important/, ""));
const TABLE_LIKE = /(table|(^|[\s.>,])t[hd]\b|cell|actions|\bcol[A-Z]?|head\b|Head\b|name|email|clamp|ref)/;
const FIXED_LENGTH = /^(\d+(\.\d+)?)(px|rem|em|ch)$/;

describe.each(MODULES)("no sideways scrolling in the %s styles", (m) => {
  const rules = readRules(read(`${m}.module.css`));
  it("the stylesheet reader finds rules (sanity)", () => { expect(rules.length).toBeGreaterThan(20); });
  it("overflow-x: auto|scroll|overlay only inside @media (min-width: 1025px)", () => {
    for (const r of rules) if (decl(r.body, "overflow-x").some((v) => /^(auto|scroll|overlay)$/.test(v))) expect(r.media, `${r.selector} scrolls sideways`).toContain(DESKTOP_ONLY);
  });
  it("overflow: auto|scroll (shorthand) only inside @media (min-width: 1025px) unless overflow-x is hidden, clip or visible in the same rule", () => {
    for (const r of rules) {
      if (!decl(r.body, "overflow").some((v) => /(^|\s)(auto|scroll|overlay)(\s|$)/.test(v))) continue;
      if (decl(r.body, "overflow-x").some((v) => /^(hidden|clip|visible)$/.test(v))) continue;
      expect(r.media, `${r.selector} uses overflow: auto|scroll`).toContain(DESKTOP_ONLY);
    }
  });
  it("overflow-y: auto|scroll turns overflow-x into auto too: the rule must say overflow-x: hidden (or sit in the desktop block)", () => {
    for (const r of rules) {
      if (!decl(r.body, "overflow-y").some((v) => /^(auto|scroll|overlay)$/.test(v)) || r.media.includes(DESKTOP_ONLY)) continue;
      expect(decl(r.body, "overflow-x").some((v) => /^(hidden|clip)$/.test(v)), `${r.selector} scrolls vertically without overflow-x: hidden`).toBe(true);
    }
  });
  it("fixed min-width or width on a table, cell, column or actions rule only inside @media (min-width: 1025px)", () => {
    for (const r of rules) {
      if (r.media.includes(DESKTOP_ONLY) || !TABLE_LIKE.test(r.selector)) continue;
      for (const prop of ["min-width", "width"]) for (const v of decl(r.body, prop)) {
        if (prop === "width" && !/\b(th|td)\b|Cell|actions/i.test(r.selector)) continue;
        expect(FIXED_LENGTH.test(v) && parseFloat(v) > 0 && !/^0/.test(v), `${r.selector} { ${prop}: ${v} } is a fixed table width outside the desktop block`).toBe(false);
      }
    }
  });
  it("no grid column track with a px or rem minimum (minmax(200px, ...)) outside @media (min-width: 1025px); use minmax(0, ...) or minmax(min(Npx, 100%), ...)", () => {
    for (const r of rules) {
      if (r.media.includes(DESKTOP_ONLY)) continue;
      for (const v of decl(r.body, "grid-template-columns")) expect(/minmax\(\s*\d+(\.\d+)?(px|rem|em)\b/.test(v), `${r.selector} { grid-template-columns: ${v} }`).toBe(false);
    }
  });
  it("white-space: nowrap on a table, cell or actions rule only inside @media (min-width: 1025px) (a stacked record wraps)", () => {
    for (const r of rules) {
      if (r.media.includes(DESKTOP_ONLY) || !/(table|(^|[\s.>,])t[hd]\b|cell|actions)/i.test(r.selector)) continue;
      expect(decl(r.body, "white-space").some((v) => v === "nowrap"), `${r.selector} is nowrap`).toBe(false);
    }
  });
  it("no local table wrapper class (.tableWrap): tables use the shared ScrollTable", () => { expect(rules.some((r) => /\.tableWrap\b/.test(r.selector))).toBe(false); });
});

describe.each(MODULES)("no sideways scrolling in the %s markup", (m) => {
  const tsx = read(`${m}.tsx`);
  it("no inline overflow or overflowX scroll, no inline numeric minWidth", () => {
    expect(tsx).not.toMatch(/overflowX\s*:\s*["'`](auto|scroll)/);
    expect(tsx).not.toMatch(/overflow\s*:\s*["'`](auto|scroll)/);
    expect(tsx).not.toMatch(/overflow-x\s*:\s*(auto|scroll)/);
    expect(tsx).not.toMatch(/style=\{\{[^}]*minWidth\s*:\s*\d/);
  });
  it("every table is the shared ScrollTable (no raw <table>), so it stacks at 1024 px and under", () => {
    expect(tsx).not.toMatch(/<table[\s>]/);
    expect(tsx).not.toContain("role=\"region\" aria-label");
  });
  it("every svg has a viewBox so it scales to its container (the 10 px close glyph included)", () => {
    for (const tag of tsx.match(/<svg\b[^>]*>/g) ?? []) expect(tag, tag).toContain("viewBox");
  });
});

describe("the dashboard and the table screens use the shared responsive pieces", () => {
  it("the Dashboard jump tabs use the shared Tabs with overflow=\"more\", with no local overflow scroller", () => {
    const tsx = read("dashboard/preview/DashboardPreview.tsx");
    expect(tsx).toMatch(/<Tabs label="Jump to" overflow="more"/);
    expect(read("dashboard/preview/DashboardPreview.module.css")).not.toMatch(/\.jump \[role="tablist"\]/);
  });
  it("the Revenue, Numbers and Dashboard data tables are ScrollTable", () => {
    expect(read("reports/preview/ReportsPreview.tsx")).toMatch(/<ScrollTable label=\{`\$\{label\}, table`\}/);
    expect(read("numbers/preview/NumbersPreview.tsx")).toContain("<ScrollTable label=\"Invoiced, received and gap by month\"");
    expect(read("dashboard/preview/DashboardPreview.tsx")).toContain("<ScrollTable label=\"Team this week\"");
  });
});
