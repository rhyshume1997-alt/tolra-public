/**
 * Dashboard show / hide (Rhys, Fri 23 Oct: people can select or deselect what they see). The admin hides one KPI tile (Open Quotes)
 * and one section (Quote Pipeline) from the Dashboard's Columns picker: both are gone, the remaining tiles keep equal heading box
 * heights and equal number-box tops in a row (same shape as the Job Board KPI tiles), nothing overlaps or scrolls sideways at 1280
 * and 390, and the choice is remembered after a reload. The org's settings are put back at the end.
 */
import { expect, test, type Page } from "@playwright/test";

import { signIn, world } from "./helpers";

const w = world();
const HIDE = [{ label: "Open quotes", text: "Open quotes" }, { label: "Quote pipeline", text: "Quote pipeline" }];

test.describe.configure({ mode: "serial" });

async function setShown(page: Page, label: string, shown: boolean) {
  await page.getByRole("button", { name: "Columns" }).click();
  const item = page.getByRole("menuitemcheckbox", { name: label, exact: true });
  if ((await item.getAttribute("aria-checked")) !== String(shown)) await item.click();
  await page.keyboard.press("Escape");
}

type TileBox = { top: number; height: number; valueTop: number; left: number; right: number; bottom: number };

/** Every tile's heading, number and box, read in one go in the page so all three come from the same layout (no shift between reads). */
function measureTiles(page: Page): Promise<TileBox[]> {
  return page.evaluate(async () => {
    await document.fonts.ready;
    return Array.from(document.querySelectorAll<HTMLElement>("main p.label-mono")).map((label) => {
      let value = label.nextElementSibling;
      while (value && value.tagName !== "P") value = value.nextElementSibling;
      let tile = label.parentElement;
      while (tile && !(tile.tagName === "DIV" && tile.className.includes("rounded-xl"))) tile = tile.parentElement;
      const lb = label.getBoundingClientRect();
      const vb = value!.getBoundingClientRect();
      const tb = tile!.getBoundingClientRect();
      return { top: Math.round(lb.y), height: Math.round(lb.height), valueTop: Math.round(vb.y - tb.y), left: tb.x, right: tb.x + tb.width, bottom: tb.y + tb.height };
    });
  });
}

/** Heading boxes all the same height; number boxes level within a row of tiles; no tile overlaps another; the page does not scroll sideways.
 *  Measured once the page has settled: nothing in main still says Loading (the Today list and panels above the tiles grow when their data
 *  arrives and push the tile rows down), fonts are ready, and two reads in a row give the same layout. */
async function expectTilesAligned(page: Page) {
  const labels = page.locator("main p.label-mono");
  await expect(labels.first()).toBeVisible();
  await expect(page.locator("main").getByText(/^Loading(\.\.\.|…)$/)).toHaveCount(0);
  let rows: TileBox[] = await measureTiles(page);
  await expect.poll(async () => {
    const before = JSON.stringify(rows);
    rows = await measureTiles(page);
    return JSON.stringify(rows) === before;
  }, { message: "tile layout settled", intervals: [250] }).toBe(true);
  expect(new Set(rows.map((r) => r.height)).size, "equal heading box heights").toBe(1);
  for (const top of new Set(rows.map((r) => r.top))) {
    expect(new Set(rows.filter((r) => r.top === top).map((r) => r.valueTop)).size, `number tops level in the row at ${top}`).toBe(1);
  }
  for (let i = 0; i < rows.length; i += 1) for (let j = i + 1; j < rows.length; j += 1) {
    const a = rows[i];
    const b = rows[j];
    expect(a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1, `tiles ${i} and ${j} do not overlap`).toBe(false);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no sideways scroll").toBe(true);
}

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage();
  await signIn(page, w.tenants.alpha.users.admin);
  for (const { label } of HIDE) await setShown(page, label, true);
  await page.close();
});

for (const [name, size] of [["1280", { width: 1280, height: 900 }], ["390", { width: 390, height: 844 }]] as const) {
  test(`hidden tile and section are gone, the rest line up, and it is remembered (${name})`, async ({ page }) => {
    await page.setViewportSize(size);
    await signIn(page, w.tenants.alpha.users.admin);
    for (const { text } of HIDE) await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
    await expectTilesAligned(page);

    for (const { label } of HIDE) await setShown(page, label, false);
    for (const { text } of HIDE) await expect(page.locator("main").getByText(text, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    await expect(page.locator("main").getByText("Open jobs", { exact: true })).toBeVisible();
    await expectTilesAligned(page);

    await page.reload();
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
    for (const { text } of HIDE) await expect(page.locator("main").getByText(text, { exact: true })).toHaveCount(0);
    await expectTilesAligned(page);

    for (const { label } of HIDE) await setShown(page, label, true);
    for (const { text } of HIDE) await expect(page.locator("main").getByText(text, { exact: true }).first()).toBeVisible();
  });
}
