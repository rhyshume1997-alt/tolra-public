/**
 * One click per task: a draft invoice stays open after Issue (with Send to Customer ready), and "Issue & send" issues it and then
 * runs the normal send (PDF download, mail draft) with the "I've sent it" confirmation still asked.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
const tag = () => w.runId.slice(0, 6);

async function draftInvoice(customer: string) {
  const org = w.tenants.alpha.id;
  const service = adminClient();
  const { data: invoice, error } = await service.from("invoices").insert({ organization_id: org, invoice_ref: null, customer, status: "draft", subtotal: 100, vat: 20, total: 120, vat_enabled: true, due_date: "2099-01-31", description: "Bush" }).select("id").single();
  expect(error).toBeNull();
  expect((await service.from("invoice_line_items").insert({ organization_id: org, invoice_id: invoice!.id, position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20 })).error).toBeNull();
  return invoice!.id as string;
}

const stored = async (id: string) => (await adminClient().from("invoices").select("status, invoice_ref, sent_date").eq("id", id).single()).data!;

test("Issue keeps the invoice open and Send to Customer is there at once", async ({ page }) => {
  const customer = `Issue Open ${tag()} Ltd`;
  const id = await draftInvoice(customer);
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/invoices");
  await page.getByRole("row").filter({ hasText: customer }).getByRole("button", { name: "View" }).click();
  await page.getByRole("dialog", { name: /invoice details/ }).getByRole("button", { name: "Issue Invoice" }).click();
  await page.getByRole("dialog", { name: `Issue this invoice to ${customer}?` }).getByRole("button", { name: "Issue Invoice" }).click();
  await expect.poll(async () => (await stored(id)).status).toBe("issued");
  const { invoice_ref: ref } = await stored(id);
  const details = page.getByRole("dialog", { name: `${ref} invoice details` });
  await expect(details.getByRole("button", { name: "Send to Customer" })).toBeVisible();
  await expect(details.getByRole("button", { name: /^Issue/ })).toHaveCount(0);
});

test("Issue & send issues the invoice, downloads the PDF and still asks to confirm it was sent", async ({ page }) => {
  const customer = `Issue Send ${tag()} Ltd`;
  const id = await draftInvoice(customer);
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/invoices");
  await page.getByRole("row").filter({ hasText: customer }).getByRole("button", { name: "View" }).click();
  await page.getByRole("dialog", { name: /invoice details/ }).getByRole("button", { name: "Issue & send" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("dialog", { name: `Issue this invoice to ${customer}?` }).getByRole("button", { name: "Issue & send" }).click();
  await download;
  const { invoice_ref: ref, status } = await stored(id);
  expect(status).toBe("issued");
  const confirm = page.getByRole("dialog", { name: `Has ${ref} gone to the customer?` });
  await expect(confirm).toBeVisible();
  // Not recorded as sent until the person says so.
  expect((await stored(id)).sent_date).toBeNull();
  await confirm.getByRole("button", { name: /sent it/ }).click();
  await expect.poll(async () => Boolean((await stored(id)).sent_date)).toBe(true);
});
