/**
 * Admin > Data: read one upload, an .xlsx workbook or a .csv file, into sheets of rows. Nothing is interpreted here.
 *
 * .xlsx is read with `read-excel-file` (never the npm `xlsx` package, which has unpatched vulnerabilities). Its "universal" build runs on
 * the page itself: the browser build starts a Web Worker from a blob, which the app's Content-Security-Policy (worker-src 'self') refuses.
 */
import { type Cell, type ParsedSheet, headerScore } from "@/lib/import-detect";

export const MAX_IMPORT_BYTES = 15 * 1024 * 1024;
/** The database takes at most 25,000 records (and 50,000 lines) in one import (076): a bigger file is refused here, before anything is sent. */
export const MAX_IMPORT_ROWS = 25_000;
/** What an .xlsx may unpack to: a small file can be a zip bomb, so the sizes in its directory are read first. */
export const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
/** Title or blank rows allowed above the header row. */
export const MAX_ROWS_ABOVE_HEADER = 5;

export class ImportFileError extends Error {}

/** RFC 4180: quoted fields, doubled quotes, line breaks inside quotes, comma separated (a semicolon when the first line has no comma). */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? "";
  const sep = !firstLine.includes(",") && firstLine.includes(";") ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === sep) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * The header row: among the first rows (a few title or blank rows may sit above it) the first that scores as a header, two or more cells
 * that are words a kind knows (lib/import-detect headerScore); with none, the first filled row. The rows after it keep their place in the
 * file (row 1 is the first line).
 */
export function sheetFromRows(name: string, data: Cell[][]): ParsedSheet | null {
  const empty = (row: Cell[]) => row.every((c) => c === null || c === undefined || String(c).trim() === "");
  const firstFilled = data.findIndex((row) => !empty(row));
  if (firstFilled < 0) return null;
  let headerAt = firstFilled;
  for (let i = 0; i <= MAX_ROWS_ABOVE_HEADER && i < data.length; i += 1) {
    if (!empty(data[i]) && headerScore(data[i]) >= 2) { headerAt = i; break; }
  }
  const headers = data[headerAt].map((h) => (h === null || h === undefined ? "" : String(h).trim()));
  const rows: Cell[][] = [];
  const rowNumbers: number[] = [];
  for (let i = headerAt + 1; i < data.length; i += 1) {
    if (empty(data[i])) continue;
    rows.push(headers.map((_, c) => data[i][c] ?? null));
    rowNumbers.push(i + 1);
  }
  return { name, headers, rows, rowNumbers };
}

/** Refuses a file with too many rows, in one sheet or all together, with the reason. */
export function checkRowLimits(sheets: Pick<ParsedSheet, "name" | "rows">[]): void {
  let total = 0;
  for (const sheet of sheets) {
    if (sheet.rows.length > MAX_IMPORT_ROWS) {
      throw new ImportFileError(`The sheet "${sheet.name}" has ${sheet.rows.length.toLocaleString("en-GB")} rows. One import takes at most ${MAX_IMPORT_ROWS.toLocaleString("en-GB")}: split the file and import it in pieces.`);
    }
    total += sheet.rows.length;
  }
  if (total > MAX_IMPORT_ROWS) {
    throw new ImportFileError(`The file has ${total.toLocaleString("en-GB")} rows in all. One import takes at most ${MAX_IMPORT_ROWS.toLocaleString("en-GB")}: split the file and import it in pieces.`);
  }
}

/** What the .xlsx would unpack to, from the sizes in its zip directory (nothing is unpacked), or null when it is not a readable zip. */
export async function unpackedSize(bytes: ArrayBuffer): Promise<number | null> {
  try {
    const { unzipSync } = await import("fflate");
    let total = 0;
    unzipSync(new Uint8Array(bytes), { filter: (entry) => { total += entry.originalSize; return false; } });
    return total;
  } catch {
    return null;
  }
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function decodeCsv(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // A CSV saved by Excel in the old Windows code page.
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export type ReadFile = { name: string; sha256: string; sheets: ParsedSheet[] };

/** One upload: its name, its SHA-256 (the database records it) and its sheets. Throws ImportFileError with a message for the admin. */
export async function readImportFile(file: File): Promise<ReadFile> {
  if (file.size > MAX_IMPORT_BYTES) throw new ImportFileError("That file is over 15 MB. Split it, or leave out columns Tolra doesn't need.");
  const lower = file.name.toLowerCase();
  const bytes = await file.arrayBuffer();
  const sha256 = await sha256Hex(bytes);
  const base = file.name.replace(/\.[^.]+$/, "") || "Sheet1";
  const sheets: ParsedSheet[] = [];
  if (lower.endsWith(".csv")) {
    const sheet = sheetFromRows(base, parseCsv(decodeCsv(bytes)));
    if (sheet) sheets.push(sheet);
  } else if (lower.endsWith(".xlsx")) {
    const unpacked = await unpackedSize(bytes);
    if (unpacked !== null && unpacked > MAX_UNPACKED_BYTES) throw new ImportFileError("That workbook is far bigger than it looks once opened (over 100 MB). Save it again from Excel as a plain .xlsx, or split it.");
    const { default: readXlsx } = await import("read-excel-file/universal");
    let workbook: { sheet: string; data: Cell[][] }[];
    try {
      workbook = (await readXlsx(new Blob([bytes]))) as unknown as { sheet: string; data: Cell[][] }[];
    } catch {
      throw new ImportFileError("That file can't be read as an Excel workbook. Save it as .xlsx (or .csv) and try again.");
    }
    for (const { sheet: name, data } of workbook) {
      const parsed = sheetFromRows(name, data);
      if (parsed) sheets.push(parsed);
    }
  } else if (lower.endsWith(".xls")) {
    throw new ImportFileError("Tolra reads .xlsx and .csv. Open the file in Excel and save it as .xlsx.");
  } else {
    throw new ImportFileError("Upload an .xlsx workbook or a .csv file.");
  }
  if (!sheets.length) throw new ImportFileError("There is nothing in that file: no header row and no rows.");
  checkRowLimits(sheets);
  return { name: file.name, sha256, sheets };
}
