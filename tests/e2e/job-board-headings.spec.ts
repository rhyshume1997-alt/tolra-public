/**
 * Job Board headings line up (Rhys, Fri 23 Oct): at 390, 768, 1280 and 1523 px, in Cards, List and Table,
 * - every KPI tile's number sits at the same offset from its tile top (and the numbers of one row of tiles share one top),
 *   and every KPI label box is the same height;
 * - every filter label box has the same left and the same width;
 * - the column headers of one table share one top and one height;
 * - no heading text overflows its box (scrollWidth <= clientWidth).
 *
 * The view is chosen at 1280 px (the switcher is hidden on phones) and the window is then resized, because the view is remembered per
 * person. What each width really shows follows the app: phones (< 768) always show Cards; from 768 to 1024 a chosen Table is shown as
 * Cards (dense tables need the desk layout); List and Table are tables from 768 / 1025 px. The expected layout is asserted, so a
 * width that silently showed the wrong thing fails here instead of passing on the wrong boxes.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

type View = "Cards" | "List" | "Table";
const VIEWS: View[] = ["Cards", "List", "Table"];
const WIDTHS = [390, 768, 1280, 1523];

/** Selectors: CONTRACT (HEADINGS-CONTRACT.md) for the data attributes and roles; the KPI tile is the label's own card (ASSUMED: no test id). */
const SEL = {
  kpiLabel: "[data-kpi-label]",
  kpiNumber: "[data-kpi-value]",
  filterLabel: '[data-board-heading="filter"]',
};
const FILTER_COUNT = 6; // Show, Type, Group, Due, Tag, Stage

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  // Real rows so the tables have bodies; long text so a heading squeezed by a wide column would show.
  const admin = adminClient();
  const org = w.tenants.alpha.id;
  for (const key of ["a", "b"]) {
    const jobNo = `J-HD${key.toUpperCase()}-${w.runId}`;
    const found = (await admin.from("jobs").select("id").eq("organization_id", org).eq("job_no", jobNo).maybeSingle()).data;
    if (!found) {
      const { error } = await admin.from("jobs").insert({ organization_id: org, job_no: jobNo, customer: "Headings Co With A Rather Long Customer Name Ltd", description: `Headings ${key}`, specification: "Spec 316 polish", due_date: "2026-12-01" });
      expect(error).toBeNull();
    }
  }
});

/** Chooses the view at 1280 px, then resizes. Returns what the width really shows. */
async function openView(page: Page, width: number, view: View): Promise<"cards" | "list" | "table"> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/jobs");
  const choice = page.getByRole("group", { name: "View" }).getByRole("button", { name: view, exact: true });
  await choice.click();
  await expect(choice).toHaveAttribute("aria-pressed", "true");
  await page.setViewportSize({ width, height: 900 });
  const shown = width < 768 ? "cards" : view === "Table" && width <= 1024 ? "cards" : (view.toLowerCase() as "cards" | "list" | "table");
  if (shown === "cards") {
    await expect(page.locator('[data-testid="job-card"]:visible').first()).toBeVisible();
    await expect(page.locator("table:visible")).toHaveCount(0);
  } else {
    await expect(page.locator("table:visible").first()).toBeVisible();
    await expect(page.locator("tbody tr:visible").first()).toBeVisible();
    await expect(page.locator('[data-testid="job-card"]:visible')).toHaveCount(0);
  }
  await page.evaluate(() => document.fonts.ready);
  return shown;
}

