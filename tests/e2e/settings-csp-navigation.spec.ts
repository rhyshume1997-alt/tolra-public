/**
 * Settings CSP across navigation (REAL document response headers). Settings alone has the wider policy (frame-src blob:, data: in connect-src); no other
 * document may carry it, however it was reached: direct entry, Dashboard to Settings, Settings to Job Board, browser Back and Forward, and sign out.
 * Must not change: the global policy (tests/unit/security-headers.test.ts). Each check reads the header of the navigation request that loaded the document.
 */
import { expect, test, type Page } from "@playwright/test";

import { signIn, world } from "./helpers";

const csp = (value: string | undefined) => value ?? "";
const hasWide = (value: string) => /frame-src blob:/.test(value) || /connect-src[^;]*\bdata:/.test(value);

/** The CSP of the most recent document (navigation) response. */
function trackDocumentCsp(page: Page) {
  const seen: { url: string; csp: string }[] = [];
  page.on("response", (response) => {
    if (response.request().resourceType() === "document" && response.request().isNavigationRequest()) seen.push({ url: new URL(response.url()).pathname, csp: csp(response.headers()["content-security-policy"]) });
  });
  return { seen, last: (path: string) => [...seen].reverse().find((d) => d.url === path)?.csp ?? "" };
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
  const docs = trackDocumentCsp(page);
  await signIn(page, world().tenants.alpha.users.admin);
  expectGlobalPolicy(docs.last("/dashboard"));
  await page.goto("/jobs");
  expectGlobalPolicy(docs.last("/jobs"));
  await page.goto("/settings");
  expectSettingsPolicy(docs.last("/settings"));
});

test("Dashboard to Settings to Job Board: each document has its own route's policy", async ({ page }) => {
  const docs = trackDocumentCsp(page);
  await signIn(page, world().tenants.alpha.users.admin);
  await page.getByRole("link", { name: "Settings", exact: true }).first().click();
  await page.waitForURL(/\/settings/);
  expectSettingsPolicy(docs.last("/settings"));
  await page.getByRole("link", { name: "Job Board" }).first().click();
  await page.waitForURL(/\/jobs/);
  expectGlobalPolicy(docs.last("/jobs"));
  // The document in the page itself: blob: frames and data: fetches are refused here.
  const blocked = await page.evaluate(async () => {
    const frame = document.createElement("iframe");
    const frameBlocked = new Promise<boolean>((resolve) => {
      document.addEventListener("securitypolicyviolation", (e) => { if (e.violatedDirective.startsWith("frame-src") || e.violatedDirective.startsWith("child-src") || e.violatedDirective.startsWith("default-src")) resolve(true); });
      setTimeout(() => resolve(false), 3000);
    });
    frame.src = URL.createObjectURL(new Blob(["x"], { type: "text/html" }));
    document.body.appendChild(frame);
    const fetchBlocked = await fetch("data:text/plain,x").then(() => false, () => true);
    return { frame: await frameBlocked, fetch: fetchBlocked };
  });
  expect(blocked).toEqual({ frame: true, fetch: true });
});

test("browser Back and Forward across Settings keep each document's own policy", async ({ page }) => {
  const docs = trackDocumentCsp(page);
  await signIn(page, world().tenants.alpha.users.admin);
  await page.getByRole("link", { name: "Settings", exact: true }).first().click();
  await page.waitForURL(/\/settings/);
  await page.getByRole("link", { name: "Job Board" }).first().click();
  await page.waitForURL(/\/jobs/);
  await page.goBack();
  await page.waitForURL(/\/settings/);
  await expect(page.getByRole("heading", { name: "Settings" }).first()).toBeVisible();
  expectSettingsPolicy(docs.last("/settings"));
  await page.goForward();
  await page.waitForURL(/\/jobs/);
  await expect(page.getByRole("heading").first()).toBeVisible();
  expectGlobalPolicy(docs.last("/jobs"));
});

test("signing out from Settings lands on a document with the global policy", async ({ page }) => {
  const docs = trackDocumentCsp(page);
  await signIn(page, world().tenants.alpha.users.admin);
  await page.goto("/settings");
  expectSettingsPolicy(docs.last("/settings"));
  await page.getByRole("button", { name: "Log out" }).first().click();
  await page.waitForURL(/\/login/, { timeout: 30_000 });
  expectGlobalPolicy(docs.last("/login"));
});
