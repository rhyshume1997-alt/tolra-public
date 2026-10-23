/**
 * Sign-in throttling (audit B0a: SEC6). Failures from one place can't lock the person out elsewhere, and correct
 * sign-ins never use up an account's budget. The test server has no proxy in front, so the caller IP comes from
 * x-real-ip, which the hosting platform sets in production.
 */
import { expect, test, type APIRequestContext } from "@playwright/test";

import { world } from "./helpers";

const w = world();

function attempt(request: APIRequestContext, ip: string, identifier: string, password: string) {
  return request.post("/api/auth/signin", { headers: { "x-real-ip": ip }, data: { identifier, password } });
}

test("ten failures from one address block that address only; the real person still signs in elsewhere", async ({ playwright, baseURL }) => {
  const victim = w.tenants.beta.users.viewer;
  const attacker = await playwright.request.newContext({ baseURL });
  for (let i = 0; i < 10; i += 1) expect((await attempt(attacker, "198.51.100.7", victim.email, "wrong-password-1")).status()).toBe(401);
  expect((await attempt(attacker, "198.51.100.7", victim.email, "wrong-password-1")).status()).toBe(429);
  expect((await attempt(attacker, "198.51.100.7", victim.email, victim.password)).status()).toBe(429);
  await attacker.dispose();

  const office = await playwright.request.newContext({ baseURL });
  expect((await attempt(office, "203.0.113.20", victim.email, victim.password)).status()).toBe(200);
  await office.dispose();
});

test("correct sign-ins don't count against the account", async ({ playwright, baseURL }) => {
  const user = w.tenants.beta.users.workshop;
  for (let i = 0; i < 12; i += 1) {
    const context = await playwright.request.newContext({ baseURL });
    expect((await attempt(context, "203.0.113.30", user.email, user.password)).status()).toBe(200);
    await context.dispose();
  }
});

test("failures spread over many addresses are capped per account, and the answer stays generic", async ({ playwright, baseURL }) => {
  const target = `nobody.${w.runId}@example.test`;
  const context = await playwright.request.newContext({ baseURL });
  for (let i = 0; i < 50; i += 1) {
    const response = await attempt(context, `192.0.2.${10 + (i % 6)}`, target, "guess");
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid username or password" });
  }
  expect((await attempt(context, "192.0.2.99", target, "guess")).status()).toBe(429);
  await context.dispose();
});
