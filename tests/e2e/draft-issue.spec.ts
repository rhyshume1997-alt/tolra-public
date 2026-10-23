/**
 * Independent review of 0604bf4, in the browser: imported documents whose lines don't add up to their stored totals
 * can't be printed or sent (the reason is shown, the stored amount kept); imported invoices without payment details
 * wait for someone to confirm; purchase orders are issued explicitly and their sending recorded separately.
 */
import { expect, test } from "@playwright/test";

import { adminClient, withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("an imported quote whose lines don't add up to its £120 face value can't be printed or sent", async ({ page }) => {
  const ref = `QUO-IMP-${w.runId}`;
  const org = w.tenants.beta.id;
  // As the legacy import writes it (database owner): sent, face value £120, one line priced at total / quantity + VAT.
  await withDb(async (db) => {
    const { rows } = await db.query("insert into public.quotes (organization_id, quote_ref, customer, total_value, vat_enabled, status) values ($1, $2, 'Legacy Example Ltd', 120, true, 'sent') returning id", [org, ref]);
    await db.query("insert into public.quote_line_items (organization_id, quote_id, position, description, quantity, unit_price, vat_pct) values ($1, $2, 0, 'Priceless line', 2, 60, 20)", [org, rows[0].id]);
  });
  await signIn(page, w.tenants.beta.users.office);
  await page.goto("/quotes");
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: "All", exact: true }).click();
  const card = page.locator('[data-slot="card"]', { hasText: ref });
  await card.getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${ref} quote details` });
  await expect(details.getByRole("alert")).toContainText("stored total of £120.00");
  await expect(details.getByRole("alert")).toContainText("add up to £144.00");
  await expect(details.getByText("£120.00").first()).toBeVisible();
  await expect(details.getByRole("button", { name: "Download PDF" })).toBeDisabled();
  await expect(details.getByRole("button", { name: /Send to Customer/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  // The list's PDF button explains instead of downloading.
  let downloaded = false;
  page.on("download", () => { downloaded = true; });
  await card.getByRole("button", { name: "PDF" }).click();
  await expect(page.getByText("can't be printed or sent as it is").first()).toBeVisible();
  expect(downloaded).toBe(false);
  expect((await adminClient().from("quotes").select("total_value").eq("quote_ref", ref).single()).data?.total_value).toBe(120);
});

test("an imported invoice without payment details isn't owed until someone confirms it", async ({ page }) => {
  const ref = `INV-IMP-${w.runId}`;
  // Tenant alpha: receivables.spec asserts tenant beta's exact money owed.
  const org = w.tenants.alpha.id;
  await withDb(async (db) => {
    const { rows } = await db.query(
      `insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, amount_paid, due_date, payment_unverified, vat_enabled)
       values ($1, $2, 'Legacy Example Ltd', 100, 20, 120, 'part_paid', 0, '2026-01-31', true, true) returning id`, [org, ref]);
    await db.query("insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct) values ($1, $2, 0, 'Legacy work', 1, 100, 20)", [org, rows[0].id]);
  });
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/invoices");
  const row = page.getByRole("row").filter({ hasText: ref });
  await expect(row).toContainText("PAYMENT TO CONFIRM");
  await row.getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${ref} invoice details` });
  // The dialog also has the delivery-notes panel's own loading status, so pick the import notice by its words.
  await expect(details.getByRole("status").filter({ hasText: "Imported without payment details" })).toBeVisible();
  await details.getByRole("button", { name: "Confirm Still Owed" }).click();
  const confirm = page.getByRole("dialog", { name: `Confirm payments complete on ${ref}?` });
  await expect(confirm.getByRole("button", { name: "Confirm payments complete" })).toBeDisabled();
  await confirm.getByLabel("Note").fill("Checked against the records: still owed");
  await confirm.getByRole("button", { name: "Confirm payments complete" }).click();
  await expect.poll(async () => (await adminClient().from("invoices").select("payment_unverified, amount_paid").eq("invoice_ref", ref).single()).data)
    .toEqual({ payment_unverified: false, amount_paid: 0 });
  await expect(row).toContainText("overdue");
});

test("purchase order: saved as a draft, issued explicitly, sending recorded separately", async ({ page }) => {
  const ref = `PO-DR-${w.runId}`;
  const org = w.tenants.beta.id;
  const { data, error } = await adminClient().from("purchase_orders")
    .insert({ organization_id: org, po_ref: ref, po_number: ref, supplier: "Steel Ltd", total_value: 250, status: "draft", items: [{ description: "Bar", qty: 10, unit_price: 25 }] })
    .select("id").single();
  expect(error).toBeNull();
  const status = async () => (await adminClient().from("purchase_orders").select("status, sent_at").eq("id", data!.id).single()).data;
  await signIn(page, w.tenants.beta.users.office);
  await page.goto("/purchase-orders");
  const row = page.getByRole("row").filter({ hasText: ref });
  await expect(row.getByRole("button", { name: "Mark Received" })).toBeDisabled();
  await row.getByRole("button", { name: "Issue" }).click();
  await page.getByRole("dialog", { name: `Issue ${ref}?` }).getByRole("button", { name: "Issue Purchase Order" }).click();
  await expect.poll(status).toMatchObject({ status: "issued", sent_at: null });

  await row.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: `Edit ${ref}` });
  await expect(edit.getByText("Issued: the supplier, items and value are fixed")).toBeVisible();
  await expect(edit.getByRole("combobox")).toBeDisabled();
  await page.keyboard.press("Escape");

  await row.getByRole("button", { name: "Record Sent" }).click();
  await page.getByRole("dialog", { name: `Has ${ref} gone to the supplier?` }).getByRole("button", { name: /sent it/ }).click();
  await expect.poll(async () => Boolean((await status())?.sent_at)).toBe(true);
  expect((await status())?.status).toBe("issued");
});
