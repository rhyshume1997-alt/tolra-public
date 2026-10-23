/**
 * Admin > Data (migrations 076 and 085): one upload, a dry run, then confirm. The database decides every match, link and problem; these tests
 * drive the page and read the database back. Numbers carry the run id and are not INV-digits, so no company counter moves.
 */
import { expect, test, type Page } from "@playwright/test";

import { adminClient, signedInClient, withDb } from "../support/fixtures";
import { smallWorkbook } from "../support/import-workbook";
import { type TestCell, workbookBytes } from "../support/workbook";
import { signIn, world } from "./helpers";

const w = world();
test.describe.configure({ mode: "serial" });

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function openData(page: Page) {
  await signIn(page, w.tenants.alpha.users.admin);
  await page.goto("/admin/data");
  await expect(page.getByRole("heading", { name: "Data", exact: true })).toBeVisible();
}

async function upload(page: Page, name: string, sheets: { name: string; rows: TestCell[][] }[]) {
  await page.getByTestId("import-file").setInputFiles({ name, mimeType: XLSX, buffer: Buffer.from(workbookBytes(sheets)) });
  await expect(page.getByRole("button", { name: "Check the file" })).toBeVisible();
}

async function check(page: Page) {
  await page.getByRole("button", { name: "Check the file" }).click();
  await expect(page.getByTestId("import-preview")).toBeVisible({ timeout: 60_000 });
}

/** The check says the file is clean; when it does not, the failure carries what the page listed (a problem, or an error), not just a missing heading. */
async function expectClean(page: Page) {
  const heading = page.getByRole("heading", { name: /^The file (is clean|has problems)$/ });
  await expect(heading).toBeVisible();
  if ((await heading.textContent()) !== "The file is clean") {
    const problems = await page.getByTestId("import-problems-line").allTextContents();
    const error = await page.getByTestId("import-error").allTextContents();
    throw new Error(`The check did not come back clean. Problems: ${JSON.stringify(problems)} Error: ${JSON.stringify(error)}`);
  }
}

const cell = (page: Page, kind: string, col: string) => page.getByTestId(`import-count-${kind}`).locator(`[data-col=${col}]`);

async function count(table: string, column: string, value: string) {
  const { count: n, error } = await adminClient().from(table).select("id", { count: "exact", head: true }).eq("organization_id", w.tenants.alpha.id).eq(column, value);
  expect(error).toBeNull();
  return n ?? 0;
}

