import { readFileSync, mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { totpCode } from "../support/totp";
import type { SyntheticWorld } from "../support/fixtures";

// No imported global E2E setup: this is the persistent, disposable PQ world.
function accounts(): { world: SyntheticWorld; totpSecret: string } {
  return JSON.parse(readFileSync("tests/pq/.runtime/accounts.json", "utf8"));
}
async function login(page: Page, role: "admin" | "workshop") {
  const a = accounts(); const user = a.world.tenants.alpha.users[role];
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/(mfa|select-role|dashboard)/);
  if (page.url().includes("/mfa")) {
    await page.getByLabel("6-digit code").fill(totpCode(a.totpSecret));
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.waitForURL(/\/(select-role|dashboard)/);
  }
  if (page.url().includes("/select-role")) {
    await page.getByRole("button", { name: role === "admin" ? "Continue as Admin" : "Continue as Workshop" }).click();
  }
  await expect(page).toHaveURL(/\/dashboard/);
}
test("synthetic desktop PQ pages and workshop board can be opened and photographed", async ({ page }) => {
  // Never leave loopback, even if somebody accidentally clicks an external link.
  await page.context().route("**/*", async route => {
    const u = new URL(route.request().url());
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname)) await route.continue();
    else await route.abort("blockedbyclient");
  });
  mkdirSync("tests/pq/screenshots", { recursive: true });
  await login(page, "admin");
  const screens = [
    ["customers", "FAKE Pump Customer Ltd"],
    ["quotes", "QUO-PQ-0001"],
    ["sales-orders", "FAKE-CUSTOMER-PO-0001"],
    ["jobs", "J-PQ-0001"],
    ["delivery-notes", "DLN-PQ-0001"],
    ["invoices", "INV-PQ-0001"],
    ["approval", "SYNTHETIC PQ: invoice approval draft"],
  ];
  for (const [route, text] of screens) {
    await page.goto(`/${route}`);
    await expect(page.getByText(text, { exact: false }).first()).toBeVisible();
    await page.screenshot({ path: `tests/pq/screenshots/${route}.png`, fullPage: true });
  }
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: /Settings/ }).first()).toBeVisible();
  await page.screenshot({ path: "tests/pq/screenshots/settings.png", fullPage: true });
  await page.context().clearCookies();
  await login(page, "workshop");
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/jobs");
  await expect(page.getByText("J-PQ-0001", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: "tests/pq/screenshots/workshop-jobs.png", fullPage: true });
});
