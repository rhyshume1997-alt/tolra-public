import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ListSkeleton } from "@/components/list-skeleton";

describe("ListSkeleton", () => {
  it("shows the asked number of placeholder rows and says what is loading", () => {
    const html = renderToStaticMarkup(createElement(ListSkeleton, { label: "Loading users", rows: 5 }));
    expect(html).toContain('aria-label="Loading users"');
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/animate-pulse/g)?.length ?? 0).toBe(5);
  });

  it("defaults to three rows, like the list pages", () => {
    const html = renderToStaticMarkup(createElement(ListSkeleton, { label: "Loading" }));
    expect(html.match(/animate-pulse/g)?.length ?? 0).toBe(3);
  });
});

// The skeleton was on the page but could not be seen: it was `bg-muted` (oklch 0.97, about #f7f7f7) on the page's #f5f6f8 canvas, a
// contrast of about 1.0, and the pulse fades it further. Rhys saw a blank table area for the whole load.
describe("the skeleton is visible on the page", () => {
  const css = readFileSync("app/globals.css", "utf8");
  const token = (name: string) => new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css)![1];
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const ratio = (a: number[], b: number[]) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const blend = (fg: number[], bg: number[], alpha: number) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));

  it("uses the muted-foreground tint, not the canvas-coloured muted fill", () => {
    const source = readFileSync("components/ui/skeleton.tsx", "utf8");
    expect(source).toMatch(/bg-muted-foreground\/\d+/);
    expect(source).not.toMatch(/bg-muted["\s]/);
  });

  it("stands out from the canvas and from a white card (contrast at least 1.1)", () => {
    const alpha = Number(/bg-muted-foreground\/(\d+)/.exec(readFileSync("components/ui/skeleton.tsx", "utf8"))![1]) / 100;
    const bar = blend(rgb(token("muted-foreground")), rgb(token("canvas")), alpha);
    expect(ratio(bar, rgb(token("canvas")))).toBeGreaterThanOrEqual(1.1);
    expect(ratio(blend(rgb(token("muted-foreground")), [255, 255, 255], alpha), [255, 255, 255])).toBeGreaterThanOrEqual(1.1);
  });
});
