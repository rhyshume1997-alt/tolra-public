/**
 * The owner's Overview jump bar (Rhys, Thu 29 Oct: on live it slid under the app's sticky top bar when scrolling, only a faint
 * ghost showing). Scrolled down, the bar sits wholly below the top bar and stays readable, and a jump link brings its section's
 * heading in below the bar, at 1280 and 390.
 */
import { expect, test } from "@playwright/test";

import { signIn, world } from "./helpers";

const w = world();

for (const [name, size] of [["1280", { width: 1280, height: 900 }], ["390", { width: 390, height: 844 }]] as const) {
  test(`the jump bar stays below the top bar and a jump lands below it (${name})`, async ({ page }) => {
    await page.setViewportSize(size);
    await signIn(page, w.tenants.alpha.users.admin);
    const topBar = page.getByRole("banner");
    const jump = page.getByRole("navigation", { name: "Jump to" });
    await expect(jump).toBeVisible();

    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(async () => {
      const bar = (await topBar.boundingBox())!;
      const nav = (await jump.boundingBox())!;
      return Math.round(nav.y) >= Math.round(bar.y + bar.height) - 1;
    }, { message: "the jump bar is below the top bar, not under it" }).toBe(true);
    await expect(jump.getByRole("link", { name: "Work", exact: true })).toBeInViewport();

    await page.evaluate(() => window.scrollTo(0, 0));
    await jump.getByRole("link", { name: "Work", exact: true }).click();
    const heading = page.locator("#work-title");
    await expect.poll(async () => {
      const nav = (await jump.boundingBox())!;
      const h = (await heading.boundingBox())!;
      return Math.round(h.y) >= Math.round(nav.y + nav.height) - 1;
    }, { message: "the Work heading lands below the jump bar" }).toBe(true);
  });
}
