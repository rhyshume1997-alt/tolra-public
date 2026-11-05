/**
 * Costing in the app, the way John uses it: an admin enters the company's costing rates in Settings, prices a part in the Quote Builder with
 * "Price this part", puts the price into the quote line, saves the quote, and later changes the rates: the saved quote does not change.
 *
 * The figures are the worked example in tests/unit/costing-price-part.test.ts (by hand and through the golden-checked engine, lib/costing/engine.ts):
 *   steel bar GBP 4.00/kg, 5% scrap; Mill GBP 65/h; labour 25, programming 40, overhead 150 (x1.5), margin 20%.
 *   10 off, 0.5 kg each, setup 1 h for the batch, cycle 0.2 h each, programming 2 h for the batch:
 *   material 2.10, machine 19.50, labour 7.50, programming 8.00, overhead 13.50, cost per part 50.60, price per part 60.72, total 607.20.
 *   After the rates change (machine GBP 80/h, margin 35%): cost 57.35, price 77.42 (unit test "after the rates change").
 *
 * Needs release 143 (costing tables and save_costing_settings_atomic) in the test database. Never run in the build that wrote it: CI only.
 * No Python costing service is involved (it stays off); the quote's own line picker is not used.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

async function clearRates(orgId: string) {
  const admin = adminClient();
  for (const table of ["costing_materials", "costing_machines", "costing_defaults"]) {
    expect((await admin.from(table).delete().eq("organization_id", orgId)).error).toBeNull();
  }
}

async function enterRates(page: Page, rates: { machine: number; margin: number }) {
  await page.goto("/settings");
  const card = page.getByRole("region", { name: "Costing rates" });
  await expect(card).toBeVisible();
  const materials = await card.getByLabel(/^Material name /).count();
  if (materials === 0) {
    await card.getByRole("button", { name: "Add material" }).click();
    await card.getByLabel(/^Material name /).fill("Steel bar");
    await card.getByLabel(/^Price £ /).fill("4");
    await card.getByLabel(/^Scrap % /).fill("5");
    await card.getByRole("button", { name: "Add machine" }).click();
    await card.getByLabel(/^Machine name /).fill("Mill");
  }
  await card.getByLabel(/^Machine £ per hour /).fill(String(rates.machine));
  await card.getByLabel("Labour £ per hour", { exact: true }).fill("25");
  await card.getByLabel("Programming £ per hour", { exact: true }).fill("40");
  await card.getByLabel("Overhead %", { exact: true }).fill("150");
  await card.getByLabel("Margin %", { exact: true }).fill(String(rates.margin));
  await card.getByRole("button", { name: "Save costing rates" }).click();
  await expect(card.getByText("Costing rates saved.")).toBeVisible();
}

test("costing rates in Settings -> Price this part -> quote line; changing the rates later leaves the saved quote alone", async ({ page }) => {
  test.setTimeout(240_000);
  const admin = adminClient();
  const org = w.tenants.alpha.id;
  const customer = `Costing Co ${w.runId}`;
  expect((await admin.from("customers").insert({ organization_id: org, name: customer })).error).toBeNull();
  await clearRates(org);

  try {
    await signIn(page, w.tenants.alpha.users.admin);

    // 1. No rates yet: the quote builder says costing is not set up and shows no price or cost.
    await page.goto("/quotes");
    await page.getByRole("button", { name: "New quote" }).first().click();
    const builder = page.getByRole("dialog", { name: "Quote Builder" });
    const panel = builder.getByRole("region", { name: "Price this part" });
    await expect(panel.getByText("Costing is not set up: enter your rates in Settings > Costing rates")).toBeVisible();
    await expect(panel.getByLabel("Cost breakdown")).toHaveCount(0);
    await expect(panel.getByText(/£\d/)).toHaveCount(0);
    await page.keyboard.press("Escape");

    // 2. Settings says nothing is entered yet; enter the rates and save (one atomic save).
    await page.goto("/settings");
    await expect(page.getByRole("region", { name: "Costing rates" }).getByText("No costing rates entered yet")).toBeVisible();
    await enterRates(page, { machine: 65, margin: 20 });
    const stored = async () => ({
      materials: (await admin.from("costing_materials").select("name, price_pence, price_unit, scrap_pct").eq("organization_id", org)).data,
      machines: (await admin.from("costing_machines").select("name, hourly_rate_pence").eq("organization_id", org)).data,
      defaults: (await admin.from("costing_defaults").select("labour_rate_pence, programming_rate_pence, overhead_pct, default_margin_pct").eq("organization_id", org).single()).data,
    });
    await expect.poll(async () => (await stored()).machines?.[0]?.hourly_rate_pence).toBe(6500);
    const saved = await stored();
    expect(saved.materials).toEqual([{ name: "Steel bar", price_pence: 400, price_unit: "kg", scrap_pct: 5 }]);
    expect(saved.defaults).toMatchObject({ labour_rate_pence: 2500, programming_rate_pence: 4000, overhead_pct: 150, default_margin_pct: 20 });
    expect(Number(saved.defaults!.default_margin_pct)).toBe(20);

    // 3. A new quote: Price this part, the figures are the engine's for these rates.
    await page.goto("/quotes");
    await page.getByRole("button", { name: "New quote" }).first().click();
    await builder.getByRole("combobox").first().selectOption({ label: customer });
    await panel.getByLabel("Part description").fill("Bush 40mm");
    await panel.getByLabel("Part quantity").fill("10");
    await panel.getByLabel("Material weight kg per part").fill("0.5");
    await panel.getByLabel("Setup hours for batch").fill("1");
    await panel.getByLabel("Cycle hours per part").fill("0.2");
    await panel.getByLabel("Programming hours for batch").fill("2");
    const breakdown = panel.getByLabel("Cost breakdown");
    for (const line of ["Material: £2.10", "Machine: £19.50", "Labour: £7.50", "Programming: £8.00", "Overhead: £13.50", "Cost per part: £50.60", "Price per part: £60.72", "Total quote: £607.20"]) {
      await expect(breakdown).toContainText(line);
    }

    // 4. Apply: the price goes into the quote line (the empty starter line is replaced); save the quote.
    await panel.getByRole("button", { name: "Add as quote line" }).click();
    await expect(builder.getByRole("textbox", { name: "Description", exact: true })).toHaveValue("Bush 40mm");
    await expect(builder.getByRole("spinbutton", { name: "Quantity" })).toHaveValue("10");
    await expect(builder.getByRole("spinbutton", { name: "Unit price" })).toHaveValue("60.72");
    await builder.getByRole("button", { name: "Save Quote" }).click();
    await expect(builder).toBeHidden();

    const quote = async () => (await admin.from("quotes").select("id, total_value").eq("customer", customer).eq("organization_id", org).single()).data!;
    await expect.poll(async () => (await quote()).id).toBeTruthy();
    const { id: quoteId, total_value: totalBefore } = await quote();
    const lines = async () => (await admin.from("quote_line_items").select("description, quantity, unit_price, source").eq("quote_id", quoteId).order("position")).data!;
    const before = await lines();
    expect(before.map((l) => ({ description: l.description, quantity: Number(l.quantity), unit_price: Number(l.unit_price), source: l.source })))
      .toEqual([{ description: "Bush 40mm", quantity: 10, unit_price: 60.72, source: "costing_calculator" }]);

    // 5. The rates change (dearer machine, higher margin): the same part now prices differently...
    await enterRates(page, { machine: 80, margin: 35 });
    await expect.poll(async () => (await stored()).machines?.[0]?.hourly_rate_pence).toBe(8000);
    await page.goto("/quotes");
    await page.getByRole("button", { name: "New quote" }).first().click();
    await panel.getByLabel("Part description").fill("Bush 40mm");
    await panel.getByLabel("Part quantity").fill("10");
    await panel.getByLabel("Material weight kg per part").fill("0.5");
    await panel.getByLabel("Setup hours for batch").fill("1");
    await panel.getByLabel("Cycle hours per part").fill("0.2");
    await panel.getByLabel("Programming hours for batch").fill("2");
    await expect(panel.getByLabel("Cost breakdown")).toContainText("Price per part: £77.42");
    await page.keyboard.press("Escape");

    // 6. ...and the saved quote is exactly as it was: the line, and the quote's total.
    expect(await lines()).toEqual(before);
    expect((await quote()).total_value).toBe(totalBefore);
    await page.reload();
    await expect(page.locator('[data-slot="card"]', { hasText: customer }).first()).toBeVisible();
    expect(await lines()).toEqual(before);
  } finally {
    await clearRates(org);
  }
});
