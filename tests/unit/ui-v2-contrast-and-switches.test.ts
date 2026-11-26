// Log out and the sidebar's own controls read at WCAG AA (4.5:1) on every company brand colour; the old hand-built switches get the premium look on v2 screens only.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { luminance, textOn } from "@/lib/branding";

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (rgb: number[]) => { const [r, g, b] = rgb.map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** Contrast of `ink` at `alpha` over `bg`. */
function contrast(bg: string, ink: string, alpha: number) {
  const b = hex(bg); const f = hex(ink);
  const blended = b.map((v, i) => Math.round(alpha * f[i] + (1 - alpha) * v));
  const l1 = lum(blended); const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
const BRANDS = ["#1e3472", "#2563eb", "#0b6e4f", "#b45309", "#fbbf24", "#ffffff", "#000000", "#7c3aed", "#dc2626", "#0891b2", "#64748b", "#16a34a", "#f97316", "#94a3b8", "#334155"];
const sidebar = readFileSync("components/sidebar.tsx", "utf8");

describe("Log out and sidebar controls", () => {
  it("full brand ink reads at 4.5:1 or better on every sampled brand colour", () => {
    for (const b of BRANDS) expect(contrast(b, textOn(b), 1), b).toBeGreaterThanOrEqual(4.5);
  });
  it("the sidebar Log out and Settings gear use full brand ink (the old 60% and 55% fail on mid-tone brands)", () => {
    expect(sidebar).toContain('text-brand-ink hover:bg-brand-ink/10 hover:text-brand-ink" onClick={signOut}');
    expect(sidebar).not.toContain('text-brand-ink/60 hover:bg-brand-ink/10 hover:text-brand-ink" onClick={signOut}');
    expect(BRANDS.some((b) => contrast(b, textOn(b), 0.6) < 4.5)).toBe(true);
  });
});

describe("skin scope", () => {
  const css = readFileSync("app/globals.css", "utf8");
  const skin = css.slice(css.indexOf("UI V2 SKIN."), css.indexOf("NAVY SELECTION BAR"));
  it("button rules leave the app's own sidebar and its drawer alone", () => {
    const rules = skin.split("\n").filter((l) => l.startsWith('html[data-ui-v2="on"] [data-slot="button"]') || l.startsWith('html[data-ui-v2="on"] :is([data-slot="button"]'));
    expect(rules.length).toBeGreaterThan(8);
    for (const l of rules) expect(l).toContain(':not(:is(aside, [data-slot="sheet-content"][data-side="left"]) *)');
  });
  it("old role=switch buttons are restyled only inside the v2 attribute", () => {
    const lines = skin.split("\n").filter((l) => l.includes('role="switch"'));
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const l of lines) expect(l.startsWith('html[data-ui-v2="on"]')).toBe(true);
    expect(skin).toContain('button[role="switch"][class*="rounded-none"] { border-radius: 12px; }');
  });
});
