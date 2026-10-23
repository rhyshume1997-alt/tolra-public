/**
 * Regression: an imported invoice flagged payment_unverified, part paid and then paid in full, still shows its
 * payment history (and the Reverse buttons) on the invoice detail after a reload. The "marked paid before payments
 * were recorded" text is only for an invoice that truly has no payment rows.
 */
import { expect, test } from "@playwright/test";

import { adminClient, withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("an unverified invoice paid in two parts shows its payment history and can be reversed after a reload", async ({ page }) => {
  const ref = `INV-PDET-${w.runId}`;
  const org = w.tenants.alpha.id;
  const id = await withDb(async (db) => {
    const { rows } = await db.query(
      `insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, amount_paid, due_date, vat_enabled, payment_unverified)
       values ($1, $2, 'Imported Example Ltd', 300, 60, 360, 'issued', 0, '2026-01-31', true, true) returning id`, [org, ref]);
    await db.query("insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct) values ($1, $2, 0, 'Imported work', 1, 300, 20)", [org, rows[0].id]);
    return rows[0].id as string;
  });
  const stored = async () => (await adminClient().from("invoices").select("status, amount_paid, payment_unverified").eq("id", id).single()).data;
  const count = async () => ((await adminClient().from("invoice_payments").select("id").eq("invoice_id", id)).data ?? []).length;

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

  // Part payment: still "payment to confirm" in the list (unverified imports stay so until confirm_invoice_payments).
  await record("100");
  await expect(row()).toContainText("PAYMENT TO CONFIRM");
  await expect.poll(stored).toMatchObject({ amount_paid: 100, payment_unverified: true });
  // The rest.
  await record("260");
  await expect.poll(stored).toMatchObject({ status: "paid", amount_paid: 360, payment_unverified: true });
  expect(await count()).toBe(2);

  // Reload and open it: the history is there, with a Reverse button on each recorded payment.
  await page.reload();
  await page.getByRole("group", { name: "Show" }).getByRole("button", { name: /Done/ }).click();
  // A slow answer for the payment rows (held for 3s): until it arrives the section must not claim the invoice was
  // "marked paid before payments were recorded" (it used to, as soon as the dialog opened on a paid invoice).
  await page.route(/\/rest\/v1\/invoice_payments\?/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue();
  });
  await row().getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${ref} invoice details` });
  await expect(details.getByRole("heading", { name: "Payments" })).toBeVisible();
  // Checked at once, not retried: the claim must never be on screen while the rows are on their way.
  expect(await details.getByText("Marked paid before payments were recorded").count()).toBe(0);
  await expect(details).toContainText("Loading payments", { timeout: 2000 });
  const history = details.getByRole("list", { name: "Payment history" });
  await expect(history.getByTestId("payment-row")).toHaveCount(2);
  // Wait for any held request to be let through before removing the hold; unrouting under a running handler made
  // its continue() fail with "Route is already handled" (a CI-only race).
  await page.unrouteAll({ behavior: "wait" });
  await expect(history).toContainText("£100.00");
  await expect(history).toContainText("£260.00");
  await expect(details.getByRole("button", { name: "Reverse" })).toHaveCount(2);
  await expect(details).not.toContainText("Marked paid before payments were recorded");

  // Reverse the last one: the balance is back.
  await history.getByTestId("payment-row").nth(1).getByRole("button", { name: "Reverse" }).click();
  const reverse = page.getByRole("dialog", { name: "Reverse this payment?" });
  await reverse.getByLabel("Reason").fill("Paid to the wrong invoice");
  await reverse.getByRole("button", { name: "Reverse payment" }).click();
  await expect(history.getByTestId("payment-row").nth(1)).toContainText("Reversed");
  await expect.poll(stored).toMatchObject({ amount_paid: 100, payment_unverified: true });
  await expect(details).toContainText("£100.00 received");
});
