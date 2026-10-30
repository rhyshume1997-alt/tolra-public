/**
 * Invoices > "Compact list" (E4b): the dense, accounting-package style table with totals at the foot.
 *
 * Three invoices in a company of their own (the footer sums whatever the list shows, so it must not share a company with other specs):
 * one unpaid, one part paid, one void. The void invoice stays listed but adds nothing to any total. The switch is remembered per person
 * across a reload, a click on a row opens that invoice, and switching off restores the normal table. Synthetic data only.
 */
import { expect, test } from "@playwright/test";

import { adminClient, createSoloTenant, withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("Compact list: dense rows, footer totals leave out the void invoice, remembered after reload, row opens the invoice, off restores the table", async ({ page }) => {
  const solo = await createSoloTenant(w.runId, "compact");
  const org = solo.id;
  const tag = w.runId.slice(0, 6);
  const open = { ref: `INV-CL1-${tag}`, customer: `Compact Open ${tag} Ltd` };
  const part = { ref: `INV-CL2-${tag}`, customer: `Compact Part ${tag} Ltd` };
  const dead = { ref: `INV-CL3-${tag}`, customer: `Compact Void ${tag} Ltd` };

  // One row per insert (a batch whose rows carry different keys would send null for the keys a row lacks).
  const service = adminClient();
  const first = await service.from("invoices").insert({ organization_id: org, invoice_ref: open.ref, customer: open.customer, status: "sent", subtotal: 100, vat: 20, total: 120, amount_paid: 0, vat_enabled: true, invoice_date: "2026-10-01", due_date: "2099-01-31" });
  expect(first.error).toBeNull();
  await withDb(async (db) => {
    const { rows } = await db.query(
      `insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, amount_paid, invoice_date, due_date, vat_enabled)
       values ($1, $2, $3, 250.50, 50.10, 300.60, 'partial', 100, '2026-10-02', '2099-01-31', true) returning id`, [org, part.ref, part.customer]);
    await db.query("insert into public.invoice_payments (organization_id, invoice_id, amount, paid_on, method, reference, source) values ($1, $2, 100, '2026-10-05', 'BACS', $3, 'recorded')", [org, rows[0].id, `REM-${tag}`]);
  });
  const third = await service.from("invoices").insert({ organization_id: org, invoice_ref: dead.ref, customer: dead.customer, status: "void", subtotal: 832.5, vat: 166.5, total: 999, amount_paid: 0, vat_enabled: true, invoice_date: "2026-10-03", due_date: "2099-01-31" });
  expect(third.error).toBeNull();

  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, solo.admin);
  await page.goto("/invoices");

  // Normal table first: the switch is off, there is no dense list.
  const compactButton = page.getByRole("button", { name: "Compact list", exact: true });
  await expect(page.getByRole("row").filter({ hasText: open.ref })).toBeVisible();
  await expect(compactButton).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("compact-invoice-list")).toHaveCount(0);

  // On: the dense table shows all three rows (the void one included).
  await compactButton.click();
  await expect(compactButton).toHaveAttribute("aria-pressed", "true");
  const list = page.getByTestId("compact-invoice-list");
  await expect(list).toBeVisible();
  await expect(list.getByRole("columnheader")).toHaveText(["Invoice", "Date", "Customer", "Net", "VAT", "Gross", "Paid", "Outstanding", "Status", "Due"]);
  const rows = list.getByTestId("compact-invoice-row");
  await expect(rows).toHaveCount(3);
  const rowOf = (ref: string) => rows.filter({ hasText: ref });
  await expect(rowOf(open.ref)).toContainText(open.customer);
  await expect(rowOf(open.ref)).toContainText("£100.00");
  await expect(rowOf(open.ref)).toContainText("£20.00");
  await expect(rowOf(open.ref)).toContainText("£120.00");
  await expect(rowOf(part.ref)).toContainText("£250.50");
  await expect(rowOf(part.ref)).toContainText("£300.60");
  await expect(rowOf(part.ref)).toContainText("£200.60");
  await expect(rowOf(dead.ref)).toContainText("VOID");

  // Footer: the two non-void invoices only.
  // net 100.00 + 250.50, VAT 20.00 + 50.10, gross 120.00 + 300.60, paid 0 + 100.00, outstanding 120.00 + 200.60.
  const totals = page.getByTestId("compact-invoice-totals");
  await expect(totals).toContainText("Totals (3 invoices)");
  const total = (key: string) => totals.locator(`[data-total="${key}"]`);
  await expect(total("net")).toHaveText("£350.50");
  await expect(total("vat")).toHaveText("£70.10");
  await expect(total("gross")).toHaveText("£420.60");
  await expect(total("paid")).toHaveText("£100.00");
  await expect(total("outstanding")).toHaveText("£320.60");

  // Remembered after a reload.
  await page.reload();
  await expect(page.getByTestId("compact-invoice-list")).toBeVisible();
  await expect(page.getByRole("button", { name: "Compact list", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("compact-invoice-row")).toHaveCount(3);
  await expect(page.getByTestId("compact-invoice-totals").locator('[data-total="gross"]')).toHaveText("£420.60");

  // A click on a row opens that invoice.
  await page.getByTestId("compact-invoice-row").filter({ hasText: open.ref }).getByText(open.customer).click();
  const details = page.getByRole("dialog", { name: `${open.ref} invoice details` });
  await expect(details).toBeVisible();
  await expect(details).toContainText(open.customer);
  await expect(details.getByRole("button", { name: "Download PDF" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();

  // Off restores the normal table (and is remembered).
  await page.getByRole("button", { name: "Compact list", exact: true }).click();
  await expect(page.getByRole("button", { name: "Compact list", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("compact-invoice-list")).toHaveCount(0);
  await expect(page.getByRole("row").filter({ hasText: open.ref }).getByRole("button", { name: "View", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("row").filter({ hasText: open.ref })).toBeVisible();
  await expect(page.getByRole("button", { name: "Compact list", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByTestId("compact-invoice-list")).toHaveCount(0);
});
