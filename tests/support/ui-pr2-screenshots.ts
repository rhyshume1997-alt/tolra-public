/**
 * Screenshot helper for the UI PR 2 check (tablet shell and responsive repairs): ADMIN / OFFICE / WORKSHOP at phone
 * (390x844), tablet (820x1180) and desktop (1280x800), nine images, written to test-results/ui-pr2-screenshots/
 * (gitignored: evidence for review, never committed). Devices are built as in PR 1 (touch + mobile emulation, so
 * `(pointer: coarse)` matches on phone and tablet).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { VIEWPORTS, deviceContext, type ViewportSpec } from "./ui-pr1-screenshots";

export { VIEWPORTS, deviceContext };
export type { ViewportSpec };

export const SCREENSHOT_DIR = path.resolve(__dirname, "../../test-results/ui-pr2-screenshots");

/** The widest tablet width that still uses the drawer (1024px inclusive), as a touch device. */
export const EDGE: ViewportSpec = { name: "tablet", width: 1024, height: 768, touch: true };

export function screenshotPath(role: string, viewport: ViewportSpec, screen: string) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  return path.join(SCREENSHOT_DIR, `${role}-${viewport.width}x${viewport.height}-${screen}.png`);
}

/** Saves what the screen shows (the viewport, so an open dialog sits where a person sees it) and returns the path. */
export async function saveScreenshot(page: Page, role: string, viewport: ViewportSpec, screen: string) {
  const file = screenshotPath(role, viewport, screen);
  await page.screenshot({ path: file });
  return file;
}
