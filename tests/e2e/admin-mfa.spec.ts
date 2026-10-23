/**
 * Admin two-step sign-in in the browser. Uses a second copy of the app started with REQUIRE_ADMIN_MFA=true (see
 * playwright.config.ts); the main server leaves it off so the rest of the suite signs in with a password alone.
 *
 * An admin with only a password is sent to the set-up screen from every page and refused by the API; after setting up an
 * authenticator app (the code is worked out here from the key the screen shows, as a phone app would) they get in, and at the
 * next sign-in they are asked for a code. Office staff are never asked.
 *
 * Onboarding (migration 065), on the MAIN server where REQUIRE_ADMIN_MFA is off: an admin who creates another admin is told,
 * there and then, that the new admin must set up an authenticator app; Admin > Users shows who has; and the new admin is sent to
 * the set-up screen (with the same message) at their first sign-in until they have set it up, then gets in.
 */
import { expect, test, type Page } from "@playwright/test";

import { totpCode } from "../support/totp";
import { asSeparateDevice, signIn, world } from "./helpers";
import { E2E_MFA_PORT } from "./paths";

const w = world();
const base = `http://localhost:${E2E_MFA_PORT}`;

async function passwordSignIn(page: Page, user: { email: string; password: string }) {
  await asSeparateDevice(page);
  await page.goto(`${base}/login`);
  await page.getByLabel("Username or email").fill(user.email);
  await page.getByLabel("Password", { exact: true }).fill(user.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

const api = (page: Page, path: string) => page.request.post(`${base}${path}`, { headers: { origin: base }, data: {} });

test("admin: sent to set-up from every page, refused by the API, then in after the code; asked for a code next time", async ({ page }) => {
  const admin = w.tenants.beta.users.admin;
  await passwordSignIn(page, admin);
  await page.waitForURL(/\/mfa/, { timeout: 45_000 }).catch(async () => {
    // Admins choose a view first.
    await page.getByRole("button", { name: "Continue as Admin" }).click();
    await page.waitForURL(/\/mfa/, { timeout: 30_000 });
  });
  await expect(page.getByRole("heading", { name: "Set up two-step sign-in" })).toBeVisible();

  // Nothing else opens, and the API says why.
  for (const path of ["/dashboard", "/settings", "/invoices", "/admin/users"]) {
    await page.goto(`${base}${path}`);
    await expect(page).toHaveURL(/\/mfa/);
  }
  const refused = await api(page, "/api/admin/alert-test");
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toMatchObject({ code: "mfa_required" });
  expect((await api(page, "/api/send-job/resolve")).status()).toBe(403);

  // Set up: the key is shown for people who can't scan; a wrong code is refused.
  await expect(page.getByAltText("QR code for your authenticator app")).toBeVisible();
  const secret = (await page.getByTestId("mfa-secret").textContent())!.trim();
  await page.getByLabel("6-digit code").fill("000000");
  await page.getByRole("button", { name: "Turn on and continue" }).click();
  await expect(page.getByText("That code didn't work")).toBeVisible();
  await page.getByLabel("6-digit code").fill(totpCode(secret));
  await page.getByRole("button", { name: "Turn on and continue" }).click();
  await page.waitForURL(/\/(dashboard|select-role)/, { timeout: 30_000 });

  await page.goto(`${base}/settings`);
  await expect(page).toHaveURL(/\/settings/);
  const allowed = await api(page, "/api/admin/alert-test");
  expect(allowed.status()).toBe(200);
  expect(await allowed.json()).toMatchObject({ sent: false, reason: "disabled" }); // past the guard; alerts are off here

  // Signing in again: password alone is not enough, the code screen has no QR code.
  // The open page is left first: with its cookies gone it would send itself to the sign-in page (the access recheck) mid-navigation.
  await page.goto("about:blank");
  await page.context().clearCookies();
  await passwordSignIn(page, admin);
  await page.waitForURL(/\/(mfa|select-role)/, { timeout: 45_000 });
  if (page.url().includes("/select-role")) await page.goto(`${base}/dashboard`);
  await expect(page).toHaveURL(/\/mfa/);
  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  await expect(page.getByAltText("QR code for your authenticator app")).toHaveCount(0);
  await page.getByLabel("6-digit code").fill("123456");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("That code didn't work")).toBeVisible();
  await page.getByLabel("6-digit code").fill(totpCode(secret));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/\/(dashboard|select-role)/, { timeout: 30_000 });
});

test("office staff are never asked for a code", async ({ page }) => {
  await passwordSignIn(page, w.tenants.beta.users.office);
  await page.waitForURL(/\/dashboard/, { timeout: 45_000 });
  await page.goto(`${base}/quotes`);
  await expect(page).toHaveURL(/\/quotes/);
  expect((await api(page, "/api/report-error")).status()).toBe(200);
});

test("onboarding with the switch off: a new admin is announced, shown as not set up, and sent to set up at first sign-in", async ({ page, browser }) => {
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/admin/users");
  await expect(page.getByTestId("admin-mfa-rule")).toBeVisible();

  const email = `newadmin.${w.runId}@example.test`;
  await page.getByRole("button", { name: "New user" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Full name").fill("New Admin");
  await dialog.getByLabel("Email").fill(email);
  await expect(dialog.getByTestId("admin-mfa-notice")).toHaveCount(0);
  await dialog.getByRole("combobox", { name: "Role", exact: true }).selectOption("admin");
  await expect(dialog.getByTestId("admin-mfa-notice")).toContainText("authenticator app");
  await dialog.getByText("Must change password at first sign-in").click();
  const password = await dialog.getByLabel("Password", { exact: true }).inputValue();
  await dialog.getByRole("button", { name: "Create user" }).click();
  await expect(page.getByRole("dialog").getByTestId("admin-mfa-notice")).toContainText("next sign-in");
  await page.getByRole("button", { name: "Done" }).click();
  const row = page.getByTestId("user-row").filter({ hasText: email });
  await expect(row.getByTestId("admin-mfa-status")).toHaveText("Two-step sign-in: not set up (asked at next sign-in)");

  // The new admin, on their own device: sent to set up, told why, then in.
  const device = await browser.newPage();
  await asSeparateDevice(device);
  await device.goto("/login");
  await device.getByLabel("Username or email").fill(email);
  await device.getByLabel("Password", { exact: true }).fill(password);
  await device.getByRole("button", { name: "Sign in", exact: true }).click();
  await device.waitForURL(/\/mfa\?enrol=1/, { timeout: 45_000 });
  await expect(device.getByTestId("mfa-new-admin")).toContainText("authenticator app");
  await device.goto("/settings");
  await expect(device).toHaveURL(/\/mfa\?enrol=1/);
  const secret = (await device.getByTestId("mfa-secret").textContent())!.trim();
  await device.getByLabel("6-digit code").fill(totpCode(secret));
  await device.getByRole("button", { name: "Turn on and continue" }).click();
  await device.waitForURL(/\/(dashboard|select-role)/, { timeout: 30_000 });
  await device.goto("/settings");
  await expect(device).toHaveURL(/\/settings/);
  await device.close();

  await page.reload();
  await expect(page.getByTestId("user-row").filter({ hasText: email }).getByTestId("admin-mfa-status")).toHaveText("Two-step sign-in: set up");
});
