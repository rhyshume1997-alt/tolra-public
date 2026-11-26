// The sidebar shows which page you are on: aria-current=page on the longest matching visible item, its visible parents marked, hidden items never current.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { navActive } from "@/lib/nav-active";
import { textOn } from "@/lib/branding";

const ITEMS = ["/dashboard", "/jobs", "/jobs/ncr", "/quotes", "/admin/users", "/admin/iso", "/settings"];

describe("navActive", () => {
  it("marks the page itself, and sub-pages light their item", () => {
    expect(navActive("/quotes", ITEMS)).toEqual({ current: "/quotes", parents: [] });
    expect(navActive("/quotes/preview", ITEMS).current).toBe("/quotes");
    expect(navActive("/admin/iso/quality-manual", ITEMS).current).toBe("/admin/iso");
    expect(navActive("/admin/users", ITEMS).current).toBe("/admin/users");
  });
  it("the NCR register is current with Job Board as its parent; hidden, Job Board is current", () => {
    expect(navActive("/jobs/ncr", ITEMS)).toEqual({ current: "/jobs/ncr", parents: ["/jobs"] });
    expect(navActive("/jobs/ncr", ITEMS.filter((h) => h !== "/jobs/ncr"))).toEqual({ current: "/jobs", parents: [] });
  });
  it("no match, no current; a prefix of a name is not a match", () => {
    expect(navActive("/portal", ITEMS)).toEqual({ current: null, parents: [] });
    expect(navActive("/jobsx", ITEMS).current).toBeNull();
  });
});

describe("active look", () => {
  const sidebar = readFileSync("components/sidebar.tsx", "utf8");
  const css = readFileSync("app/globals.css", "utf8");
  it("every link carries aria-current for the current page and a data marker for current and parent", () => {
    expect(sidebar.match(/aria-current=\{active \? "page" : undefined\}/g)?.length).toBe(2);
    expect(sidebar.match(/data-nav-active=\{active \? "current" : parentActive \? "parent" : undefined\}/g)?.length).toBe(2);
    expect(sidebar).toContain("navActive(pathname,");
  });
  it("the new look is only under the v2 attribute: ink fill, brand text, bold, 3px bar", () => {
    const lines = css.split("\n").filter((l) => l.startsWith("html") && l.includes('data-nav-active'));
    expect(lines.length).toBe(3);
    for (const l of lines) expect(l.startsWith('html[data-ui-v2="on"]')).toBe(true);
    expect(css).toContain('a[data-nav-active="current"] { background: var(--brand-ink); color: var(--brand); font-weight: 600; box-shadow: inset 3px 0 0 var(--brand); }');
  });
  it("brand text on the ink fill is the same pair the sidebar already uses, so it reads at 4.5:1 or better on any brand colour", () => {
    const lumv = (h: string) => { const [r, g, b] = [1, 3, 5].map((i) => { const c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    for (const brand of ["#1e3472", "#2563eb", "#0b6e4f", "#b45309", "#fbbf24", "#ffffff", "#000000", "#7c3aed", "#dc2626", "#0891b2", "#64748b", "#16a34a", "#f97316", "#94a3b8", "#334155"]) {
      const a = lumv(brand); const b = lumv(textOn(brand));
      expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), brand).toBeGreaterThanOrEqual(4.5);
    }
  });
});
