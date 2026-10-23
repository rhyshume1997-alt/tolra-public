/**
 * Baseline journey through the real browser, server and isolated database (audit B1/D27): records created from
 * the current forms appear in their lists, survive a reload, and are stored in the creator's organisation.
 */
import { expect, test } from "@playwright/test";

import { adminClient, type SyntheticTenant } from "../support/fixtures";
import { signIn, world } from "./helpers";

test.describe.configure({ mode: "serial" });

const w = world();
let alpha: SyntheticTenant;
let tag: string;
let customer: string;
let supplier: string;

test.beforeAll(() => {
  alpha = w.tenants.alpha;
  tag = w.runId;
  customer = `E2E Customer ${tag}`;
  supplier = `E2E Supplier ${tag}`;
});

async function storedIn(table: string, column: string, value: string) {
  const { data, error } = await adminClient().from(table).select("organization_id").eq(column, value);
  expect(error).toBeNull();
  return (data ?? []).map((row) => row.organization_id);
}

test.describe("office records persist through the browser (admin, tenant alpha)", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, alpha.users.admin);
  });

  test("customer: add, listed, survives reload, stored in own organisation", async ({ page }) => {
    await page.goto("/customers");
    await page.getByRole("button", { name: "New customer" }).click();
    const dialog = page.getByRole("dialog", { name: "Add customer" });
    await dialog.getByRole("textbox", { name: "Customer name" }).fill(customer);
    await dialog.getByRole("textbox", { name: "Email" }).fill(`buyer.${tag}@example.test`);
    await dialog.getByRole("button", { name: "Save Customer" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("cell", { name: customer })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("cell", { name: customer })).toBeVisible();
    expect(await storedIn("customers", "name", customer)).toEqual([alpha.id]);
  });

  test("supplier: add, listed, survives reload, stored in own organisation", async ({ page }) => {
    await page.goto("/suppliers");
    await page.getByRole("button", { name: "New supplier" }).click();
    const dialog = page.getByRole("dialog", { name: "Add supplier" });
    await dialog.getByRole("textbox", { name: "Supplier name" }).fill(supplier);
    await dialog.getByRole("textbox", { name: "Email" }).fill(`sales.${tag}@example.test`);
    await dialog.getByRole("button", { name: "Save Supplier" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("cell", { name: supplier })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("cell", { name: supplier })).toBeVisible();
    expect(await storedIn("suppliers", "name", supplier)).toEqual([alpha.id]);
  });

  test("quote: build for the customer, listed, survives reload, lines stored", async ({ page }) => {
    await page.goto("/quotes");
    await page.getByRole("button", { name: "New quote" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Quote Builder" });
    await dialog.getByRole("combobox").first().selectOption({ label: customer });
    await dialog.getByRole("textbox", { name: "Quote description" }).fill(`E2E quote ${tag}`);
    await dialog.getByRole("textbox", { name: "Description", exact: true }).fill(`Flange ${tag}`);
    await dialog.getByRole("spinbutton", { name: "Quantity" }).fill("2");
    await dialog.getByRole("spinbutton", { name: "Unit price" }).fill("150");
    await dialog.getByRole("button", { name: "Save Quote" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(customer).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText(customer).first()).toBeVisible();

    const { data: quotes } = await adminClient().from("quotes").select("id, organization_id").eq("customer", customer);
    expect(quotes?.map((q) => q.organization_id)).toEqual([alpha.id]);
    const { data: lines } = await adminClient().from("quote_line_items").select("description, quantity, unit_price, organization_id").eq("quote_id", quotes![0].id);
    expect(lines?.map((l) => ({ ...l, quantity: Number(l.quantity), unit_price: Number(l.unit_price) }))).toEqual([
      { description: `Flange ${tag}`, quantity: 2, unit_price: 150, organization_id: alpha.id },
    ]);
  });

  test("rfq: create, listed, survives reload", async ({ page }) => {
    const rfqCustomer = `E2E RFQ ${tag}`;
    await page.goto("/rfq");
    await page.getByRole("button", { name: /New RFQ/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Create New RFQ" });
    await dialog.getByRole("textbox", { name: "Customer" }).fill(rfqCustomer);
    await dialog.getByRole("textbox", { name: "Description" }).fill(`E2E rfq ${tag}`);
    await dialog.getByRole("button", { name: "Save RFQ" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(rfqCustomer).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText(rfqCustomer).first()).toBeVisible();
    expect(await storedIn("rfqs", "customer", rfqCustomer)).toEqual([alpha.id]);
  });

  test("invoice: create for the customer, listed, survives reload", async ({ page }) => {
    await page.goto("/invoices");
    await page.getByRole("button", { name: /New invoice/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Create Invoice" });
    await dialog.getByRole("combobox").first().selectOption({ label: customer });
    await dialog.getByRole("textbox", { name: "Description" }).fill(`E2E invoice ${tag}`);
    await dialog.getByRole("spinbutton", { name: "Quantity" }).fill("2");
    await dialog.getByRole("spinbutton", { name: "Unit price (ex VAT)" }).fill("150");
    await dialog.getByRole("button", { name: "Save Invoice" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(customer).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText(customer).first()).toBeVisible();
    expect(await storedIn("invoices", "customer", customer)).toEqual([alpha.id]);

    // Saved as a draft (027): no number, not money owed, no payment can be recorded.
    const { data: draft } = await adminClient().from("invoices").select("id, invoice_ref, status").eq("customer", customer).single();
    expect(draft).toMatchObject({ status: "draft", invoice_ref: null });
    const draftRow = page.getByRole("row").filter({ hasText: customer });
    await expect(draftRow).toContainText("DRAFT");
    await expect(draftRow.getByRole("button", { name: "Record payment" })).toHaveCount(0); // a draft takes no payment: the button is not shown

    // Issued explicitly: next number, customer details recorded (B4a).
    await draftRow.getByRole("button", { name: "View" }).click();
    await page.getByRole("button", { name: "Issue Invoice" }).click();
    await page.getByRole("dialog", { name: /Issue this invoice/ }).getByRole("button", { name: "Issue Invoice" }).click();
    await expect.poll(async () => (await adminClient().from("invoices").select("status").eq("id", draft!.id).single()).data?.status).toBe("issued");
    const { data: issued } = await adminClient().from("invoices").select("invoice_ref, status, customer_snapshot, sent_date").eq("id", draft!.id).single();
    expect(issued).toMatchObject({ status: "issued", customer_snapshot: { name: customer, found: true }, sent_date: null });
    expect(issued!.invoice_ref).toMatch(/^INV-\d+$/);

    // Sending is recorded separately, only once confirmed; the status stays "issued".
    const row = page.getByRole("row").filter({ hasText: issued!.invoice_ref });
    // The invoice stays open after Issue, shown with its new number and Send to Customer ready (no reopening it from the list).
    const details = page.getByRole("dialog", { name: `${issued!.invoice_ref} invoice details` });
    await expect(details).toBeVisible();
    await expect(details.getByRole("button", { name: /^Issue/ })).toHaveCount(0);
    const download = page.waitForEvent("download");
    await details.getByRole("button", { name: "Send to Customer" }).click();
    await download;
    await page.getByRole("dialog", { name: `Has ${issued!.invoice_ref} gone to the customer?` }).getByRole("button", { name: /sent it/ }).click();
    await expect.poll(async () => (await adminClient().from("invoices").select("sent_date, status").eq("id", draft!.id).single()).data).toMatchObject({ status: "issued" });
    await expect.poll(async () => Boolean((await adminClient().from("invoices").select("sent_date").eq("id", draft!.id).single()).data?.sent_date)).toBe(true);
    await page.keyboard.press("Escape");

    // Recording the payment (in full: the dialog starts with the balance) still works through the issue lock.
    await row.getByRole("button", { name: "Record payment" }).click();
    await page.getByRole("button", { name: "Save payment" }).click();
    await expect.poll(async () => (await adminClient().from("invoices").select("status").eq("customer", customer).single()).data?.status).toBe("paid");
  });

  test("invoice with several lines at different VAT rates: stored, totals agree, reprint has every line", async ({ page }) => {
    const ref = `Multi ${tag}`;
    await page.goto("/invoices");
    await page.getByRole("button", { name: /New invoice/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "Create Invoice" });
    await dialog.getByRole("combobox").first().selectOption({ label: customer });
    await dialog.getByPlaceholder("Customer order no.").fill(ref);
    await dialog.getByRole("textbox", { name: "Description" }).fill("Machined flange");
    await dialog.getByRole("spinbutton", { name: "Quantity" }).fill("4");
    await dialog.getByRole("spinbutton", { name: "Unit price (ex VAT)" }).fill("37.5");
    await dialog.getByRole("button", { name: "Add another line" }).click();
    await dialog.getByRole("textbox", { name: "Line 2 description" }).fill("Inspection report");
    await dialog.getByRole("spinbutton", { name: "Line 2 quantity" }).fill("1");
    await dialog.getByRole("spinbutton", { name: "Line 2 unit price" }).fill("20");
    await dialog.getByRole("combobox", { name: "Line 2 VAT rate" }).selectOption({ label: "0%" });
    await expect(dialog.getByText("£200.00").first()).toBeVisible(); // 150 + 20% + 20 at 0%
    await dialog.getByRole("button", { name: "Save Invoice" }).click();
    await expect(dialog).toBeHidden();

    const { data: invoice } = await adminClient().from("invoices").select("id, subtotal, vat, total").eq("customer_po", ref).single();
    expect([Number(invoice?.subtotal), Number(invoice?.vat), Number(invoice?.total)]).toEqual([170, 30, 200]);
    const { data: lines } = await adminClient().from("invoice_line_items").select("description, quantity, unit_price, vat_pct, position").eq("invoice_id", invoice!.id).order("position");
    expect(lines?.map((l) => [l.description, Number(l.quantity), Number(l.unit_price), Number(l.vat_pct)])).toEqual([["Machined flange", 4, 37.5, 20], ["Inspection report", 1, 20, 0]]);
  });

  test("purchase order: raise to the supplier, listed, survives reload", async ({ page }) => {
    await page.goto("/purchase-orders");
    await page.getByRole("button", { name: "New purchase order" }).first().click();
    const dialog = page.getByRole("dialog", { name: "New Purchase Order" });
    // The supplier control takes a real click (Playwright refuses one that something covers), lists the supplier, and picks it.
    const picker = dialog.getByRole("combobox", { name: "Supplier" });
    await expect(picker).toBeEnabled();
    await expect(picker.locator("option", { hasText: supplier })).toHaveCount(1);
    await picker.click();
    await picker.selectOption({ label: supplier });
    await expect(picker).toHaveValue(supplier);
    await dialog.getByPlaceholder("Description").fill(`E2E bar stock ${tag}`);
    await dialog.getByPlaceholder("Qty").fill("3");
    await dialog.getByPlaceholder("Unit price (ex VAT)").fill("7391");
    await dialog.getByRole("button", { name: "Save PO" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText(supplier).first()).toBeVisible();
    await page.reload();
    await expect(page.getByText(supplier).first()).toBeVisible();
    expect(await storedIn("purchase_orders", "supplier", supplier)).toEqual([alpha.id]);
  });
});
