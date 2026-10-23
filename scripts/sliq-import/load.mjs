// Reads the input folder: CSV files and Excel (.xlsx) workbooks. Checksums, byte sizes and row counts per source; encoding
// and date-format detection; the mapping check (by header name); then every row into canonical records. Parse problems are
// collected (file, row, column, value, message), not thrown, so one report shows them all. A missing required column, an
// unmatched or ambiguous worksheet, or ambiguous dates throws a MappingError first and nothing else is read.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { decodeBytes, detectDateFormat, detectEncoding } from "./detect.mjs";
import { CANONICAL, FILE_KINDS, IDENTIFIER_FIELDS, MappingError, checkMapping, describeProblems, normHeader, resolveColumn, unmappedColumns } from "./mapping.mjs";
import { ParseError, parseCsv, parseDate, parseMoneyPence, parsePercentCenti, parseQuantityMilli } from "./parse.mjs";

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

const isoDay = (d) => d.toISOString().slice(0, 10);
/** A spreadsheet or CSV cell as text. A native date cell becomes an ISO day. */
function cellText(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return isoDay(v);
  return String(v);
}

/** Reads every .xlsx in the folder: all worksheets, as arrays of rows. Async because the reader is. */
export async function readWorkbooks(folder) {
  const names = existsSync(folder) ? readdirSync(folder).filter((f) => /\.xlsx$/i.test(f) && !f.startsWith("~$")).sort() : [];
  if (names.length === 0) return [];
  const { default: readExcelFile } = await import("read-excel-file/node");
  const out = [];
  for (const file of names) {
    const bytes = readFileSync(path.join(folder, file));
    let sheets;
    try {
      sheets = (await readExcelFile(bytes)).map((s) => ({ name: s.sheet, data: s.data }));
    } catch (e) {
      throw new MappingError(`${file} cannot be read as an Excel workbook: ${e.message}`, [{ file, problem: "unreadable workbook", detail: e.message }]);
    }
    out.push({ file, sha256: sha256Hex(bytes), bytes: bytes.length, sheets });
  }
  return out;
}

function sheetTable(data) {
  const rows = data.filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ""));
  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => cellText(h).trim());
  const body = rows.slice(1).map((r) => headers.map((_, i) => r[i] ?? null));
  return { headers, rows: body };
}

const requiredHeadersPresent = (profile, kind, headers) => {
  const norm = headers.map(normHeader);
  const req = Object.entries(CANONICAL[kind]).filter(([, d]) => d.required);
  return req.length > 0 && req.every(([f]) => {
    const r = resolveColumn(profile.files[kind].columns[f], norm);
    return r.mapped && r.present.length > 0 && (!r.join || r.present.length === r.wanted.length);
  });
};

const mappedPresent = (profile, kind, headers) => {
  const norm = headers.map(normHeader);
  return Object.keys(CANONICAL[kind]).filter((f) => resolveColumn(profile.files[kind].columns[f], norm).present.length > 0).length;
};

/**
 * @param opts { workbooks?, sheets?: {kind: "Sheet" | "file.xlsx:Sheet"}, encoding?, dateFormat? }
 *   encoding / dateFormat are the operator's explicit confirmation (flags); the mapping file may record them too.
 */
