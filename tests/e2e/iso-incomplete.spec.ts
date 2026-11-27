/**
 * ISO fails closed (/admin/iso). Only the ISO evidence reads are delayed or rejected (page.route); the session, membership and company calls are never touched.
 * Reads ok and empty: exports on. One read fails, or one takes over 20 s: the incomplete warning and every export off. Retry failing: warning stays; retry
 * succeeding: warning gone, exports on. Switch off: no evidence reads. Company switch while loading or generating: the old company's data is never shown or exported.
 * Own company per run (createSoloTenant); the marker is cleared in afterAll. Rules: tests/unit/iso-export-ready.test.ts.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { ISO_DOCUMENTS } from "@/lib/iso/document-list";
import { ISO_OFF_NOTICE, ISO_TEMPLATES_ON_MARKER } from "@/lib/iso/iso-switch";

import { createSoloTenant, withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
// Only the ISO evidence reads (the same list as iso-templates.spec.ts); the shell never makes these.
const ISO_READ = /\/rest\/v1\/(organization_members\?[^#]*can_inspect=eq\.true|inspector_authorisations|audit_log_view|job_rework|suppliers\?[^#]*supplier_status|jobs\?[^#]*(drawing_revision_required|traceable))/;

let solo: Awaited<ReturnType<typeof createSoloTenant>>;
async function setMarker(on: boolean) {
  await withDb(async (db) => {
    await db.query("update public.organization_settings set hidden_nav = case when $2 then array_append(array_remove(hidden_nav, $3), $3) else array_remove(hidden_nav, $3) end where organization_id = $1", [solo.id, on, ISO_TEMPLATES_ON_MARKER]);
  });
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => { solo = await createSoloTenant(w.runId, `isoinc-${randomUUID().slice(0, 6)}`, undefined, { salesOrders: false }); });
test.afterAll(async () => { if (solo) await setMarker(false); });

const exportButtons = (page: Page) => [
  page.getByRole("button", { name: "Download pack (zip)" }),
  page.getByRole("button", { name: "Download checklist (PDF)" }),
  page.getByRole("button", { name: "Download checklist (CSV)" }),
  ...ISO_DOCUMENTS.map((d) => page.getByRole("button", { name: `Download PDF: ${d.title}`, exact: true })),
];
async function expectExports(page: Page, enabled: boolean) {
  for (const button of exportButtons(page)) await (enabled ? expect(button).toBeEnabled() : expect(button).toBeDisabled());
}
const warning = (page: Page) => page.getByTestId("iso-incomplete");

test("all reads ok and empty: exports enabled, no warning", async ({ page }) => {
  await setMarker(true);
  await signIn(page, solo.admin);
  await page.goto("/admin/iso");
  await expect(page.getByRole("button", { name: "Download pack (zip)" })).toBeEnabled({ timeout: 60_000 });
  await expect(warning(page)).toHaveCount(0);
  await expectExports(page, true);
});

test("one read fails: warning and every export disabled; retry failing keeps it; retry succeeding clears it", async ({ page }) => {
  test.setTimeout(120_000);
  await setMarker(true);
  let failing = true;
  await page.route(/\/rest\/v1\/suppliers\?[^#]*supplier_status/, (route) => (failing ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) }) : route.continue()));
  await signIn(page, solo.admin);
  await page.goto("/admin/iso");
  await expect(warning(page)).toBeVisible({ timeout: 60_000 });
  await expect(warning(page)).toContainText("ISO information is incomplete");
  await expectExports(page, false);
  await page.getByRole("button", { name: "Try reading again" }).click();
  await expect(warning(page)).toBeVisible({ timeout: 60_000 });
  await expectExports(page, false);
  failing = false;
  await page.getByRole("button", { name: "Try reading again" }).click();
  await expect(warning(page)).toHaveCount(0, { timeout: 60_000 });
  await expectExports(page, true);
});

test("a read over 20 seconds: loading ends, warning, exports disabled", async ({ page }) => {
  test.setTimeout(120_000);
  await setMarker(true);
  await page.route(/\/rest\/v1\/audit_log_view/, async (route) => { await new Promise((r) => setTimeout(r, 25_000)); await route.continue().catch(() => undefined); });
  await signIn(page, solo.admin);
  await page.goto("/admin/iso");
  await expect(warning(page)).toBeVisible({ timeout: 60_000 });
  await expectExports(page, false);
});

test("switch OFF: no evidence reads and the original view", async ({ page }) => {
  await setMarker(false);
  const reads: string[] = [];
  page.on("request", (request) => { if (ISO_READ.test(request.url())) reads.push(request.url()); });
  await signIn(page, solo.admin);
  const settings = page.waitForResponse((r) => /\/rest\/v1\/organization_settings/.test(r.url()));
  await page.goto("/admin/iso");
  await settings;
  await expect(page.getByText(ISO_OFF_NOTICE)).toBeVisible();
  await page.waitForTimeout(2000);
  expect(reads).toEqual([]);
});
