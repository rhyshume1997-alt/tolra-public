/**
 * Admin > Integrations, guided setup (W-F4): four cards in one frame, in this order (AI, Xero, Microsoft 365, Resend), each with its own
 * activation line; the e-mail guide sits above Microsoft 365 and Resend; "More" keeps the earlier cards; the page reads at phone width; and
 * a non-admin never sees it. Read only: nothing here connects, saves a key or flips a switch, so no provider is reached and no data changes.
 *
 * What is asserted about the switches: AI and Xero are Off in the test world (no key saved, nothing connected, no release). Microsoft 365
 * and Resend have no switch (the server has none): the spec asserts no switch is rendered and a "Sending: ..." status line is, not a fixed
 * wording, because Resend can legitimately read "ready" when the test server's mock key and sender are set.
 * Written to the conventions of integrations-send-log.spec.ts; it runs in CI only.
 */
import { expect, test } from "@playwright/test";

import { signIn, world } from "./helpers";
import { SECRET_IN_PAGE } from "../support/secret-patterns";

const CARDS = ["ai", "xero", "microsoft", "resend"] as const;

test("an admin sees the four setup cards in order, each Off or disabled, the e-mail guide above the two e-mail cards, and More", async ({ page }) => {
  await signIn(page, world().tenants.beta.users.admin);
  await page.goto("/admin/integrations");
  await expect(page.getByRole("heading", { name: "Integrations", exact: true })).toBeVisible();

  const ids = page.locator('[data-testid^="setup-card-"]');
  await expect(ids).toHaveCount(4);
  expect(await ids.evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")))).toEqual(CARDS.map((id) => `setup-card-${id}`));
  await expect(page.locator('[id^="setup-title-"]')).toHaveText(["AI", "Xero", "Microsoft 365", "Resend"]);

  // AI and Xero: Off, and the switch is not on. Microsoft 365 and Resend: no switch at all, only a "Sending: ..." status line.
  for (const id of ["ai", "xero"] as const) {
    await expect(page.getByTestId(`activation-badge-${id}`)).toContainText("Off");
    await expect(page.getByTestId(`activation-${id}`).getByRole("switch")).toHaveAttribute("aria-checked", "false");
  }
  for (const id of ["microsoft", "resend"] as const) {
    await expect(page.getByTestId(`setup-card-${id}`).getByRole("switch")).toHaveCount(0);
    await expect(page.getByTestId(`activation-status-${id}`)).toContainText("Sending:");
  }

  // The e-mail guide is above both e-mail cards and below Xero.
  const y = async (testId: string) => (await page.getByTestId(testId).boundingBox())!.y;
  expect(await y("email-choice-guide")).toBeGreaterThan(await y("setup-card-xero"));
  expect(await y("email-choice-guide")).toBeLessThan(await y("setup-card-microsoft"));
  expect(await y("email-choice-guide")).toBeLessThan(await y("setup-card-resend"));

  // More: after the four cards, and it keeps the earlier tools (the accountant's link on the Xero tools card, the send log's place).
  const more = page.getByTestId("integrations-more");
  await expect(more.getByRole("heading", { name: "More", exact: true })).toBeVisible();
  expect(await y("integrations-more")).toBeGreaterThan(await y("setup-card-resend"));
  await expect(more.getByText("Xero: send now and the accountant's link")).toBeVisible();

  // No secret in the page.
  expect(await page.content()).not.toMatch(SECRET_IN_PAGE);
});

test("at phone width the cards stack and the page does not scroll sideways", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, world().tenants.beta.users.admin);
  await page.goto("/admin/integrations");
  await expect(page.getByTestId("setup-card-resend")).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("office is sent away from the page", async ({ page }) => {
  await signIn(page, world().tenants.beta.users.office);
  await page.goto("/admin/integrations");
  await expect(page).toHaveURL(/\/dashboard/);
});
