/**
 * Settings CSP across navigation (REAL document response headers). Settings alone has the wider policy (frame-src blob:, data: in connect-src); no other
 * document may carry it, however it was reached: direct entry, Dashboard to Settings, Settings to Job Board, browser Back and Forward, and sign out.
 * Must not change: the global policy (tests/unit/security-headers.test.ts). Each check reads the header of the navigation request that loaded the document.
 */
import { expect, test, type Page } from "@playwright/test";

import { signIn, world } from "./helpers";

const csp = (value: string | undefined) => value ?? "";
const hasWide = (value: string) => /frame-src blob:/.test(value) || /connect-src[^;]*\bdata:/.test(value);

/**
 * Runs `action` and returns the CSP header of the DOCUMENT response for `path` that it causes. A client-side navigation changes the URL before the
 * boundary's reload happens, so the URL is not proof: the header of the new document response is. Fails (timeout) when no document is loaded.
 */
async function documentCspAfter(page: Page, path: string, action: () => Promise<unknown>): Promise<string> {
  const response = page.waitForResponse((r) => r.request().isNavigationRequest() && r.request().resourceType() === "document" && new URL(r.url()).pathname === path, { timeout: 30_000 });
  // A history navigation the boundary replaces is reported as aborted by Playwright; the replacing load is the one measured.
  await Promise.resolve(action()).catch(() => undefined);
  const header = (await response).headers()["content-security-policy"];
  await page.waitForLoadState("load");
  return csp(header);
}

function expectSettingsPolicy(value: string) {
  expect(value).toContain("frame-src blob:");
  expect(value).toMatch(/connect-src[^;]*\bdata:/);
  expect(value).toContain("object-src 'none'");
  expect(value).toContain("worker-src 'self'");
}
function expectGlobalPolicy(value: string) {
  expect(value).toContain("default-src 'self'");
  expect(hasWide(value)).toBe(false);
}

test("Settings has its own policy and every other route has the global one", async ({ page }) => {
  await signIn(page, world().tenants.alpha.users.admin);
  expectGlobalPolicy(await documentCspAfter(page, "/dashboard", () => page.goto("/dashboard")));
  expectGlobalPolicy(await documentCspAfter(page, "/jobs", () => page.goto("/jobs")));
  expectSettingsPolicy(await documentCspAfter(page, "/settings", () => page.goto("/settings")));
});

test("Dashboard to Settings to Job Board: each document has its own route's policy", async ({ page }) => {
  await signIn(page, world().tenants.alpha.users.admin);
  expectSettingsPolicy(await documentCspAfter(page, "/settings", () => page.getByRole("link", { name: "Settings", exact: true }).first().click()));
  expectGlobalPolicy(await documentCspAfter(page, "/jobs", () => page.getByRole("link", { name: "Job Board" }).first().click()));
  // The document in the page itself: blob: frames and data: fetches are refused here.
  const blocked = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (e) => violations.push(e.violatedDirective));
    const frame = document.createElement("iframe");
    frame.src = URL.createObjectURL(new Blob(["x"], { type: "text/html" }));
    document.body.appendChild(frame);
    const fetchBlocked = await fetch("data:text/plain,x").then(() => false, () => true);
    await new Promise((r) => setTimeout(r, 500));
    return { frame: violations.some((v) => /^(frame-src|child-src|default-src)/.test(v)), fetch: fetchBlocked };
  });
  expect(blocked).toEqual({ frame: true, fetch: true });
});

test("browser Back and Forward across Settings keep each document's own policy", async ({ page }) => {
  await signIn(page, world().tenants.alpha.users.admin);
  expectSettingsPolicy(await documentCspAfter(page, "/settings", () => page.getByRole("link", { name: "Settings", exact: true }).first().click()));
  expectGlobalPolicy(await documentCspAfter(page, "/jobs", () => page.getByRole("link", { name: "Job Board" }).first().click()));
  expectSettingsPolicy(await documentCspAfter(page, "/settings", () => page.goBack({ waitUntil: "commit" })));
  await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  expectGlobalPolicy(await documentCspAfter(page, "/jobs", () => page.goForward({ waitUntil: "commit" })));
});

test("signing out from Settings lands on a document with the global policy", async ({ page }) => {
  await signIn(page, world().tenants.alpha.users.admin);
  await page.goto("/settings");
  await page.waitForLoadState("load");
  expectGlobalPolicy(await documentCspAfter(page, "/login", () => page.getByRole("button", { name: "Log out" }).first().click()));
});
