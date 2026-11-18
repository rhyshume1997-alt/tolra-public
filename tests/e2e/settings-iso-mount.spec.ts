/**
 * Settings page with the ISO templates switch mounted (app/(dashboard)/settings/page.tsx, next to the Job reports card). Proves the
 * cards the page showed before are still there for an admin, with the new switch present and off by default, and that an office user
 * still gets exactly what they got before: /settings is admin-only in middleware.ts, so they are sent to the dashboard and no switch shows.
 * Switch behaviour itself: tests/e2e/iso-templates.spec.ts.
 *
 * Synthetic data only. Own company (createSoloTenant) so the switch is read from a company with no ISO marker.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { createSoloTenant } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

/** Card titles the page rendered before this mount (settings/page.tsx titles, Job reports and Print layout cards). */
const EXISTING_CARDS = ["Company details", "Archive", "Quote to job", "Customer sign-off", "Job reports", "Print layout", "Year-end export", "Menu Sections", "Display"];

const cardTitle = (page: Page, name: string) => page.locator('[data-slot="card-title"]').filter({ hasText: new RegExp(`^\\s*${name}\\s*$`) });

test("admin settings page still shows its existing cards and now shows the ISO templates switch (off by default)", async ({ page }) => {
  const solo = await createSoloTenant(w.runId, `isomount-${randomUUID().slice(0, 6)}`, undefined, { salesOrders: false });
  await signIn(page, solo.admin);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByTestId("company-details-form")).toHaveAttribute("data-loaded", "true");
  for (const name of EXISTING_CARDS) await expect(cardTitle(page, name), name).toBeVisible();
  await expect(page.getByTestId("iso-switch-card")).toBeVisible();
  await expect(page.getByRole("switch", { name: "ISO 9001 draft templates" })).toHaveAttribute("aria-checked", "false");
});

test("office user: settings page behaviour unchanged and no ISO switch", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/settings");
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByTestId("iso-switch-card")).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "ISO 9001 draft templates" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toHaveCount(0);
});