test("upload customers + quotes + invoices + payments: dry run, confirm, counts", async ({ page }) => {
  const f = smallWorkbook(w.runId);
  await openData(page);
  await upload(page, "small.xlsx", f.sheets);

  // Four sheets, each recognised from its headers (nothing guessed): no sheet is waiting to be chosen.
  await expect(page.getByTestId("import-sheet")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Check the file" })).toBeEnabled();
  // "Account Memo" is nobody's synonym: offered as a mapping (a field, or ignore). Map it to Notes: saved for the company on confirm.
  await page.getByLabel("Column Account Memo goes to").selectOption({ label: "Notes" });
  // The contact person is free text, and it says so.
  await expect(page.getByText("The contact person is kept as free text, not a Tolra user.")).toBeVisible();

  await check(page);
  await expectClean(page);
  await expect(page.getByText("Small enough to go in as one step")).toBeVisible();
  await expect(cell(page, "customers", "created")).toHaveText("1");
  await expect(cell(page, "quotes", "created")).toHaveText("1");
  await expect(cell(page, "invoices", "created")).toHaveText("2");
  await expect(cell(page, "payments", "created")).toHaveText("1");
  await expect(cell(page, "invoices", "problems")).toHaveText("0");
  // Nothing is written by a dry run.
  expect(await count("invoices", "invoice_ref", f.inv1)).toBe(0);

  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByTestId("import-done")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("import-done-customers")).toContainText("1 created");
  await expect(page.getByTestId("import-done-invoices")).toContainText("2 created");
  await expect(page.getByTestId("import-done-payments")).toContainText("1 created");

  // The database, read back: the invoice with its lines, its payment and the state that follows from it.
  const admin = adminClient();
  const invoice = (await admin.from("invoices").select("id, customer, total, amount_paid, status").eq("organization_id", w.tenants.alpha.id).eq("invoice_ref", f.inv1).single()).data!;
  expect(invoice).toMatchObject({ customer: f.customer, status: "partial" });
  expect(Number(invoice.total)).toBe(120);
  expect(Number(invoice.amount_paid)).toBe(60);
  expect((await admin.from("invoice_line_items").select("id").eq("invoice_id", invoice.id)).data).toHaveLength(2);
  expect((await admin.from("invoice_payments").select("amount").eq("invoice_id", invoice.id)).data?.map((p) => Number(p.amount))).toEqual([60]);
  expect(await count("quotes", "quote_ref", f.quote)).toBe(1);
  const customer = (await admin.from("customers").select("contact_name, notes").eq("organization_id", w.tenants.alpha.id).eq("name", f.customer).single()).data!;
  expect(customer).toMatchObject({ contact_name: "Pat Buyer", notes: "Pays on the 28th" });

  // The column choice was saved for the company, once.
  const mappings = (await admin.from("import_mappings").select("kind, mapping").eq("organization_id", w.tenants.alpha.id)).data!;
  expect(mappings).toHaveLength(1);
  expect(mappings[0]).toMatchObject({ kind: "customers", mapping: { "account memo": "notes", name: "name" } });

  // A small import is listed in the history as one step.
  await expect(page.getByTestId("import-history").getByTestId("history-state").first()).toContainText("Imported in one step");
});

test("re-uploading the same file: 0 created, everything matched, nothing to confirm", async ({ page }) => {
  const f = smallWorkbook(w.runId);
  await openData(page);
  await upload(page, "small.xlsx", f.sheets);
  // The saved mapping is used: the column is already Notes and nothing is asked.
  await expect(page.getByText("known from your saved mapping")).toBeVisible();
  await expect(page.getByLabel("Column Account Memo goes to")).toHaveValue("notes");

  await check(page);
  for (const [kind, matched] of [["customers", "1"], ["quotes", "1"], ["invoices", "2"], ["payments", "1"]] as const) {
    await expect(cell(page, kind, "created"), `${kind} created`).toHaveText("0");
    await expect(cell(page, kind, "matched"), `${kind} matched`).toHaveText(matched);
    await expect(cell(page, kind, "problems"), `${kind} problems`).toHaveText("0");
  }
  await expect(page.getByText("everything in this file is already in Tolra")).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm import" })).toBeDisabled();
  // Still one of each in the database.
  expect(await count("invoices", "invoice_ref", f.inv1)).toBe(1);
  expect(await count("customers", "name", f.customer)).toBe(1);
});

test("a sheet without a match key: it is not guessed, every row is a problem, and nothing is written", async ({ page }) => {
  const tag = w.runId;
  const customer = `NoKey Co ${tag} Ltd`;
  await openData(page);
  const invoicesBefore = (await adminClient().from("invoices").select("id", { count: "exact", head: true }).eq("organization_id", w.tenants.alpha.id)).count;
  await upload(page, "nokey.xlsx", [{ name: "Invoices", rows: [["Customer", "Invoice Date", "Total"], [customer, "2026-10-01", 50], [customer, "2026-10-01", 50]] }]);

  // No Invoice No column: the sheet is not placed by itself; the admin says what it is, and is told the key is missing.
  await expect(page.getByRole("button", { name: "Check the file" })).toBeDisabled();
  await page.getByLabel("What is Invoices?").selectOption("invoices");
  await expect(page.getByText("No column is the invoice number.")).toBeVisible();
  await check(page);
  await expect(page.getByText("The file has problems")).toBeVisible();
  // One problem per row (the database lists them in no set order).
  const lines = page.getByTestId("import-problems-line");
  await expect(lines).toHaveCount(2);
  await expect(lines.filter({ hasText: "Invoices, row 2, invoice_ref: Invoice number is required." })).toHaveCount(1);
  await expect(lines.filter({ hasText: "Invoices, row 3, invoice_ref: Invoice number is required." })).toHaveCount(1);
  await expect(cell(page, "invoices", "created")).toHaveText("0");
  await expect(page.getByRole("button", { name: "Confirm import" })).toBeDisabled();

  // Nothing was written, so nothing can be doubled.
  expect((await adminClient().from("invoices").select("id", { count: "exact", head: true }).eq("organization_id", w.tenants.alpha.id)).count).toBe(invoicesBefore);
  expect(await count("invoices", "customer", customer)).toBe(0);
});

