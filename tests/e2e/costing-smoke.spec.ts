import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { adminClient, createSoloTenant } from "../support/fixtures";
import { optionalBackendConfigured } from "../support/optional-backend";
import { signIn, world } from "./helpers";

test.skip(!optionalBackendConfigured(), "No disposable test database configured.");
let org: Awaited<ReturnType<typeof createSoloTenant>>;
let customer: string;
test.beforeEach(async ({ page }) => {
  const tag = randomUUID().slice(0, 8);
  org = await createSoloTenant(world().runId, `cost-smoke-${tag}`);
  customer = `Costing smoke ${tag}`;
  const db = adminClient();
  expect((await db.from("customers").insert({ organization_id: org.id, name: customer, email: `costing.${tag}@example.test` })).error).toBeNull();
  expect((await db.from("costing_materials").insert({ organization_id: org.id, name: "Test blank", price_pence: 200, price_unit: "each", scrap_pct: 0 })).error).toBeNull();
  expect((await db.from("costing_machines").insert({ organization_id: org.id, name: "Test mill", hourly_rate_pence: 6000, labour_rate_pence: null })).error).toBeNull();
  expect((await db.from("costing_defaults").insert({ organization_id: org.id, labour_rate_pence: 3000, programming_rate_pence: 7500, overhead_pct: 150, default_margin_pct: 20 })).error).toBeNull();
  await signIn(page, org.admin);
});

test("company costing settings save pounds as integer pence and reload", async ({ page }) => {
  await page.goto("/settings");
  const settings = page.getByRole("region", { name: "Company costing settings" });
  await expect(settings.getByRole("heading", { name: "Costing rates" })).toBeVisible();
  await settings.getByLabel("Labour £ per hour", { exact: true }).fill("40.29");
  await settings.getByRole("button", { name: "Save costing rates" }).click();
  await expect(settings.getByText("Costing rates saved.", { exact: true })).toBeVisible();
  const result = await adminClient().from("costing_defaults").select("labour_rate_pence").eq("organization_id", org.id).single();
  expect(result.error).toBeNull(); expect(result.data!.labour_rate_pence).toBe(4029);
  await page.reload();
  await expect(page.getByLabel("Labour £ per hour", { exact: true })).toHaveValue("40.29");
});
test("Price this part shows the expected price and copies one rounded quote line", async ({ page }) => {
  await page.goto("/quotes");
  await page.getByRole("button", { name: "New quote", exact: true }).first().click();
  const builder = page.getByRole("dialog", { name: "Quote Builder", exact: true });
  await builder.getByRole("combobox").first().selectOption({ label: customer });
  const pricing = builder.getByRole("region", { name: "Price this part", exact: true });
  await expect(pricing).toBeVisible();
  await pricing.getByLabel("Part description", { exact: true }).fill("Test bracket");
  await pricing.getByLabel("Quantity", { exact: true }).fill("2");
  await pricing.getByLabel("Setup hours for this batch", { exact: true }).fill("1");
  await expect(pricing.getByText("Price per part: £83.40", { exact: true })).toBeVisible();
  await expect(pricing.getByText("Quote line total before VAT: £166.80", { exact: true })).toBeVisible();
  await pricing.getByRole("button", { name: "Add as quote line" }).click();
  await expect(builder.getByRole("textbox", { name: "Description", exact: true })).toHaveValue("Test bracket");
  await expect(builder.getByRole("spinbutton", { name: "Unit price", exact: true })).toHaveValue("83.4");
  await expect(builder.getByRole("spinbutton", { name: "Quantity", exact: true }).first()).toHaveValue("2");
  // No sending or payment routes are invoked by this smoke test.
});
