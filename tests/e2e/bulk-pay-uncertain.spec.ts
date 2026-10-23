/**
 * Bulk "Pay Selected in Full" keeps one payment attempt per invoice (lib/payment-attempts.ts). When the answer for one
 * invoice is lost the payment was in fact committed; that invoice shows the uncertain state with "Check and save", and
 * checking finds the payment by its request id: exactly one payment row, never a second under a new id.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("bulk pay: a lost answer on one invoice shows Check and save, which finds the one payment", async ({ page }) => {
  const org = w.tenants.alpha.id;
  const tag = w.runId;
  const lost = `INV-BLOST-${tag}`;
  const fine = `INV-BFINE-${tag}`;
  const { error } = await adminClient().from("invoices").insert([lost, fine].map((ref) => ({ organization_id: org, invoice_ref: ref, customer: "Bulk Example Ltd", subtotal: 90, vat: 0, vat_enabled: false, total: 90, amount_paid: 0, status: "sent", due_date: "2026-01-10" })));
  expect(error).toBeNull();
  const ids = Object.fromEntries(((await adminClient().from("invoices").select("id, invoice_ref").in("invoice_ref", [lost, fine])).data ?? []).map((r) => [r.invoice_ref, r.id as string]));
  const paymentCount = async (ref: string) => (await adminClient().from("invoice_payments").select("id").eq("invoice_id", ids[ref])).data?.length ?? 0;

  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/invoices");

  // The payment for one invoice is saved by the database, but its answer never reaches the browser (once).
  let cut = 0;
  const requests: string[] = [];
  await page.route(/\/rest\/v1\/rpc\/record_invoice_payment/, async (route) => {
    const body = route.request().postData() ?? "";
    requests.push(body);
    if (body.includes(ids[lost]) && cut === 0) {
      cut += 1;
      await route.fetch();
      await route.abort("connectionreset");
      return;
    }
    await route.continue();
  });

  for (const ref of [lost, fine]) await page.getByRole("row").filter({ hasText: ref }).getByRole("checkbox").check();
  await page.getByRole("button", { name: "Pay Selected in Full" }).click();
  await page.getByRole("dialog", { name: "Record 2 invoices as paid in full?" }).getByRole("button", { name: "Confirm 2 Paid in Full" }).click();

  const notice = page.getByTestId("uncertain-payments");
  await expect(notice).toContainText(lost);
  await expect(notice).not.toContainText(fine);
  await expect(notice).toContainText("couldn't confirm");
  expect(await paymentCount(fine)).toBe(1);
  expect(await paymentCount(lost)).toBe(1); // committed, though the browser never heard

  await notice.getByRole("button", { name: "Check and save" }).click();
  const dialog = page.getByRole("dialog", { name: `Record a payment on ${lost}` });
  await expect(dialog).toContainText("couldn't confirm");
  await dialog.getByRole("button", { name: "Check and save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("uncertain-payments")).toBeHidden();

  expect(await paymentCount(lost)).toBe(1);
  expect(await paymentCount(fine)).toBe(1);
  expect(requests.filter((b) => b.includes(ids[lost])).length).toBe(1); // the check found it: nothing was sent again
});
