// Reads the three extra SliQ files (open jobs, sales orders, opening WIP) the way load.mjs reads the others: CSV by the mapped
// file name, or an Excel worksheet (--sheet jobs=<Sheet>, or a worksheet load.mjs left unmatched whose headers fit exactly one of
// the three). Checksums, byte sizes and row counts go into loaded.inputs (so the write's stale-report check covers these files
// too), the encoding into loaded.formats, row problems into loaded.errors (an unreadable row stops a write, as for every file).
// The header row of each of these files is always checked strictly: a missing or an unknown column refuses the run with a list.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { decodeBytes, detectEncoding } from "./detect.mjs";
import { JOBS_CANONICAL, JOB_FILE_KINDS, JOB_IDENTIFIER_FIELDS, compareHeaders, describeHeaderProblems, getHeaderCheck, getJobsProfile, readMappingRaw } from "./jobs-mapping.mjs";
import { sha256Hex } from "./load.mjs";
import { MappingError, normHeader, resolveColumn } from "./mapping.mjs";
import { ParseError, parseCsv, parseDate, parseMoneyPence, parseQuantityMilli } from "./parse.mjs";

const isoDay = (d) => d.toISOString().slice(0, 10);
const cellText = (v) => (v === null || v === undefined ? "" : v instanceof Date ? isoDay(v) : String(v));

function sheetTable(data) {
  const rows = data.filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ""));
  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => cellText(h).trim());
  return { headers, rows: rows.slice(1).map((r) => headers.map((_, i) => r[i] ?? null)) };
}

const fits = (spec, kind, headers) => {
  const norm = headers.map(normHeader);
  return Object.entries(JOBS_CANONICAL[kind]).filter(([, d]) => d.required).every(([f]) => resolveColumn(spec.files[kind].columns[f], norm).present.length > 0);
};

/**
 * @param folder  the export folder
 * @param mapping the --mapping value (name or path) the main profile came from
 * @param loaded  the result of loadFolder (extended in place: inputs, errors, formats.encoding.perFile)
 * @param opts    { workbooks?, sheets? }
 * Returns { profile (null when the mapping has no jobsImport section), headerCheck, records: { jobs, salesOrders, wip }, inputs }.
 */
