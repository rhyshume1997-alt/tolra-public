/**
 * Platform behaviour kept across the framework upgrade (audit B9: SEC11): the install manifest (always Tolra) and its
 * icons, the favicon rewrite, the versioned service worker, and the offline page served by it.
 */
import { expect, test } from "@playwright/test";

import { signIn, world } from "./helpers";

const w = world();

test("manifest, icons and favicon for a signed-in member", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.admin);
  const manifest = await page.request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()["content-type"]).toContain("application/manifest+json");
  const body = await manifest.json();
  // The installed app is Tolra for every company: name, theme and icon don't depend on who is signed in.
  expect(body).toMatchObject({ name: "Tolra", short_name: "Tolra", theme_color: "#0b1626", start_url: "/dashboard?source=pwa", display: "standalone" });
  expect(body.icons.map((i: { sizes: string; purpose: string }) => `${i.sizes} ${i.purpose}`)).toEqual(["192x192 any", "512x512 any", "192x192 maskable", "512x512 maskable"]);
  for (const size of [192, 512, 180]) {
    const icon = await page.request.get(`/api/pwa-icon?size=${size}`);
    expect(icon.status()).toBe(200);
    expect(icon.headers()["content-type"]).toContain("image/png");
    // PNG header: width and height at bytes 16-23.
    const png = await icon.body();
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
  }
  await page.goto("/dashboard");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute("href", /\/api\/pwa-icon\?size=180/);
  const favicon = await page.request.get("/favicon.ico");
  expect(favicon.status()).toBe(200);
  expect(favicon.headers()["content-type"]).toMatch(/^image\//);
});

test("service worker: versioned, never cached by HTTP, installs, and serves the offline page", async ({ page, context }) => {
  const sw = await page.request.get("/sw.js");
  expect(sw.status()).toBe(200);
  expect(sw.headers()["content-type"]).toContain("javascript");
  expect(sw.headers()["cache-control"]).toMatch(/no-cache|no-store/);
  expect(await sw.text()).toMatch(/const VERSION = "[^"]+";/);

  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/dashboard");
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  expect(new URL(scope).pathname).toBe("/");
  await page.reload(); // controlled by the worker from here
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);

  await context.setOffline(true);
  await page.goto("/jobs").catch(() => undefined);
  await expect(page.locator("body")).toContainText(/offline/i);
  await context.setOffline(false);
});

test.describe("after a deploy", () => {
  // page.route can't see requests a service worker makes; this test is about the error boundary, not the worker.
  test.use({ serviceWorkers: "block" });

  test("an open tab asking for a chunk of the previous build reloads once onto the new build", async ({ page }) => {
    await signIn(page, w.tenants.alpha.users.admin);
    await page.goto("/dashboard");
    let reloaded = false;
    page.on("request", (request) => {
      if (request.isNavigationRequest() && new URL(request.url()).pathname === "/jobs") reloaded = true;
    });
    // The old build's chunks are gone from the server until the tab reloads.
    await page.route((url) => url.pathname.startsWith("/_next/static/chunks/") && decodeURIComponent(url.pathname).includes("jobs/page"), (route) =>
      reloaded ? route.continue() : route.fulfill({ status: 404, body: "" }));
    await page.locator("aside").getByRole("link", { name: "Job Board" }).first().click();
    await expect(page.getByRole("button", { name: "Print Workshop Pack" })).toBeVisible();
    await expect(page.getByText("Something went wrong")).toHaveCount(0);
    expect(reloaded).toBe(true);
  });
});
