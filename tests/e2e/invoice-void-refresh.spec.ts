/**
 * Invoices: after Void with a reason, the open details reopen from the re-read row and show the voided state.
 * From the void test of tests/e2e/sweep-invoices.spec.ts (cc64906); that file is part of the invoices sweep, which is not in this PR.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
const tag = () => w.runId.slice(0, 6);

test("invoices: after Void with a reason the open details show the voided state (no Void, Record payment or New credit note)", async ({ page }) => {
  const service = adminClient();
  const ref = `INV-SWX-${tag()}`;
  const { error } = await service.from("invoices").insert({ organization_id: w.tenants.alpha.id, invoice_ref: ref, customer: `Void Now ${tag()} Ltd`, status: "sent", subtotal: 100, vat: 20, total: 120, vat_enabled: true, due_date: "2099-01-31" });
  expect(error).toBeNull();
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/invoices");
  await page.getByRole("row").filter({ hasText: ref }).getByRole("button", { name: "View", exact: true }).click();
  const details = page.getByRole("dialog").filter({ hasText: "Download PDF" });
  await expect(details.getByRole("button", { name: "Void Invoice" })).toBeVisible();
  await details.getByRole("button", { name: "Void Invoice" }).click();
  const voiding = page.getByRole("dialog", { name: `Void invoice ${ref}?` });
  await voiding.getByLabel(/^Reason/).fill("Raised in error");
  await voiding.getByRole("button", { name: "Void invoice" }).click();
  await expect(voiding).toBeHidden();
  // The details stay open, now as the voided invoice.
  await expect(details.getByText("Void: not owed.")).toBeVisible();
  await expect(details.getByRole("button", { name: "Void Invoice" })).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Record payment" })).toHaveCount(0);
  await expect(details.getByRole("button", { name: "New credit note" })).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Download PDF" })).toBeVisible();
});
