/**
 * Admin > Users (prod audit): a date must not overlap the sign-in help line ("Leaver whose only company is this one...") under
 * the Inspectors section. Checked at desktop, desk, tablet and phone widths: no visible date box may intersect the help box.
 */
import { expect, test, type Locator } from "@playwright/test";

import { signIn, world } from "./helpers";

const w = world();
const WIDTHS: Array<[number, number]> = [[1280, 800], [1024, 800], [820, 1180], [390, 844]];
// en-GB short date and time from fmtDateTime, e.g. 22/10/2026, 10:15
const DATE = /\d{1,2}\/\d{1,2}\/\d{2,4}/;

type Box = { x: number; y: number; width: number; height: number };

function intersects(a: Box, b: Box) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

async function visibleBox(locator: Locator): Promise<Box | null> {
  if (!(await locator.isVisible())) return null;
  return locator.boundingBox();
}

for (const [width, height] of WIDTHS) {
  test(`Admin > Users: no date overlaps the sign-in help text at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await signIn(page, w.tenants.alpha.users.admin);
    await page.goto("/admin/users");
    await expect(page.getByTestId("user-row").first()).toBeVisible();

    const help = page.getByTestId("sign-in-help");
    await expect(help).toContainText("Leaver whose only company is this one");
    const helpBox = await help.boundingBox();
    expect(helpBox, "sign-in help box").not.toBeNull();

    // Every visible date on the page, wherever it sits (user table, Inspectors list, History).
    const dates = page.locator("main").getByText(DATE);
    const count = await dates.count();
    expect(count, "dates on the page").toBeGreaterThan(0);

    const overlaps: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const box = await visibleBox(dates.nth(i));
      if (!box) continue;
      if (intersects(box, helpBox!)) overlaps.push(`${(await dates.nth(i).textContent())?.trim()} at y=${Math.round(box.y)}`);
    }
    expect(overlaps, `dates overlapping the help text at ${width}px`).toEqual([]);
  });
}
