/**
 * Screenshot helper for the UI PR 1 check: ADMIN / OFFICE / WORKSHOP at phone (390x844), tablet (820x1180) and
 * desktop (1280x800), one image per combination, written to test-results/ui-pr1-screenshots/ (gitignored: the images are
 * evidence for review, never committed).
 *
 * Phone and tablet contexts have touch and mobile emulation, so `(pointer: coarse)` matches there, as on a real device.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import type { Browser, BrowserContext, Page } from "@playwright/test";

export const SCREENSHOT_DIR = path.resolve(__dirname, "../../test-results/ui-pr1-screenshots");

export type ViewportSpec = { name: "phone" | "tablet" | "desktop"; width: number; height: number; touch: boolean };
export const VIEWPORTS: ViewportSpec[] = [
  { name: "phone", width: 390, height: 844, touch: true },
  { name: "tablet", width: 820, height: 1180, touch: true },
  { name: "desktop", width: 1280, height: 800, touch: false },
];

/** A fresh browser context shaped like the device: touch devices get hasTouch + isMobile so the pointer is coarse. */
export function deviceContext(browser: Browser, viewport: ViewportSpec, baseURL: string): Promise<BrowserContext> {
  return browser.newContext({
    baseURL,
    viewport: { width: viewport.width, height: viewport.height },
    hasTouch: viewport.touch,
    isMobile: viewport.touch,
    deviceScaleFactor: viewport.touch ? 2 : 1,
  });
}

export function screenshotPath(role: string, viewport: ViewportSpec, screen: string) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  return path.join(SCREENSHOT_DIR, `${role}-${viewport.width}x${viewport.height}-${screen}.png`);
}

/** Saves a full-page screenshot and returns its path. */
export async function saveScreenshot(page: Page, role: string, viewport: ViewportSpec, screen: string) {
  const file = screenshotPath(role, viewport, screen);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}