export function loadFolder(folder, profile, opts = {}) {
  const workbooks = opts.workbooks ?? [];
  const sources = {};
  const missingFiles = [];
  const sheetPool = workbooks.flatMap((w) => w.sheets.map((s) => ({ wb: w, name: s.name, data: s.data, used: false })));
  const encodingConfirmed = opts.encoding ?? profile.encoding ?? null;
  const encodings = [];

  // 1. explicit --sheet kind=Name, then CSV by file name
  for (const { kind } of FILE_KINDS) {
    const want = opts.sheets?.[kind];
    if (want) {
      const [fileName, sheetName] = want.includes(":") ? [want.slice(0, want.indexOf(":")), want.slice(want.indexOf(":") + 1)] : [null, want];
      const hits = sheetPool.filter((s) => s.name === sheetName && (!fileName || s.wb.file === fileName));
      if (hits.length !== 1) throw new MappingError(`--sheet ${kind}=${want}: ${hits.length === 0 ? "no such worksheet" : "more than one workbook has that worksheet name (use file.xlsx:Sheet)"}.`);
      hits[0].used = true;
      sources[kind] = { kind, file: hits[0].wb.file, sheet: hits[0].name, sha256: hits[0].wb.sha256, bytes: hits[0].wb.bytes, ...sheetTable(hits[0].data), xlsx: true };
      continue;
    }
    const name = profile.files[kind].file.find((f) => existsSync(path.join(folder, f)));
    if (name) {
      const bytes = readFileSync(path.join(folder, name));
      const detected = detectEncoding(bytes);
      const used = encodingConfirmed ?? detected;
      let text;
      try {
        text = decodeBytes(bytes, used);
      } catch (e) {
        throw new MappingError(`${name} cannot be decoded as ${used}${encodingConfirmed ? " (the confirmed encoding)" : ""}: ${e.message}. Detected: ${detected}.`);
      }
      let table;
      try {
        table = parseCsv(text);
      } catch (e) {
        if (e instanceof ParseError) throw new MappingError(`${name} cannot be read as CSV: ${e.message}`, [{ file: name, problem: "unreadable CSV", detail: e.message }]);
        throw e;
      }
      encodings.push({ file: name, detected, used });
      sources[kind] = { kind, file: name, sheet: null, sha256: sha256Hex(bytes), bytes: bytes.length, ...table, xlsx: false };
    }
  }

  // 2. worksheets matched to the kinds still missing, by their headers
  const unmatchedSheets = [];
  const ambiguousSheets = [];
  const open = FILE_KINDS.map((k) => k.kind).filter((k) => !sources[k]);
  const claims = new Map();
  for (const s of sheetPool.filter((x) => !x.used)) {
    const t = sheetTable(s.data);
    const scored = open.filter((k) => requiredHeadersPresent(profile, k, t.headers)).map((k) => ({ k, score: mappedPresent(profile, k, t.headers) }));
    const top = Math.max(0, ...scored.map((x) => x.score));
    // The best match wins (an invoice sheet also has every column a quote sheet needs); a tie needs --sheet.
    const cands = scored.filter((x) => x.score === top).map((x) => x.k);
    if (cands.length === 0) unmatchedSheets.push({ file: s.wb.file, sheet: s.name, headers: t.headers });
    else if (cands.length > 1) ambiguousSheets.push({ file: s.wb.file, sheet: s.name, kinds: cands });
    else {
      if (!claims.has(cands[0])) claims.set(cands[0], []);
      claims.get(cands[0]).push({ s, t });
    }
  }
  const problems = [];
  for (const a of ambiguousSheets) problems.push({ file: a.file, problem: "worksheet ambiguous", detail: `worksheet "${a.sheet}" has the headers of ${a.kinds.join(" and ")}: say which with --sheet <kind>=${a.sheet}` });
  for (const [kind, list] of claims) {
    if (list.length > 1) problems.push({ file: list[0].s.wb.file, problem: "worksheets ambiguous", detail: `${list.length} worksheets (${list.map((x) => x.s.name).join(", ")}) match ${kind}: say which with --sheet ${kind}=<name>` });
    else {
      const { s, t } = list[0];
      s.used = true;
      sources[kind] = { kind, file: s.wb.file, sheet: s.name, sha256: s.wb.sha256, bytes: s.wb.bytes, ...t, xlsx: true };
    }
  }
  for (const { kind } of FILE_KINDS) if (!sources[kind]) missingFiles.push({ kind, file: profile.files[kind].file[0] });

  // 3. mapping check
  const found = {};
  for (const [kind, src] of Object.entries(sources)) found[kind] = { headers: src.headers, file: src.sheet ? `${src.file} [${src.sheet}]` : src.file };
  const mapProblems = [...problems, ...checkMapping(profile, found)];
  if (mapProblems.length > 0) throw new MappingError(describeProblems(profile, mapProblems), mapProblems);

  // 4. date format: proposed from the data, confirmed only by the operator or the mapping file
  const dateValues = [];
  for (const [kind, src] of Object.entries(sources)) {
    const norm = src.headers.map(normHeader);
    for (const [field, def] of Object.entries(CANONICAL[kind])) {
      if (def.type !== "date") continue;
      for (const h of resolveColumn(profile.files[kind].columns[field], norm).present) {
        const i = norm.indexOf(normHeader(h));
        for (const r of src.rows) if (typeof r[i] === "string" && r[i].trim()) dateValues.push(r[i]);
      }
    }
  }
  const detectedDates = detectDateFormat(dateValues);
  const dateConfirmed = opts.dateFormat ?? profile.dateFormat ?? null;
  let dateUsed = dateConfirmed ?? (detectedDates.format && !detectedDates.ambiguous ? detectedDates.format : null);
  if (!dateUsed && dateValues.length > 0) {
    throw new MappingError(
      detectedDates.conflict
        ? `The dates cannot be read with one format: ${detectedDates.conflict} (examples: ${detectedDates.examples.join(", ")}). Fix the export or pass --date-format.`
        : `The dates are ambiguous: every day-of-month is 12 or less, so DD/MM/YYYY and MM/DD/YYYY cannot be told apart (examples: ${detectedDates.examples.join(", ")}). Pass --date-format explicitly, even for a dry run.`,
    );
  }
  dateUsed ??= "DD/MM/YYYY";

  // 5. rows -> canonical records
  const records = {};
  const errors = [];
  const warnings = [];
  const numericIds = [];
  const inputs = [];
  for (const { kind } of FILE_KINDS) {
    records[kind] = [];
    const src = sources[kind];
    if (!src) continue;
    const norm = src.headers.map(normHeader);
    const idx = (h) => norm.indexOf(normHeader(h));
    const label = src.sheet ? `${src.file} [${src.sheet}]` : src.file;
    inputs.push({ kind, file: src.file, sheet: src.sheet, sha256: src.sha256, bytes: src.bytes, rows: src.rows.length, unmappedColumns: unmappedColumns(profile, kind, src.headers) });
    const optionalAbsent = Object.entries(CANONICAL[kind]).filter(([f]) => { const r = resolveColumn(profile.files[kind].columns[f], norm); return r.mapped && r.present.length === 0; }).map(([f]) => f);
    inputs.at(-1).optionalColumnsMissing = optionalAbsent;
    src.rows.forEach((cells, n) => {
      const rowNo = n + 2;
      const rec = { _row: rowNo, _file: label };
      for (const [field, def] of Object.entries(CANONICAL[kind])) {
        const r = resolveColumn(profile.files[kind].columns[field], norm);
        if (!r.mapped || r.present.length === 0) {
          rec[field] = null;
          continue;
        }
        const raws = r.present.map((h) => cells[idx(h)]);
        const col = r.present.join(" + ");
        try {
          if (src.xlsx && IDENTIFIER_FIELDS.has(field) && typeof raws[0] === "number") {
            numericIds.push({ file: label, row: rowNo, column: col, value: String(raws[0]) });
          }
          rec[field] = convert(def.type, raws, profile, kind, dateUsed);
          if (def.type === "status") rec[`${field}Raw`] = cellText(raws[0]).trim() || null;
          if ((rec[field] === null || rec[field] === "") && def.required && !def.blankOk) throw new ParseError(`${field} is blank but required`);
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
          errors.push({ file: label, row: rowNo, column: col, value: raws.map(cellText).join(" | "), message: e.message });
          rec[field] = null;
          rec._bad = true;
        }
      }
      records[kind].push(rec);
    });
  }

  if (numericIds.length > 0) {
    // 00045 stored as a number reads back as 45: the exact text is gone, so nothing is read until it is exported as text.
    const shown = numericIds.slice(0, 20).map((n) => `  - ${n.file} row ${n.row}, column "${n.column}": ${n.value}`);
    throw new MappingError(
      `${numericIds.length} identifier(s) are numeric spreadsheet cells, so leading zeros and prefixes cannot be trusted:\n${shown.join("\n")}\nExport document numbers, item codes and account codes as text (format the column as Text, or save as CSV), then run again. Nothing was read further and nothing was written.`,
      numericIds.map((n) => ({ file: n.file, problem: "numeric identifier cell", detail: `row ${n.row} ${n.column}: ${n.value}` })),
    );
  }

  const formats = {
    encoding: {
      perFile: encodings,
      detected: [...new Set(encodings.map((e) => e.detected))],
      confirmed: encodingConfirmed,
      note: encodings.length === 0 ? "no CSV files (workbooks have no text encoding)" : null,
    },
    dateFormat: { detected: detectedDates.format, ambiguous: detectedDates.ambiguous, conflict: detectedDates.conflict, examples: detectedDates.examples, confirmed: dateConfirmed, used: dateUsed, valuesSeen: dateValues.length },
  };
  return { profile, folder, inputs, missingFiles, unmatchedSheets, errors, warnings, records, formats, options: { sheets: opts.sheets ?? {} } };
}