test("the same document number twice in the file is a problem", async ({ page }) => {
  const ref = `INV-DI-${w.runId}-DUP`;
  await openData(page);
  await upload(page, "dup.xlsx", [{ name: "Invoices", rows: [["Invoice No", "Customer", "Invoice Date", "Total"], [ref, "Dup Co Ltd", "2026-10-01", 10], [ref, "Dup Co Ltd", "2026-10-01", 10]] }]);
  await check(page);
  await expect(page.getByTestId("import-problems")).toContainText("This number is in the file twice (also row 2).");
  await expect(page.getByTestId("import-problems-line")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Confirm import" })).toBeDisabled();
  expect(await count("invoices", "invoice_ref", ref)).toBe(0);
});

test("a payment for an invoice already in Tolra is refused with the message", async ({ page }) => {
  const ref = `INV-DI-${w.runId}-EXIST`;
  await withDb(async (db) => {
    await db.query(
      `insert into public.invoices (organization_id, invoice_ref, customer, subtotal, vat, total, status, amount_paid, invoice_date, due_date, vat_enabled)
       values ($1, $2, 'DI Existing Co Ltd', 100, 20, 120, 'issued', 0, '2026-10-01', '2099-12-31', true)`, [w.tenants.alpha.id, ref]);
  });
  await openData(page);
  await upload(page, "payment.xlsx", [{ name: "Payments", rows: [["Invoice No", "Paid On", "Amount", "Method"], [ref, "2026-10-05", 20, "BACS"]] }]);
  await check(page);
  await expect(page.getByTestId("import-problems")).toContainText(`Invoice ${ref} is already in Tolra: record this payment on it with Record payment.`);
  await expect(cell(page, "payments", "created")).toHaveText("0");
  await expect(page.getByRole("button", { name: "Confirm import" })).toBeDisabled();
  // Nothing was written: the invoice has no payment and is as it was.
  const invoice = (await adminClient().from("invoices").select("id, amount_paid, status").eq("organization_id", w.tenants.alpha.id).eq("invoice_ref", ref).single()).data!;
  expect(Number(invoice.amount_paid)).toBe(0);
  expect(invoice.status).toBe("issued");
  expect((await adminClient().from("invoice_payments").select("id").eq("invoice_id", invoice.id)).data).toEqual([]);
});

test("a name that matches two customers is a problem, never a guess", async ({ page }) => {
  const tag = w.runId;
  const admin = adminClient();
  // "Limited" and "Ltd" are the same name once normalised, so Tolra already holds two customers the file's name matches.
  expect((await admin.from("customers").insert([{ organization_id: w.tenants.alpha.id, name: `Twin ${tag} Ltd` }, { organization_id: w.tenants.alpha.id, name: `Twin ${tag} Limited` }])).error).toBeNull();
  await openData(page);
  await upload(page, "twin.xlsx", [{ name: "Customers", rows: [["Name", "Email"], [`Twin ${tag} Ltd`, "twin@example.test"]] }]);
  await check(page);
  await expect(page.getByTestId("import-problems")).toContainText("Matches 2 customers already in Tolra with the same name");
  await expect(page.getByRole("button", { name: "Confirm import" })).toBeDisabled();
  expect((await admin.from("customers").select("id", { count: "exact", head: true }).eq("organization_id", w.tenants.alpha.id).ilike("name", `Twin ${tag}%`)).count).toBe(2);
});

test("credit notes and delivery notes go in with the invoice they credit; 'sent by' and 'signed by' kept as text (085)", async ({ page }) => {
  const t = w.runId;
  const inv = `INV-E${t}`;
  await openData(page);
  await upload(page, "extras.xlsx", [
    { name: "Invoices", rows: [["Invoice No", "Customer", "Invoice Date", "Total", "VAT", "Invoice sent by"], [inv, `Extras Co ${t} Ltd`, "2026-08-01", 120, 20, "Jo Sender"]] },
    { name: "Credit notes", rows: [["Credit Note No", "Invoice No", "Credit Date", "Total", "VAT", "Reason"], [`CRD-E${t}`, inv, "2026-08-05", 120, 20, "Returned"]] },
    { name: "Delivery notes", rows: [["DN No", "Customer", "Invoice No", "Delivery Date", "Signed By", "Description", "Qty"], [`DLN-E${t}`, `Extras Co ${t} Ltd`, inv, "2026-07-30", "Kim Receiver", "Shaft", 4]] },
    { name: "Customers", rows: [["Name", "Delivery note signed by"], [`Extras Co ${t} Ltd`, "Kim Receiver"]] },
  ]);
  // Every sheet is recognised from its headers; who sent or signed a document is said to be text, not a Tolra user.
  await expect(page.getByTestId("import-sheet")).toHaveCount(4);
  await expect(page.getByTestId("import-credit-note-help")).toContainText("applied in full to its invoice");
  await expect(page.getByTestId("import-people-help").first()).toContainText("not a Tolra user");
  await expect(page.getByTestId("import-people-column")).toContainText("is not part of customers, so it is not imported");
  await check(page);
  await expectClean(page);
  await expect(cell(page, "credit_notes", "created")).toHaveText("1");
  await expect(cell(page, "credit_notes", "linked")).toHaveText("1");
  await expect(cell(page, "delivery_notes", "created")).toHaveText("1");
  await expect(cell(page, "delivery_notes", "linked")).toHaveText("1");
  expect(await count("credit_notes", "credit_ref", `CRD-E${t}`)).toBe(0);

  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByTestId("import-done")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("import-done-credit_notes")).toContainText("1 created");
  await expect(page.getByTestId("import-done-delivery_notes")).toContainText("1 created");
  const admin = adminClient();
  const invoice = (await admin.from("invoices").select("id, status, credited_amount, sent_by_name, sent_by_user_id").eq("organization_id", w.tenants.alpha.id).eq("invoice_ref", inv).single()).data!;
  expect(invoice).toMatchObject({ status: "credited", sent_by_name: "Jo Sender", sent_by_user_id: null });
  expect(Number(invoice.credited_amount)).toBe(120);
  const credit = (await admin.from("credit_notes").select("status, total, allocated_amount, invoice_id").eq("organization_id", w.tenants.alpha.id).eq("credit_ref", `CRD-E${t}`).single()).data!;
  expect(credit).toMatchObject({ status: "issued", invoice_id: invoice.id });
  expect(Number(credit.allocated_amount)).toBe(120);
  const note = (await admin.from("delivery_notes").select("status, signed_by_name, signed_by_user_id, invoice_id").eq("organization_id", w.tenants.alpha.id).eq("dn_number", `DLN-E${t}`).single()).data!;
  expect(note).toMatchObject({ status: "signed", signed_by_name: "Kim Receiver", signed_by_user_id: null, invoice_id: invoice.id });
});

