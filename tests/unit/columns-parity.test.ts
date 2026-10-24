/**
 * Columns drift guard (Rhys, 22/23 Oct): every list page with a view toggle shows the SAME columns in the SAME order in Cards, List and
 * Table. COLUMN_TABLES (lib/org-settings, the Columns picker's list) is the one definition per page; each page's header row and body
 * cells must walk it in order, nothing may be hidden by view (no data-secondary), and the Job Board's three views share
 * JOB_TABLE_COLUMNS (lib/job-board-files). A page that adds, drops or reorders a column in one place fails here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: null }));

import { IMPORT_COLUMNS } from "@/lib/import-columns";
import { JOB_TABLE_COLUMNS } from "@/lib/job-board-files";
import { COLUMN_TABLES } from "@/lib/org-settings";

const read = (name: string) => readFileSync(path.resolve(__dirname, `../../app/(dashboard)/${name}/page.tsx`), "utf8");
const keysIn = (source: string) => [...source.matchAll(/isVisible\("([a-z-]+)"\)/g)].map((match) => match[1]);
const unique = (keys: string[]) => keys.filter((key, i) => keys.indexOf(key) === i);
const pickerKeys = (table: string) => COLUMN_TABLES.find((def) => def.key === table)!.columns.map((column) => column.key);

/** One responsive <Table data-view={view}>: Cards, List and Table are the same markup, so one header row and one body row define all three. */
const TABLE_PAGES = ["sales-orders", "invoices", "purchase-orders", "customers", "suppliers", "delivery-notes"];

