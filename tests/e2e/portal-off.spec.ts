/**
 * BOUNDARY (module 10): real disposable Portal-OFF server -> refusal without customer records or activation.
 * Run separately from portal-acceptance.spec.ts with CUSTOMER_PORTAL_ENABLED unset/false.
 * Shared harness, staff authentication, database security and feature defaults must remain unchanged.
 */
import { expect, test } from "@playwright/test";
import { verifyBackendIdentity } from "../support/fixtures";
import { asSeparateDevice } from "./helpers";

test.beforeAll(async () => {
  await verifyBackendIdentity();
  expect(process.env.CUSTOMER_PORTAL_ENABLED).not.toBe("true");
});

test("Portal OFF refuses every customer page even with a customer-shaped cookie", async ({ page, baseURL }) => {
  await asSeparateDevice(page);
  await page.context().addCookies([{ name: "__Host-tolra_portal", value: "A".repeat(43), url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
  for (const route of ["/portal","/portal/signin","/portal/quotes","/portal/jobs",`/portal/code/${"A".repeat(22)}`]) {
    const response = await page.goto(route);
    expect(response!.status(),route).toBe(404);
    await expect(page.getByTestId("portal-home")).toHaveCount(0);
    await expect(page.getByTestId("portal-quotes")).toHaveCount(0);
    await expect(page.getByTestId("portal-jobs")).toHaveCount(0);
    await expect(page).not.toHaveURL(/\/login/);
  }
});

test("Portal OFF code refusals expose no reason or authentication cookie", async ({ page, baseURL }) => {
  await asSeparateDevice(page);
  const refused = [];
  for (const code of ["12345678","87654321"]) {
    const response = await page.request.post("/api/portal/signin/verify", { form: { ref: "A".repeat(22), code }, headers: { origin: baseURL! }, maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(response.headers()["cache-control"]).toBe("no-store");
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect(await response.text()).toBe("");
    const location = new URL(response.headers().location,baseURL);
    expect(location.searchParams.get("c")).toMatch(/^[0-9a-f-]{36}$/);
    location.searchParams.delete("c");
    refused.push(location.pathname+location.search);
  }
  expect(refused[0]).toBe(refused[1]);
});
