/**
 * Linked despatch and invoicing (migration 034, W2), in the browser: part despatch from a sales order, the remaining quantities,
 * the refusal of more than is left, an invoice made from the delivery notes at the order's prices, no second invoice for the same
 * notes, and signatures on a delivery note with several items surviving a reload.
 */
import { expect, test } from "@playwright/test";

import { documentTotals } from "@/lib/money";
import { adminClient } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();
const tag = () => w.runId.slice(0, 6);
const LINES = [
  { description: "Flange 80mm", quantity: 12, unit_price: 150, vat_pct: 20, vat_exempt: false },
  { description: "Spacer", quantity: 4, unit_price: 2.5, vat_pct: 0, vat_exempt: false },
  { description: "Bush 25mm", quantity: 7, unit_price: 14.29, vat_pct: 20, vat_exempt: false },
];

async function orderWithLines(customer: string) {
  const org = w.tenants.alpha.id;
  const service = adminClient();
  const { data: quote } = await service.from("quotes").insert({ organization_id: org, quote_ref: `QUO-E2E-${tag()}`, customer, status: "draft", total_value: 0 }).select("id").single();
  await service.from("quote_line_items").insert(LINES.map((l, position) => ({ ...l, position, quote_id: quote!.id, organization_id: org })));
  const totals = documentTotals(LINES.map((l) => ({ quantity: l.quantity, unitPrice: l.unit_price, vatPct: l.vat_pct })), 0, { vatEnabled: true });
  await service.from("quotes").update({ total_value: totals.total, vat_enabled: true }).eq("id", quote!.id);
  await service.from("quotes").update({ status: "accepted" }).eq("id", quote!.id);
  const so = `PO-E2E-${tag()}`;
  const { data: order, error } = await service.from("sales_orders").insert({ organization_id: org, so_number: so, customer_po: so, customer, quote_id: quote!.id, total_value: totals.subtotal, vat_enabled: true, status: "open" }).select("id").single();
  expect(error).toBeNull();
  return { so, order: order!.id as string, totals };
}

