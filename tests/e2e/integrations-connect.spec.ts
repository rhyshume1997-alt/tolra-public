/**
 * Admin > Integrations (migration 107, E7): the Microsoft 365 card. With no app details entered by the platform owner (none in CI), the
 * card says "Not set up yet" and Connect stays disabled; nothing is sent anywhere. Company beta's admin; nothing is written.
 */
import { expect, test } from "@playwright/test";

import { signIn, world } from "./helpers";

test("the Microsoft 365 card: no mailbox connected, Connect disabled until the owner enters the app details", async ({ page }) => {
  const w = world();
  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/admin/integrations");
  const card = page.getByTestId("microsoft-card");
  await expect(card.getByTestId("microsoft-status")).toContainText("No mailbox connected");
  await expect(card.getByTestId("microsoft-not-set-up")).toHaveText("Not set up yet: the owner must enter the Microsoft 365 app details.");
  await expect(card.getByRole("button", { name: "Connect Microsoft 365" })).toBeDisabled();
  // The Xero card's own line is still the only "Not connected" on the page (integrations-send-log.spec.ts relies on that).
  await expect(page.getByText("Not connected")).toHaveCount(1);
});