test("only an admin: another role is sent away from the page and the import functions refuse it", async ({ page }) => {
  await signIn(page, w.tenants.alpha.users.office);
  await page.goto("/admin/data");
  await expect(page).toHaveURL(/\/dashboard/);

  const office = await signedInClient(w.tenants.alpha.users.office);
  const payload = { file_name: "x.csv", file_sha256: "c".repeat(64), customers: [{ name: `Nope ${w.runId} Ltd` }] };
  const id = "00000000-0000-4000-8000-000000000001";
  const calls = [
    office.rpc("import_company_data", { p_payload: payload, p_dry_run: true, p_client_op_id: id }),
    office.rpc("import_stage_part", { p_import_id: id, p_part: 1, p_payload: payload }),
    office.rpc("import_validate", { p_import_id: id, p_part_weight: 500, p_client_op_id: id }),
    office.rpc("import_commit_part", { p_import_id: id, p_client_op_id: id }),
    office.rpc("import_undo", { p_import_id: id, p_client_op_id: id }),
  ];
  for (const { error } of await Promise.all(calls)) {
    expect(error?.message).toBe("Only an admin can import data.");
  }
  expect(await count("customers", "name", `Nope ${w.runId} Ltd`)).toBe(0);
  // The saved mappings and the history are the admin's alone.
  expect((await office.from("import_mappings").select("id")).data).toEqual([]);
  expect((await office.from("import_batches").select("id")).data).toEqual([]);
});

