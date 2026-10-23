/**
 * Export CSV on the invoice list downloads a real CSV with the import column spec (lib/import-columns.ts): the header
 * row and a known invoice's stored figures, for the whole filter when nothing is selected.
 */
import { readFileSync } from "node:fs";

import { expect, test, type Page } from "@playwright/test";

import { adminClient, withDb } from "../support/fixtures";
import { signIn, world } from "./helpers";

const w = world();

/** Opens the list's Export menu and returns one of its entries (CSV, Excel, Payments CSV ...). */
async function exportItem(page: Page, name: string) {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  return page.getByRole("menuitem", { name, exact: true });
}

/** Clicks an export button (or, for `{ menuItem }`, an entry of the Export menu) and returns the downloaded CSV: its file name, header cells, and the cells of the row starting with `first`. */
async function downloadCsv(page: Page, button: string | { menuItem: string }, first: string) {
  const target = typeof button === "string" ? page.getByRole("button", { name: button, exact: true }) : await exportItem(page, button.menuItem);
  const [download] = await Promise.all([page.waitForEvent("download"), target.click()]);
  const text = readFileSync(await download.path(), "utf8");
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const lines = text.slice(1).split("\r\n");
  const header = lines[0].split(",");
  const line = lines.find((l) => l.startsWith(`${first},`));
  expect(line, `a row for ${first}`).toBeTruthy();
  return { filename: download.suggestedFilename(), header, row: Object.fromEntries(line!.split(",").map((value, i) => [header[i], value])) as Record<string, string> };
}

test("Export CSV on invoices downloads the import columns and the stored figures of a known invoice", async ({ page }) => {
  const ref = `INV-EXP-${w.runId}`;
  await withDb(async (db) => {
    await db.query(
      `insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, amount_paid, invoice_date, due_date, vat_enabled, customer_po)
       values ($1, $2, 'Export Example Ltd', 100, 20, 120, 'issued', 0, '2026-10-01', '2099-12-31', true, 'PO-EXP')`, [w.tenants.alpha.id, ref]);
  });

  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/invoices");
  await expect(page.getByRole("row").filter({ hasText: ref })).toBeVisible();

  const button = await exportItem(page, "CSV");
  // Nothing is selected, so it says it exports the whole filter.
  await expect(button).toHaveAttribute("title", /^Exports all \d+ invoices? in the current filter/);
  const [download] = await Promise.all([page.waitForEvent("download"), button.click()]);
  expect(download.suggestedFilename()).toMatch(/^Invoices-\d{4}-\d{2}-\d{2}\.csv$/);

  const text = readFileSync(await download.path(), "utf8");
  expect(text.charCodeAt(0)).toBe(0xfeff);
  const lines = text.slice(1).split("\r\n");
  expect(lines.at(-1)).toBe("");
  const header = lines[0].split(",");
  expect(header).toEqual(["Invoice No", "Customer", "Invoice Date", "Due Date", "Tax Point", "Terms", "Quote Ref", "Customer PO", "Net", "VAT", "Total", "Paid", "Credited", "Balance Due", "Status", "Stored Status"]);

  const line = lines.find((l) => l.startsWith(`${ref},`));
  expect(line, `a row for ${ref}`).toBeTruthy();
  const cell = Object.fromEntries(line!.split(",").map((value, i) => [header[i], value]));
  expect(cell).toMatchObject({
    "Invoice No": ref, Customer: "Export Example Ltd", "Invoice Date": "2026-10-01", "Due Date": "2099-12-31", "Customer PO": "PO-EXP",
    Net: "100.00", VAT: "20.00", Total: "120.00", Paid: "0.00", "Balance Due": "120.00", Status: "outstanding",
  });
});

