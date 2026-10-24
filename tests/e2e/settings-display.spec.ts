/**
 * Settings > Display: untick, see it on the screen and after a reload, then reset. Customers > Phone is the example.
 * Synthetic data only (alpha tenant). The world is read inside the tests, never at import.
 */
import { expect, test } from "@playwright/test";

import { signIn, world } from "./helpers";

for (const width of [1280, 768, 390]) {
  test(`Settings > Display: untick, reload, reset one screen; no sideways scroll at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, world().tenants.alpha.users.admin);
    await page.goto("/settings");
    const card = page.getByTestId("display-screen-customers");
    const phone = card.getByRole("checkbox", { name: "Phone" });
    const count = page.getByTestId("display-count-customers");
    await expect(page.getByTestId("display-settings")).toBeVisible();
    await expect(count).toHaveText("5 of 5 shown");
    try {
      await phone.uncheck();
      await expect(count).toHaveText("4 of 5 shown");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

      await page.goto("/customers");
      await page.getByRole("button", { name: "List", exact: true }).click();
      await expect(page.locator('table[data-view="list"]')).toBeVisible();
      await expect(page.getByRole("columnheader", { name: "Name", exact: true })).toBeVisible();
      await expect(page.getByRole("columnheader", { name: "Phone", exact: true })).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole("columnheader", { name: "Name", exact: true })).toBeVisible();
      await expect(page.getByRole("columnheader", { name: "Phone", exact: true })).toHaveCount(0);

      await page.goto("/settings");
      await expect(phone).not.toBeChecked();
      await card.getByRole("button", { name: "Reset Customers to default" }).click();
      await expect(phone).toBeChecked();
      await expect(count).toHaveText("5 of 5 shown");
      await page.goto("/customers");
      await expect(page.getByRole("columnheader", { name: "Phone", exact: true })).toBeVisible();
    } finally {
      await page.goto("/settings");
      const resetBtn = page.getByRole("button", { name: "Reset all to default" });
      await resetBtn.click();
    }
  });
}