const ZERO_DISCOUNT = /^[£]?\s*0*(\.0*)?\s*%?$/;

function convert(type, raws, profile, kind, dateFormat) {
  const first = raws[0];
  const text = cellText(first);
  switch (type) {
    case "text": {
      const parts = raws.map((r) => cellText(r).trim()).filter(Boolean);
      return parts.length ? parts.join(", ") : null;
    }
    case "money":
      return parseMoneyPence(text);
    case "quantity":
      return parseQuantityMilli(text);
    case "integer": {
      const s = text.trim();
      if (s === "") return null;
      if (!/^-?\d+$/.test(s)) throw new ParseError(`"${text}" is not a whole number.`);
      return Number(s);
    }
    case "percent":
      if (typeof first === "number" && first > 0 && first < 1) throw new ParseError(`Rate ${first} is a fraction (a cell formatted as a percentage?): ambiguous, export it as a number such as 20.`);
      return parsePercentCenti(text);
    case "discount": {
      const s = text.trim();
      return s === "" || ZERO_DISCOUNT.test(s) ? null : s;
    }
    case "date":
      if (first instanceof Date) return isoDay(first);
      return parseDate(text, dateFormat);
    case "status":
    case "poStatus": {
      const raw = text.trim();
      if (raw === "") return null;
      const table = profile.statusWords[type === "poStatus" ? "po" : kind === "quotes" ? "quote" : "invoice"] ?? {};
      if (!(raw in table)) throw new ParseError(`Status "${raw}" is not in the mapping's status words (${Object.keys(table).join(", ") || "none defined"}).`);
      return table[raw];
    }
    case "docType": {
      const raw = text.trim();
      if (raw === "") return null;
      if (!(raw in profile.docTypeWords)) throw new ParseError(`Document type "${raw}" is not in the mapping's document-type words.`);
      return profile.docTypeWords[raw];
    }
    default:
      throw new Error(`unknown field type ${type}`);
  }
}
