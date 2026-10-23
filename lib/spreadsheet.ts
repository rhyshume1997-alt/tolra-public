/**
 * Spreadsheet files from a column spec and rows: CSV (RFC 4180) and a minimal Excel workbook (.xlsx).
 *
 * The .xlsx is hand-built Office Open XML zipped with fflate (already in the app for the year-end export). The npm
 * `xlsx` / SheetJS package is deliberately not used: it has unpatched vulnerabilities.
 *
 * Column types (lib/import-columns.ts says what each export column holds):
 *   text   written as it is. In a CSV, text starting = + - @ tab or CR gets a leading apostrophe so Excel and Sheets
 *          never run it as a formula (the same guard as lib/html.ts). In an .xlsx it is an inline string, which is
 *          never a formula, so it is left exactly as it is.
 *   number a plain number.
 *   money  pounds, written to 2 decimal places ("12.50"). In an .xlsx a real number shown as 0.00.
 *   date   YYYY-MM-DD text (ISO), never a locale date, so it reads the same everywhere.
 */

export type SheetColumnType = "text" | "number" | "money" | "date";

export type SheetColumn<R> = {
  header: string;
  type: SheetColumnType;
  /** The cell's value. null / undefined / "" is an empty cell. */
  value: (row: R) => string | number | null | undefined;
};

type Cell = { kind: "text"; text: string } | { kind: "number"; number: number; text: string };

/** One cell, normalised: empty, text, or a finite number (money rounded to 2 dp). */
function cellOf<R>(column: SheetColumn<R>, row: R): Cell | null {
  const raw = column.value(row);
  if (raw === null || raw === undefined || raw === "") return null;
  if (column.type === "number" || column.type === "money") {
    const n = typeof raw === "number" ? raw : Number(raw);
    // A value that isn't a number is kept as text rather than lost.
    if (!Number.isFinite(n)) return { kind: "text", text: String(raw) };
    if (column.type === "money") {
      const pounds = Math.round(n * 100) / 100;
      return { kind: "number", number: pounds, text: pounds.toFixed(2) };
    }
    return { kind: "number", number: n, text: String(n) };
  }
  return { kind: "text", text: String(raw) };
}

/** A well-formed plain number ("12", "-12.50"): safe in a spreadsheet, so a negative amount is not mistaken for a formula. */
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

function csvCellText(cell: Cell | null): string {
  if (!cell) return "";
  let text = cell.text;
  if (cell.kind === "text" && !PLAIN_NUMBER.test(text) && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const BOM = "﻿";

/** RFC 4180: comma separated, CRLF line ends, fields with a comma, quote or line break quoted. UTF-8 with a BOM so Excel reads it as UTF-8. */
export function toCsv<R>(columns: SheetColumn<R>[], rows: R[]): string {
  const header = columns.map((column) => csvCellText({ kind: "text", text: column.header }));
  const lines = rows.map((row) => columns.map((column) => csvCellText(cellOf(column, row))).join(","));
  return `${BOM}${[header.join(","), ...lines].join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------------------------------------------------
// .xlsx

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Escape for XML text, dropping characters XML 1.0 can't hold (they would make Excel report a corrupt file). */
function xml(value: string): string {
  return value
    .replace(/[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
function columnLetters(index: number): string {
  let n = index + 1;
  let letters = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/** Excel sheet names: at most 31 characters, none of [ ] : * ? / \ , not empty. */
function safeSheetName(name: string): string {
  return name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet1";
}

// Style ids in styles.xml below: 0 normal, 1 bold header, 2 money (0.00).
const STYLE_HEADER = 1;
const STYLE_MONEY = 2;

const STYLES_XML = `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

function inlineString(ref: string, text: string, style = 0): string {
  const space = text !== text.trim() || /[\r\n]/.test(text) ? ' xml:space="preserve"' : "";
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ""}><is><t${space}>${xml(text)}</t></is></c>`;
}

function sheetXml<R>(columns: SheetColumn<R>[], rows: R[]): string {
  const lastCol = columnLetters(Math.max(columns.length, 1) - 1);
  const widths = columns.map((column) => {
    const longest = Math.max(column.header.length, ...rows.slice(0, 200).map((row) => cellOf(column, row)?.text.length ?? 0));
    return Math.min(Math.max(longest + 2, 10), 50);
  });
  const header = `<row r="1">${columns.map((column, c) => inlineString(`${columnLetters(c)}1`, column.header, STYLE_HEADER)).join("")}</row>`;
  const body = rows.map((row, r) => {
    const cells = columns.map((column, c) => {
      const cell = cellOf(column, row);
      if (!cell) return "";
      const ref = `${columnLetters(c)}${r + 2}`;
      if (cell.kind === "number") return `<c r="${ref}"${column.type === "money" ? ` s="${STYLE_MONEY}"` : ""}><v>${cell.number}</v></c>`;
      return inlineString(ref, cell.text);
    }).join("");
    return `<row r="${r + 2}">${cells}</row>`;
  }).join("");
  return `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastCol}${rows.length + 1}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join("")}</cols><sheetData>${header}${body}</sheetData></worksheet>`;
}

/**
 * A one-sheet Excel workbook: bold, frozen header row; text as inline strings, numbers as numbers (money shown 0.00),
 * dates as ISO text. Opens in Excel and LibreOffice. fflate is imported on demand so it stays out of the page bundle.
 */
export async function toXlsx<R>(sheetName: string, columns: SheetColumn<R>[], rows: R[]): Promise<Uint8Array> {
  const { strToU8, zipSync } = await import("fflate");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(`${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    "_rels/.rels": strToU8(`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(safeSheetName(sheetName))}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(STYLES_XML),
    "xl/worksheets/sheet1.xml": strToU8(sheetXml(columns, rows)),
  };
  return zipSync(files);
}

// ---------------------------------------------------------------------------------------------------------------------
// Download

export const CSV_TYPE = "text/csv;charset=utf-8";
export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Saves data as a file download (browser only). */
export function downloadFile(filename: string, data: BlobPart, type: string) {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** The button title that says what an export covers: the selected rows if any, otherwise every row in the current filter. */
export function exportScopeTitle(noun: string, selected: number, inFilter: number): string {
  const plural = (n: number) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  return selected > 0 ? `Exports the ${plural(selected)} selected` : `Exports all ${plural(inFilter)} in the current filter (nothing is selected)`;
}

/** The button title for a list with no selection or filter: it exports every record. */
export function exportAllTitle(noun: string, count: number): string {
  return `Exports all ${count} ${noun}${count === 1 ? "" : "s"}`;
}
