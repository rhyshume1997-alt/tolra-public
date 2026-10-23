/**
 * Credit notes (migration 034, W4), in the browser: an office user makes a credit note from an invoice's lines and issues it; issuing
 * applies it to the invoice in the same step, so the balance drops (without a payment row) and anything beyond what was owed shows as
 * customer credit. The PDF downloads, and over-crediting is refused with the reason.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

import { adminClient, withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("make and issue a credit note; issuing applies it, the balance falls, amount paid doesn't, the PDF downloads, over-credit is refused", async ({ page }) => {
  const service = adminClient();
  const org = w.tenants.alpha.id;
  const ref = `INV-CN-${w.runId.slice(0, 6)}`;
  const { data: invoice, error } = await service.from("invoices").insert({ organization_id: org, invoice_ref: null, customer: "Credit E2E Ltd", status: "draft", subtotal: 100, vat: 20, total: 120, vat_enabled: true, due_date: "2099-01-31", description: "Bush" }).select("id").single();
  expect(error).toBeNull();
  expect((await service.from("invoice_line_items").insert({ organization_id: org, invoice_id: invoice!.id, position: 0, description: "Bush", quantity: 2, unit_price: 50, vat_pct: 20 })).error).toBeNull();
  expect((await service.from("invoices").update({ invoice_ref: ref, status: "sent" }).eq("id", invoice!.id)).error).toBeNull();

  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/invoices");
  await page.getByRole("row").filter({ hasText: ref }).getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${ref} invoice details` });
  const panel = details.getByRole("region", { name: "Credit notes" });
  await expect(panel).toContainText("No credit notes against this invoice.");

  // More than the invoice is refused, with the reason, and nothing is saved.
  await panel.getByRole("button", { name: "New credit note" }).click();
  // The form starts at the full creditable quantity (2 bushes), with the total and VAT already shown.
  await expect(panel.getByLabel("Quantity to credit: Bush")).toHaveValue("2");
  await expect(panel.getByTestId("credit-preview")).toHaveText("Net £100.00 + VAT £20.00 = £120.00");
  await panel.getByLabel("Quantity to credit: Bush").fill("3");
  await panel.getByRole("button", { name: "Save draft credit note" }).click();
  await expect(panel.getByRole("alert")).toContainText("More credited than invoiced");
  expect((await service.from("credit_notes").select("id").eq("invoice_id", invoice!.id)).data).toEqual([]);

  // One bush: £50 + £10 VAT.
  await panel.getByLabel("Quantity to credit: Bush").fill("1");
  await panel.getByLabel("Reason for the credit").fill("One bush returned");
  await panel.getByRole("button", { name: "Save draft credit note" }).click();
  const row = panel.getByTestId("credit-note-row");
  await expect(row).toContainText("Draft");
  await expect(row).toContainText("£60.00");
  await row.getByRole("button", { name: "Issue credit note" }).click();
  await expect(row).toContainText(/CRD-\d+/);
  const note = (await service.from("credit_notes").select("id, credit_ref, status, subtotal, vat, total, organization_id").eq("invoice_id", invoice!.id).single()).data!;
  expect(note).toMatchObject({ status: "issued", subtotal: 50, vat: 10, total: 60, organization_id: org });
  expect(note.credit_ref).toMatch(/^CRD-\d+$/);

  // Issuing applied it: the balance dropped to £60 in the same step; no payment is recorded and amount paid stays 0. There is nothing left to apply.
  await expect(details).toContainText("Credits applied £60.00, balance due £60.00");
  await expect(row).toContainText(`£60.00 applied to ${ref}, £0.00 left`);
  await expect(row.getByRole("button", { name: "Apply credit" })).toHaveCount(0);
  const stored = (await service.from("invoices").select("amount_paid, credited_amount, status").eq("id", invoice!.id).single()).data;
  expect(stored).toMatchObject({ amount_paid: 0, credited_amount: 60, status: "sent" });
  expect((await service.from("invoice_payments").select("id").eq("invoice_id", invoice!.id)).data).toEqual([]);
  expect((await service.from("invoice_credit_allocations").select("amount").eq("credit_note_id", note.id)).data).toEqual([{ amount: 60 }]);

  // The invoice list shows what is still owed: £60.00 of the £120.00.
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByRole("row").filter({ hasText: ref })).toContainText("£60.00 credited, £60.00 still owed");

  // The credit note prints on the invoice layout, titled Credit Note.
  await page.getByRole("row").filter({ hasText: ref }).getByRole("button", { name: "View" }).click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("dialog", { name: `${ref} invoice details` }).getByRole("region", { name: "Credit notes" }).getByRole("button", { name: "Download PDF" }).click()]);
  expect(download.suggestedFilename()).toBe(`credit-note-${note.credit_ref}.pdf`);
  expect(readFileSync((await download.path())!).subarray(0, 5).toString()).toBe("%PDF-");
});

test("£120 invoiced, £60 paid, £80 credited: issuing settles the invoice (nothing owed) and £20 shows as customer credit, available to refund or use", async ({ page, browser }) => {
  const service = adminClient();
  const org = w.tenants.alpha.id;
  const ref = `INV-CC-${w.runId.slice(0, 6)}`;
  const { data: invoice, error } = await service.from("invoices").insert({ organization_id: org, invoice_ref: null, customer: "Settled E2E Ltd", status: "draft", subtotal: 120, vat: 0, total: 120, vat_enabled: false, due_date: "2099-01-31", description: "Widget" }).select("id").single();
  expect(error).toBeNull();
  expect((await service.from("invoice_line_items").insert({ organization_id: org, invoice_id: invoice!.id, position: 0, description: "Widget", quantity: 12, unit_price: 10, vat_pct: 0 })).error).toBeNull();
  expect((await service.from("invoices").update({ invoice_ref: ref, status: "sent" }).eq("id", invoice!.id)).error).toBeNull();
  // £60 received: a payment row and the invoice's amount paid, written as the database owner (the invoice lock leaves that to Record payment for the API roles).
  await withDb(async (db) => {
    await db.query("insert into public.invoice_payments (organization_id, invoice_id, amount, paid_on, method, source) values ($1, $2, 60, current_date, 'BACS', 'recorded')", [org, invoice!.id]);
    await db.query("update public.invoices set amount_paid = 60, status = 'partial' where id = $1", [invoice!.id]);
  });

  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/invoices");
  await page.getByRole("row").filter({ hasText: ref }).getByRole("button", { name: "View" }).click();
  const details = page.getByRole("dialog", { name: `${ref} invoice details` });
  const panel = details.getByRole("region", { name: "Credit notes" });
  await expect(details.getByRole("region", { name: "Customer credit" })).toHaveCount(0);

  // 8 widgets at £10: a £80 credit note, £20 more than the £60 still owed.
  await panel.getByRole("button", { name: "New credit note" }).click();
  await panel.getByLabel("Quantity to credit: Widget").fill("8");
  await panel.getByLabel("Reason for the credit").fill("Eight widgets rejected");
  await panel.getByRole("button", { name: "Save draft credit note" }).click();
  const row = panel.getByTestId("credit-note-row");
  await expect(row).toContainText("£80.00");
  await row.getByRole("button", { name: "Issue credit note" }).click();
  await expect(row).toContainText(/CRD-\d+/);

  // Applied in the same step: all of it is on the invoice, nothing is left to apply, the invoice is settled and the extra £20 is the customer's.
  await expect(row).toContainText(`£80.00 applied to ${ref}, £0.00 left`);
  await expect(row.getByRole("button", { name: "Apply credit" })).toHaveCount(0);
  await expect(details).toContainText("Credits applied £80.00, balance due £0.00");
  const credit = details.getByRole("region", { name: "Customer credit" });
  await expect(credit).toContainText("Customer credit £20.00");
  await expect(credit).toContainText(ref);
  const stored = (await service.from("invoices").select("amount_paid, credited_amount, refunded_amount, status").eq("id", invoice!.id).single()).data!;
  expect(stored).toMatchObject({ amount_paid: 60, credited_amount: 80, refunded_amount: 0, status: "paid" }); // owed = 120 - 60 - 80, below zero
  expect((await service.from("invoice_payments").select("amount").eq("invoice_id", invoice!.id)).data).toEqual([{ amount: 60 }]);
  expect(await withDb(async (db) => (await db.query("select amount_paid + credited_amount - refunded_amount - total as surplus from public.invoices where id = $1", [invoice!.id])).rows[0].surplus)).toBe("20.00");

  // The list shows nothing owed on it, and the page says customer credit is held.
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.getByRole("row").filter({ hasText: ref })).toHaveCount(0); // settled, so it is under Done, not Open
  await page.getByRole("button", { name: /^Done/ }).click();
  const listed = page.getByRole("row").filter({ hasText: ref });
  await expect(listed).toContainText("£120.00");
  await expect(listed).not.toContainText("still owed");
  await expect(page.getByTestId("customer-credit-held")).toContainText("Customer credit held");

  // The £20 is usable through the customer-credit flow: an admin sees it on the invoice with the refund action.
  const adminPage = await browser.newPage();
  await signIn(adminPage, w.tenants.alpha.users.admin);
  await adminPage.goto("/invoices");
  await adminPage.getByRole("button", { name: /^Done/ }).click();
  await adminPage.getByRole("row").filter({ hasText: ref }).getByRole("button", { name: "View" }).click();
  const adminCredit = adminPage.getByRole("dialog", { name: `${ref} invoice details` }).getByRole("region", { name: "Customer credit" });
  await expect(adminCredit).toContainText("Customer credit £20.00");
  await expect(adminCredit.getByRole("button", { name: /Refund/ })).toBeVisible();
  await adminPage.close();
});

test("the Balance due setting is in Settings for admins only, off by default, and is saved in the company profile", async ({ page, browser }) => {
  const org = w.tenants.beta.id; // its own company, so the other specs' invoice PDFs are not affected
  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/settings");
  // The page fills the form from the saved profile once it has loaded; ticking the box before that would be overwritten by it.
  await page.waitForLoadState("networkidle");
  const box =page.getByLabel("Show credit notes in Balance due on invoice PDFs");
  await expect(box).not.toBeChecked();
  await box.check();
  await page.getByRole("button", { name: "Save company details" }).click();
  await expect(page.getByText("Company details saved")).toBeVisible();
  const profile = (await adminClient().from("organization_settings").select("company_profile").eq("organization_id", org).single()).data!.company_profile as Record<string, unknown>;
  expect(profile.showCreditsInBalance).toBe(true);
  await page.reload();
  await expect(page.getByLabel("Show credit notes in Balance due on invoice PDFs")).toBeChecked();
  await page.getByLabel("Show credit notes in Balance due on invoice PDFs").uncheck();
  await page.getByRole("button", { name: "Save company details" }).click();
  await expect(page.getByText("Company details saved")).toBeVisible();

  // Office never reaches the page.
  const officePage = await browser.newPage();
  await signIn(officePage, w.tenants.beta.users.office);
  await officePage.goto("/settings");
  await expect(officePage).toHaveURL(/\/dashboard/);
  await officePage.close();
});
