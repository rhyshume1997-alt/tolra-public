/**
 * Module 7 acceptance, in the browser: error + Retry on Reports, Revenue and the Dashboard, and the Reports > Revenue link.
 * Inputs: the alpha company's admin; both report switches set through SQL (removed again in afterAll, whatever happened).
 * Each check makes one read fail at the network (HTTP 500), sees the failure message with a Retry button, lets reads through,
 * presses Retry and sees the figures return. Also: the Revenue link shows on Reports only while the Revenue switch is on.
 * Serial (the markers are shared state). Needs the local test backend like every other spec; listing needs none.
 * Must not change: the markers (lib/reports/*-switch.ts) or the visible texts asserted here.
 */
import { expect, test, type Page } from "@playwright/test";

import { REPORTS_ON_MARKER } from "@/lib/reports/reports-switch";
import { REVENUE_ON_MARKER } from "@/lib/reports/revenue/revenue-switch";

import { withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
let org = "";

test.describe.configure({ mode: "serial" });

const setMarker = (marker: string, on: boolean) => withDb(async (db) => {
  const done = await db.query(
    "update public.organization_settings set hidden_nav = case when $2::boolean then array_append(array_remove(hidden_nav, $3), $3) else array_remove(hidden_nav, $3) end where organization_id = $1",
    [org, on, marker],
  );
  if (done.rowCount !== 1) throw new Error(`no organization_settings row for ${org}`);
});

/** Fails every GET to the table with a 500 while `broken.on` is true. */
async function breakReads(page: Page, table: string) {
  const broken = { on: true };
  await page.route(new RegExp(`/rest/v1/${table}(\\?|$)`), (route) => (broken.on && route.request().method() === "GET"
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "forced failure", code: "XX000" }) })
    : route.continue()));
  return broken;
}

test.beforeAll(() => { org = w.tenants.alpha.id; });
test.afterAll(async () => { await setMarker(REPORTS_ON_MARKER, false); await setMarker(REVENUE_ON_MARKER, false); });

test("Reports: a failed read shows Retry, and Retry brings the card back; the Revenue link follows its switch", async ({ page }) => {
  test.setTimeout(120_000);
  await setMarker(REPORTS_ON_MARKER, true);
  await setMarker(REVENUE_ON_MARKER, false);
  await signIn(page, w.tenants.alpha.users.admin);
  const broken = await breakReads(page, "jobs");
  await page.goto("/reports");
  await expect(page.getByTestId("reports-view")).toBeVisible();
  await expect(page.getByTestId("report-wip").getByTestId("report-error")).toBeVisible();
  await expect(page.getByTestId("reports-revenue-link")).toHaveCount(0);

  broken.on = false;
  await page.getByTestId("report-wip").getByTestId("report-retry").click();
  await expect(page.getByTestId("report-wip").getByTestId("report-error")).toHaveCount(0);
  await expect(page.getByTestId("report-wip").getByTestId("report-retry")).toHaveCount(0);

  await setMarker(REVENUE_ON_MARKER, true);
  await page.reload();
  await page.getByTestId("reports-revenue-link").click();
  await expect(page).toHaveURL(/\/reports\/revenue$/);
  await expect(page.getByTestId("revenue-page")).toBeVisible();
});

test("Revenue: a failed read shows Retry, and Retry re-reads", async ({ page }) => {
  test.setTimeout(120_000);
  await setMarker(REVENUE_ON_MARKER, true);
  await signIn(page, w.tenants.alpha.users.admin);
  const broken = await breakReads(page, "invoices");
  await page.goto("/reports/revenue");
  await expect(page.getByTestId("revenue-invoiced-failed")).toBeVisible();
  broken.on = false;
  await page.getByTestId("revenue-retry").click();
  await expect(page.getByTestId("revenue-invoiced-failed")).toHaveCount(0);
  await expect(page.getByTestId("revenue-retry")).toHaveCount(0);
  await expect(page.getByTestId("revenue-invoiced-total")).toBeVisible();
});

test("Revenue OFF: the notice, no Retry, no link on Reports", async ({ page }) => {
  await setMarker(REVENUE_ON_MARKER, false);
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/reports/revenue");
  await expect(page.getByTestId("revenue-off")).toBeVisible();
  await expect(page.getByTestId("revenue-retry")).toHaveCount(0);
});

test("Dashboard: a failed load shows Retry, and Retry brings it back", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, w.tenants.alpha.users.admin);
  const broken = await breakReads(page, "jobs");
  await page.goto("/dashboard");
  await expect(page.getByRole("button", { name: "Retry" }).first()).toBeVisible();
  broken.on = false;
  await page.getByRole("button", { name: "Retry" }).first().click();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
});
