/**
 * Security page (Admin > Security, /admin/compliance): an audit hash is never silently cut. Each hash cell either fits its
 * cell with nothing clipped, or carries the full value in its title. The page never scrolls sideways at tablet or phone width.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

for (const [width, height] of [[1280, 800], [820, 1000], [390, 844]] as const) {
  test(`security page at ${width}px: audit hashes are not clipped and nothing scrolls sideways`, async ({ page }) => {
    // An audited write on the synthetic tenant, so the audit log has at least one entry with a hash.
    const { error } = await adminClient()
      .from("time_settings")
      .upsert({ organization_id: w.tenants.alpha.id, lunch_minutes: 30 }, { onConflict: "organization_id" });
    expect(error).toBeNull();

    await page.setViewportSize({ width, height });
    await signIn(page, w.tenants.alpha.users.admin);
    await page.goto("/admin/compliance");
    await expect(page.getByRole("heading", { name: "Security" })).toBeVisible();

    const hashes = page.locator("table td.font-mono");
    await expect(hashes.first()).toBeVisible();
    const cells = await hashes.evaluateAll((els) =>
      els.map((el) => ({
        text: (el.textContent ?? "").trim(),
        clipped: el.scrollWidth > el.clientWidth + 1,
        title: el.getAttribute("title"),
      })),
    );
    expect(cells.filter((cell) => cell.text !== "Pending").length, `${width}px: no hash rendered`).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(!cell.clipped || cell.title === cell.text, `${width}px: clipped hash ${cell.text}`).toBe(true);
    }

    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(sideways, `${width}px: page scrolls sideways`).toBeLessThanOrEqual(1);
  });
}
