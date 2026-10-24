/**
 * Pins today's behaviour (Rhys, 23 Oct: people may hide columns on every screen): hiding a column in the Columns picker
 * (lib/org-settings.ts hiddenColumns) changes the on-screen table ONLY. CSV / Excel, Word / PDF / print record exports, the
 * year-end zip, the weekly hours export, print packs and PDF documents stay fixed. Exports are the import spec
 * (lib/import-columns.ts), so a re-import always works; documents are forms, not tables.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { IMPORT_COLUMNS } from "@/lib/import-columns";
import { COLUMN_TABLES } from "@/lib/org-settings";
import { toCsv } from "@/lib/spreadsheet";
import { WEEK_COLUMNS } from "@/lib/time-week-export";

const ROOT = join(__dirname, "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** Every module that produces a file or a document a person receives. None may know about column visibility. */
const OUTPUT_MODULES = [
  "lib/spreadsheet.ts", "lib/export-records.ts", "lib/import-columns.ts", "lib/time-week-export.ts", "lib/year-end-export.tsx",
  "lib/print-pack.ts", "lib/download-pdf.tsx", "lib/invoice-pdf-data.ts", "lib/customer-signoff-print.ts",
  "components/pdf/BaseDocumentPDF.tsx", "components/pdf/InvoicePDF.tsx", "components/pdf/QuotePDF.tsx", "components/pdf/DeliveryNotePDF.tsx",
  "components/pdf/PurchaseOrderPDF.tsx", "components/pdf/SalesOrderPDF.tsx", "components/pdf/CreditNotePDF.tsx",
];
const VISIBILITY = /org-settings|useColumnVisibility|isVisible|hiddenColumns|hidden_columns/;

describe("exports and documents ignore hiddenColumns", () => {
  it.each(OUTPUT_MODULES)("%s does not read column visibility", (path) => {
    expect(read(path)).not.toMatch(VISIBILITY);
  });

  it("the other print routes (job/SO/PO/DN/time print pages) do not read column visibility", () => {
    for (const path of [
      "app/(dashboard)/sales-orders/[id]/print/page.tsx", "app/(dashboard)/purchase-orders/[id]/print/page.tsx",
      "app/(dashboard)/delivery-notes/[id]/print/page.tsx", "app/(dashboard)/time/print/page.tsx", "app/(dashboard)/time/week/print/page.tsx",
    ]) expect(read(path), path).not.toMatch(VISIBILITY);
  });

  it("every CSV / Excel call site passes the full import spec and an unfiltered row set", () => {
    const sites: [string, string, string][] = [
      ["app/(dashboard)/quotes/page.tsx", "QUOTE_COLUMNS", "exportScope"],
      ["app/(dashboard)/invoices/page.tsx", "INVOICE_COLUMNS", "exportScope"],
      ["app/(dashboard)/sales-orders/page.tsx", "SALES_ORDER_COLUMNS", "exportScope"],
      ["app/(dashboard)/purchase-orders/page.tsx", "PURCHASE_ORDER_COLUMNS", "exportScope"],
      ["app/(dashboard)/customers/page.tsx", "CUSTOMER_COLUMNS", "savedCustomers"],
      ["app/(dashboard)/suppliers/page.tsx", "SUPPLIER_COLUMNS", "suppliers"],
    ];
    for (const [path, spec, rows] of sites) {
      const src = read(path);
      for (const format of ["csv", "xlsx"]) expect(src, `${path} ${format}`).toMatch(new RegExp(`exportSpreadsheet\\("${format}", "[^"]+", ${spec}, ${rows},`));
      // The row set is built from filters and selection, never from the visible columns.
      const scope = src.split("\n").find((line) => /\bconst exportScope\b/.test(line));
      if (scope) expect(scope).not.toMatch(VISIBILITY);
    }
  });

  it("the payments export and the weekly hours export use their fixed specs", () => {
    expect(read("app/(dashboard)/invoices/page.tsx")).toMatch(/exportSpreadsheet\(format, "Invoice Payments", PAYMENT_COLUMNS,/);
    expect(read("components/time/week-review.tsx")).toMatch(/exportSpreadsheet\(format, `Weekly Hours \$\{week\}`, WEEK_COLUMNS,/);
  });

  it("the Word / PDF / print record exports build fixed rows (selected records, fixed fields)", () => {
    const quotes = read("app/(dashboard)/quotes/page.tsx");
    const invoices = read("app/(dashboard)/invoices/page.tsx");
    const quoteRows = quotes.slice(quotes.indexOf("const selectedRows"), quotes.indexOf("const selectedRows") + 400);
    const invoiceRows = invoices.slice(invoices.indexOf("const selectedInvoiceRows"), invoices.indexOf("const selectedInvoiceRows") + 500);
    expect(quoteRows).not.toMatch(VISIBILITY);
    expect(invoiceRows).not.toMatch(VISIBILITY);
    // "Valid Until" is a Quotes screen column, "Paid" / "Balance Due" are not screen columns at all: the export carries them whatever is shown.
    expect(quoteRows).toContain('"Valid Until"');
    expect(invoiceRows).toContain('"Balance Due"');
  });

  it("Print Selected packs (sales orders, purchase orders, delivery notes) are per-record forms, not the table", () => {
    for (const [path, pack] of [
      ["app/(dashboard)/sales-orders/page.tsx", "Sales Order Pack"], ["app/(dashboard)/purchase-orders/page.tsx", "Purchase Order Pack"], ["app/(dashboard)/delivery-notes/page.tsx", "Delivery Note Pack"],
    ]) {
      const src = read(path);
      const at = src.indexOf(`${pack}\``);
      expect(at, path).toBeGreaterThan(0);
      expect(src.slice(at, at + 1200), path).not.toMatch(VISIBILITY);
    }
  });
});

describe("the CSV / Excel header row is the whole import spec, whatever the screen shows", () => {
  const screenColumns = new Map(COLUMN_TABLES.map((table) => [table.key, table.columns.length]));

  it.each(Object.entries(IMPORT_COLUMNS))("%s: every spec column is written", (_name, columns) => {
    const header = toCsv(columns as never, []).replace(/^﻿/, "").split("\r\n")[0];
    expect(header.split(",")).toHaveLength(columns.length);
    expect(header).toBe(columns.map((column) => column.header).join(","));
  });

  it("is never narrower than the columns a screen can show (a hidden screen column does not shrink it)", () => {
    expect(IMPORT_COLUMNS.customers.length).toBeGreaterThanOrEqual(screenColumns.get("customers") ?? 0);
    expect(IMPORT_COLUMNS.suppliers.length).toBeGreaterThanOrEqual(screenColumns.get("suppliers") ?? 0);
    expect(IMPORT_COLUMNS.quotes.length).toBeGreaterThan(screenColumns.get("quotes") ?? 0);
    expect(IMPORT_COLUMNS.invoices.length).toBeGreaterThan(screenColumns.get("invoices") ?? 0);
  });

  it("the weekly hours export has a fixed header", () => {
    const header = toCsv(WEEK_COLUMNS, []).replace(/^﻿/, "").split("\r\n")[0];
    expect(header).toBe(WEEK_COLUMNS.map((column) => column.header).join(","));
  });
});
