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
const ISO_READS = [/\/rest\/v1\/organization_members\?[^#]*can_inspect=eq\.true/, /\/rest\/v1\/inspector_authorisations/, /\/rest\/v1\/audit_log_view/, /\/rest\/v1\/job_rework/, /\/rest\/v1\/suppliers\?[^#]*supplier_status/, /\/rest\/v1\/jobs\?[^#]*drawing_revision_required/, /\/rest\/v1\/jobs\?[^#]*traceable/];

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
  // Counting has started (above); now wait for the company settings that decide the switch, then the notice.
  const settings = page.waitForResponse((r) => /\/rest\/v1\/organization_settings/.test(r.url()));
  await page.goto("/admin/iso");
  await settings;
  await expect(page.getByText(ISO_OFF_NOTICE)).toBeVisible();
  await expect(page.getByRole("button", { name: "Download pack (zip)" })).toHaveCount(0);
  // A fixed window after the switch is known: any ISO read would have started by now.
  await page.waitForTimeout(2000);
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
  // Scope to the Documents table row (the one with this document's download button): titles such as
  // "Quality policy" also appear as clause requirements in the Gap checklist table.
  for (const d of ISO_DOCUMENTS) {
    const documentRow = page.getByRole("row").filter({ has: page.getByRole("button", { name: `Download PDF: ${d.title}`, exact: true }) });
    await expect(documentRow.getByRole("cell", { name: d.title, exact: true })).toBeVisible();
  }
  // The reader ran (so the "off" check above is not vacuous).
  expect(reads.some((url) => /inspector_authorisations/.test(url))).toBe(true);
  expect(reads.some((url) => /organization_members/.test(url))).toBe(true);
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

test("admin switches ISO templates on from the page, then off; other hidden_nav entries kept", async ({ page }) => {
  test.setTimeout(120_000);
  const KEEP = "iso-switch-test-keep";
  const hiddenNav = async () => withDb(async (db) => {
    const row = await db.query("select hidden_nav from public.organization_settings where organization_id = $1", [solo.id]);
    return (row.rows[0]?.hidden_nav ?? []) as string[];
  });
  await setMarker(false);
  await withDb(async (db) => { await db.query("update public.organization_settings set hidden_nav = array_append(array_remove(hidden_nav, $2), $2) where organization_id = $1", [solo.id, KEEP]); });
  try {
    await signIn(page, solo.admin);
    await page.goto("/admin/iso");
    await expect(page.getByText(ISO_OFF_NOTICE)).toBeVisible();
    const toggle = page.getByRole("switch", { name: "ISO 9001 draft templates" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(page.getByRole("button", { name: "Download pack (zip)" })).toBeVisible({ timeout: 60_000 });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    // The switch updates the screen at once and saves in the background (lib/org-settings.ts enqueue), so wait for the
    // stored row itself rather than reading it straight after the click.
    await expect.poll(hiddenNav, { timeout: 30_000 }).toEqual(expect.arrayContaining([KEEP, ISO_TEMPLATES_ON_MARKER]));
    await toggle.click();
    await expect(page.getByText(ISO_OFF_NOTICE)).toBeVisible({ timeout: 60_000 });
    await expect.poll(hiddenNav, { timeout: 30_000 }).not.toContain(ISO_TEMPLATES_ON_MARKER);
    const after = await hiddenNav();
    expect(after).toContain(KEEP);
    expect(after).not.toContain(ISO_TEMPLATES_ON_MARKER);
  } finally {
    await withDb(async (db) => { await db.query("update public.organization_settings set hidden_nav = array_remove(hidden_nav, $2) where organization_id = $1", [solo.id, KEEP]); });
  }
});

test("office user cannot reach the switch", async ({ page }) => {
  await signIn(page, world().tenants.alpha.users.office);
  await page.goto("/admin/iso");
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByTestId("iso-switch-card")).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "ISO 9001 draft templates" })).toHaveCount(0);
});
