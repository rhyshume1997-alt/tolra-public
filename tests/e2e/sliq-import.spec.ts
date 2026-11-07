/**
 * Admin > Data > SliQ go-live import (gate D1, proposal p152): the browser flow end to end. Synthetic CSVs are built here from small strings
 * and handed to the card's file input; nothing real is used. The database is read back with the service client to prove that checking and
 * the preflight write nothing, that the import writes exactly the file's records, and that a second run writes nothing.
 *
 * Runs in its own company (createSoloTenant) so the counts are this spec's alone. Needs the disposable Supabase stack; it is skipped without one.
 *
 * Markup this spec depends on (update here if the card changes): see the SEL block below. Entries marked "new card" are for the validation
 * report, reconciliation table and signing sheet, which the card must expose with these test ids.
 */
import { createHash } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

import { adminClient, createSoloTenant } from "../support/fixtures";
import { browserDatabaseConfigured, NO_BROWSER_DATABASE } from "../support/optional-browser-database";
import { signIn, world } from "./helpers";

test.skip(!browserDatabaseConfigured(), NO_BROWSER_DATABASE);
test.describe.configure({ mode: "serial" });

const SEL = {
  card: "sliq-import",
  fileInput: "SliQ files and mapping", // aria-label of the <input type=file multiple>
  files: "sliq-files",
  hashes: "sliq-hashes",
  preflight: "sliq-preflight",
  done: "sliq-done",
  report: "sliq-report", // new card: validation report container
  reportError: "sliq-report-error", // new card: one element per error, text carries file, row and field
  reconcile: "sliq-reconcile", // new card: reconciliation table
  sheet: "sliq-sheet", // new card: signing-sheet text
} as const;

const enc = (s: string) => Buffer.from(s, "utf8");
const sha = (s: string) => createHash("sha256").update(enc(s)).digest("hex");

const CSV = {
  "customers.csv": "Account,Name\r\nC001,Alpha Fabrications Ltd\r\nC002,Beta Engineering Limited\r\n",
  "suppliers.csv": "Account,Name\r\nSUP1,Steel Supplies Ltd\r\n",
  "invoices.csv": "Invoice No,Date,Account,Gross\r\nS1001,25/03/2026,C001,120.00\r\nS1002,26/03/2026,C002,600.00\r\n",
  "payments.csv": "Invoice No,Received,Amount\r\nS1001,27/03/2026,120.00\r\nS1002,30/03/2026,100.00\r\n",
} as const;

// Every date has day and month both 12 or lower, so DD/MM and MM/DD both read them: the validator refuses this without a signed-off dateSample.
const AMBIGUOUS_CSV = {
  ...CSV,
  "invoices.csv": "Invoice No,Date,Account,Gross\r\nS1001,01/03/2026,C001,120.00\r\nS1002,02/03/2026,C002,600.00\r\n",
  "payments.csv": "Invoice No,Received,Amount\r\nS1001,05/03/2026,120.00\r\nS1002,10/03/2026,100.00\r\n",
} as const;

// dateSample: invoices.csv row 2 (the first data row; the header is row 1) is 25/03/2026, which can only be day-first: 25 March 2026.
const DATE_SAMPLE = { file: "invoices.csv", row: 2, raw: "25/03/2026", means: "2026-03-25", confirmedBy: "John (synthetic e2e)" };

const mapping = (confirmed: boolean, dateSample: boolean = true) => JSON.stringify({
  version: 1, confirmed, dateFormat: "DD/MM/YYYY",
  ...(dateSample ? { dateSample: DATE_SAMPLE } : {}),
  entities: {
    customers: { file: "customers.csv", columns: { key: "Account", name: "Name" } },
    suppliers: { file: "suppliers.csv", columns: { key: "Account", name: "Name" } },
    invoices: { file: "invoices.csv", columns: { ref: "Invoice No", customerKey: "Account", date: "Date", gross: "Gross" } },
    payments: { file: "payments.csv", columns: { invoiceRef: "Invoice No", date: "Received", amount: "Amount" } },
  },
});

const toFiles = (csv: Record<string, string>, map: string) => [
  { name: "mapping.json", mimeType: "application/json", buffer: enc(map) },
  ...Object.entries(csv).map(([name, text]) => ({ name, mimeType: "text/csv", buffer: enc(text) })),
];

let org: Awaited<ReturnType<typeof createSoloTenant>>;

async function counts() {
  const db = adminClient();
  const n = async (table: string) => {
    const { count, error } = await db.from(table).select("id", { count: "exact", head: true }).eq("organization_id", org.id);
    expect(error, table).toBeNull();
    return count ?? 0;
  };
  return { customers: await n("customers"), suppliers: await n("suppliers"), invoices: await n("invoices"), payments: await n("invoice_payments") };
}

async function openCard(page: Page) {
  await signIn(page, org.admin);
  await page.goto("/admin/data");
  await expect(page.getByRole("heading", { name: "Data", exact: true })).toBeVisible();
  const card = page.getByTestId(SEL.card);
  await expect(card.getByRole("heading", { name: "SliQ go-live import" })).toBeVisible();
  return card;
}

test.beforeAll(async () => {
  org = await createSoloTenant(world().runId, "sliq-import", undefined, { salesOrders: false });
});

