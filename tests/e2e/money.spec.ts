/**
 * Prices and quantities in the browser (audit B3: D11, D12, D13). Unsupported precision is refused before
 * anything is saved, and an accepted quote stores exactly the totals the builder showed.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

test.describe.configure({ mode: "serial" });

const w = world();
let customer = "";

async function openBuilder(page: Page) {
  await page.goto("/quotes");
  await page.getByRole("button", { name: "New quote" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Quote Builder" });
  await dialog.getByRole("combobox").first().selectOption({ label: customer });
  return dialog;
}

async function quotesFor(name: string) {
  const { data } = await adminClient().from("quotes").select("id, total_value").eq("customer", name);
  return data ?? [];
}

test.beforeAll(async () => {
  customer = `Money Customer ${w.runId}`;
  const { error } = await adminClient().from("customers").insert({ organization_id: w.tenants.alpha.id, name: customer });
  expect(error).toBeNull();
});

test.beforeEach(async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.office);
});

test("a price with fractions of a penny can't be submitted", async ({ page }) => {
  const dialog = await openBuilder(page);
  const price = dialog.getByRole("spinbutton", { name: "Unit price" });
  await price.fill("0.125");
  await dialog.getByRole("button", { name: "Save Quote" }).click();
  expect(await price.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  await expect(dialog).toBeVisible();
  expect(await quotesFor(customer)).toEqual([]);
});

test("a quantity with more than 3 decimal places can't be submitted", async ({ page }) => {
  const dialog = await openBuilder(page);
  const quantity = dialog.getByRole("spinbutton", { name: "Quantity" });
  await quantity.fill("1.2345");
  await dialog.getByRole("spinbutton", { name: "Unit price" }).fill("10");
  await dialog.getByRole("button", { name: "Save Quote" }).click();
  expect(await quantity.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(false);
  expect(await quotesFor(customer)).toEqual([]);
});

test("a priced row without a description is refused, not silently dropped", async ({ page }) => {
  const dialog = await openBuilder(page);
  await dialog.getByRole("textbox", { name: "Description", exact: true }).fill("");
  await dialog.getByRole("spinbutton", { name: "Unit price" }).fill("40");
  await dialog.getByRole("button", { name: "Save Quote" }).click();
  await expect(page.getByText("Every line needs a description")).toBeVisible();
  await expect(dialog).toBeVisible();
  expect(await quotesFor(customer)).toEqual([]);
});

test("0.02 x £7.25 is saved as the builder shows it: £0.15 net, £0.18 with VAT", async ({ page }) => {
  const dialog = await openBuilder(page);
  await dialog.getByRole("textbox", { name: "Description", exact: true }).fill("Shim");
  await dialog.getByRole("spinbutton", { name: "Quantity" }).fill("0.02");
  await dialog.getByRole("spinbutton", { name: "Unit price" }).fill("7.25");
  await expect(dialog.getByText("£0.18").first()).toBeVisible();
  await dialog.getByRole("button", { name: "Save Quote" }).click();
  await expect(dialog).toBeHidden();
  const saved = await quotesFor(customer);
  expect(saved.map((q) => Number(q.total_value))).toEqual([0.18]);
});
