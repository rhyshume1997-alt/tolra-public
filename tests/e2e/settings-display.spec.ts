/**
 * Settings > Display: untick, see it on the screen and after a reload, then reset. Customers > Phone is the example.
 * Synthetic data only (alpha tenant). The world is read inside the tests, never at import.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

/** The Display change's background save (lib/org-settings.ts: an upsert, POST): leaving the page before it is back aborts it. */
const settingsSaved = (page: Page) => page.waitForResponse((r) => r.url().includes("/rest/v1/organization_settings") && ["POST", "PATCH"].includes(r.request().method()) && r.ok());

for (const width of [1280, 768, 390]) {
  test(`Settings > Display: untick, reload, reset one screen; no sideways scroll at ${width} px`, async ({ page }) => {
    // Its own customer, so the cards have a row to show whichever specs ran before this one on the same database (CI shards).
    const w = world();
    const { error } = await adminClient().from("customers").insert({ organization_id: w.tenants.alpha.id, name: `Display ${w.runId.slice(0, 6)} ${width}`, phone: "0123 456700" });
    expect(error).toBeNull();
    await page.setViewportSize({ width, height: 900 });
    await signIn(page, w.tenants.alpha.users.admin);
    await page.goto("/settings");
    const card = page.getByTestId("display-screen-customers");
    const phone = card.getByRole("checkbox", { name: "Phone" });
    const count = page.getByTestId("display-count-customers");
    await expect(page.getByTestId("display-settings")).toBeVisible();
    await expect(count).toHaveText("5 of 5 shown");
    try {
      const unticked = settingsSaved(page);
      await phone.uncheck();
      await expect(count).toHaveText("4 of 5 shown");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
      await unticked;

      await page.goto("/customers");
      if (width < 768) {
        // Phones: the View switcher is hidden and the page always renders cards (no table headers).
        const nameCells = page.locator('table[data-view="cards"] td[data-label="Name"]');
        const phoneCells = page.locator('table[data-view="cards"] td[data-label="Phone"]');
        await expect(nameCells.first()).toBeVisible();
        await expect(phoneCells).toHaveCount(0);
        await page.reload();
        await expect(nameCells.first()).toBeVisible();
        await expect(phoneCells).toHaveCount(0);
      } else {
        await page.getByRole("button", { name: "List", exact: true }).click();
        await expect(page.locator('table[data-view="list"]')).toBeVisible();
        await expect(page.getByRole("columnheader", { name: "Name", exact: true })).toBeVisible();
        await expect(page.getByRole("columnheader", { name: "Phone", exact: true })).toHaveCount(0);
        await page.reload();
        await expect(page.getByRole("columnheader", { name: "Name", exact: true })).toBeVisible();
        await expect(page.getByRole("columnheader", { name: "Phone", exact: true })).toHaveCount(0);
      }

      await page.goto("/settings");
      await expect(phone).not.toBeChecked();
      const reset = settingsSaved(page);
      await card.getByRole("button", { name: "Reset Customers to default" }).click();
      await expect(phone).toBeChecked();
      await expect(count).toHaveText("5 of 5 shown");
      await reset;
      await page.goto("/customers");
      if (width < 768) await expect(page.locator('table[data-view="cards"] td[data-label="Phone"]').first()).toBeVisible();
      else await expect(page.getByRole("columnheader", { name: "Phone", exact: true })).toBeVisible();
    } finally {
      // Put every column back before the next spec on this database: the reset only acts once the settings have loaded and it
      // saves in the background, so wait for the page, then confirm the saved state after a reload.
      await page.goto("/settings");
      await expect(page.getByTestId("display-settings")).toBeVisible();
      await expect(count).toHaveText(/of 5 shown/);
      await page.getByRole("button", { name: "Reset all to default" }).click();
      await expect(count).toHaveText("5 of 5 shown");
      await expect.poll(async () => { await page.reload(); return count.textContent(); }, { timeout: 20_000 }).toBe("5 of 5 shown");
    }
  });
}
