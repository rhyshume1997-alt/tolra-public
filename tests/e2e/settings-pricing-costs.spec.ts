/**
 * Settings > Costing (Pricing and profit, stage A1), off by default behind the company marker pricing-costs:on.
 * OFF company: the admin sees only the switch (off), no costing section and NO costing request. ON company: the section loads for the admin; the
 * designated person edits, every other admin sees no figure. The CI database has no p172 table (it is a proposal, rehearsed on scratch only), so
 * the real-backend ON test accepts "not available yet" and the editing tests answer the costing requests from the browser (page.route), with
 * made-up example figures. Office users cannot open /settings at all (middleware).
 * Own company per test group (createSoloTenant); the marker is cleared in afterAll.
 */
import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { PRICING_COSTS_ON_MARKER } from "@/lib/costing/costing-switch";

import { createSoloTenant, withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
const COSTING_REQUESTS = [/\/rest\/v1\/company_pricing_costs/, /\/rest\/v1\/rpc\/pricing_costs_overview/, /\/rest\/v1\/rpc\/save_pricing_costs/, /\/rest\/v1\/rpc\/set_pricing_profit_viewer/];
let solo: Awaited<ReturnType<typeof createSoloTenant>>;

async function setMarker(on: boolean) {
  await withDb(async (db) => {
    const done = await db.query(
      "update public.organization_settings set hidden_nav = case when $2 then array_append(array_remove(hidden_nav, $3), $3) else array_remove(hidden_nav, $3) end where organization_id = $1",
      [solo.id, on, PRICING_COSTS_ON_MARKER],
    );
    expect(done.rowCount).toBe(1);
  });
}

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => { solo = await createSoloTenant(w.runId, `costing-${randomUUID().slice(0, 6)}`, undefined, { salesOrders: false }); });
test.afterAll(async () => { if (solo) await setMarker(false); });

async function noSideways(page: Page) {
  for (const width of [360, 390, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(wide, `sideways scroll at ${width}`).toBe(false);
  }
}

test("OFF (the default): only the switch shows, and no costing request is made", async ({ page }) => {
  const seen: string[] = [];
  page.on("request", (r) => { if (COSTING_REQUESTS.some((re) => re.test(r.url()))) seen.push(r.url()); });
  await signIn(page, solo.admin);
  await page.goto("/settings");
  await expect(page.getByTestId("pricing-costs-card")).toBeVisible();
  await expect(page.getByRole("switch", { name: "Costing" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("costing-figures")).toHaveCount(0);
  await expect(page.getByTestId("costing-viewer")).toHaveCount(0);
  await page.waitForTimeout(2000);
  expect(seen).toEqual([]);
});

test("ON against the real database: the section loads for the admin (not available yet where p172 is not applied) and never errors", async ({ page }) => {
  await setMarker(true);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await signIn(page, solo.admin);
  await page.goto("/settings");
  const card = page.getByTestId("pricing-costs-card");
  await expect(card.getByTestId("costing-not-available").or(card.getByTestId("costing-viewer"))).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});

test("ON, designated person (answered in the browser): empty boxes, no number until entered, then the break-even, and a save", async ({ page }) => {
  await setMarker(true);
  let saved: unknown = null;
  await page.route(/\/rest\/v1\/company_pricing_costs/, (route) => route.fulfill({ json: [{ version: 1, men: null, hours_per_week: null, weeks_per_year: null, hourly_cost: null, yearly_target: null, profit_target_pct: null, running_costs: [] }] }));
  await page.route(/\/rest\/v1\/rpc\/pricing_costs_overview/, (route) => route.fulfill({ json: { viewer: { id: solo.admin.id, name: "Example admin" }, candidates: [{ id: solo.admin.id, name: "Example admin" }] } }));
  await page.route(/\/rest\/v1\/rpc\/save_pricing_costs/, (route) => { saved = route.request().postDataJSON(); return route.fulfill({ json: { version: 2 } }); });
  await signIn(page, solo.admin);
  await page.goto("/settings");
  await expect(page.getByTestId("costing-figures")).toBeVisible({ timeout: 30_000 });
  for (const label of ["Men on the shop floor", "Hours per week per man", "Working weeks per year", "Hourly cost per man (£)", "Yearly target (£)"]) await expect(page.getByLabel(label)).toHaveValue("");
  const helper = page.getByTestId("break-even");
  await expect(helper.getByText("Enter your rates in Settings").first()).toBeVisible();
  await expect(helper).not.toContainText("£");
  await page.getByLabel("Men on the shop floor").fill("2");
  await page.getByLabel("Hours per week per man").fill("40");
  await page.getByLabel("Working weeks per year").fill("50");
  await page.getByLabel("Hourly cost per man (£)").fill("10");
  await page.getByRole("button", { name: "Add a running cost" }).click();
  // Scoped to the row: the Settings page has other "Name" boxes (for example the company name) above this section.
  const row = page.getByTestId("running-cost-row").first();
  await row.getByLabel("Name", { exact: true }).fill("Example rent");
  await row.getByLabel("Amount (£)", { exact: true }).fill("1000");
  await expect(page.getByTestId("running-total")).toHaveText("Monthly total: £1,000.00");
  await expect(helper).toContainText("£13.00 an hour");
  await page.getByLabel("Profit percent you want (%)").fill("20");
  await expect(helper).toContainText("£16.25 an hour");
  await page.getByRole("button", { name: "Save costing figures" }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => saved).toMatchObject({ p_base_version: 1, p_values: { men: 2, hourlyCost: 10, yearlyTarget: null } });
  await noSideways(page);
});

test("ON, an admin who is not the designated person (answered in the browser): the chooser, and no figure", async ({ page }) => {
  await setMarker(true);
  await page.route(/\/rest\/v1\/company_pricing_costs/, (route) => route.fulfill({ json: [] }));
  await page.route(/\/rest\/v1\/rpc\/pricing_costs_overview/, (route) => route.fulfill({ json: { viewer: { id: randomUUID(), name: "Example John" }, candidates: [{ id: solo.admin.id, name: "Example admin" }] } }));
  await signIn(page, solo.admin);
  await page.goto("/settings");
  await expect(page.getByTestId("costing-viewer")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("costing-hidden")).toBeVisible();
  await expect(page.getByTestId("costing-figures")).toHaveCount(0);
  await noSideways(page);
});

test("office user: cannot open Settings, so no costing section", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/settings");
  await page.waitForURL(/\/dashboard/);
  await expect(page.getByTestId("pricing-costs-card")).toHaveCount(0);
});