describe("columns parity: one column list per page, in every view", () => {
  for (const page of TABLE_PAGES) {
    it(`${page}: header and cells walk the Columns picker's list in order; one table drives Cards, List and Table`, () => {
      const source = read(page);
      const start = source.indexOf("<Table data-view={view}");
      expect(start, `${page} renders <Table data-view={view}>`).toBeGreaterThan(-1);
      const headEnd = source.indexOf("</TableHeader>", start);
      const bodyEnd = source.indexOf("</TableBody>", headEnd);
      const picker = pickerKeys(page);
      expect(unique(keysIn(source.slice(start, headEnd)))).toEqual(picker);
      expect(unique(keysIn(source.slice(headEnd, bodyEnd)))).toEqual(picker);
      expect(source).toContain("<ViewSwitcher");
      expect(source).toContain(`<ColumnToggle tableKey="${page}"`);
      expect(source, "no column may be hidden in one view only").not.toMatch(/data-secondary|data-tablet-cards/);
    });
  }

  it("quotes: the table (List and Table) walks the picker's list in order and the Cards show Date and Description", () => {
    const source = read("quotes");
    const start = source.indexOf('aria-label="Quotes"');
    const headEnd = source.indexOf("</TableHeader>", start);
    const bodyEnd = source.indexOf("</TableBody>", headEnd);
    const picker = pickerKeys("quotes");
    expect(unique(keysIn(source.slice(start, headEnd)))).toEqual(picker);
    expect(unique(keysIn(source.slice(headEnd, bodyEnd)))).toEqual(picker);
    expect(source.slice(start, bodyEnd), "List and Table are not told apart").not.toMatch(/view === "table" &&/);
    const cards = source.slice(source.indexOf("grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"));
    expect(cards).toContain('isVisible("date")');
    expect(cards).toContain('isVisible("description")');
  });

  /**
   * Exports keep the import spec (CSV / Excel are the data-import round trip), so they are not rebuilt from the views. Instead every
   * display column of a page that has an export must map to a column the export already carries: the views never show a field the
   * export lacks. Job Board: the columns with no export counterpart are listed here on purpose; changing that list is a decision.
   */
  const EXPORT_FOR: Record<string, { sheet: keyof typeof IMPORT_COLUMNS; map: Record<string, string> }> = {
    quotes: { sheet: "quotes", map: { ref: "quote_ref", date: "quote_date", customer: "customer", description: "description", status: "status", value: "total", valid: "valid_until" } },
    "sales-orders": { sheet: "sales_orders", map: { ref: "ref", customer: "customer", date: "order_date", delivery: "delivery_date", value: "net", status: "status" } },
    "purchase-orders": { sheet: "purchase_orders", map: { ref: "po_ref", supplier: "supplier", date: "order_date", delivery: "expected_delivery", value: "net", status: "status" } },
    invoices: { sheet: "invoices", map: { invoice: "reference", customer: "customer", status: "status", amount: "total" } },
    customers: { sheet: "customers", map: { name: "name", contact: "contact_name", email: "email", phone: "phone", address: "address" } },
    suppliers: { sheet: "suppliers", map: { name: "name", contact: "contact_name", email: "email", phone: "phone", notes: "notes", status: "reliability_status" } },
  };
  for (const [page, { sheet, map }] of Object.entries(EXPORT_FOR)) {
    it(`${page}: every display column maps to a column its export already carries`, () => {
      const carried = new Set(IMPORT_COLUMNS[sheet].map((column) => column.key));
      expect(Object.keys(map)).toEqual(pickerKeys(page));
      for (const [display, exported] of Object.entries(map)) expect(carried.has(exported), `${page}: ${display} -> ${exported}`).toBe(true);
    });
  }

  it("jobs: the display columns with no export counterpart are exactly the known list", () => {
    const carried = new Set(IMPORT_COLUMNS.jobs.map((column) => column.header));
    const labels = JOB_TABLE_COLUMNS.map((column) => column.label);
    const missing = labels.filter((label) => label !== "Actions" && !carried.has(label) && !(label === "Due" && carried.has("Date Required")) && !(label === "Inspection" && carried.has("Inspected")));
    expect(missing).toEqual(["Specification", "Drawings", "Attachments", "Machine", "Operator"]);
  });

  /** Astra's rulings (Rhys relay 23 Oct 13:45), pinned literally. Every view, the shared definition and the picker must read exactly these. */
  const QUOTE_ORDER = ["Quote", "Date", "Customer", "Description", "Status", "Value", "Valid until", "Actions"];
  const JOB_ORDER = ["Job No", "Customer", "Description", "Specification", "Drawings", "Attachments", "Stage", "Machine", "Operator", "Due", "Started", "Finished", "Inspection", "Actions"];
  const headLabels = (source: string) => [...source.matchAll(/<TableHead[^>]*>(?:<span[^>]*>)?([A-Za-z /]+?)(?:<\/span>)?<\/TableHead>/g)].map((match) => match[1]);
  const captions = (source: string) => [...source.matchAll(/<dt className="label-mono field-caption">([A-Za-z /]+)<\/dt>/g)].map((match) => match[1]);

  it("quotes: Quote, Date, Customer, Description, Status, Value, Valid until, Actions in the picker, the table (List and Table) and the Cards", () => {
    const source = read("quotes");
    expect([...COLUMN_TABLES.find((def) => def.key === "quotes")!.columns.map((column) => column.label), "Actions"]).toEqual(QUOTE_ORDER);
    const start = source.indexOf('aria-label="Quotes"');
    expect(headLabels(source.slice(start, source.indexOf("</TableHeader>", start)))).toEqual(QUOTE_ORDER);
    const cards = source.slice(source.indexOf("grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"));
    expect(captions(cards.slice(0, cards.indexOf("</dl>")))).toEqual(QUOTE_ORDER.slice(1, 7));
    expect(source.slice(start, source.indexOf("</TableHeader>", start))).not.toContain("max-desk:hidden");
  });

  it("jobs: Job No ... Inspection, Actions in the shared list, the Table, the List and the Cards (Status folded into the Due cell)", () => {
    const source = read("jobs");
    expect(JOB_TABLE_COLUMNS.map((column) => column.label)).toEqual(JOB_ORDER);
    // Table and List both render their headings from the one shared list (filtered by the Columns picker), nothing hard-coded.
    expect(source).toContain("jobColumns.map((column) => <TableHead");
    const list = source.slice(source.indexOf('aria-label="Jobs"'));
    const listHead = list.slice(0, list.indexOf("</TableHeader>"));
    expect(listHead).toContain("{jobColumns.map((column) => column.key === \"actions\"");
    expect(headLabels(listHead).filter((label) => label !== "Details" && label !== "Actions")).toEqual([]);
    const card = source.slice(source.indexOf("const jobCard"));
    expect(captions(card.slice(0, card.indexOf("</dl>"))).filter((label) => label !== "Rework")).toEqual(JOB_ORDER.slice(1, 13));
    // Status is not a column anywhere: the List and Table render the badges inside the Due cell.
    expect(source).not.toMatch(/<TableHead[^>]*>Status<\/TableHead>/);
  });

  it("quotes: the Cards title is gated by the Quote column, which is locked on so the title is always shown", () => {
    expect(COLUMN_TABLES.find((def) => def.key === "quotes")!.columns.find((column) => column.key === "ref")?.locked).toBe(true);
    const source = read("quotes");
    const cards = source.slice(source.indexOf("grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"));
    expect(cards).toContain('{isVisible("ref") ? <CardHeader><CardTitle');
  });
});
