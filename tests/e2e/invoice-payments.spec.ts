/**
 * Part payments (migration 032, GitHub issue #5), in the browser: record a part payment and see "Part paid" and the
 * balance, pay the rest and see "Paid", with the payment history on the invoice; an admin reverses a payment with a
 * reason and the invoice goes back to part paid.
 */
import { expect, test } from "@playwright/test";

import { toDateInput } from "@/lib/dates";
import { adminClient, withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("record a part payment, see Part paid and the balance, then pay the rest and see Paid", async ({ page }) => {
  const ref = `INV-PAY-${w.runId}`;
  // Tenant alpha: receivables.spec asserts tenant beta's exact money owed.
  const org = w.tenants.alpha.id;
  const id = await withDb(async (db) => {
    const { rows } = await db.query(
      `insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, amount_paid, due_date, vat_enabled)
       values ($1, $2, 'Payments Example Ltd', 100, 20, 120, 'issued', 0, '2099-01-31', true) returning id`, [org, ref]);
    await db.query("insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct) values ($1, $2, 0, 'Machined bush', 1, 100, 20)", [org, rows[0].id]);
    return rows[0].id as string;
  });
  const stored = async () => (await adminClient().from("invoices").select("status, amount_paid, paid_at").eq("id", id).single()).data;
  const rows = async () => ((await adminClient().from("invoice_payments").select("amount, method, reference, source").eq("invoice_id", id).order("created_at")).data ?? []);
  /** A reversal is its own negative row pointing at the payment it reverses (032): none until one is recorded. */
  const reversals = async () => ((await adminClient().from("invoice_payments").select("amount, reverses_payment_id, void_reason").eq("invoice_id", id).not("reverses_payment_id", "is", null)).data ?? []);

  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/invoices");
  const row = page.getByRole("row").filter({ hasText: ref });
  await expect(row).toContainText("Due in");

  // The dialog starts with the full balance, so paying in full is one click; here it is changed to a part payment.
  await row.getByRole("button", { name: "Record payment" }).click();
  const dialog = page.getByRole("dialog", { name: `Record a payment on ${ref}` });
  await expect(dialog.getByLabel("Amount received")).toHaveValue("120.00");
  await expect(dialog.getByLabel("Date received")).toHaveValue(toDateInput(new Date()));
  await dialog.getByLabel("Amount received").fill("200");
  await dialog.getByRole("button", { name: "Save payment" }).click();
  await expect(dialog.getByRole("alert")).toContainText("That is more than the balance due (£120.00).");
  expect(await rows()).toHaveLength(0);

  await dialog.getByLabel("Amount received").fill("50");
  await dialog.getByLabel("Method").selectOption("cheque");
  await dialog.getByLabel("Reference").fill("CHQ 100");
  await dialog.getByRole("button", { name: "Save payment" }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText("PART PAID");
  await expect(row).toContainText("£50.00 paid, £70.00 still owed");
  expect(await stored()).toMatchObject({ status: "partial", amount_paid: 50, paid_at: null });
  expect(await rows()).toEqual([{ amount: 50, method: "cheque", reference: "CHQ 100", source: "recorded" }]);

  // It survives a reload, and is listed under the "Part paid" filter.
  await page.reload();
  await page.getByRole("group", { name: "Filters" }).getByRole("button", { name: "Part paid" }).click();
  await expect(page.getByRole("row").filter({ hasText: ref })).toContainText("PART PAID");

  // The history on the invoice shows the payment; the rest is paid from there.
  await page.getByRole("row").filter({ hasText: ref }).getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${ref} invoice details` });
  await expect(details.getByRole("list", { name: "Payment history" })).toContainText("£50.00");
  await expect(details.getByRole("list", { name: "Payment history" })).toContainText("CHQ 100");
  await expect(details).toContainText("balance due £70.00");
  await details.getByRole("button", { name: "Record payment" }).click();
  const second = page.getByRole("dialog", { name: `Record a payment on ${ref}` });
  await expect(second.getByLabel("Amount received")).toHaveValue("70.00");
  await second.getByRole("button", { name: "Save payment" }).click();
  await expect(page.getByText(`${ref} paid in full`)).toBeVisible();
  await expect.poll(stored).toMatchObject({ status: "paid", amount_paid: 120 });
  expect((await stored())!.paid_at).toBeTruthy();
  expect(await rows()).toHaveLength(2);

  // Paid: the list moves to Done / Paid by itself and the row reads PAID.
  const paidRow = page.getByRole("row").filter({ hasText: ref });
  await expect(paidRow).toContainText("PAID");
  await expect(paidRow.getByRole("button", { name: "Record payment" })).toBeDisabled();

  // An admin can reverse the last payment, with a reason: the original stays, struck through, and it is part paid again.
  await paidRow.getByRole("button", { name: "View" }).click();
  const paidDetails = page.getByRole("dialog", { name: `${ref} invoice details` });
  const history = paidDetails.getByRole("list", { name: "Payment history" });
  await expect(history.getByTestId("payment-row")).toHaveCount(2);
  await history.getByTestId("payment-row").nth(1).getByRole("button", { name: "Reverse" }).click();
  const reverseDialog = page.getByRole("dialog", { name: "Reverse this payment?" });
  // No reason yet: Reverse payment stays pressable and says why it did nothing (PR 2 UX), and nothing is reversed. The history list
  // sits behind this dialog, so "nothing reversed" is read from the database: no reversal row, still two payments, still paid in full.
  await reverseDialog.getByRole("button", { name: "Reverse payment" }).click();
  await expect(reverseDialog.getByRole("alert")).toHaveText("Give a reason (at least 1 character).");
  await expect(reverseDialog).toBeVisible();
  expect(await reversals(), "no reversal recorded without a reason").toEqual([]);
  expect(await rows()).toHaveLength(2);
  expect(await stored()).toMatchObject({ status: "paid", amount_paid: 120 });
  await reverseDialog.getByLabel("Reason").fill("Paid to the wrong invoice");
  await reverseDialog.getByRole("button", { name: "Reverse payment" }).click();
  await expect(reverseDialog).toBeHidden();
  // The reversal row: negative, pointing at the second payment, carrying the reason.
  await expect.poll(reversals).toHaveLength(1);
  expect((await reversals())[0]).toMatchObject({ void_reason: "Paid to the wrong invoice" });
  expect((await reversals())[0].amount).toBeLessThan(0);
  await expect(history.getByTestId("payment-row").nth(1)).toContainText("Reversed");
  await expect(history.getByTestId("payment-row").nth(1)).toContainText("Paid to the wrong invoice");
  await expect(history.getByTestId("payment-row").nth(1).getByRole("button", { name: "Reverse" })).toHaveCount(0);
  await expect(paidDetails).toContainText("PART PAID");
  await expect.poll(stored).toMatchObject({ status: "partial", amount_paid: 50, paid_at: null });
  expect(await rows()).toHaveLength(3);
});

test("an office user opens Invoicing, records a payment and can't reverse it", async ({ page }) => {
  const ref = `INV-OFF-${w.runId}`;
  const org = w.tenants.alpha.id;
  const id = await withDb(async (db) => {
    const { rows } = await db.query(
      `insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, amount_paid, due_date, vat_enabled)
       values ($1, $2, 'Office Payments Ltd', 100, 20, 120, 'issued', 0, '2099-01-31', true) returning id`, [org, ref]);
    await db.query("insert into public.invoice_line_items (organization_id, invoice_id, position, description, quantity, unit_price, vat_pct) values ($1, $2, 0, 'Machined bush', 1, 100, 20)", [org, rows[0].id]);
    return rows[0].id as string;
  });

  await signIn(page, w.tenants.alpha.users.office);
  await expect(page.getByRole("link", { name: "Invoicing" })).toBeVisible();
  await page.goto("/invoices");
  const row = page.getByRole("row").filter({ hasText: ref });
  await row.getByRole("button", { name: "Record payment" }).click();
  const dialog = page.getByRole("dialog", { name: `Record a payment on ${ref}` });
  await dialog.getByLabel("Amount received").fill("50");
  await dialog.getByRole("button", { name: "Save payment" }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText("PART PAID");

  // It survives a reload, is stored against the office user in the right company, and the office can read it back.
  await page.reload();
  await expect(page.getByRole("row").filter({ hasText: ref })).toContainText("PART PAID");
  const stored = (await adminClient().from("invoice_payments").select("amount, organization_id, created_by").eq("invoice_id", id)).data;
  expect(stored).toEqual([{ amount: 50, organization_id: org, created_by: w.tenants.alpha.users.office.id }]);
  await page.getByRole("row").filter({ hasText: ref }).getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${ref} invoice details` });
  await expect(details.getByTestId("payment-row")).toHaveCount(1);
  // Reversing is for admins only: the button isn't offered.
  await expect(details.getByRole("button", { name: "Reverse" })).toHaveCount(0);
});
