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
  await page.waitForLoadState("load", { timeout: 30_000 });
  return csp(header);
}

/**
 * What the document the person is on actually allows: does a data: fetch work, does a blob: iframe load. A probe that hits a document being replaced
 * ("Execution context was destroyed") or one that is not on `path` yet answers { waiting: why, with the URL }, so a poll tries again and a failure says where the page was.
 */
async function behaviourOn(page: Page, path: string): Promise<{ dataFetchAllowed: boolean; blobFrameAllowed: boolean } | { waiting: string }> {
  try {
    if (new URL(page.url()).pathname !== path) return { waiting: `on ${page.url()}, wanted ${path}` };
    return await page.evaluate(async () => {
      if (document.readyState !== "complete") return { waiting: `readyState ${document.readyState}` };
      const violations: string[] = [];
      const onViolation = (e: SecurityPolicyViolationEvent) => violations.push(e.violatedDirective);
      document.addEventListener("securitypolicyviolation", onViolation);
      const frame = document.createElement("iframe");
      frame.src = URL.createObjectURL(new Blob(["x"], { type: "text/html" }));
      document.body.appendChild(frame);
      const dataFetchAllowed = await fetch("data:text/plain,x").then(() => true, () => false);
      await new Promise((r) => setTimeout(r, 500));
      document.removeEventListener("securitypolicyviolation", onViolation);
      frame.remove();
      return { dataFetchAllowed, blobFrameAllowed: !violations.some((v) => /^(frame-src|child-src|default-src)/.test(v)) };
    });
  } catch {
    return { waiting: `document replaced while probing, on ${page.url()}` }; // the boundary's reload: try again
  }
}
/**
 * Moves through history WITHOUT waiting for a navigation event: the suite sets no navigation timeout, and page.goBack waits for a commit that the boundary's
 * location.replace can supersede, which never arrives. The page is told to move and the polling below waits for the settled document. A context destroyed
 * by the replace while this runs is expected.
 */
async function historyMove(page: Page, direction: "back" | "forward") {
  await page.evaluate((d) => { if (d === "back") history.back(); else history.forward(); }, direction).catch(() => undefined);
}
/** Polls until the settled document on `path` behaves as `expected`. The page being replaced answers null or the other policy, never `expected`. */
async function expectBehaviour(page: Page, path: string, settings: boolean) {
  await expect.poll(() => behaviourOn(page, path), { timeout: 30_000, intervals: [500, 500, 1000] }).toEqual({ dataFetchAllowed: settings, blobFrameAllowed: settings });
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
  expectGlobalPolicy(await documentCspAfter(page, "/dashboard", () => page.goto("/dashboard", { timeout: 30_000 })));
  expectGlobalPolicy(await documentCspAfter(page, "/jobs", () => page.goto("/jobs", { timeout: 30_000 })));
  expectSettingsPolicy(await documentCspAfter(page, "/settings", () => page.goto("/settings", { timeout: 30_000 })));
});

test("Dashboard to Settings to Job Board: each document has its own route's policy", async ({ page }) => {
  await signIn(page, world().tenants.alpha.users.admin);
  expectSettingsPolicy(await documentCspAfter(page, "/settings", () => page.getByRole("link", { name: "Settings", exact: true }).first().click()));
  expectGlobalPolicy(await documentCspAfter(page, "/jobs", () => page.getByRole("link", { name: "Job Board" }).first().click()));
  // The document in the page itself (once the boundary's reload has settled): blob: frames and data: fetches are refused here.
  await expectBehaviour(page, "/jobs", false);
});

test("browser Back and Forward across Settings keep each document's own policy", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, world().tenants.alpha.users.admin);
  expectSettingsPolicy(await documentCspAfter(page, "/settings", () => page.getByRole("link", { name: "Settings", exact: true }).first().click()));
  expectGlobalPolicy(await documentCspAfter(page, "/jobs", () => page.getByRole("link", { name: "Job Board" }).first().click()));
  // Settle on /jobs first: the boundary's reload follows the client navigation by a moment, and a history move made while it is in flight is superseded by it
  // and lost. (A person cannot press Back in that fraction of a second; this is a limit of the test's speed, not of the app.)
  await expectBehaviour(page, "/jobs", false);
  // A history navigation is not always a network document request (cache restore, or only the boundary's replace), so the policy of the document the
  // person ends on is checked by what it allows, not by a response header.
  await historyMove(page, "back");
  await expectBehaviour(page, "/settings", true);
  await historyMove(page, "forward");
  await expectBehaviour(page, "/jobs", false);
});

test("signing out from Settings lands on a document with the global policy", async ({ page }) => {
  await signIn(page, world().tenants.alpha.users.admin);
  await page.goto("/settings", { timeout: 30_000 });
  await page.waitForLoadState("load", { timeout: 30_000 });
  expectGlobalPolicy(await documentCspAfter(page, "/login", () => page.getByRole("button", { name: "Log out" }).first().click()));
});
