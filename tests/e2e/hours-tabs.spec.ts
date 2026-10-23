/**
 * "Weekly hours" is one menu item with two tabs: Today (was "Daily Job Sheet") and This week (was "Weekly Hours"). "Job sheet" now
 * means only a job's own sheet.
 */
import { expect, test } from "@playwright/test";

import { signIn, world } from "./helpers";

const w = world();

test("one menu item, Weekly hours, with the tabs Today and This week", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/dashboard");
  await expect(page.getByRole("link", { name: "Weekly hours", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Daily Job Sheet" })).toHaveCount(0);

  await page.goto("/time");
  const tabs = page.getByRole("tablist", { name: "Weekly hours" });
  await expect(tabs.getByRole("tab", { name: "Today" })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab", { name: "This week" })).toHaveAttribute("aria-selected", "false");
  await expect(page.getByTestId("day-sheet")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Weekly hours", exact: true })).toBeVisible();

  await tabs.getByRole("tab", { name: "This week" }).click();
  await expect(page).toHaveURL(/\/time\/week/);
  await expect(page.getByTestId("week-review")).toBeVisible();
  await expect(tabs.getByRole("tab", { name: "This week" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { level: 1, name: "Weekly hours", exact: true })).toBeVisible();

  await tabs.getByRole("tab", { name: "Today" }).click();
  await expect(page).toHaveURL(/\/time$/);
  await expect(page.getByTestId("day-sheet")).toBeVisible();
});
