/**
 * Active filter chip contrast inside the redesign token scope (components/ui/premium/premium.module.css `.tokens`).
 * Inputs: the real FilterBar chip classes, the real Tailwind output of app/globals.css and the real premium stylesheet, loaded in Chromium.
 * Output: the active chip's text must contrast with its fill (>= 4.5:1); the inactive chip keeps the colour the token scope gives it; the
 * same chip outside `.tokens` (legacy screens) is white on ink. Needs no sign-in, backend or network (page.setContent), so the suite's
 * global setup is the only backend dependency. Must not change: do not relax the ratio or drop the inactive and legacy checks.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";


const root = process.cwd();
/** Tailwind compiled from the app's real entry stylesheet, and the premium module as written (its local class `.tokens` is stable in the source). */
async function stylesheets() {
  const entry = path.join(root, "app/globals.css");
  const tw = await postcss([tailwind()]).process(readFileSync(entry, "utf8"), { from: entry });
  const premium = readFileSync(path.join(root, "components/ui/premium/premium.module.css"), "utf8");
  return `${tw.css}\n${premium}`;
}

/**
 * The chip's real class strings, read from components/filter-bar.tsx (Playwright's loader replaces React inside spec imports, so the component
 * cannot be rendered here). The chip is a single <button> carrying these classes; the spec fails loudly if the source stops matching.
 */
function chipClasses() {
  const source = readFileSync(path.join(root, "components/filter-bar.tsx"), "utf8");
  const m = source.match(/"(h-8 [^"]*)",\s*selected\s*\?\s*"([^"]+)"\s*:\s*"([^"]+)"/);
  if (!m) throw new Error("components/filter-bar.tsx no longer has the chip class pattern this spec reads; update the spec with it, do not drop the check");
  return { base: m[1], active: m[2], inactive: m[3] };
}
const c = chipClasses();
const chips = `<button type="button" aria-pressed="false" class="${c.base} ${c.inactive}">All</button><button type="button" aria-pressed="true" class="${c.base} ${c.active}">Open</button>`;

function channel(c: number) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
function luminance(rgb: string) {
  const [r, g, b] = (rgb.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

async function read(page: import("@playwright/test").Page, scope: boolean) {
  const css = await stylesheets();
  await page.setContent(`<html><head><style>${css}</style></head><body><div class="${scope ? "tokens" : "legacy"}">${chips}</div></body></html>`);
  const pick = (pressed: string) =>
    page.locator(`button[aria-pressed="${pressed}"]`).first().evaluate((el) => {
      const s = getComputedStyle(el);
      return { color: s.color, background: s.backgroundColor };
    });
  return { active: await pick("true"), inactive: await pick("false") };
}

test.describe("active filter chip contrast", () => {
  test("inside the redesign token scope the active chip text is readable", async ({ page }) => {
    const { active } = await read(page, true);
    expect(active.color).toBe("rgb(255, 255, 255)");
    expect(contrast(active.color, active.background)).toBeGreaterThanOrEqual(4.5);
  });

  test("inside the token scope the inactive chip keeps the colour it had (token ink on the surface) and stays readable", async ({ page }) => {
    const { inactive } = await read(page, true);
    expect(inactive.color).toBe("rgb(14, 23, 38)");
    expect(inactive.background).toBe("rgb(255, 255, 255)");
    expect(contrast(inactive.color, inactive.background)).toBeGreaterThanOrEqual(4.5);
  });

  test("outside the token scope (legacy screens) the chip is white on ink as before", async ({ page }) => {
    const { active } = await read(page, false);
    expect(active.color).toBe("rgb(255, 255, 255)");
    expect(active.background).toBe("rgb(14, 23, 38)");
  });
});