test("part despatch from an order, the rest later, an invoice from the notes at the order's prices, and signatures that stick", async ({ page }) => {
  const customer = `Despatch E2E ${tag()} Ltd`;
  const { so, order, totals } = await orderWithLines(customer);
  const service = adminClient();

  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/delivery-notes");
  await page.getByRole("button", { name: "New delivery note" }).click();
  const dialog = page.getByRole("dialog", { name: "New Delivery Note" });
  await dialog.getByRole("button", { name: "From a sales order" }).click(); // the form opens on "From a job" once jobs exist
  await dialog.getByLabel("Sales order").selectOption({ label: `${so} - ${customer}` });
  const table = dialog.getByRole("table", { name: "Lines to despatch" });
  await expect(table.getByRole("row", { name: /Flange 80mm/ })).toContainText("12");
  // Part now: 5 flanges and all the bushes; no spacers.
  await dialog.getByLabel("Quantity to despatch: Flange 80mm").fill("5");
  await dialog.getByLabel("Quantity to despatch: Spacer").fill("");
  await dialog.getByRole("button", { name: "Save Delivery Note" }).click();
  await expect(page.getByText(/Delivery note DLN-\d+ created/)).toBeVisible();
  const first = (await service.from("delivery_notes").select("id, dn_number, invoice_ref").eq("sales_order_id", order)).data!;
  expect(first).toHaveLength(1);
  expect(first[0].invoice_ref).toBeNull();

  // The rest: what is left is shown, and more than that is refused by the database.
  await page.getByRole("button", { name: "New delivery note" }).click();
  await dialog.getByRole("button", { name: "From a sales order" }).click(); // the form opens on "From a job" once jobs exist
  await dialog.getByLabel("Sales order").selectOption({ label: `${so} - ${customer}` });
  await expect(table.getByRole("row", { name: /Flange 80mm/ })).toContainText("7");
  await expect(table.getByRole("row", { name: /Bush 25mm/ }).getByLabel(/Quantity to despatch/)).toBeDisabled(); // nothing left on the bushes
  await dialog.getByLabel("Quantity to despatch: Flange 80mm").fill("8");
  await dialog.getByRole("button", { name: "Save Delivery Note" }).click();
  await expect(dialog.getByRole("alert")).toContainText("More than is left to despatch");
  expect((await service.from("delivery_notes").select("id").eq("sales_order_id", order)).data).toHaveLength(1);
  await dialog.getByLabel("Quantity to despatch: Flange 80mm").fill("7");
  await dialog.getByRole("button", { name: "Save Delivery Note" }).click();
  await expect.poll(async () => (await service.from("delivery_notes").select("id").eq("sales_order_id", order)).data?.length).toBe(2);
  const notes = (await service.from("delivery_notes").select("id, dn_number").eq("sales_order_id", order).order("created_at")).data!;
  expect(notes).toHaveLength(2);

  // Sent out: each note gets its own draft invoice by itself (migration 059), and the two drafts add up to the order at its prices.
  for (const note of notes) {
    await page.getByRole("row").filter({ hasText: note.dn_number }).getByRole("button", { name: "Mark Despatched" }).click();
    await expect.poll(async () => (await service.from("delivery_notes").select("status").eq("id", note.id).single()).data?.status).toBe("despatched");
    await expect(page.getByRole("row").filter({ hasText: note.dn_number }).getByTestId("note-invoice-state")).toHaveText("Draft invoice created");
  }
  const drafts = (await service.from("invoices").select("id, status, invoice_ref, subtotal, vat, total").eq("customer", customer)).data!;
  expect(drafts).toHaveLength(2);
  expect(drafts.every((d) => d.status === "draft" && d.invoice_ref === null)).toBe(true);
  const pence = (v: number) => Math.round(Number(v) * 100);
  expect(drafts.reduce((s, d) => s + pence(d.subtotal), 0)).toBe(pence(totals.subtotal));
  expect(drafts.reduce((s, d) => s + pence(d.total), 0)).toBe(pence(totals.total));
  const lines = (await service.from("invoice_line_items").select("description, quantity").in("invoice_id", drafts.map((d) => d.id))).data!;
  for (const l of LINES) expect(lines.filter((x) => x.description === l.description).reduce((s, x) => s + Number(x.quantity), 0)).toBe(l.quantity);
  await page.goto("/invoices");
  await expect(page.getByTestId("auto-drafted").filter({ hasText: notes[0].dn_number })).toBeVisible();

  // They are not offered again.
  // The page's own button (059's "Sent but not invoiced" list has a second one with the same name).
  await page.locator('button:not([data-testid="uninvoiced-delivery-notes"] button)').filter({ hasText: /^Invoice from Delivery Notes$/ }).click();
  await expect(page.getByRole("dialog", { name: "Invoice from delivery notes" })).toContainText("No delivery notes are waiting to be invoiced");
  await page.keyboard.press("Escape");

  // A signature on a note with several items is still there after a reload, with every item.
  await page.goto("/delivery-notes");
  await page.getByRole("row").filter({ hasText: notes[1].dn_number }).getByRole("button", { name: "Mark Signed" }).click();
  const signing = page.getByRole("dialog", { name: `Mark ${notes[1].dn_number} as signed` });
  await signing.getByPlaceholder("Signed by").fill("A. Receiver");
  await signing.getByRole("button", { name: "Confirm Signed" }).click();
  await expect(page.getByText("1 delivery note(s) moved to Signed")).toBeVisible();
  await page.reload();
  const stored = (await service.from("delivery_notes").select("status, signed_by_name, signed_at").eq("id", notes[1].id).single()).data!;
  expect(stored).toMatchObject({ status: "signed", signed_by_name: "A. Receiver" });
  expect(stored.signed_at).toBeTruthy();
  expect((await service.from("delivery_note_items").select("quantity").eq("delivery_note_id", notes[1].id)).data).toHaveLength(2);
});