test("a large import goes in parts with a progress bar; a part whose answer is lost is retried once; Undo removes it", async ({ page }) => {
  test.setTimeout(300_000);
  const tag = w.runId;
  const fileName = `bulk-${tag}.xlsx`;
  const org = w.tenants.alpha.id;
  const bulk = async () => (await adminClient().from("customers").select("id", { count: "exact", head: true }).eq("organization_id", org).ilike("name", `Bulk ${tag} %`)).count;
  try {
    // More audit rows than one call takes (2,000): staged, checked whole, committed in parts.
    const rows: TestCell[][] = [["Name"], ...Array.from({ length: 2100 }, (_, i) => [`Bulk ${tag} ${String(i + 1).padStart(4, "0")} Ltd`])];
    await openData(page);
    await upload(page, fileName, [{ name: "Customers", rows }]);
    await check(page);
    await expect(page.getByTestId("import-large")).toBeVisible();
    await expect(cell(page, "customers", "created")).toHaveText("2100");

    // The answer to the second part is lost on the way back (the part itself went in): the page stops and offers Retry this part and Undo.
    let commits = 0;
    await page.route("**/rpc/import_commit_part", async (route) => {
      commits += 1;
      if (commits === 2) {
        await route.fetch();
        await route.abort("failed");
        return;
      }
      await route.continue();
    });
    await page.getByRole("button", { name: "Confirm import" }).click();
    const failed = page.getByTestId("import-failed");
    await expect(failed).toBeVisible({ timeout: 240_000 });
    await expect(failed).toContainText("Part 2 of");
    await expect(failed.getByRole("button", { name: "Undo this import" })).toBeVisible();
    expect(await bulk()).toBeGreaterThan(0);
    expect(await bulk()).toBeLessThan(2100);

    // Retry sends the same key: the database answers part 2 again, commits nothing twice, and the import finishes.
    await failed.getByRole("button", { name: "Retry this part" }).click();
    await expect(page.getByTestId("import-done")).toBeVisible({ timeout: 240_000 });
    await expect(page.getByTestId("import-done")).toContainText("Imported (large import)");
    expect(await bulk()).toBe(2100);

    // History: this file, marked large, with its undo state and an Undo button.
    const row = page.getByTestId("history-row").filter({ hasText: fileName });
    await expect(row.getByTestId("history-state")).toHaveText("Imported");
    await expect(row).toContainText("Large import");
    await row.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Undo import" }).click();
    await expect(page.getByTestId("history-note")).toContainText("Undone", { timeout: 240_000 });
    await expect(row.getByTestId("history-state")).toHaveText("Undone");
    expect(await bulk()).toBe(0);
  } finally {
    // Whatever happened above, the 2,100 customers do not stay in the tenant.
    await adminClient().from("customers").delete().eq("organization_id", org).ilike("name", `Bulk ${tag} %`);
  }
});