for (const width of WIDTHS) {
  for (const view of VIEWS) {
    test(`${view} at ${width}px: KPI tiles, filter labels and column headers line up, no heading overflows`, async ({ page }) => {
      await signIn(page, w.tenants.alpha.users.admin);
      const shown = await openView(page, width, view);
      const at = `${view}@${width}`;

      // The page never scrolls sideways.
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), `${at}: page scrolls sideways`).toBe(true);

      const measured = await page.evaluate((sel) => {
        type Box = { top: number; left: number; width: number; height: number };
        const rect = (el: Element): Box => { const r = el.getBoundingClientRect(); return { top: r.top, left: r.left, width: r.width, height: r.height }; };
        const visible = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        // Text boxes that spill: a heading element or any text-carrying child (sr-only 1px spans are not headings).
        const spills = (root: Element) => {
          const out: string[] = [];
          for (const el of [root, ...Array.from(root.querySelectorAll("*"))] as HTMLElement[]) {
            const r = el.getBoundingClientRect();
            if (r.width <= 1 || r.height <= 1) continue;
            if (!Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())) continue;
            if (el.scrollWidth > el.clientWidth + 1) out.push(`${el.textContent?.trim().slice(0, 40)} (${el.scrollWidth} > ${el.clientWidth})`);
          }
          return out;
        };

        const labels = Array.from(document.querySelectorAll(sel.kpiLabel)).filter(visible);
        const numbers = Array.from(document.querySelectorAll(sel.kpiNumber)).filter(visible);
        const kpi = labels.map((label, index) => {
          const tile = label.closest("div.rounded-xl") ?? label.parentElement!;
          const number = numbers[index];
          return { tile: rect(tile), label: rect(label), number: rect(number), spills: [...spills(label), ...spills(number)] };
        });
        const filters = Array.from(document.querySelectorAll(sel.filterLabel)).filter(visible).map((el) => ({ text: el.textContent?.trim() ?? "", box: rect(el), spills: spills(el) }));
        // Column headers of the one table on screen.
        const table = Array.from(document.querySelectorAll("table")).find(visible);
        const heads = table ? Array.from(table.querySelectorAll("thead th")).filter(visible).map((th) => ({ text: th.textContent?.trim() ?? "", box: rect(th), spills: spills(th) })) : [];
        return { kpi, numbers: numbers.length, filters, heads };
      }, SEL);

      // KPI tiles: six; the same number offset inside every tile, the numbers of one row of tiles on one top, one label height.
      expect(measured.kpi.length, `${at}: KPI labels on screen`).toBe(6);
      expect(measured.numbers, `${at}: KPI numbers on screen`).toBe(6);
      const offsets = measured.kpi.map((k) => k.number.top - k.tile.top);
      expect(Math.max(...offsets) - Math.min(...offsets), `${at}: number offset inside the tile ${offsets.map((n) => n.toFixed(1))}`).toBeLessThanOrEqual(1);
      const rows = new Map<number, number[]>();
      for (const k of measured.kpi) {
        const key = [...rows.keys()].find((t) => Math.abs(t - k.tile.top) <= 2) ?? k.tile.top;
        rows.set(key, [...(rows.get(key) ?? []), k.number.top]);
      }
      for (const [rowTop, tops] of rows) expect(Math.max(...tops) - Math.min(...tops), `${at}: KPI numbers in the row at ${rowTop.toFixed(0)}px share one top (${tops.map((n) => n.toFixed(1))})`).toBeLessThanOrEqual(1);
      const labelHeights = measured.kpi.map((k) => k.label.height);
      expect(Math.max(...labelHeights) - Math.min(...labelHeights), `${at}: KPI label heights ${labelHeights.map((n) => n.toFixed(1))}`).toBeLessThanOrEqual(1);
      expect(measured.kpi.flatMap((k) => k.spills), `${at}: KPI text overflows`).toEqual([]);

      // Filter labels: one left, one width.
      expect(measured.filters.length, `${at}: filter labels on screen`).toBe(FILTER_COUNT);
      const lefts = measured.filters.map((f) => f.box.left);
      const widths = measured.filters.map((f) => f.box.width);
      expect(Math.max(...lefts) - Math.min(...lefts), `${at}: filter label lefts ${measured.filters.map((f) => `${f.text}=${f.box.left.toFixed(1)}`)}`).toBeLessThanOrEqual(1);
      expect(Math.max(...widths) - Math.min(...widths), `${at}: filter label widths ${measured.filters.map((f) => `${f.text}=${f.box.width.toFixed(1)}`)}`).toBeLessThanOrEqual(1);
      expect(measured.filters.flatMap((f) => f.spills), `${at}: filter label text overflows`).toEqual([]);

      // Column headers (List and Table): one top, one height, no overflow. Cards have no header row.
      if (shown === "cards") {
        expect(measured.heads, `${at}: Cards have no column headers`).toEqual([]);
      } else {
        expect(measured.heads.length, `${at}: column headers on screen`).toBeGreaterThan(10);
        const tops = measured.heads.map((h) => h.box.top);
        const heights = measured.heads.map((h) => h.box.height);
        expect(Math.max(...tops) - Math.min(...tops), `${at}: header tops ${measured.heads.map((h) => `${h.text}=${h.box.top.toFixed(1)}`)}`).toBeLessThanOrEqual(1);
        expect(Math.max(...heights) - Math.min(...heights), `${at}: header heights ${measured.heads.map((h) => `${h.text}=${h.box.height.toFixed(1)}`)}`).toBeLessThanOrEqual(1);
        expect(measured.heads.flatMap((h) => h.spills), `${at}: header text overflows`).toEqual([]);
      }
    });
  }
}
