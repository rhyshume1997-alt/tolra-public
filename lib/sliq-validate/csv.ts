/**
 * Byte-level CSV reading for the SliQ source-file validator: BOM and encoding detection, delimiter detection and a small
 * RFC 4180 style parser (quoted fields, doubled quotes, embedded newlines, CRLF/LF/CR). Pure: no fs, no network.
 */

export type DetectedEncoding = "utf-8" | "utf-16le" | "windows-1252";
export type LineEnding = "CRLF" | "LF" | "CR" | "none";

export const DELIMITERS = [",", ";", "\t", "|"] as const;
export type Delimiter = (typeof DELIMITERS)[number];

export type DecodedText = { text: string; encoding: DetectedEncoding; bom: boolean };

/** BOM, else valid UTF-8, else Windows-1252. A UTF-16 big-endian BOM is refused (returns an error string). */
export function decodeBytes(bytes: Uint8Array): DecodedText | { error: string } {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { error: "UTF-16 big-endian is not supported" };
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    try {
      return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes), encoding: "utf-8", bom: true };
    } catch {
      return { error: "file starts with a UTF-8 BOM but is not valid UTF-8" };
    }
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    try {
      return { text: new TextDecoder("utf-16le", { fatal: true }).decode(bytes), encoding: "utf-16le", bom: true };
    } catch {
      return { error: "file starts with a UTF-16 LE BOM but is not valid UTF-16" };
    }
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8", bom: false };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(bytes), encoding: "windows-1252", bom: false };
  }
}

export function detectLineEnding(text: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        i++;
      } else cr++;
    } else if (c === 10) lf++;
  }
  const kinds = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
  if (kinds === 0) return "none";
  if (kinds > 1) return crlf >= lf && crlf >= cr ? "CRLF" : lf >= cr ? "LF" : "CR";
  return crlf ? "CRLF" : lf ? "LF" : "CR";
}

/** The first record's text (up to the first newline outside quotes). */
function firstRecord(text: string): string {
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') inQ = !inQ;
    else if (!inQ && (c === "\n" || c === "\r")) return text.slice(0, i);
  }
  return text;
}

/** The delimiter from the header record: the one candidate that appears most outside quotes. Null when none or tied. */
export function detectDelimiter(text: string): Delimiter | null {
  const head = firstRecord(text);
  const counts = new Map<Delimiter, number>(DELIMITERS.map((d) => [d, 0]));
  let inQ = false;
  for (const c of head) {
    if (c === '"') inQ = !inQ;
    else if (!inQ && (DELIMITERS as readonly string[]).includes(c)) counts.set(c as Delimiter, (counts.get(c as Delimiter) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) return null;
  return ranked[0][0];
}

export type ParsedCsv = { records: string[][]; error?: string };

/** Parses to records (blank lines skipped). Record index + 1 is the file row number (header = row 1). */
export function parseCsv(text: string, delimiter: Delimiter): ParsedCsv {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  let fieldQuoted = false;
  const endField = () => {
    row.push(field);
    field = "";
    fieldQuoted = false;
  };
  const endRow = () => {
    endField();
    if (!(row.length === 1 && row[0] === "")) records.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
    } else if (c === '"' && field === "" && !fieldQuoted) {
      inQ = true;
      fieldQuoted = true;
    } else if (c === delimiter) endField();
    else if (c === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else if (c === "\n") endRow();
    else field += c;
  }
  if (inQ) return { records, error: "unterminated quoted field" };
  if (field !== "" || row.length > 0) endRow();
  return { records };
}
