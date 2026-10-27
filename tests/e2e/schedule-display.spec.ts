/**
 * Machine Schedule show / hide (Rhys, Fri 23 Oct): the Show / hide picker removes an element from the screen, in the 1-week and 2-week
 * views alike, and the choice is remembered after a reload. Checked at laptop (1280) and phone (390) widths.
 */
import { expect, test } from "@playwright/test";

import { signIn, world } from "./helpers";

const w = world();

test.describe.configure({ mode: "serial" });

for (const width of [1280, 390]) {
  test(`hiding the colour legend removes it from the 1-week and 2-week views and is remembered after reload (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await signIn(page, w.tenants.alpha.users.admin);
    await page.goto("/schedule");
    const legend = page.getByTestId("schedule-legend");
    const toggle = page.getByRole("button", { name: "Show / hide" });
    await expect(toggle).toBeVisible();
    for (const span of ["2 weeks", "1 week"]) {
      await page.getByRole("button", { name: span, exact: true }).click();
      await expect(legend, `${span} shows the legend by default`).toBeVisible();
    }

    await toggle.click();
    // The machine name and the time axis are locked on.
    await expect(page.getByRole("menuitemcheckbox", { name: "Machine name" })).toBeDisabled();
    await expect(page.getByRole("menuitemcheckbox", { name: "Day headers (time axis)" })).toBeDisabled();
    await page.getByRole("menuitemcheckbox", { name: "Colour legend" }).click();
    await page.keyboard.press("Escape");

    for (const span of ["1 week", "2 weeks"]) {
      await page.getByRole("button", { name: span, exact: true }).click();
      await expect(legend, `${span} no longer shows the legend`).toHaveCount(0);
      await expect(page.getByTestId("day-header").first()).toBeVisible();
    }

    await page.reload();
    for (const span of ["1 week", "2 weeks"]) {
      await page.getByRole("button", { name: span, exact: true }).click();
      await expect(page.getByTestId("day-header").first()).toBeVisible();
      await expect(legend, `${span} still hides the legend after reload`).toHaveCount(0);
    }

    // Put it back so later specs see the default screen.
    await page.getByRole("button", { name: "Show / hide" }).click();
    await page.getByRole("menuitemcheckbox", { name: "Colour legend" }).click();
    await page.keyboard.press("Escape");
    await expect(legend).toBeVisible();
  });
}
