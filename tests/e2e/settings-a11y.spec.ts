/**
 * Settings page accessibility: every text field on Company details has a visible name a screen reader and getByRole can find, and
 * each "Works" label on the working-hours days is fully visible (not clipped) at 1280, 1024, 820 and 390 px.
 *
 * Synthetic data only (alpha tenant of the synthetic world). The world is read inside the tests, never at import.
 */
import { expect, test, type Page } from "@playwright/test";

import { signIn, world } from "./helpers";

/** Visible label text of each text field and textarea in Company details, with its role (all textboxes). */
const NAMED_FIELDS = [
  "Trading name",
  "Name on documents *",
  "Address (one line per row) *",
  "Phone",
  "Fax",
  "Email",
  "Website",
  "Sign-in tagline",
  "Eyebrow line (dark style)",
  "Default quote terms",
  "Default invoice terms",
] as const;

async function openSettings(page: Page) {
  await signIn(page, world().tenants.alpha.users.admin);
  await page.goto("/settings");
  await expect(page.getByTestId("company-details-form")).toHaveAttribute("data-loaded", "true");
}

test("Settings > Company details: every text field is found by its visible label", async ({ page }) => {
  await openSettings(page);
  for (const name of NAMED_FIELDS) {
    await expect(page.getByRole("textbox", { name, exact: true })).toBeVisible();
  }
  // The VAT number label gains a * when the company is VAT registered.
  await expect(page.getByRole("textbox", { name: /^VAT number/ })).toBeVisible();
});

test("Settings > Workshop Email: the email field is found by its label", async ({ page }) => {
  await openSettings(page);
  await expect(page.getByRole("textbox", { name: "Workshop Email", exact: true })).toBeVisible();
});

for (const width of [1280, 1024, 820, 390]) {
  test(`Settings > Working hours: each "Works" label is fully visible at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openSettings(page);
    const works = page.getByTestId("working-hours-days").getByText("Works", { exact: true });
    await expect(works).toHaveCount(7);
    for (const label of await works.all()) {
      await expect(label).toBeVisible();
      const { scrollWidth, clientWidth } = await label.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
      expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 1);
    }
  });
}
