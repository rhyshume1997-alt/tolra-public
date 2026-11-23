/*
 * BOUNDARY (Quotes, RFQ and Sales Orders previews, v4, test only). Inputs: the source text of the three preview stylesheets and components. Output: a failing test when any of them can scroll sideways
 * below 1025 px: overflow or overflow-x auto/scroll, a fixed px width or min-width on a table cell or column rule, or an inline overflowX / minWidth style, unless it sits inside @media (min-width: 1025px)
 * (desktop only). Must not change: it reads files only; it never renders or edits anything.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const AREAS: Array<{ name: string; css: string; tsx: string }> = [
  { name: "quotes", css: "components/quotes/preview/QuotesPreview.module.css", tsx: "components/quotes/preview/QuotesPreview.tsx" },
];

type Hit = { selector: string; decl: string };

/** Pure: the declarations that live OUTSIDE an @media (min-width: 1025px) block, with their selector. */
export function declarationsOutsideDesktop(css: string): Hit[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const hits: Hit[] = [];
  const walk = (src: string, desktop: boolean) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < src.length && depth) { if (src[j] === "{") depth++; else if (src[j] === "}") depth--; j++; }
      const body = src.slice(open + 1, j - 1);
      if (head.startsWith("@media")) walk(body, desktop || /min-width:\s*1025px/.test(head));
      else if (head.startsWith("@")) { /* keyframes etc. */ }
      else if (!desktop) for (const d of body.split(";")) { const t = d.trim(); if (t) hits.push({ selector: head, decl: t.replace(/\s+/g, " ") }); }
      i = j;
    }
  };
  walk(text, false);
  return hits;
}

const sideways = (h: Hit) => /^overflow(-x)?\s*:\s*(auto|scroll)\b/.test(h.decl) || (/\b(th|td|cActions|cell|col\w*)\b/i.test(h.selector) && /^(min-)?width\s*:\s*\d+(\.\d+)?px/.test(h.decl));

describe("no sideways scrolling in the previews (phone and tablet)", () => {
  it("finds a violation when one exists (the scan itself works)", () => {
    expect(declarationsOutsideDesktop(".a td { min-width: 120px; } .b { overflow-x: auto; }").filter(sideways)).toHaveLength(2);
    expect(declarationsOutsideDesktop("@media (min-width: 1025px) { .a td { min-width: 120px; overflow-x: auto; } }").filter(sideways)).toHaveLength(0);
    expect(declarationsOutsideDesktop("@media (max-width: 1024px) { .a { overflow: scroll; } }").filter(sideways)).toHaveLength(1);
  });
  for (const a of AREAS) {
    it(`${a.name}: stylesheet has no sideways scroll or fixed table width outside @media (min-width: 1025px)`, () => {
      expect(declarationsOutsideDesktop(readFileSync(a.css, "utf8")).filter(sideways)).toEqual([]);
    });
    it(`${a.name}: component has no inline overflowX auto/scroll or inline minWidth`, () => {
      const tsx = readFileSync(a.tsx, "utf8");
      expect(tsx).not.toMatch(/overflowX\s*:\s*["'`](auto|scroll)/);
      expect(tsx).not.toMatch(/style=\{\{[^}]*minWidth/);
    });
    it(`${a.name}: uses the shared stacked ScrollTable (no local table scroll box)`, () => {
      const tsx = readFileSync(a.tsx, "utf8");
      expect(tsx).toMatch(/<ScrollTable /);
      expect(tsx).not.toMatch(/<table[\s>]/);
    });
  }
});
