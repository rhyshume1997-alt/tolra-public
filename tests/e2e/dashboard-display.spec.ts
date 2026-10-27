/**
 * Dashboard show / hide (Rhys, Fri 23 Oct: people can select or deselect what they see). The admin hides one KPI tile (Open Quotes)
 * and one section (Quote Pipeline) from the Dashboard's Columns picker: both are gone, the remaining tiles keep equal heading box
 * heights and equal number-box tops in a row (same shape as the Job Board KPI tiles), nothing overlaps or scrolls sideways at 1280
 * and 390, and the choice is remembered after a reload. The org's settings are put back at the end.
 */
import { expect, test, type Page } from "@playwright/test";

import { signIn, world } from "./helpers";

const w = world();
const HIDE = [{ label: "Open Quotes", text: "Open Quotes" }, { label: "Quote Pipeline", text: "Quote Pipeline" }];

test.describe.configure({ mode: "serial" });

async function setShown(page: Page, label: string, shown: boolean) {
  await page.getByRole("button", { name: "Columns" }).click();
  const item = page.getByRole("menuitemcheckbox", { name: label, exact: true });
  if ((await item.getAttribute("aria-checked")) !== String(shown)) await item.click();
  await page.keyboard.press("Escape");
}

/** Heading boxes all the same height; number boxes level within a row of tiles; no tile overlaps another; the page does not scroll sideways. */
async function expectTilesAligned(page: Page) {
  const labels = page.locator("main p.label-mono");
  await expect(labels.first()).toBeVisible();
  const n = await labels.count();
  const rows: Array<{ top: number; height: number; valueTop: number; left: number; right: number; bottom: number }> = [];
  for (let i = 0; i < n; i += 1) {
    const label = labels.nth(i);
    const lb = (await label.boundingBox())!;
    const vb = (await label.locator("xpath=following-sibling::p[1]").boundingBox())!;
    const tile = (await label.locator("xpath=ancestor::div[contains(@class,'rounded-xl')][1]").boundingBox())!;
    rows.push({ top: Math.round(lb.y), height: Math.round(lb.height), valueTop: Math.round(vb.y - tile.y), left: tile.x, right: tile.x + tile.width, bottom: tile.y + tile.height });
  }
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
