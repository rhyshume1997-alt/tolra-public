/**
 * Error display and recovery on the auth pages (UI audit #30, #31, #32). Responses are faked with route interception, so no
 * real credentials are needed for the sign-in cases. Nothing here changes what the server reveals about accounts: a wrong
 * password still gets the one generic answer.
 */
import { expect, test, type Page } from "@playwright/test";

import { asSeparateDevice, signIn, world } from "./helpers";
import { E2E_MFA_PORT } from "./paths";

// Next's route announcer is always in the page with role="alert"; only the page's own alerts count here.
const pageAlert = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

async function submitLogin(page: Page) {
  await asSeparateDevice(page);
  await page.goto("/login");
  await page.getByLabel("Username or email").fill("nobody@example.test");
  await page.getByLabel("Password", { exact: true }).fill("not-a-real-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

const UNREACHABLE = "Can't reach Tolra right now. Check your connection and try again.";

test("#31 a network failure says it can't reach Tolra and offers Retry, which works once the network is back", async ({ page }) => {
  await page.route("**/api/auth/signin", (route) => route.abort("connectionrefused"));
  await submitLogin(page);
  await expect(page.getByText(UNREACHABLE)).toBeVisible();
  await expect(page.getByText("Invalid username or password")).toHaveCount(0);

  await page.unroute("**/api/auth/signin");
  await page.route("**/api/auth/signin", (route) => route.fulfill({ status: 401, json: { error: "Invalid username or password" } }));
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Invalid username or password.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
});

for (const status of [500, 503]) {
  test(`#31 a ${status} from the server is "can't reach" with Retry`, async ({ page }) => {
    await page.route("**/api/auth/signin", (route) => route.fulfill({ status, json: { error: "Sign-in is temporarily unavailable. Try again shortly." } }));
    await submitLogin(page);
    await expect(page.getByText(UNREACHABLE)).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  });
}

test("#31 wrong credentials (401) keep the existing message, with no Retry", async ({ page }) => {
  await page.route("**/api/auth/signin", (route) => route.fulfill({ status: 401, json: { error: "Invalid username or password" } }));
  await submitLogin(page);
  await expect(page.getByText("Invalid username or password.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
});

test("#31 too many attempts (429) keeps the server's message, with no Retry", async ({ page }) => {
  const message = "Too many sign-in attempts. Wait a few minutes and try again.";
  await page.route("**/api/auth/signin", (route) => route.fulfill({ status: 429, json: { error: message } }));
  await submitLogin(page);
  await expect(page.getByText(message)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
});

test("#30 a failed MFA set-up shows the error with Retry and Sign out, not 'One moment…' for ever", async ({ page }) => {
  const base = `http://localhost:${E2E_MFA_PORT}`;
  const admin = world().tenants.alpha.users.admin;
  // A different admin from admin-mfa.spec.ts, which leaves the beta admin with a verified factor (the code screen, not set-up).
  // Starting the enrolment is the POST to /auth/v1/factors.
  await page.route("**/auth/v1/factors", (route) => (route.request().method() === "POST" ? route.abort("connectionrefused") : route.continue()));
  await asSeparateDevice(page);
  await page.goto(`${base}/login`);
  await page.getByLabel("Username or email").fill(admin.email);
  await page.getByLabel("Password", { exact: true }).fill(admin.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/(mfa|select-role)/, { timeout: 45_000 });
  if (page.url().includes("/select-role")) {
    await page.getByRole("button", { name: "Continue as Admin" }).click();
    await page.waitForURL(/\/mfa/, { timeout: 30_000 });
  }
  await expect(pageAlert(page)).toContainText("Couldn't start the set-up");
  await expect(page.getByText("One moment…")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  await page.unroute("**/auth/v1/factors");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "Set up two-step sign-in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("#32 a failed company-list load offers Retry as well as Sign out", async ({ page }) => {
  // Any signed-in person can open the picker page; the list comes from my_organizations().
  await signIn(page, world().tenants.alpha.users.office);
  let fail = true;
  await page.route("**/rest/v1/rpc/my_organizations", (route) => (fail ? route.abort("connectionrefused") : route.continue()));
  await page.goto("/choose-company");
  await expect(pageAlert(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
  fail = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(pageAlert(page)).toHaveCount(0);
});

test("review: a successful sign-in whose session can't be read is 'can't reach' with Retry, never 'Invalid username or password'", async ({ page }) => {
  // The server says ok but sets no session, so the browser's getUser() finds no user.
  await page.route("**/api/auth/signin", (route) => route.fulfill({ status: 200, json: { ok: true } }));
  await submitLogin(page);
  await expect(page.getByText(UNREACHABLE)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByText("Invalid username or password")).toHaveCount(0);
});

test("review: a failed role lookup after sign-in is 'can't reach' with Retry and does not route an admin to the dashboard", async ({ page }) => {
  const base = `http://localhost:${E2E_MFA_PORT}`;
  const admin = world().tenants.beta.users.admin;
  // The first user_profiles read (id, active) goes through; the role / secondary_role read fails.
  await page.route("**/rest/v1/user_profiles*", (route) => (route.request().url().includes("secondary_role") ? route.abort("connectionrefused") : route.continue()));
  await asSeparateDevice(page);
  await page.goto(`${base}/login`);
  await page.getByLabel("Username or email").fill(admin.email);
  await page.getByLabel("Password", { exact: true }).fill(admin.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(UNREACHABLE)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.waitForTimeout(500);
  expect(page.url()).toContain("/login");
  await expect(page.getByText("Invalid username or password")).toHaveCount(0);
});

test("review: a 503 on the first profile lookup is 'can't reach' with Retry (not 'Contact your administrator'), and Retry signs in once it recovers", async ({ page }) => {
  const base = `http://localhost:${E2E_MFA_PORT}`;
  const admin = world().tenants.beta.users.admin;
  let failing = true;
  // PostgREST reports the status on the HTTP response, with a body that carries no status of its own.
  await page.route("**/rest/v1/user_profiles*", (route) =>
    failing ? route.fulfill({ status: 503, contentType: "application/json", json: { message: "Service unavailable" } }) : route.continue());
  await asSeparateDevice(page);
  await page.goto(`${base}/login`);
  await page.getByLabel("Username or email").fill(admin.email);
  await page.getByLabel("Password", { exact: true }).fill(admin.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByText(UNREACHABLE)).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByText("Contact your administrator")).toHaveCount(0);
  expect(page.url()).toContain("/login");
  failing = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page).not.toHaveURL(/\/login/);
});

test("review: MFA Sign out with the network down stays on the page, says so, and leaves only once the session is really gone", async ({ page }) => {
  const base = `http://localhost:${E2E_MFA_PORT}`;
  const admin = world().tenants.beta.users.admin;
  await asSeparateDevice(page);
  await page.goto(`${base}/login`);
  await page.getByLabel("Username or email").fill(admin.email);
  await page.getByLabel("Password", { exact: true }).fill(admin.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/(mfa|select-role)/, { timeout: 45_000 });
  if (page.url().includes("/select-role")) {
    await page.getByRole("button", { name: "Continue as Admin" }).click();
    await page.waitForURL(/\/mfa/, { timeout: 30_000 });
  }
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();

  // The sign-out call can't reach the server: the session is still live, so the page must not pretend it ended.
  await page.route("**/auth/v1/logout*", (route) => route.abort("connectionrefused"));
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByTestId("mfa-signout-error")).toHaveText("Sign-out failed — try again.");
  await page.waitForTimeout(1000);
  expect(page.url()).toContain("/mfa");

  // Network back: the same button now ends the session and leaves.
  await page.unroute("**/auth/v1/logout*");
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  await page.goto(`${base}/dashboard`);
  await expect(page).toHaveURL(/\/login/);
});
