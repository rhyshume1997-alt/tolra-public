/**
 * The public home page and /privacy (middleware.ts): signed out, "/" is the marketing page and /privacy opens, while a protected page
 * still goes to /login; signed in, "/" goes to /dashboard as it always did, /privacy still opens and /login goes to /dashboard.
 */
import { expect, test } from "@playwright/test";

import { signIn, world } from "./helpers";

const w = world();

test("signed out: / is the public home page, /privacy opens, /dashboard still asks for sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("heading", { level: 1, name: "Quotes, jobs and invoices for small CNC and fabrication shops" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Privacy", exact: true }).first()).toHaveAttribute("href", "/privacy");

  await page.goto("/privacy");
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { level: 1, name: "Privacy" })).toBeVisible();

  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login(\?|$)/);
});

test("signed in: / goes to the dashboard, /privacy still opens, /login goes to the dashboard", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.office);

  await page.goto("/");
  await expect(page).toHaveURL(/\/dashboard(\?|$)/);

  await page.goto("/privacy");
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole("heading", { level: 1, name: "Privacy" })).toBeVisible();

  await page.goto("/login");
  await expect(page).toHaveURL(/\/dashboard(\?|$)/);
});
