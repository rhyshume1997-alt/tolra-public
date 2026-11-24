/**
 * Purchase Orders: "Email to supplier" opens the shared SendEmailDialog with the supplier's address, with the redesign ON
 * (marker "ui-purchase-orders-v2:on" in organization_settings.hidden_nav) and OFF (marker absent, the default). Closing the dialog
 * sends nothing: no request to /api/email/send from the page and nothing recorded by the mock provider for that address.
 *
 * Inputs: an issued PO (status "issued") for a supplier with an e-mail on file, in an own company (createSoloTenant, Sales Orders off), so
 * the marker is set and cleared on that company only and no other spec sees it. afterAll clears it even when a test fails. Serial, as the
 * marker is shared state within this file. Synthetic data only; teardown removes the company with the rest of the run.
 * Must not change: the marker text (app/(dashboard)/purchase-orders/page.tsx), or the visible texts asserted here.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import type { RecordedEmail } from "../support/mock-providers";
import { adminClient, createSoloTenant, withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";
import { E2E_MOCK_PORT } from "./paths";

const w = world();
const MARKER = "ui-purchase-orders-v2:on";

let solo: Awaited<ReturnType<typeof createSoloTenant>>;
let ref = "";
let supplierEmail = "";

test.describe.configure({ mode: "serial" });

async function setMarker(on: boolean) {
  await withDb(async (db) => {
    const done = await db.query(
      "update public.organization_settings set hidden_nav = case when $2::boolean then array_append(array_remove(hidden_nav, $3), $3) else array_remove(hidden_nav, $3) end where organization_id = $1",
      [solo.id, on, MARKER],
    );
    expect(done.rowCount).toBe(1);
  });
}

async function recordedTo(address: string): Promise<RecordedEmail[]> {
  const response = await fetch(`http://127.0.0.1:${E2E_MOCK_PORT}/__emails`);
  return ((await response.json()) as RecordedEmail[]).filter((email) => JSON.stringify(email.body).includes(address));
}

test.beforeAll(async () => {
  const tag = randomUUID().slice(0, 6);
  solo = await createSoloTenant(w.runId, `poem-${tag}`, undefined, { salesOrders: false });
  const supplier = `PO Email Supplier ${tag} Ltd`;
  supplierEmail = `po.supplier.${tag}.${w.runId}@example.test`;
  ref = `PO-EM-${tag}`;
  const service = adminClient();
  expect((await service.from("suppliers").insert({ organization_id: solo.id, name: supplier, email: supplierEmail })).error).toBeNull();
  expect((await service.from("purchase_orders").insert({ organization_id: solo.id, po_ref: ref, supplier, total_value: 250, status: "issued", order_date: "2026-10-01", expected_delivery: "2026-10-09" })).error).toBeNull();
});

test.afterAll(async () => {
  if (solo) await setMarker(false);
});

/** Opens the order's detail, clicks Email to supplier, checks the dialog and its recipient, closes it, and proves nothing was sent. */
async function emailThenClose(page: Page) {
  const sends: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/email/send")) sends.push(request.method()); });

  await signIn(page, solo.admin);
  await page.goto("/purchase-orders");
  await page.getByRole("row").filter({ hasText: ref }).getByRole("button", { name: "View" }).click();
  await page.getByRole("dialog", { name: ref }).getByRole("button", { name: "Email to supplier" }).click();

  const dialog = page.getByRole("dialog", { name: "Send by e-mail" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("To", { exact: true })).toHaveValue(supplierEmail);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // Give any stray request a moment to show up, then prove none was made and the provider recorded nothing for this address.
  await page.waitForLoadState("networkidle");
  expect(sends).toEqual([]);
  expect(await recordedTo(supplierEmail)).toHaveLength(0);
}

test("redesign ON: Email to supplier opens the e-mail dialog with the supplier's address, and closing it sends nothing", async ({ page }) => {
  await setMarker(true);
  await emailThenClose(page);
});

test("redesign OFF (marker absent): Email to supplier opens the same dialog, and closing it sends nothing", async ({ page }) => {
  await setMarker(false);
  await emailThenClose(page);
});
