/**
 * Review condition (phone lag, fix 1): every PDF and export entry point on the nine list pages (plus the credit notes panel on
 * invoices) still makes the same file under the same name with the same audit entry after the PDF code moved to load on the press.
 *
 * The page handlers build their documents from React state, so they are not called here. Instead:
 *  1. each entry point's call (downloadPdf / exportRows / exportSpreadsheet) is read from the page source and its file name and audit
 *     arguments are compared with the text of the same call at origin/main 1939755 (BEFORE, captured below);
 *  2. the document each lazy builder imports is the same component, from the same module, that 1939755 imported up front;
 *  3. the shared helpers those calls go through (downloadPdf, exportRows, exportSpreadsheet) are run with each page's arguments and
 *     must save the file under the name and record the audit event that 1939755's helpers did (same code, renderer now lazy).
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SheetColumn } from "@/lib/spreadsheet";

const ROOT = join(__dirname, "..", "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

const hoisted = vi.hoisted(() => ({ rendered: [] as unknown[] }));
vi.mock("@react-pdf/renderer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@react-pdf/renderer")>()),
  pdf: (element: unknown) => {
    hoisted.rendered.push(element);
    return { toBlob: async () => new Blob(["%PDF"]) };
  },
}));
const audit = vi.hoisted(() => ({ events: [] as unknown[] }));
vi.mock("@/lib/audit", () => ({ auditEvent: vi.fn(async (event: unknown) => { audit.events.push(event); }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock("@/lib/company", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/company")>();
  return { ...original, requireCompanyProfile: async () => original.JNR_PROFILE };
});

const downloads: string[] = [];
beforeEach(() => {
  downloads.length = 0;
  audit.events.length = 0;
  hoisted.rendered.length = 0;
  vi.stubGlobal("document", {
    createElement: () => {
      const link = { href: "", download: "", click: () => downloads.push(link.download), remove: () => undefined };
      return link;
    },
    body: { appendChild: () => undefined },
  });
});
afterEach(() => vi.unstubAllGlobals());

// ---- 1. the entry points' arguments, unchanged since 1939755 ------------------------------------------------------------------
type Call = [fn: "downloadPdf", filename: string, audit: string] | [fn: "exportRows" | "exportSpreadsheet", format: string, title: string, table: string | null];

/** Every downloadPdf / exportRows / exportSpreadsheet call in each file at origin/main 1939755, in source order (read with the same walker). */
const BEFORE: Record<string, Call[]> = {
  "app/(dashboard)/quotes/page.tsx": [
    ["downloadPdf", "pdfName(quote)", '{ entityTable: "quotes", entityId: quote.ref }'],
    ["downloadPdf", "pdfName(quote)", '{ entityTable: "quotes", entityId: quote.ref }'],
    ["exportSpreadsheet", '"csv"', '"Quotes"', '"quotes"'],
    ["exportSpreadsheet", '"xlsx"', '"Quotes"', '"quotes"'],
    ["exportRows", '"word"', "EXPORT_TITLES.quotes", '"quotes"'],
    ["exportRows", '"pdf"', "EXPORT_TITLES.quotes", '"quotes"'],
  ],
  "app/(dashboard)/invoices/page.tsx": [
    ["exportSpreadsheet", "format", '"Invoice Payments"', '"invoices"'],
    ["downloadPdf", "`invoice-${invoice.reference}.pdf`", '{ entityTable: "invoices", entityId: invoice.reference }'],
    ["downloadPdf", "`invoice-${invoice.reference}.pdf`", '{ entityTable: "invoices", entityId: invoice.reference }'],
    ["exportSpreadsheet", '"csv"', '"Invoices"', '"invoices"'],
    ["exportSpreadsheet", '"xlsx"', '"Invoices"', '"invoices"'],
    ["exportRows", '"word"', "EXPORT_TITLES.invoices", '"invoices"'],
    ["exportRows", '"pdf"', "EXPORT_TITLES.invoices", '"invoices"'],
  ],
  "components/credit-notes-panel.tsx": [
    ["downloadPdf", "`credit-note-${note.credit_ref}.pdf`", '{ entityTable: "invoices", entityId: note.credit_ref ?? invoice.reference }'],
  ],
  "app/(dashboard)/sales-orders/page.tsx": [
    ["downloadPdf", "`sales-order-${order.ref}.pdf`", '{ entityTable: "sales_orders", entityId: order.ref }'],
    ["exportSpreadsheet", '"csv"', '"Sales Orders"', '"sales_orders"'],
    ["exportSpreadsheet", '"xlsx"', '"Sales Orders"', '"sales_orders"'],
  ],
  "app/(dashboard)/delivery-notes/page.tsx": [
    ["downloadPdf", "`delivery-note-${note.ref}.pdf`", '{ entityTable: "delivery_notes", entityId: note.ref }'],
  ],
  "app/(dashboard)/purchase-orders/page.tsx": [
    ["downloadPdf", "`purchase-order-${po.ref}.pdf`", '{ entityTable: "purchase_orders", entityId: po.ref }'],
    ["exportSpreadsheet", '"csv"', '"Purchase Orders"', '"purchase_orders"'],
    ["exportSpreadsheet", '"xlsx"', '"Purchase Orders"', '"purchase_orders"'],
  ],
  "app/(dashboard)/jobs/page.tsx": [
    ["exportSpreadsheet", '"csv"', '"Jobs"', '"jobs"'],
    ["exportSpreadsheet", '"xlsx"', '"Jobs"', '"jobs"'],
    ["exportRows", '"word"', "EXPORT_TITLES.jobs", '"jobs"'],
    ["exportRows", '"pdf"', "EXPORT_TITLES.jobs", '"jobs"'],
  ],
  "app/(dashboard)/customers/page.tsx": [
    ["exportSpreadsheet", '"csv"', '"Customers"', '"customers"'],
    ["exportSpreadsheet", '"xlsx"', '"Customers"', '"customers"'],
  ],
  "app/(dashboard)/suppliers/page.tsx": [
    ["exportSpreadsheet", '"csv"', '"Suppliers"', '"suppliers"'],
    ["exportSpreadsheet", '"xlsx"', '"Suppliers"', '"suppliers"'],
  ],
  // /time/week renders <WeekReview />; its export is here. The weekly hours are not an audited record type (no table argument).
  "components/time/week-review.tsx": [
    ["exportSpreadsheet", "format", "`Weekly Hours ${week}`", null],
  ],
};

