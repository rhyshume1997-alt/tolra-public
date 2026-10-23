/**
 * Regression: the invoice detail's Payments section sat on "Loading payments…" forever, with no request to
 * rest/v1/invoice_payments and no error, and a reload did not help.
 *
 * Cause: every Supabase query first asks auth-js for the session, and auth-js serialises that through ONE Web Lock shared
 * by every tab of the browser (`lock:sb-<ref>-auth-token`). supabase-js 2.105 passes `lockAcquireTimeout: undefined`,
 * which overwrote auth-js's 5 s default, so a waiter never gave up (and never took the orphaned lock): while another
 * tab or app window of the same browser held that lock without letting go (stuck mid-refresh, frozen), nothing in this
 * tab could talk to the database. lib/supabase.ts now sets the timeout, so the waiter steals the orphaned lock.
 *
 * This test plays the stuck tab: a second page of the same browser context takes the auth lock and never releases it.
 */
import { expect, test } from "@playwright/test";

import { withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("a stuck tab holding the shared auth lock does not leave the Payments section loading forever", async ({ page }) => {
  const ref = `INV-LOCK-${w.runId}`;
  const org = w.tenants.alpha.id;
  await withDb(async (db) => {
    const { rows } = await db.query(
      `insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, amount_paid, due_date, vat_enabled, payment_unverified)
       values ($1, $2, 'Lock Example Ltd', 300, 60, 360, 'issued', 0, '2026-01-31', true, true) returning id`, [org, ref]);
    await db.query("insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct) values ($1, $2, 0, 'Imported work', 1, 300, 20)", [org, rows[0].id]);
  });

  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/invoices");
  const row = () => page.getByRole("row").filter({ hasText: ref });
  async function record(amount: string) {
    await row().getByRole("button", { name: "Record payment" }).click();
    const dialog = page.getByRole("dialog", { name: `Record a payment on ${ref}` });
    await dialog.getByLabel("Amount received").fill(amount);
    await dialog.getByRole("button", { name: "Save payment" }).click();
    await expect(dialog).toBeHidden();
  }
  await record("100");
  await record("260");

  // The auth lock is named after the session cookie (sb-<ref>-auth-token): another tab takes it and never lets go.
  const cookie = (await page.context().cookies()).map((c) => /^(sb-.+-auth-token)(\.\d+)?$/.exec(c.name)?.[1]).find(Boolean);
  expect(cookie).toBeTruthy();
  const stuck = await page.context().newPage();
  await stuck.goto("/offline.html");
  await stuck.evaluate((name) => new Promise<void>((held) => { void navigator.locks.request(`lock:${name}`, () => { held(); return new Promise(() => undefined); }); }), cookie!);

  // This tab reloads and opens the invoice: the page loads and the payment history arrives (after the 5 s wait for the lock).
  await page.reload();
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: /Done/ }).click({ timeout: 30_000 });
  await row().getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${ref} invoice details` });
  await expect(details.getByTestId("payment-row")).toHaveCount(2, { timeout: 30_000 });
  await expect(details).not.toContainText("Loading payments");
});

test("a payment history that never arrives stops saying Loading and offers a reload", async ({ page }) => {
  const ref = `INV-SLOW-${w.runId}`;
  const org = w.tenants.alpha.id;
  await withDb(async (db) => {
    const { rows } = await db.query(
      `insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, amount_paid, due_date, vat_enabled)
       values ($1, $2, 'Slow Example Ltd', 100, 20, 120, 'issued', 0, '2099-01-31', true) returning id`, [org, ref]);
    await db.query("insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct) values ($1, $2, 0, 'Work', 1, 100, 20)", [org, rows[0].id]);
  });
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/invoices");
  // The read is held back and never answered.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/rest\/v1\/invoice_payments\?/, async (route) => { await held; await route.abort(); });
  await page.getByRole("row").filter({ hasText: ref }).getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${ref} invoice details` });
  await expect(details).toContainText("Loading payments");
  await expect(details.getByRole("alert").filter({ hasText: "Couldn't load the payments. Reload the page to try again." })).toBeVisible({ timeout: 20_000 });
  await expect(details).not.toContainText("Loading payments");
  release();
});
