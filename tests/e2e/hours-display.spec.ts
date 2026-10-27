/**
 * Weekly hours "show / hide" columns, in the browser, against the local disposable backend only (synthetic alpha tenant).
 *
 * - Hiding one column (Breaks) in the Columns picker removes its header and its cells together on This week (header count == cell
 *   count), and its tile on Today; the person and Paid stay.
 * - It is remembered after a reload, and works at 1280 and 390 wide.
 * - The week total (Paid) is the same whatever is hidden. Display only: no hours or pay figure changes.
 * - The same list is in Settings > Table Columns.
 *
 * Seeds one worked day (Tuesday 3 March 2026, 08:00 to 16:30) for the workshop person. The picker setting is restored afterwards.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient, withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

test.describe.configure({ mode: "serial" });

const w = world();
const person = () => w.tenants.alpha.users.workshop;
const WEEK = "/time/week?week=2026-03-02";
let before: unknown = null;

test.beforeAll(async () => {
  await withDb(async (db) => {
    await db.query(
      `insert into public.attendance_events (organization_id, user_id, client_op_id, action, at, source, recorded_by)
       values ($1, $2, gen_random_uuid(), 'in', '2026-03-03T08:00:00Z', 'clock', $2), ($1, $2, gen_random_uuid(), 'out', '2026-03-03T16:30:00Z', 'clock', $2)`, [w.tenants.alpha.id, person().id]);
  });
  const { data } = await adminClient().from("organization_settings").select("hidden_columns").eq("organization_id", w.tenants.alpha.id).maybeSingle();
  before = data?.hidden_columns ?? {};
});

test.afterAll(async () => {
  await adminClient().from("organization_settings").update({ hidden_columns: before ?? {} }).eq("organization_id", w.tenants.alpha.id);
});

const headers = (page: Page) => page.getByTestId("week-table").locator("thead th");
const firstRowCells = (page: Page) => page.getByTestId(`week-row-${person().id}`).locator("td");

async function setBreaks(page: Page, visible: boolean) {
  await page.getByRole("button", { name: "Columns" }).click();
  const item = page.getByRole("menuitemcheckbox", { name: "Breaks" });
  if ((await item.getAttribute("aria-checked")) !== String(visible)) await item.click();
  await page.keyboard.press("Escape");
}

for (const size of [{ name: "1280", width: 1280, height: 800 }, { name: "390", width: 390, height: 844 }]) {
  test(`hiding Breaks takes its header and cells together, is remembered after reload, and Paid is unchanged (${size.name})`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await signIn(page, w.tenants.alpha.users.admin);
    await page.goto(WEEK);
    const row = page.getByTestId(`week-row-${person().id}`);
    await expect(row).toBeVisible();
    const paid = (await row.getByTestId("week-paid").innerText()).trim();
    expect(paid).not.toBe("");
    const allHeaders = await headers(page).count();
    expect(await firstRowCells(page).count()).toBe(allHeaders);
    await expect(headers(page).filter({ hasText: "Breaks" })).toHaveCount(1);

    await setBreaks(page, false);
    await expect(headers(page).filter({ hasText: "Breaks" })).toHaveCount(0);
    await expect(headers(page)).toHaveCount(allHeaders - 1);
    await expect(firstRowCells(page)).toHaveCount(allHeaders - 1);
    await expect(headers(page).filter({ hasText: "Person" })).toHaveCount(1);
    await expect(headers(page).filter({ hasText: "Paid" })).toHaveCount(1);
    await expect(row.getByTestId("week-paid")).toHaveText(paid);

    await page.reload();
    await expect(row).toBeVisible();
    await expect(headers(page).filter({ hasText: "Breaks" })).toHaveCount(0);
    await expect(headers(page)).toHaveCount(allHeaders - 1);
    await expect(firstRowCells(page)).toHaveCount(allHeaders - 1);
    await expect(row.getByTestId("week-paid")).toHaveText(paid);

    // Today shows the same choice and keeps Paid.
    await page.goto(`/time?date=2026-03-03&user=${person().id}`);
    const totals = page.getByTestId("day-totals");
    await expect(totals.getByText("Paid", { exact: true })).toBeVisible();
    await expect(totals.getByText("Breaks", { exact: true })).toHaveCount(0);
    await expect(totals.getByText("Clocked", { exact: true })).toBeVisible();

    // The same list is in Settings > Table Columns, and putting Breaks back restores header and cell.
    await page.goto("/settings");
    const breaksSwitch = page.getByRole("switch", { name: "Show Breaks in Weekly hours" });
    await expect(breaksSwitch).toBeVisible();
    await expect(breaksSwitch).toHaveAttribute("aria-checked", "false");
    await page.goto(WEEK);
    await expect(row).toBeVisible();
    await setBreaks(page, true);
    await expect(headers(page)).toHaveCount(allHeaders);
    await expect(firstRowCells(page)).toHaveCount(allHeaders);
    await expect(row.getByTestId("week-paid")).toHaveText(paid);
  });
}

test("with every optional column hidden, the header is still Person, Clocked, Paid, Check, Approval; locked columns in a saved set are ignored", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // Everything hidden, including the locked keys, as an old or hand-edited saved set might hold it.
  const all = ["days", "clocked", "breaks", "jobs", "unallocated", "ticks", "check", "approval"];
  const { error } = await adminClient().from("organization_settings").update({ hidden_columns: { hours: all } }).eq("organization_id", w.tenants.alpha.id);
  expect(error).toBeNull();
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto(WEEK);
  await expect(page.getByTestId(`week-row-${person().id}`)).toBeVisible();
  const text = await headers(page).evaluateAll((cells) => cells.map((c) => (c.textContent ?? "").trim()));
  expect(text).toEqual(["Person", "Clocked", "Paid", "Check", "Approval", ""]);
  await expect(firstRowCells(page)).toHaveCount(text.length);

  await page.getByRole("button", { name: "Columns" }).click();
  for (const name of ["Clocked", "Check", "Approval"]) {
    const item = page.getByRole("menuitemcheckbox", { name });
    await expect(item).toHaveAttribute("aria-checked", "true");
    await expect(item).toHaveAttribute("aria-disabled", "true");
  }
  await page.keyboard.press("Escape");

  await page.goto(`/time?date=2026-03-03&user=${person().id}`);
  const totals = page.getByTestId("day-totals");
  await expect(totals.getByText("Clocked", { exact: true })).toBeVisible();
  await expect(totals.getByText("Paid", { exact: true })).toBeVisible();
  await expect(totals.getByText("Breaks", { exact: true })).toHaveCount(0);

  await page.goto("/settings");
  await expect(page.getByRole("switch", { name: "Approval is always shown in Weekly hours" })).toBeDisabled();
  await expect(page.getByRole("switch", { name: "Approval is always shown in Weekly hours" })).toHaveAttribute("aria-checked", "true");
});