function entryPointCalls(source: string): Call[] {
  const file = ts.createSourceFile("page.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calls: Call[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const a = node.arguments;
      const name = node.expression.text;
      if (name === "downloadPdf") calls.push(["downloadPdf", a[1].getText(), a[2].getText()]);
      if (name === "exportRows") calls.push(["exportRows", a[0].getText(), a[1].getText(), a[3]?.getText() ?? null]);
      if (name === "exportSpreadsheet") calls.push(["exportSpreadsheet", a[0].getText(), a[1].getText(), a[4]?.getText() ?? null]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

describe("each page's PDF and export calls name the file and the audit entry as at 1939755", () => {
  for (const [file, before] of Object.entries(BEFORE)) {
    it(file, () => expect(entryPointCalls(read(file))).toEqual(before));
  }

  it("the names those calls use are unchanged: the quote file name and the export titles", async () => {
    expect(read("app/(dashboard)/quotes/page.tsx")).toContain("const pdfName = (quote: QuoteRow) => `quote-${quote.ref.replace(/\\s+/g, \"-\")}.pdf`;");
    const { EXPORT_TITLES } = await import("@/lib/export-records");
    expect(EXPORT_TITLES).toEqual({ quotes: "Quotes Export", invoices: "Invoices Export", jobs: "Job Board Export" });
  });

  it("the nine list pages (the walker covers /time/week through <WeekReview />)", () => {
    expect(read("app/(dashboard)/time/week/page.tsx")).toMatch(/import \{ WeekReview \} from "@\/components\/time\/week-review"/);
  });
});

// ---- 2. the lazily loaded document is the one 1939755 imported up front ------------------------------------------------------
/** At 1939755 each of these files had `import { <Doc> } from "@/components/pdf/<Doc>"`; now the builder imports it on the press. */
const DOCUMENTS: Record<string, string> = {
  "app/(dashboard)/quotes/page.tsx": "QuotePDF",
  "app/(dashboard)/invoices/page.tsx": "InvoicePDF",
  "components/credit-notes-panel.tsx": "CreditNotePDF",
  "app/(dashboard)/sales-orders/page.tsx": "SalesOrderPDF",
  "app/(dashboard)/delivery-notes/page.tsx": "DeliveryNotePDF",
  "app/(dashboard)/purchase-orders/page.tsx": "PurchaseOrderPDF",
};

describe("each PDF builder loads the same document component on the press", () => {
  for (const [file, doc] of Object.entries(DOCUMENTS)) {
    it(`${file}: ${doc}`, async () => {
      const source = read(file);
      expect(source).not.toMatch(new RegExp(`^import \\{[^}]*\\b${doc}\\b[^}]*\\} from`, "m"));
      expect(source).toContain(`const { ${doc} } = await import("@/components/pdf/${doc}");`);
      expect(source).toContain(`<${doc}`);
      const mod = (await import(`@/components/pdf/${doc}.tsx`)) as Record<string, unknown>;
      expect(typeof mod[doc]).toBe("function");
    });
  }
});

// ---- 3. the shared helpers, run with each entry point's arguments -------------------------------------------------------------
describe("downloadPdf with a lazy builder (quotes, invoices, credit notes, sales orders, delivery notes, purchase orders)", () => {
  // The file name and audit entry each page passes (BEFORE above), with a sample reference.
  const cases = [
    { doc: "QuotePDF", filename: "quote-Q-0001.pdf", entityTable: "quotes", entityId: "Q-0001" },
    { doc: "InvoicePDF", filename: "invoice-INV-0001.pdf", entityTable: "invoices", entityId: "INV-0001" },
    { doc: "CreditNotePDF", filename: "credit-note-CN-0001.pdf", entityTable: "invoices", entityId: "CN-0001" },
    { doc: "SalesOrderPDF", filename: "sales-order-SO-0001.pdf", entityTable: "sales_orders", entityId: "SO-0001" },
    { doc: "DeliveryNotePDF", filename: "delivery-note-DN-0001.pdf", entityTable: "delivery_notes", entityId: "DN-0001" },
    { doc: "PurchaseOrderPDF", filename: "purchase-order-PO-0001.pdf", entityTable: "purchase_orders", entityId: "PO-0001" },
  ] as const;

  for (const c of cases) {
    it(`${c.doc}: saved as ${c.filename}, audited DOWNLOAD_PDF on ${c.entityTable}`, async () => {
      const { downloadPdf } = await import("@/lib/download-pdf");
      const data = { marker: c.doc };
      const ok = await downloadPdf(async () => {
        const mod = (await import(`@/components/pdf/${c.doc}.tsx`)) as Record<string, (props: { data: unknown }) => null>;
        return createElement(mod[c.doc], { data });
      }, c.filename, { entityTable: c.entityTable, entityId: c.entityId });
      expect(ok).toBe(true);
      expect(downloads).toEqual([c.filename]);
      expect(hoisted.rendered).toHaveLength(1);
      expect((hoisted.rendered[0] as { props: { data: unknown } }).props.data).toBe(data);
      expect(audit.events).toEqual([{ action: "DOWNLOAD_PDF", entityTable: c.entityTable, entityId: c.entityId, metadata: { filename: c.filename } }]);
    });
  }
});

describe("exportRows (the Word / PDF export on quotes, invoices and jobs)", () => {
  for (const [key, table] of [["quotes", "quotes"], ["invoices", "invoices"], ["jobs", "jobs"]] as const) {
    it(`${key}: PDF saved as <title>.pdf with one EXPORT audit entry`, async () => {
      const { exportRows, EXPORT_TITLES } = await import("@/lib/export-records");
      const title = EXPORT_TITLES[key];
      await exportRows("pdf", title, [{ Ref: "R-1", Customer: "Synthetic Customer Ltd" }], table);
      expect(downloads).toEqual([`${title}.pdf`]);
      expect(hoisted.rendered).toHaveLength(1);
      expect(audit.events).toEqual([{ action: "EXPORT", entityTable: table, metadata: { title, format: "pdf", row_count: 1, columns: ["Ref", "Customer"] } }]);
    });
  }
});

describe("exportSpreadsheet (CSV on quotes, invoices, sales orders, purchase orders, jobs, customers, suppliers, weekly hours)", () => {
  const columns: SheetColumn<{ name: string }>[] = [{ header: "Name", type: "text", value: (row) => row.name }];
  for (const [base, table] of [["Quotes", "quotes"], ["Invoices", "invoices"], ["Invoice Payments", "invoices"], ["Sales Orders", "sales_orders"], ["Purchase Orders", "purchase_orders"], ["Jobs", "jobs"], ["Customers", "customers"], ["Suppliers", "suppliers"], ["Weekly Hours 2026-10-26", undefined]] as const) {
    it(`${base}: saved as ${base}-<date>.csv${table ? `, audited EXPORT on ${table}` : ", no audit entry"}; the PDF renderer is not used`, async () => {
      const { exportSpreadsheet } = await import("@/lib/export-records");
      const { toDateInput } = await import("@/lib/dates");
      await exportSpreadsheet("csv", base, columns, [{ name: "Synthetic" }], table);
      expect(downloads).toEqual([`${base}-${toDateInput(new Date())}.csv`]);
      expect(hoisted.rendered).toHaveLength(0);
      expect(audit.events).toEqual(table ? [{ action: "EXPORT", entityTable: table, metadata: { title: base, format: "csv", row_count: 1, columns: ["Name"] } }] : []);
    });
  }
});
