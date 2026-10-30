/**
 * Admin > Users > "Send password reset e-mail" (E5), end to end: an admin who has passed the second step e-mails a member the same
 * "reset your password" message Forgot password sends. The e-mail is caught by the local stack's mail catcher (never sent anywhere); the
 * link in it opens the choose-a-password page. The button is absent on the admin's own row, disabled for a login whose sign-in is off,
 * and an office login never sees the Users page at all. Synthetic people only.
 *
 * The route needs the admin at aal2 whatever REQUIRE_ADMIN_MFA says, so the admin here is a new alpha admin who enrols an authenticator
 * through the Auth API and enters the code on /mfa (the same set-up as tests/e2e/identity.spec.ts).
 */
import { expect, test, type Page } from "@playwright/test";

import { generatePassword } from "@/lib/password";

import { adminClient, signedInClient } from "../support/fixtures";
import { enrolTotp, totpCode } from "../support/totp";
import { asSeparateDevice, signIn, world } from "./helpers";

const w = world();
const MAIL = process.env.TEST_MAILPIT_URL ?? "http://127.0.0.1:54324";
let n = 0;

/** A login (service role) that belongs to alpha alone, with a display name, as the Users page lists it. */
async function alphaLogin(prefix: string, fullName: string, role: "admin" | "office" | "workshop") {
  n += 1;
  const email = `${prefix}${n}.${w.runId}@example.test`;
  const password = generatePassword(14);
  const admin = adminClient();
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name: fullName } });
  if (error || !data.user) throw new Error(error?.message);
  const added = await admin.rpc("add_member", { p_org: w.tenants.alpha.id, p_email: email, p_role: role });
  if (added.error) throw new Error(added.error.message);
  return { id: data.user.id, email, password, fullName };
}

/** A new alpha admin who has passed the second step in the browser (aal2): enrols a TOTP factor, signs in, enters the code on /mfa. */
async function aal2AdminOfAlpha(page: Page) {
  const person = await alphaLogin("resetadmin", "Reset Admin", "admin");
  const { secret } = await enrolTotp(await signedInClient(person));
  // A fresh 30-second window, so the code entered below is not the one used to enrol.
  const used = totpCode(secret);
  while (totpCode(secret) === used) await page.waitForTimeout(1000);
  await asSeparateDevice(page);
  await page.goto("/login");
  await page.getByLabel("Username or email").fill(person.email);
  await page.getByLabel("Password", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL(/\/(select-role|dashboard|mfa)/, { timeout: 45_000 });
  await page.goto("/mfa");
  await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
  await page.getByLabel("6-digit code").fill(totpCode(secret));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL(/\/(dashboard|select-role)/, { timeout: 30_000 });
  return person;
}

/** The local mail catcher (Mailpit): messages addressed to `email`, newest first. */
async function messagesTo(email: string) {
  const response = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
  const body = (await response.json()) as { messages: Array<{ ID: string; Subject: string }> };
  return body.messages;
}

/** The link in the recovery e-mail sent to `email` (waits for it to arrive). */
async function recoveryLink(email: string) {
  let id = "";
  await expect.poll(async () => { id = (await messagesTo(email))[0]?.ID ?? ""; return id; }, { timeout: 30_000 }).not.toBe("");
  const message = (await (await fetch(`${MAIL}/api/v1/message/${id}`)).json()) as { Text: string; HTML: string };
  const match = /https?:\/\/[^\s"<>]*\/auth\/v1\/verify\?[^\s"<>]+/.exec(`${message.Text}\n${message.HTML}`);
  expect(match, "the reset e-mail holds a link").not.toBeNull();
  return match![0].replace(/&amp;/g, "&");
}

const userRow = (page: Page, email: string) => page.getByTestId("user-row").filter({ hasText: email });

test("admin e-mails a member a reset link: button on others, not on self, disabled when sign-in is off; the e-mail's link opens Choose your password", async ({ browser, page, baseURL }) => {
  test.setTimeout(240_000);
  const me = await aal2AdminOfAlpha(page);
  const target = await alphaLogin("jreset", "Reset Target", "office");
  const leaver = await alphaLogin("jleaver", "Reset Leaver", "office");

  // The leaver's sign-in is switched off the way the screen does it (needs the same aal2 session).
  const off = await page.request.post("/api/admin/users/sign-in", { headers: { origin: baseURL! }, data: { user_id: leaver.id, enabled: false } });
  expect(off.status()).toBe(200);

  await page.goto("/admin/users");
  await expect(page.getByRole("heading", { name: "User Management" })).toBeVisible();
  await expect(userRow(page, target.email)).toBeVisible();

  // Not on the admin's own row (they use Forgot password on the sign-in page).
  await expect(userRow(page, me.email)).toBeVisible();
  await expect(userRow(page, me.email).getByTestId("send-reset-email")).toHaveCount(0);

  // On a normal member's row, once the page has checked who can sign in.
  const button = userRow(page, target.email).getByTestId("send-reset-email");
  await expect(button).toHaveText(/Send password reset e-mail/);
  await expect(button).toBeEnabled({ timeout: 30_000 });

  // Disabled, with the reason, for a login whose sign-in is off.
  const leaverRow = userRow(page, leaver.email);
  await expect(leaverRow.getByTestId("sign-in-disabled")).toBeVisible({ timeout: 30_000 });
  const leaverButton = leaverRow.getByTestId("send-reset-email");
  await expect(leaverButton).toBeVisible();
  await expect(leaverButton).toBeDisabled();
  await expect(leaverButton).toHaveAttribute("title", /can sign in/);

  // Clicking asks first; cancelling sends nothing.
  page.once("dialog", (dialog) => { expect(dialog.message()).toContain(target.fullName); void dialog.dismiss(); });
  await button.click();
  await page.waitForTimeout(1500);
  expect(await messagesTo(target.email)).toHaveLength(0);

  // Confirming sends it; the page says where, masked.
  page.once("dialog", (dialog) => { expect(dialog.message()).toContain(target.fullName); void dialog.accept(); });
  await button.click();
  await expect(page.getByText(/Password reset e-mail sent to j\*\*\*@example\.test/)).toBeVisible({ timeout: 30_000 });

  // The mail catcher got a recovery e-mail for that person only, and its link opens the choose-a-password page.
  const link = await recoveryLink(target.email);
  expect(link).toContain("type=recovery");
  expect(decodeURIComponent(link)).toContain("/auth/set-password");
  expect(await messagesTo(leaver.email)).toHaveLength(0);
  const context = await browser.newContext();
  try {
    const opener = await context.newPage();
    await opener.goto(link);
    await opener.waitForURL(/\/auth\/set-password/, { timeout: 30_000 });
    await expect(opener.getByRole("heading", { name: "Choose your password" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("an office login does not see the Send password reset e-mail button, and the route refuses it", async ({ page, baseURL }) => {
  const office = w.tenants.alpha.users.office;
  await signIn(page, office);
  await page.goto("/admin/users");
  await expect(page.getByRole("heading", { name: "Access Denied" })).toBeVisible();
  await expect(page.getByTestId("user-row")).toHaveCount(0);
  await expect(page.getByTestId("send-reset-email")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Send password reset e-mail/ })).toHaveCount(0);

  const refused = await page.request.post("/api/admin/users/reset-link", { headers: { origin: baseURL! }, data: { userId: w.tenants.alpha.users.workshop.id } });
  expect([401, 403]).toContain(refused.status());
  expect(await messagesTo(w.tenants.alpha.users.workshop.email)).toHaveLength(0);
});
