/**
 * Password recovery, end to end: "Forgot password?" on the sign-in page, the reset e-mail (caught by the local stack's mail
 * catcher, never sent anywhere), the link, choosing a new password, signing in with it, the old password no longer working,
 * and the SAME link refused when it is used again. Synthetic person only.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";

import { generatePassword } from "@/lib/password";
import { adminClient } from "../support/fixtures";
import { asSeparateDevice, signIn, world } from "./helpers";

const w = world();
const MAIL = process.env.TEST_MAILPIT_URL ?? "http://127.0.0.1:54324";

/** The local mail catcher (Mailpit): messages addressed to `email`, newest first. */
async function messagesTo(email: string) {
  const response = await fetch(`${MAIL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
  const body = (await response.json()) as { messages: Array<{ ID: string; Subject: string }> };
  return body.messages;
}

async function resetLink(email: string) {
  let id = "";
  await expect.poll(async () => { id = (await messagesTo(email))[0]?.ID ?? ""; return id; }, { timeout: 30_000 }).not.toBe("");
  const message = (await (await fetch(`${MAIL}/api/v1/message/${id}`)).json()) as { Text: string; HTML: string };
  const match = /https?:\/\/[^\s"<>]*\/auth\/v1\/verify\?[^\s"<>]+/.exec(`${message.Text}\n${message.HTML}`);
  expect(match, "the reset e-mail holds a link").not.toBeNull();
  return match![0].replace(/&amp;/g, "&");
}

const signInStatus = async (request: APIRequestContext, email: string, password: string) =>
  (await request.post("/api/auth/signin", { headers: { "x-real-ip": `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }, data: { identifier: email, password } })).status();

test("forgot password: e-mail, link, new password works, old one doesn't, the same link can't be used twice", async ({ browser, page, baseURL }) => {
  test.setTimeout(180_000);
  // A person made by the admin screen's own route (so the run's clean-up removes them), with a password they know.
  await signIn(page, w.tenants.alpha.users.admin);
  const email = `recover.${w.runId}@example.test`;
  const oldPassword = generatePassword(14);
  const created = await page.request.post("/api/admin/users", { headers: { origin: baseURL! }, data: { email, full_name: "Recover Person", role: "office", password: oldPassword, must_change_password: false } });
  expect(created.status()).toBe(201);
  await fetch(`${MAIL}/api/v1/messages`, { method: "DELETE" });

  // 1. Forgot password, from the sign-in page.
  const context = await browser.newContext();
  const visitor = await context.newPage();
  await asSeparateDevice(visitor);
  await visitor.goto("/login");
  await visitor.getByLabel("Username or email").fill(email);
  await visitor.getByRole("button", { name: /Forgot password/i }).click();
  await expect(visitor.getByText("If that account exists, we've sent a password reset email")).toBeVisible();

  // 2. The link in the e-mail opens the choose-a-password page.
  const link = await resetLink(email);
  expect(link).toContain("type=recovery");
  const opener = await browser.newContext();
  const first = await opener.newPage();
  await first.goto(link);
  await first.waitForURL(/\/auth\/set-password/, { timeout: 30_000 });
  await expect(first.getByRole("heading", { name: "Choose your password" })).toBeVisible();
  const newPassword = generatePassword(16);
  await first.getByLabel("New password").fill(newPassword);
  await first.getByLabel("Confirm password").fill(newPassword);
  await first.getByRole("button", { name: "Save password and continue" }).click();
  await first.waitForURL(/\/dashboard/, { timeout: 30_000 });

  // 3. The new password works; the old one is refused.
  const request = visitor.request;
  expect(await signInStatus(request, email, newPassword)).toBe(200);
  expect(await signInStatus(request, email, oldPassword)).toBe(401);

  // 4. The same link, used again in a clean browser, is refused: no session, and the page says so.
  const again = await browser.newContext();
  const reuse = await again.newPage();
  await reuse.goto(link);
  await reuse.waitForURL(/\/auth\/set-password/, { timeout: 30_000 });
  await expect(reuse.getByText(/invalid or has expired|expired|invalid/i).first()).toBeVisible();
  await expect(reuse.getByLabel("New password")).toHaveCount(0);
  await reuse.goto("/dashboard");
  await expect(reuse).toHaveURL(/\/login/);

  // The password was not changed by the second attempt.
  expect(await signInStatus(request, email, newPassword)).toBe(200);
  const profile = (await adminClient().from("user_profiles").select("id").eq("email", email).single()).data!;
  expect(profile.id).toBeTruthy();

  for (const c of [context, opener, again]) await c.close();
});
