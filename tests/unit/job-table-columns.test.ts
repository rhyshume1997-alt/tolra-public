import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({ supabase: null }));

import { JOB_TABLE_COLUMNS, shownJobColumns } from "@/lib/job-board-files";
import { COLUMN_TABLES } from "@/lib/org-settings";

/** Astra's ruling (Rhys relay 23 Oct), pinned literally. */
const JOB_COLUMN_ORDER = ["Job No", "Customer", "Description", "Specification", "Drawings", "Attachments", "Stage", "Machine", "Operator", "Due", "Started", "Finished", "Inspection", "Actions"];

const page = readFileSync(path.resolve(__dirname, "../../app/(dashboard)/jobs/page.tsx"), "utf8");

describe("Job Board table columns", () => {
  it("is Astra's exact order, ending Inspection, Actions (Status has no column: its badges sit in the Due cell)", () => {
    const labels = JOB_TABLE_COLUMNS.map((column) => column.label);
    expect(labels).toEqual(JOB_COLUMN_ORDER);
  });

  it("the table renders its headings (Actions included) from that list, filtered by the Columns picker", () => {
    expect(page).toContain("shownJobColumns(columnOn)");
    expect(page).toContain("{jobColumns.map((column) => <TableHead key={column.key} className={column.width}>{column.label}</TableHead>)}");
    expect(page).not.toMatch(/<TableHead[^>]*>Actions<\/TableHead>\s*<\/TableRow>[\s\S]{0,40}<TableBody>[\s\S]{0,200}JOB_TABLE_COLUMNS/);
    expect(page).not.toContain("title={job.specification}");
  });

  it("group rows span every shown column (Table: columns + select; List: columns + select + details)", () => {
    expect(page).toContain("colSpan={jobColumns.length + 1}>");
    expect(page).toContain("colSpan={jobColumns.length + 2}>");
    expect(page).not.toMatch(/colSpan=\{1[0-9]\}/);
  });

  it("Table and List rows render one cell per shown column, from cell maps keyed like the shared list", () => {
    const keys = JOB_TABLE_COLUMNS.map((column) => column.key);
    for (const name of ["tableCellsFor", "listCellsFor"]) {
      const start = page.indexOf(`const ${name} = `);
      const block = page.slice(start, page.indexOf("\n  });\n", start));
      expect([...block.matchAll(/^    ([a-z]+): \($/gm)].map((match) => match[1]), name).toEqual(keys);
    }
    expect(page).toContain("jobColumns.map((column) => <Fragment key={column.key}>{cells[column.key]}</Fragment>))(tableCellsFor(job))");
    expect(page).toContain("jobColumns.map((column) => <Fragment key={column.key}>{listCells[column.key]}</Fragment>)");
  });

  it("the Columns picker lists the same columns in the same order; Job No and Actions are locked on", () => {
    const picker = COLUMN_TABLES.find((table) => table.key === "jobs")!;
    expect(picker.columns.map((column) => column.label)).toEqual(JOB_COLUMN_ORDER);
    expect(picker.columns.filter((column) => column.locked).map((column) => column.label)).toEqual(["Job No", "Due", "Actions"]);
    expect(page).toContain('<ColumnToggle tableKey="jobs" />');
  });

  it("unticking hides only those columns, keeps the order, and never hides Job No or Actions", () => {
    const off = new Set(["started", "finished", "ref", "actions", "specification"]);
    expect(shownJobColumns((key) => !off.has(key)).map((column) => column.label)).toEqual(JOB_COLUMN_ORDER.filter((label) => !["Started", "Finished", "Specification"].includes(label)));
    expect(shownJobColumns(() => true).map((column) => column.label)).toEqual(JOB_COLUMN_ORDER);
    expect(shownJobColumns(() => false).map((column) => column.label)).toEqual(["Job No", "Due", "Actions"]);
  });
});
