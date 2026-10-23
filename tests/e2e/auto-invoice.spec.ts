/**
 * Migration 059 in the browser: a delivery note marked sent out makes its own draft invoice (shown on the note and badged on the
 * invoice), a person issues it; a note sent out with no draft (here: by the service role, as an import would) is listed under
 * "Sent but not invoiced" with its reason, invoiced from there, and is then gone from the list.
 */
import { expect, test } from "@playwright/test";

import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
const tag = () => w.runId.slice(0, 6);

async function orderAndNote(customer: string, suffix: string) {
  const org = w.tenants.alpha.id;
  const service = adminClient();
  const { data: quote } = await service.from("quotes").insert({ organization_id: org, quote_ref: `QUO-AUTO-${tag()}-${suffix}`, customer, status: "draft", total_value: 0 }).select("id").single();
  await service.from("quote_line_items").insert({ position: 0, description: "Bracket", quantity: 3, unit_price: 33.33, vat_pct: 20, vat_exempt: false, quote_id: quote!.id, organization_id: org });
  await service.from("quotes").update({ total_value: 119.99, vat_enabled: true }).eq("id", quote!.id);
  await service.from("quotes").update({ status: "accepted" }).eq("id", quote!.id);
  const so = `PO-AUTO-${tag()}-${suffix}`;
  const { data: order, error } = await service.from("sales_orders").insert({ organization_id: org, so_number: so, customer_po: so, customer, quote_id: quote!.id, total_value: 99.99, vat_enabled: true, status: "open" }).select("id").single();
  expect(error).toBeNull();
  return { so, order: order!.id as string };
}

test("sent out -> a draft appears -> a person issues it; a note with no draft is listed until it is invoiced", async ({ page }) => {
  const service = adminClient();
  const customer = `Auto Invoice ${tag()} Ltd`;
  const first = await orderAndNote(customer, "1");
  await signIn(page, w.tenants.alpha.users.office);

  // A note from the order, marked sent out in the app: its draft is made by the database.
  await page.goto("/delivery-notes");
  await page.getByRole("button", { name: "New delivery note" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New Delivery Note" });
  await dialog.getByRole("button", { name: "From a sales order" }).click(); // the form opens on "From a job" once jobs exist
  await dialog.getByLabel("Sales order").selectOption({ label: `${first.so} - ${customer}` });
  await dialog.getByRole("button", { name: "Save Delivery Note" }).click();
  await expect(dialog).toBeHidden();
  const note = (await service.from("delivery_notes").select("id, dn_number").eq("sales_order_id", first.order).single()).data!;
  const row = page.getByRole("row").filter({ hasText: note.dn_number });
  await row.getByRole("button", { name: "Mark Despatched" }).click();
  await expect(row.getByTestId("note-invoice-state")).toHaveText("Draft invoice created");
  const draft = (await service.from("invoices").select("id, status, invoice_ref, total").eq("customer", customer).single()).data!;
  expect(draft).toMatchObject({ status: "draft", invoice_ref: null, total: 119.99 });

  // One click from the note to its invoice: the toast offers "Open draft invoice", and the status line links to the same invoice.
  await expect(page.getByRole("button", { name: "Open draft invoice" })).toBeVisible();
  await expect(row.getByTestId("note-invoice-state").getByRole("link", { name: "Draft invoice created" })).toHaveAttribute("href", `/invoices?invoice=${draft.id}`);
  await page.getByRole("button", { name: "Open draft invoice" }).click();
  await expect(page.getByRole("dialog", { name: /invoice details/ })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/invoices\\?invoice=${draft.id}`));

  // Invoicing: counted as waiting to issue, badged with its note; nothing issued it.
  await page.goto("/invoices");
  await expect(page.getByTestId("drafts-waiting")).toContainText("Drafts waiting to issue:");
  const invoiceRow = page.getByRole("row").filter({ hasText: customer });
  await expect(invoiceRow.getByTestId("auto-drafted")).toHaveText(`Auto-drafted from ${note.dn_number}`);
  await invoiceRow.getByRole("button", { name: "View" }).click();
  await page.getByRole("dialog", { name: /invoice details/ }).getByRole("button", { name: "Issue Invoice" }).click();
  await page.getByRole("dialog", { name: `Issue this invoice to ${customer}?` }).getByRole("button", { name: "Issue Invoice" }).click();
  await expect.poll(async () => (await service.from("invoices").select("status, invoice_ref").eq("id", draft.id).single()).data).toMatchObject({ status: "issued", invoice_ref: expect.stringMatching(/^INV-\d+$/) });

  // A second note, sent out by the service role (as an import would): no draft, so it is listed with its reason.
  const second = await orderAndNote(customer, "2");
  await page.goto("/delivery-notes");
  await page.getByRole("button", { name: "New delivery note" }).first().click();
  await dialog.getByRole("button", { name: "From a sales order" }).click(); // the form opens on "From a job" once jobs exist
  await dialog.getByLabel("Sales order").selectOption({ label: `${second.so} - ${customer}` });
  await dialog.getByRole("button", { name: "Save Delivery Note" }).click();
  await expect(dialog).toBeHidden();
  const made = { data: (await service.from("delivery_notes").select("id, dn_number").eq("sales_order_id", second.order).single()).data! };
  expect((await service.from("delivery_notes").update({ status: "despatched" }).eq("id", made.data.id)).error).toBeNull();
  await page.goto("/invoices");
  const backlog = page.getByTestId("uninvoiced-delivery-notes");
  const listed = backlog.getByRole("listitem").filter({ hasText: made.data!.dn_number });
  await expect(listed).toContainText("No draft yet");
  await expect(backlog.getByRole("listitem").filter({ hasText: note.dn_number })).toHaveCount(0);

  // Invoiced from the list's own button (the manual path): it leaves the list.
  await backlog.getByRole("button", { name: "Invoice from Delivery Notes" }).click();
  const picker = page.getByRole("dialog", { name: "Invoice from delivery notes" });
  await picker.getByRole("listitem").filter({ hasText: made.data!.dn_number }).getByRole("checkbox").check();
  await picker.getByRole("button", { name: "Make draft invoice" }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByTestId("uninvoiced-delivery-notes").getByRole("listitem").filter({ hasText: made.data!.dn_number })).toHaveCount(0);
  expect((await service.from("delivery_notes").select("invoice_id").eq("id", made.data!.id).single()).data!.invoice_id).toBeTruthy();
});
