/**
 * ISO templates (/admin/iso), off by default (lib/iso/iso-switch). Switch off: the notice and no ISO evidence reads. Switch on as an
 * admin: the page renders, one document PDF and the zip download. An office user opening /admin/iso is refused (middleware: /admin is
 * admin-only). Rules and wording: tests/unit/iso-*.test.ts.
 *
 * Own company (createSoloTenant, Sales Orders off): the marker is set and cleared on that company only, and cleared in afterAll even
 * when a test fails.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, test } from "@playwright/test";
import { unzipSync } from "fflate";

import { ISO_DOCUMENTS } from "@/lib/iso/document-list";
import { ISO_OFF_NOTICE, ISO_TEMPLATES_ON_MARKER } from "@/lib/iso/iso-switch";

import { createSoloTenant, withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

// What only the ISO evidence reader asks for. The signed-in shell does not read these, so seeing one means the page read ISO evidence.
const ISO_READS = [/\/rest\/v1\/inspector_authorisations/, /\/rest\/v1\/audit_log_view/, /\/rest\/v1\/job_rework/, /\/rest\/v1\/suppliers\?[^#]*supplier_status/, /\/rest\/v1\/jobs\?[^#]*drawing_revision_required/, /\/rest\/v1\/jobs\?[^#]*traceable/];

let solo: Awaited<ReturnType<typeof createSoloTenant>>;

async function setMarker(on: boolean) {
  await withDb(async (db) => {
    const done = await db.query(
      "update public.organization_settings set hidden_nav = case when $2 then array_append(array_remove(hidden_nav, $3), $3) else array_remove(hidden_nav, $3) end where organization_id = $1",
      [solo.id, on, ISO_TEMPLATES_ON_MARKER],
    );
    expect(done.rowCount).toBe(1);
  });
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  solo = await createSoloTenant(w.runId, `iso-${randomUUID().slice(0, 6)}`, undefined, { salesOrders: false });
});

test.afterAll(async () => {
  if (solo) await setMarker(false);
});

test("switched off (the default): the notice, and no ISO evidence is read", async ({ page }) => {
  const reads: string[] = [];
  page.on("request", (request) => { if (ISO_READS.some((re) => re.test(request.url()))) reads.push(request.url()); });
  await signIn(page, solo.admin);
  await page.goto("/admin/iso");
  await expect(page.getByText(ISO_OFF_NOTICE)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download pack (zip)" })).toHaveCount(0);
  // The switch is decided once the page shows the notice; wait for the network to go quiet so a late read would have been seen.
  await page.waitForLoadState("networkidle");
  expect(reads).toEqual([]);
});

test("switched on as admin: the page renders, one PDF and the zip download", async ({ page }) => {
  test.setTimeout(180_000);
  await setMarker(true);
  const reads: string[] = [];
  page.on("request", (request) => { if (ISO_READS.some((re) => re.test(request.url()))) reads.push(request.url()); });
  await signIn(page, solo.admin);
  await page.goto("/admin/iso");
  await expect(page.getByRole("heading", { name: "ISO templates" })).toBeVisible();
  await expect(page.getByText("Needs company review. Not certification evidence.").first()).toBeVisible();
  for (const d of ISO_DOCUMENTS) await expect(page.getByRole("cell", { name: d.title, exact: true })).toBeVisible();
  // The reader ran (so the "off" check above is not vacuous).
  expect(reads.some((url) => /inspector_authorisations/.test(url))).toBe(true);
  await expect(page.getByRole("cell", { name: "Not evidenced by Tolra" }).first()).toBeVisible();

  const pdfDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PDF: Quality policy" }).click();
  const pdf = await pdfDownload;
  expect(pdf.suggestedFilename()).toBe("01-quality-policy.pdf");
  expect(readFileSync(await pdf.path()).subarray(0, 5).toString()).toBe("%PDF-");

  const zipDownload = page.waitForEvent("download", { timeout: 120_000 });
  await page.getByRole("button", { name: "Download pack (zip)" }).click();
  const zip = await zipDownload;
  expect(zip.suggestedFilename()).toMatch(/^iso-draft-templates-\d{4}-\d{2}-\d{2}\.zip$/);
  const names = Object.keys(unzipSync(new Uint8Array(readFileSync(await zip.path())))).sort();
  expect(names).toEqual([...ISO_DOCUMENTS.map((d) => `${d.filename}.pdf`), "10-gap-checklist.pdf"].sort());
});

test("an office user opening /admin/iso is refused", async ({ page }) => {
  await signIn(page, world().tenants.alpha.users.office);
  await page.goto("/admin/iso");
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByRole("heading", { name: "ISO templates" })).toHaveCount(0);
});