test("an unconfirmed mapping is refused and errors are listed with file, row and field", async ({ page }) => {
  const card = await openCard(page);
  const input = card.getByLabel(SEL.fileInput);

  // Mapping not confirmed: refused, nothing built.
  await input.setInputFiles(toFiles(CSV, mapping(false)));
  await expect(card.getByRole("alert")).toContainText(/confirmed/i);
  await expect(card.getByRole("button", { name: "Preflight (writes nothing)" })).toBeDisabled();

  // A confirmed mapping over files with a bad amount (invoices row 3) and a missing customer (invoices row 2).
  const bad = {
    ...CSV,
    "invoices.csv": "Invoice No,Date,Account,Gross\r\nS1001,25/03/2026,C999,120.00\r\nS1002,26/03/2026,C002,12x.00\r\n",
  };
  await input.setInputFiles(toFiles(bad, mapping(true)));
  await card.getByRole("button", { name: "Check files" }).click();
  const report = card.getByTestId(SEL.report);
  await expect(report).toBeVisible();
  const errors = report.getByTestId(SEL.reportError);
  await expect(errors.filter({ hasText: "invoices.csv" }).filter({ hasText: /row 2/i }).first()).toBeVisible();
  await expect(errors.filter({ hasText: "invoices.csv" }).filter({ hasText: /row 3/i }).filter({ hasText: /gross/i }).first()).toBeVisible();
  await expect(card.getByRole("button", { name: "Preflight (writes nothing)" })).toBeDisabled();
  expect(await counts()).toEqual({ customers: 0, suppliers: 0, invoices: 0, payments: 0 });
});

test("a mapping whose dates are all ambiguous and has no signed-off dateSample is refused", async ({ page }) => {
  const card = await openCard(page);
  await card.getByLabel(SEL.fileInput).setInputFiles(toFiles(AMBIGUOUS_CSV, mapping(true, false)));
  await card.getByRole("button", { name: "Check files" }).click();
  const report = card.getByTestId(SEL.report);
  await expect(report).toBeVisible();
  await expect(report.getByTestId(SEL.reportError).filter({ hasText: "dateFormat" }).filter({ hasText: /dateSample/ }).first()).toBeVisible();
  await expect(card.getByRole("button", { name: "Preflight (writes nothing)" })).toBeDisabled();
  expect(await counts()).toEqual({ customers: 0, suppliers: 0, invoices: 0, payments: 0 });
});

test("preflight writes nothing, the import runs in batches, reconciliation and the signing sheet show the file hashes", async ({ page }) => {
  const card = await openCard(page);
  await card.getByLabel(SEL.fileInput).setInputFiles(toFiles(CSV, mapping(true)));
  await expect(card.getByTestId(SEL.files)).toContainText("Mapping: chosen");
  await expect(card.getByTestId(SEL.files)).toContainText("customers yes, suppliers yes, invoices yes, payments yes");

  await card.getByRole("button", { name: "Check files" }).click();
  for (const [name, text] of Object.entries(CSV)) await expect(card.getByTestId(SEL.hashes)).toContainText(`${name} ${sha(text)}`);

  const before = await counts();
  await card.getByRole("button", { name: "Preflight (writes nothing)" }).click();
  const pre = card.getByTestId(SEL.preflight);
  await expect(pre).toContainText("customers: 2 to create, 0 already imported, 0 with problems");
  await expect(pre).toContainText("invoices: 2 to create, 0 already imported, 0 with problems");
  await expect(pre).toContainText("payments: 2 to create, 0 already imported, 0 with problems");
  expect(await counts()).toEqual(before);
  expect(before).toEqual({ customers: 0, suppliers: 0, invoices: 0, payments: 0 });

  // Import in batches, through the confirmation.
  await card.getByRole("button", { name: /^Import \d+ batches$/ }).click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(card.getByTestId(SEL.done)).toBeVisible({ timeout: 120_000 });
  await expect(card.getByTestId(SEL.done)).toContainText(/Imported: [1-9]\d* records created/);
  expect(await counts()).toEqual({ customers: 2, suppliers: 1, invoices: 2, payments: 2 });

  // Reconciliation table (new card): every check passes; the signing sheet carries each file's SHA-256.
  await card.getByRole("button", { name: /reconcil/i }).click();
  const table = card.getByTestId(SEL.reconcile);
  await expect(table).toBeVisible({ timeout: 60_000 });
  await expect(table).not.toContainText(/FAIL/);
  const sheet = card.getByTestId(SEL.sheet);
  await expect(sheet).toContainText("SLIQ IMPORT RECONCILIATION - SIGNING SHEET");
  await expect(sheet).toContainText("PASS - all differences are zero");
  for (const [name, text] of Object.entries(CSV)) await expect(sheet).toContainText(`${name}  ${sha(text)}`);
});

test("re-running the same files says already imported and changes nothing", async ({ page }) => {
  const before = await counts();
  expect(before).toEqual({ customers: 2, suppliers: 1, invoices: 2, payments: 2 });
  const card = await openCard(page);
  await card.getByLabel(SEL.fileInput).setInputFiles(toFiles(CSV, mapping(true)));
  await card.getByRole("button", { name: "Check files" }).click();
  await card.getByRole("button", { name: "Preflight (writes nothing)" }).click();
  const pre = card.getByTestId(SEL.preflight);
  await expect(pre).toContainText("customers: 0 to create, 2 already imported, 0 with problems");
  await expect(pre).toContainText("invoices: 0 to create, 2 already imported, 0 with problems");
  await expect(pre).toContainText("payments: 0 to create, 2 already imported, 0 with problems");

  await card.getByRole("button", { name: /^Import \d+ batches$/ }).click();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(card.getByTestId(SEL.done)).toBeVisible({ timeout: 120_000 });
  await expect(card.getByTestId(SEL.done)).toContainText("0 records created");
  expect(await counts()).toEqual(before);
});

test("a non-admin cannot see the SliQ card", async ({ page }) => {
  await signIn(page, world().tenants.alpha.users.office);
  await page.goto("/admin/data");
  await expect(page.getByTestId(SEL.card)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "SliQ go-live import" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
});