test("Export CSV on purchase orders, sales orders, customers and suppliers", async ({ page }) => {
  const org = w.tenants.alpha.id;
  const tag = w.runId;
  const admin = adminClient();
  expect((await admin.from("purchase_orders").insert({ organization_id: org, po_ref: `PO-EXP-${tag}`, supplier: "Export Steel Ltd", total_value: 250.5, status: "draft", order_date: "2026-10-02" })).error).toBeNull();
  expect((await admin.from("sales_orders").insert({ organization_id: org, so_number: `SO-EXP-${tag}`, customer: "Export Example Ltd", status: "open", customer_po: `CPO-EXP-${tag}`, total_value: 300, order_date: "2026-10-03" })).error).toBeNull();
  expect((await admin.from("customers").insert({ organization_id: org, name: `Export Customer ${tag}`, email: `export.${tag}@example.test`, contact_name: "Pat Contact" })).error).toBeNull();
  expect((await admin.from("suppliers").insert({ organization_id: org, name: `Export Supplier ${tag}`, email: `sup.${tag}@example.test`, contact_name: "Sam Supplier" })).error).toBeNull();

  await signIn(page, w.tenants.alpha.users.admin);

  await page.goto("/purchase-orders");
  await expect(page.getByRole("row").filter({ hasText: `PO-EXP-${tag}` })).toBeVisible();
  let csv = await downloadCsv(page, { menuItem: "CSV" }, `PO-EXP-${tag}`);
  expect(csv.filename).toMatch(/^Purchase Orders-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(csv.header.slice(0, 5)).toEqual(["PO No", "Supplier", "Order Date", "Expected Delivery", "Net"]);
  expect(csv.row).toMatchObject({ Supplier: "Export Steel Ltd", "Order Date": "2026-10-02", Net: "250.50", Status: "draft" });

  await page.goto("/sales-orders");
  await expect(page.getByRole("row").filter({ hasText: `CPO-EXP-${tag}` })).toBeVisible();
  csv = await downloadCsv(page, { menuItem: "CSV" }, `CPO-EXP-${tag}`);
  expect(csv.header.slice(0, 4)).toEqual(["Order Ref", "Customer", "Customer PO", "Quote Ref"]);
  expect(csv.row).toMatchObject({ Customer: "Export Example Ltd", "Customer PO": `CPO-EXP-${tag}`, "Order Date": "2026-10-03", Net: "300.00", Status: "open" });

  await page.goto("/customers");
  await expect(page.getByText(`Export Customer ${tag}`)).toBeVisible();
  csv = await downloadCsv(page, { menuItem: "CSV" }, `Export Customer ${tag}`);
  expect(csv.header).toEqual(["Name", "Contact", "Email", "Phone", "Mobile", "Address", "Notes"]);
  expect(csv.row).toMatchObject({ Contact: "Pat Contact", Email: `export.${tag}@example.test` });

  await page.goto("/suppliers");
  await expect(page.getByText(`Export Supplier ${tag}`)).toBeVisible();
  csv = await downloadCsv(page, { menuItem: "CSV" }, `Export Supplier ${tag}`);
  expect(csv.header.slice(0, 3)).toEqual(["Name", "Contact", "Email"]);
  expect(csv.row).toMatchObject({ Contact: "Sam Supplier", Email: `sup.${tag}@example.test` });
});

test("Export payments CSV on invoices lists the recorded payments by invoice ref, paid date and amount", async ({ page }) => {
  const ref = `INV-EXPPAY-${w.runId}`;
  const org = w.tenants.alpha.id;
  await withDb(async (db) => {
    const { rows } = await db.query(
      `insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, amount_paid, invoice_date, due_date, vat_enabled)
       values ($1, $2, 'Export Example Ltd', 100, 20, 120, 'partial', 40, '2026-10-01', '2099-12-31', true) returning id`, [org, ref]);
    await db.query("insert into public.invoice_payments (organization_id, invoice_id, amount, paid_on, method, reference, source) values ($1, $2, 40, '2026-10-05', 'BACS', $3, 'recorded')", [org, rows[0].id, `REM-${w.runId}`]);
  });

  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/invoices");
  await expect(page.getByRole("row").filter({ hasText: ref })).toBeVisible();
  const csv = await downloadCsv(page, { menuItem: "Payments CSV" }, ref);
  expect(csv.filename).toMatch(/^Invoice Payments-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(csv.header.slice(0, 5)).toEqual(["Invoice No", "Paid On", "Amount", "Method", "Reference"]);
  expect(csv.row).toMatchObject({ "Paid On": "2026-10-05", Amount: "40.00", Method: "BACS", Reference: `REM-${w.runId}`, Source: "recorded", Type: "Payment", Reversed: "No" });
});

test("Export CSV on the weekly hours review lists the person's day as shown", async ({ page }) => {
  const person = w.tenants.alpha.users.workshop;
  await withDb(async (db) => {
    // A winter week (UK time = UTC): Tuesday 3 March 2026, 08:00 to 16:30.
    await db.query(
      `insert into public.attendance_events (organization_id, user_id, client_op_id, action, at, source, recorded_by)
       values ($1, $2, gen_random_uuid(), 'in', '2026-03-03T08:00:00Z', 'clock', $2), ($1, $2, gen_random_uuid(), 'out', '2026-03-03T16:30:00Z', 'clock', $2)`, [w.tenants.alpha.id, person.id]);
  });

  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/time/week?week=2026-03-02");
  await expect(page.getByTestId(`week-row-${person.id}`)).toBeVisible();
  const csv = await downloadCsv(page, "Export CSV", "Workshop alpha");
  expect(csv.filename).toMatch(/^Weekly Hours 2026-03-02-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(csv.header.slice(0, 7)).toEqual(["Person", "Date", "Clock In", "Clock Out", "Clocked (hours)", "Breaks Deducted (hours)", "Paid (hours)"]);
  expect(csv.row).toMatchObject({ Date: "2026-03-03", "Clock In": "08:00", "Clock Out": "16:30", "Clocked (hours)": "8.5" });
});