export function loadJobsFolder(folder, mapping, loaded, opts = {}) {
  const raw = readMappingRaw(mapping, loaded.profile);
  const headerCheck = getHeaderCheck(raw);
  const profile = getJobsProfile(raw);
  const records = { jobs: [], salesOrders: [], wip: [] };
  if (!profile) return { profile: null, headerCheck, records, inputs: [], present: {} };
  const encodingConfirmed = loaded.formats.encoding.confirmed;
  const dateFormat = loaded.formats.dateFormat.used;
  const sources = {};
  const sheets = (opts.workbooks ?? []).flatMap((w) => w.sheets.map((s) => ({ wb: w, name: s.name, data: s.data })));
  const unmatched = new Set((loaded.unmatchedSheets ?? []).map((s) => `${s.file}\u0000${s.sheet}`));
  const problems = [];
  for (const kind of JOB_FILE_KINDS) {
    const want = opts.sheets?.[kind];
    if (want) {
      const [fileName, sheetName] = want.includes(":") ? [want.slice(0, want.indexOf(":")), want.slice(want.indexOf(":") + 1)] : [null, want];
      const hits = sheets.filter((s) => s.name === sheetName && (!fileName || s.wb.file === fileName));
      if (hits.length !== 1) throw new MappingError(`--sheet ${kind}=${want}: ${hits.length === 0 ? "no such worksheet" : "more than one workbook has that worksheet name (use file.xlsx:Sheet)"}.`);
      sources[kind] = { file: hits[0].wb.file, sheet: hits[0].name, sha256: hits[0].wb.sha256, bytes: hits[0].wb.bytes, ...sheetTable(hits[0].data), xlsx: true };
      continue;
    }
    const name = profile.files[kind].file.find((f) => existsSync(path.join(folder, f)));
    if (name) {
      const bytes = readFileSync(path.join(folder, name));
      const detected = detectEncoding(bytes);
      const used = encodingConfirmed ?? detected;
      let table;
      try {
        table = parseCsv(decodeBytes(bytes, used));
      } catch (e) {
        throw new MappingError(`${name} cannot be read${e instanceof ParseError ? " as CSV" : ` as ${used}`}: ${e.message}`, [{ file: name, problem: "unreadable file", detail: e.message }]);
      }
      loaded.formats.encoding.perFile.push({ file: name, detected, used });
      if (!loaded.formats.encoding.detected.includes(detected)) loaded.formats.encoding.detected.push(detected);
      sources[kind] = { file: name, sheet: null, sha256: sha256Hex(bytes), bytes: bytes.length, ...table, xlsx: false };
      continue;
    }
    const cands = sheets.filter((s) => unmatched.has(`${s.wb.file}\u0000${s.name}`)).map((s) => ({ s, t: sheetTable(s.data) })).filter(({ t }) => fits(profile, kind, t.headers));
    if (cands.length > 1) problems.push(`${cands.length} worksheets (${cands.map((c) => c.s.name).join(", ")}) look like ${kind}: say which with --sheet ${kind}=<name>`);
    else if (cands.length === 1) sources[kind] = { file: cands[0].s.wb.file, sheet: cands[0].s.name, sha256: cands[0].s.wb.sha256, bytes: cands[0].s.wb.bytes, ...cands[0].t, xlsx: true };
  }
  if (problems.length) throw new MappingError(problems.join("\n"), problems.map((p) => ({ problem: "worksheet ambiguous", detail: p })));

  // The header row of every jobs file is held to the mapping exactly, whatever the main header check says.
  const headerProblems = [];
  for (const [kind, src] of Object.entries(sources)) {
    const c = compareHeaders(profile.files[kind].columns, JOBS_CANONICAL[kind], src.headers, headerCheck.ignore[kind]);
    if (c.missing.length || c.unknown.length || c.twice.length) headerProblems.push({ kind, file: src.sheet ? `${src.file} [${src.sheet}]` : src.file, ...c });
  }
  if (headerProblems.length) throw new MappingError(describeHeaderProblems(headerProblems), headerProblems.map((p) => ({ file: p.file, problem: "header row", detail: JSON.stringify({ missing: p.missing, unknown: p.unknown }) })));

  const inputs = [];
  const numericIds = [];
  for (const kind of JOB_FILE_KINDS) {
    const src = sources[kind];
    if (!src) continue;
    const norm = src.headers.map(normHeader);
    const label = src.sheet ? `${src.file} [${src.sheet}]` : src.file;
    inputs.push({ kind, file: src.file, sheet: src.sheet, sha256: src.sha256, bytes: src.bytes, rows: src.rows.length, unmappedColumns: [], optionalColumnsMissing: [] });
    src.rows.forEach((cells, n) => {
      const rowNo = n + 2;
      const rec = { _row: rowNo, _file: label };
      for (const [field, def] of Object.entries(JOBS_CANONICAL[kind])) {
        const r = resolveColumn(profile.files[kind].columns[field], norm);
        if (!r.mapped || r.present.length === 0) {
          rec[field] = null;
          continue;
        }
        const raws = r.present.map((h) => cells[norm.indexOf(normHeader(h))]);
        try {
          if (src.xlsx && JOB_IDENTIFIER_FIELDS.has(field) && typeof raws[0] === "number") numericIds.push(`${label} row ${rowNo}, column "${r.present[0]}": ${raws[0]}`);
          rec[field] = convert(def.type, raws, profile, dateFormat);
          if (["jobStatus", "jobStage", "soStatus"].includes(def.type)) rec[`${field}Raw`] = cellText(raws[0]).trim() || null;
          if ((rec[field] === null || rec[field] === "") && def.required && !def.blankOk) throw new ParseError(`${field} is blank but required`);
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
          loaded.errors.push({ file: label, row: rowNo, column: r.present.join(" + "), value: raws.map(cellText).join(" | "), message: e.message });
          rec[field] = null;
          rec._bad = true;
        }
      }
      records[kind].push(rec);
    });
  }
  if (numericIds.length) {
    throw new MappingError(`${numericIds.length} identifier(s) in the jobs files are numeric spreadsheet cells (leading zeros and prefixes cannot be trusted):\n${numericIds.slice(0, 20).map((s) => `  - ${s}`).join("\n")}\nExport them as text, then run again.`);
  }
  loaded.inputs.push(...inputs);
  return { profile, headerCheck, records, inputs, present: Object.fromEntries(Object.keys(sources).map((k) => [k, true])) };
}

function convert(type, raws, profile, dateFormat) {
  const first = raws[0];
  const text = cellText(first).trim();
  switch (type) {
    case "text": {
      const parts = raws.map((r) => cellText(r).trim()).filter(Boolean);
      return parts.length ? parts.join(", ") : null;
    }
    case "money":
      return parseMoneyPence(text);
    case "quantity":
      return text === "" ? null : parseQuantityMilli(text);
    case "date":
      if (first instanceof Date) return isoDay(first);
      return parseDate(text, dateFormat);
    case "jobStatus": {
      if (text === "") return null;
      if (!(text in profile.jobStatusWords)) throw new ParseError(`Job status "${text}" is not in the mapping's jobStatusWords (${Object.keys(profile.jobStatusWords).join(", ") || "none defined"}).`);
      return profile.jobStatusWords[text];
    }
    case "jobStage": {
      if (text === "") return null;
      if (!(text in profile.jobStageWords)) throw new ParseError(`Job stage "${text}" is not in the mapping's jobStageWords (${Object.keys(profile.jobStageWords).join(", ") || "none defined"}).`);
      return profile.jobStageWords[text];
    }
    case "soStatus": {
      if (text === "") return null;
      if (!(text in profile.salesOrderStatusWords)) throw new ParseError(`Sales order status "${text}" is not in the mapping's salesOrderStatusWords (${Object.keys(profile.salesOrderStatusWords).join(", ") || "none defined"}).`);
      return profile.salesOrderStatusWords[text];
    }
    default:
      throw new Error(`unknown field type ${type}`);
  }
}
