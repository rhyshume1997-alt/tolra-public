/**
 * Admin > Data: reading an upload (lib/import-file.ts): a .csv, and an .xlsx through read-excel-file (never the npm `xlsx` package).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { zipSync } from "fflate";

import { ImportFileError, MAX_IMPORT_ROWS, checkRowLimits, parseCsv, readImportFile, sheetFromRows, unpackedSize } from "@/lib/import-file";
import { buildImport } from "@/lib/import-build";
import { planSheet } from "@/lib/import-detect";
import { workbookBytes } from "../support/workbook";

describe("parseCsv", () => {
  it("RFC 4180: quotes, doubled quotes, line breaks in a field, a BOM, CRLF", () => {
    expect(parseCsv('﻿Name,Notes\r\n"Acme, Ltd","say ""hi""\nnext"\r\nB,\r\n')).toEqual([["Name", "Notes"], ["Acme, Ltd", 'say "hi"\nnext'], ["B", ""]]);
  });
  it("reads a semicolon file when the first line has no comma", () => {
    expect(parseCsv("a;b\n1;2")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("the header row", () => {
  it("up to five title or blank rows above it are skipped: the first row that scores as a header", () => {
    const parsed = sheetFromRows("S", [
      ["Marpet customers, October 2026", null, null],
      [null, null, null],
      ["Printed by the office", null, null],
      ["Name", "Contact", "Email"],
      ["Acme", "Pat", "a@x"],
    ])!;
    expect(parsed.headers).toEqual(["Name", "Contact", "Email"]);
    expect(parsed.rows).toEqual([["Acme", "Pat", "a@x"]]);
    expect(parsed.rowNumbers).toEqual([5]);
  });

  it("a title row that happens to say one known word is not the header", () => {
    const parsed = sheetFromRows("S", [["Customers", null], ["Name", "Email"], ["A", "a@x"]])!;
    expect(parsed.headers).toEqual(["Name", "Email"]);
  });

  it("a header more than five rows down is not looked for: the first filled row is the header, as before", () => {
    const rows = [...Array.from({ length: 6 }, (_, i) => [`Title ${i}`, null]), ["Name", "Email"], ["A", "a@x"]];
    expect(sheetFromRows("S", rows)!.headers).toEqual(["Title 0", ""]);
  });

  it("a sheet with no recognisable header keeps its first filled row as the header", () => {
    expect(sheetFromRows("S", [["Colour", "Weight"], ["red", 3]])!.headers).toEqual(["Colour", "Weight"]);
  });
});

describe("limits", () => {
  it("a sheet or the whole file over 25,000 rows is refused early, saying why", () => {
    const rows = (n: number) => Array.from({ length: n }, () => [null]);
    expect(() => checkRowLimits([{ name: "A", rows: rows(MAX_IMPORT_ROWS) }])).not.toThrow();
    expect(() => checkRowLimits([{ name: "Big", rows: rows(MAX_IMPORT_ROWS + 1) }])).toThrow(/sheet "Big" has 25,001 rows.*at most 25,000/);
    expect(() => checkRowLimits([{ name: "A", rows: rows(15_000) }, { name: "B", rows: rows(15_000) }])).toThrow(/30,000 rows in all/);
  });

  it("an .xlsx's unpacked size is read from the zip directory without unpacking it", async () => {
    const zip = zipSync({ "a.txt": new Uint8Array(1000), "b.txt": new Uint8Array(2500) });
    expect((await unpackedSize(zip.buffer as ArrayBuffer))).toBe(3500);
    expect(await unpackedSize(new TextEncoder().encode("not a zip").buffer as ArrayBuffer)).toBeNull();
  });

  it("a workbook that unpacks to over 100 MB is refused before it is parsed", async () => {
    const zip = zipSync({ "xl/worksheets/sheet1.xml": new Uint8Array(101 * 1024 * 1024) }, { level: 1 });
    await expect(readImportFile(new File([zip as unknown as BlobPart], "bomb.xlsx"))).rejects.toThrow(/over 100 MB/);
  });
});

describe("sheetFromRows", () => {
  it("the first filled row is the header; rows keep the file's own numbers; blank rows are skipped", () => {
    const parsed = sheetFromRows("S", [[null, null], ["Name", "Email"], ["A", "a@x"], ["", ""], ["B", null]])!;
    expect(parsed.headers).toEqual(["Name", "Email"]);
    expect(parsed.rowNumbers).toEqual([3, 5]);
    expect(parsed.rows[1]).toEqual(["B", null]);
  });
  it("an empty sheet is nothing", () => {
    expect(sheetFromRows("S", [[null], [""]])).toBeNull();
  });
});

function fileOf(name: string, data: BlobPart) {
  return new File([data], name);
}

describe("readImportFile", () => {
  it("a workbook with several sheets: one plan each, dates and numbers kept as they are", async () => {
    const bytes = workbookBytes([
      { name: "Customers", rows: [["Name", "Contact"], ["Acme Ltd", "Pat"]] },
      { name: "Invoices", rows: [["Invoice No", "Customer", "Invoice Date", "Total"], ["INV-1", "Acme Ltd", "2026-10-01", 120.5]] },
    ]);
    const file = await readImportFile(fileOf("data.xlsx", bytes as unknown as BlobPart));
    expect(file.sheets.map((s) => s.name)).toEqual(["Customers", "Invoices"]);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.sheets[1].rows).toEqual([["INV-1", "Acme Ltd", "2026-10-01", 120.5]]);
    const plans = (await Promise.all(file.sheets.map((s) => planSheet(s, [])))).flat();
    const built = buildImport(plans, { name: file.name, sha256: file.sha256 });
    expect(built.payload.invoices).toEqual([{ row: 2, invoice_ref: "INV-1", customer: "Acme Ltd", invoice_date: "2026-10-01", total: "120.5" }]);
  });

  it("our own export (lib/spreadsheet.ts toXlsx) is read back", async () => {
    const { toXlsx } = await import("@/lib/spreadsheet");
    const bytes = await toXlsx("Customers", [{ header: "Name", type: "text", value: (r: { n: string }) => r.n }, { header: "Contact", type: "text", value: () => "Pat" }], [{ n: "Acme Ltd" }]);
    const file = await readImportFile(fileOf("Customers-2026-10-19.xlsx", bytes as unknown as BlobPart));
    expect(file.sheets[0].headers).toEqual(["Name", "Contact"]);
    expect(file.sheets[0].rows).toEqual([["Acme Ltd", "Pat"]]);
  });

  it("a csv is one sheet named from the file", async () => {
    const file = await readImportFile(fileOf("Invoices.csv", "Invoice No,Total\r\nINV-1,10\r\n"));
    expect(file.sheets).toHaveLength(1);
    expect(file.sheets[0]).toMatchObject({ name: "Invoices", headers: ["Invoice No", "Total"], rows: [["INV-1", "10"]], rowNumbers: [2] });
  });

  it("refuses other files with a message the admin can act on", async () => {
    await expect(readImportFile(fileOf("old.xls", "x"))).rejects.toThrow(/save it as \.xlsx/i);
    await expect(readImportFile(fileOf("notes.txt", "x"))).rejects.toThrow(ImportFileError);
    await expect(readImportFile(fileOf("empty.csv", ""))).rejects.toThrow(/nothing in that file/);
    await expect(readImportFile(fileOf("broken.xlsx", "not a zip"))).rejects.toThrow(/can't be read as an Excel workbook/);
  });
});

describe("the xlsx reader is read-excel-file, never the npm xlsx package", () => {
  it("package.json depends on read-excel-file and not on xlsx", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(all["read-excel-file"]).toBeDefined();
    expect(all.xlsx).toBeUndefined();
  });
});
