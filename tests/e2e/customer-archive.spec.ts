/**
 * Customer archive (migration 097): office archives a customer on the Customers page; it leaves the default list and the customer
 * pickers for new documents, the Archived filter shows it, Unarchive puts it back. Documents that name it keep showing it. A used
 * customer can't be deleted (the database refuses it), and another company can't archive it.
 */
import { expect, test } from "@playwright/test";

import { adminClient, signedInClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("archive hides a customer from the list and the pickers, Archived shows it, Unarchive restores it", async ({ page }) => {
  const admin = adminClient();
  const org = w.tenants.alpha.id;
  const tag = w.runId.slice(0, 8);
  const [keep, gone] = [`Arch Keep ${tag} Ltd`, `Arch Gone ${tag} Ltd`];
  const { data: rows, error } = await admin.from("customers").insert([{ organization_id: org, name: keep }, { organization_id: org, name: gone }]).select("id, name");
  expect(error).toBeNull();
  const goneId = rows!.find((r) => r.name === gone)!.id as string;
  expect((await admin.from("sales_orders").insert({ organization_id: org, so_number: `SO-ARCH-${tag}`, customer: gone, status: "open" })).error).toBeNull();

  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/customers");
  const cell = (name: string) => page.getByRole("cell", { name, exact: true });
  await expect(cell(keep)).toBeVisible();
  await expect(cell(gone)).toBeVisible();
  await page.getByRole("row").filter({ hasText: gone }).getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText(/Archived \(nothing is deleted/)).toBeVisible();
  await expect(cell(gone)).toHaveCount(0);
  await expect(cell(keep)).toBeVisible();
  expect((await admin.from("record_archive_state").select("state").eq("record_table", "customers").eq("record_id", goneId).single()).data).toEqual({ state: "archived" });

  // The Archived filter shows it (and only archived ones); All shows both.
  await page.getByRole("button", { name: /^Archived \(/ }).click();
  await expect(cell(gone)).toBeVisible();
  await expect(cell(keep)).toHaveCount(0);
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(cell(gone)).toBeVisible();
  await expect(cell(keep)).toBeVisible();

  // Not offered for a new document; the sales order that names it still shows it.
  await page.goto("/sales-orders");
  await expect(page.getByText(`SO-ARCH-${tag}`, { exact: true })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: `SO-ARCH-${tag}` })).toContainText(gone);
  await page.getByRole("button", { name: /New sales order/ }).first().click();
  const picker = page.getByRole("dialog", { name: "New Sales Order" }).locator("select[name=customer]");
  await expect(picker.locator("option", { hasText: keep })).toHaveCount(1);
  await expect(picker.locator("option", { hasText: gone })).toHaveCount(0);

  // Unarchive puts it back in the list and the picker.
  await page.goto("/customers");
  await page.getByRole("button", { name: /^Archived \(/ }).click();
  await page.getByRole("row").filter({ hasText: gone }).getByRole("button", { name: "Unarchive" }).click();
  await expect(page.getByText("Moved out of the archive")).toBeVisible();
  await expect(cell(gone)).toHaveCount(0);
  await page.getByRole("button", { name: /^Active \(/ }).click();
  await expect(cell(gone)).toBeVisible();
  expect((await admin.from("record_archive_state").select("state").eq("record_table", "customers").eq("record_id", goneId)).data).toEqual([]);
  await page.goto("/sales-orders");
  await page.getByRole("button", { name: /New sales order/ }).first().click();
  await expect(page.getByRole("dialog", { name: "New Sales Order" }).locator("select[name=customer]").locator("option", { hasText: gone })).toHaveCount(1);
  // Nothing deleted, the customer row unchanged.
  expect((await admin.from("customers").select("name").eq("id", goneId).single()).data).toEqual({ name: gone });
});

test("a used customer can't be deleted; another company can't archive it or see it", async ({ page }) => {
  const admin = adminClient();
  const org = w.tenants.alpha.id;
  const tag = w.runId.slice(0, 8);
  const used = `Arch Used ${tag} Ltd`;
  const { data: row } = await admin.from("customers").insert({ organization_id: org, name: used }).select("id").single();
  expect((await admin.from("invoices").insert({ organization_id: org, customer: used })).error).toBeNull();

  // The database refuses the delete for a signed-in admin (there is no delete button; the API is the only way in).
  const alphaAdmin = await signedInClient(w.tenants.alpha.users.admin);
  const refused = await alphaAdmin.from("customers").delete().eq("id", row!.id).select("id");
  expect(refused.error).toMatchObject({ code: "22023", hint: "customer_in_use" });
  expect((await admin.from("customers").select("id").eq("id", row!.id)).data).toHaveLength(1);

  // Another company's admin: refused as not found, and nothing is recorded.
  const betaAdmin = await signedInClient(w.tenants.beta.users.admin);
  expect((await betaAdmin.rpc("set_archive_state", { p_table: "customers", p_id: row!.id, p_state: "archived" })).error).toMatchObject({ code: "P0002" });
  expect((await admin.from("record_archive_state").select("state").eq("record_id", row!.id)).data).toEqual([]);
  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/customers");
  await expect(page.getByRole("heading", { name: "Customers" })).toBeVisible();
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect(page.getByText(used)).toHaveCount(0);
});
