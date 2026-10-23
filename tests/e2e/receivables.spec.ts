/**
 * Money owed and settlement (audit B4b: A2, D23, D18). Part payments reduce what is owed; drafts and cancelled
 * invoices are never collected; bulk "Pay Selected in Full" asks first and writes exactly what it listed.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

test("owed = face value minus receipts, drafts excluded; bulk settlement confirms first", async ({ page }) => {
  const org = w.tenants.beta.id;
  const tag = w.runId;
  const rows = [
    { invoice_ref: `INV-PART-${tag}`, total: 120, amount_paid: 50, status: "sent", due_date: "2026-01-10" },
    { invoice_ref: `INV-OPEN-${tag}`, total: 80, amount_paid: 0, status: "sent", due_date: "2099-01-01" },
    { invoice_ref: `INV-DRAFT-${tag}`, total: 500, amount_paid: 0, status: "draft", due_date: "2026-01-10" },
    { invoice_ref: `INV-VOID-${tag}`, total: 300, amount_paid: 0, status: "cancelled", due_date: "2026-01-10" },
  ];
  const { error } = await adminClient().from("invoices").insert(rows.map((r) => ({ ...r, organization_id: org, customer: "Receivables Co", subtotal: r.total, vat: 0, vat_enabled: false })));
  expect(error).toBeNull();
  // The £50 already received is a payment row, as the database keeps it (amount_paid is their sum, migration 032).
  const { data: part } = await adminClient().from("invoices").select("id").eq("invoice_ref", `INV-PART-${tag}`).single();
  expect((await adminClient().from("invoice_payments").insert({ organization_id: org, invoice_id: part!.id, amount: 50, paid_on: "2026-01-05", source: "legacy" })).error).toBeNull();

  await signIn(page, w.tenants.beta.users.admin);
  await page.goto("/invoices");
  await expect(page.getByText("£150.00").first()).toBeVisible();
  await expect(page.getByText("Across 2 outstanding invoices")).toBeVisible();
  await expect(page.getByText("£50.00 paid, £70.00 still owed")).toBeVisible();

  const pick = async (ref: string) => page.getByRole("row").filter({ hasText: ref }).getByRole("checkbox").check();
  await pick(`INV-PART-${tag}`);
  await pick(`INV-OPEN-${tag}`);
  await page.getByRole("button", { name: "Pay Selected in Full" }).click();
  const dialog = page.getByRole("dialog", { name: "Record 2 invoices as paid in full?" });
  await expect(dialog).toContainText("£150.00 received in total");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  const statuses = async () => Object.fromEntries(((await adminClient().from("invoices").select("invoice_ref, status, amount_paid").eq("organization_id", org)).data ?? []).map((r) => [r.invoice_ref, `${r.status}:${Number(r.amount_paid)}`]));
  expect(await statuses()).toMatchObject({ [`INV-PART-${tag}`]: "sent:50", [`INV-OPEN-${tag}`]: "sent:0" });

  await page.getByRole("button", { name: "Pay Selected in Full" }).click();
  await page.getByRole("dialog", { name: "Record 2 invoices as paid in full?" }).getByRole("button", { name: "Confirm 2 Paid in Full" }).click();
  await expect.poll(statuses).toMatchObject({
    [`INV-PART-${tag}`]: "paid:120", [`INV-OPEN-${tag}`]: "paid:80", [`INV-DRAFT-${tag}`]: "draft:0", [`INV-VOID-${tag}`]: "cancelled:0",
  });
});
