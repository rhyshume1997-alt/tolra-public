/**
 * One click per task: /invoices?invoice=<id> opens that invoice's details (as /jobs?job=<id> does for a job). It is looked up only
 * among the invoices the person can read, so another company's invoice, or an id that doesn't exist, opens nothing.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
const tag = () => w.runId.slice(0, 6);

async function draftIn(org: string, customer: string) {
  const { data, error } = await adminClient().from("invoices").insert({ organization_id: org, invoice_ref: null, customer, status: "draft", subtotal: 100, vat: 0, total: 100, vat_enabled: false, due_date: "2099-01-31", description: "Bush" }).select("id").single();
  expect(error).toBeNull();
  return data!.id as string;
}

test("a link with an invoice id opens that invoice's details", async ({ page }) => {
  const customer = `Link Open ${tag()} Ltd`;
  const id = await draftIn(w.tenants.alpha.id, customer);
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto(`/invoices?invoice=${id}`);
  const details = page.getByRole("dialog", { name: /invoice details/ });
  await expect(details).toBeVisible();
  await expect(details).toContainText(customer);
});

test("an invoice of another company, or an id that doesn't exist, opens nothing", async ({ page }) => {
  const other = await draftIn(w.tenants.beta.id, `Link Other ${tag()} Ltd`);
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto(`/invoices?invoice=${other}`);
  await expect(page.getByText("That invoice isn't available.")).toBeVisible();
  await expect(page.getByRole("dialog", { name: /invoice details/ })).toHaveCount(0);
  await page.goto("/invoices?invoice=00000000-0000-0000-0000-000000000000");
  await expect(page.getByText("That invoice isn't available.")).toBeVisible();
  await expect(page.getByRole("dialog", { name: /invoice details/ })).toHaveCount(0);
});
