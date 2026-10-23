// The SliQ side. Reads a folder of SliQ-shaped CSV/XLSX exports through the importer's own loader (file names, header mapping,
// encoding and date detection, exact-pence parsing), plus the extra files this reconciliation needs that the importer never
// reads (refunds, opening balances, supplier bills, sales orders, jobs, deliveries). Those extras are mapped by the same rules
// from the "reconcile" section of the mapping file. Nothing is written anywhere.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { decodeBytes, detectEncoding } from "../sliq-import/detect.mjs";
import { normNumber, normaliseName } from "../sliq-import/ids.mjs";
import { loadFolder, readWorkbooks, sha256Hex } from "../sliq-import/load.mjs";
import { MappingError, getProfile, normHeader, resolveColumn } from "../sliq-import/mapping.mjs";
import { fingerprint, safeFile, safeRef } from "./safe.mjs";
import { ParseError, parseCsv, parseDate, parseMoneyPence, parseQuantityMilli } from "../sliq-import/parse.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OWN_MAPPINGS = path.join(HERE, "mappings");

const T = (type, required = false) => ({ type, required });
/** Files the importer does not read. type: text | money | qty | date | word:<set in mapping.reconcile.words> */
export const EXTRA_KINDS = {
  openingBalances: { party: T("text", true), partyType: T("word:partyType", true), document: T("text"), date: T("date"), amount: T("money", true) },
  supplierBills: { number: T("text", true), supplier: T("text", true), date: T("date"), net: T("money"), vat: T("money"), gross: T("money", true), outstanding: T("money") },
  refunds: { invoiceNumber: T("text", true), date: T("date"), amount: T("money", true), method: T("text"), reference: T("text") },
  salesOrders: { number: T("text", true), customer: T("text", true), orderDate: T("date"), deliveryDate: T("date"), total: T("money"), status: T("word:salesOrderStatus"), quoteNumber: T("text"), customerPo: T("text") },
  jobs: {
    number: T("text", true), customer: T("text"), salesOrder: T("text"), stage: T("word:jobStage"), status: T("word:jobStatus"),
    qtyOrdered: T("qty"), qtyMade: T("qty"), qtyAccepted: T("qty"), qtyRejected: T("qty"), qtyReworked: T("qty"), qtyDespatched: T("qty"), qtyRemaining: T("qty"),
    value: T("money"), dueDate: T("date"),
  },
  deliveries: { number: T("text", true), date: T("date"), jobNumber: T("text"), salesOrderNumber: T("text"), invoiceNumber: T("text"), quantity: T("qty") },
};

/** A mapping name looks in this folder first (so the synthetic fixtures' mapping lives beside the tool), then in the importer's. */
export function resolveMappingFile(idOrPath) {
  if (/^[a-z0-9-]+$/.test(idOrPath)) {
    const own = path.join(OWN_MAPPINGS, `${idOrPath}.json`);
    if (existsSync(own)) return own;
    return path.join(HERE, "..", "sliq-import", "mappings", `${idOrPath}.json`);
  }
  return path.resolve(idOrPath);
}

function readExtrasSpec(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // the parser's message quotes the file's own text, so it is not repeated
    throw new MappingError(`The mapping file cannot be read as JSON.`);
  }
  const rc = raw.reconcile ?? {};
  const files = {};
  for (const kind of Object.keys(EXTRA_KINDS)) {
    const f = rc.files?.[kind];
    files[kind] = f ? { file: [].concat(f.file ?? `${kind}.csv`), sheet: f.sheet ?? null, columns: f.columns ?? {} } : null;
  }
  const basis = rc.purchaseOrderTotalBasis ?? null;
  if (basis !== null && basis !== "net" && basis !== "gross") throw new MappingError(`The mapping file: reconcile.purchaseOrderTotalBasis must be "net" or "gross".`);
  return { files, words: rc.words ?? {}, present: !!raw.reconcile, poTotalBasis: basis };
}

const isoDay = (d) => d.toISOString().slice(0, 10);
const cellText = (v) => (v === null || v === undefined ? "" : v instanceof Date ? isoDay(v) : String(v));

function convertExtra(type, raw, words, dateFormat) {
  const text = cellText(raw).trim();
  if (text === "") return null;
  if (type === "text") return text;
  if (type === "money") return parseMoneyPence(text);
  if (type === "qty") return parseQuantityMilli(text);
  if (type === "date") return raw instanceof Date ? isoDay(raw) : parseDate(text, dateFormat);
  if (type.startsWith("word:")) {
    const set = words[type.slice(5)] ?? {};
    // The cell's text is not repeated (the caller names the file, row and column), and the word list is not spelled out.
    if (!(text in set)) throw new ParseError(`A word in this column is not in the mapping's reconcile.words.${type.slice(5)}.`);
    return set[text];
  }
  throw new Error(`unknown extra type ${type}`);
}

function tableOfSheet(data) {
  const rows = data.filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ""));
  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => cellText(h).trim());
  return { headers, rows: rows.slice(1).map((r) => headers.map((_, i) => r[i] ?? null)) };
}

function loadExtras(folder, spec, workbooks, dateFormat) {
  const out = { records: {}, inputs: [], supplied: {}, errors: [], problems: [] };
  for (const [kind, fields] of Object.entries(EXTRA_KINDS)) {
    out.records[kind] = [];
    out.supplied[kind] = false;
    const s = spec.files[kind];
    if (!s) continue;
    let table = null;
    let label = null;
    let meta = null;
    const name = s.file.find((f) => existsSync(path.join(folder, f)));
    if (name) {
      const bytes = readFileSync(path.join(folder, name));
      let text;
      try {
        text = decodeBytes(bytes, detectEncoding(bytes));
        table = parseCsv(text);
      } catch (e) {
        out.problems.push({ file: name, problem: "unreadable file", detail: e.message });
        continue;
      }
      label = name;
      meta = { file: name, sheet: null, sha256: sha256Hex(bytes), bytes: bytes.length };
    } else if (s.sheet) {
      const hits = workbooks.flatMap((w) => w.sheets.filter((x) => x.name === s.sheet).map((x) => ({ w, x })));
      if (hits.length > 1) {
        out.problems.push({ file: s.sheet, problem: "worksheet ambiguous", detail: `${hits.length} workbooks have a worksheet named "${s.sheet}"` });
        continue;
      }
      if (hits.length === 1) {
        table = tableOfSheet(hits[0].x.data);
        label = `${hits[0].w.file} [${s.sheet}]`;
        meta = { file: hits[0].w.file, sheet: s.sheet, sha256: hits[0].w.sha256, bytes: hits[0].w.bytes };
      }
    }
    if (!table) continue;
    const norm = table.headers.map(normHeader);
    const colIdx = {};
    for (const [field, def] of Object.entries(fields)) {
      const r = resolveColumn(s.columns[field], norm);
      if (!r.mapped || r.present.length === 0) {
        if (def.required) out.problems.push({ file: label, problem: r.mapped ? "column missing" : "required field not mapped", detail: `"${field}"${r.mapped ? ` (column ${r.wanted.map((w) => `"${w}"`).join(" or ")})` : ""}` });
        continue;
      }
      if (norm.filter((x) => x === normHeader(r.present[0])).length > 1) out.problems.push({ file: label, problem: "column ambiguous", detail: `"${r.present[0]}" appears more than once` });
      colIdx[field] = norm.indexOf(normHeader(r.present[0]));
    }
    for (const field of Object.keys(s.columns)) if (!(field in fields)) out.problems.push({ file: label, problem: "unknown canonical field", detail: `"${field}" is not a field of ${kind}` });
    out.supplied[kind] = true;
    out.inputs.push({ kind, ...meta, rows: table.rows.length });
    table.rows.forEach((cells, n) => {
      const rec = { _row: n + 2, _file: label };
      for (const [field, def] of Object.entries(fields)) {
        if (!(field in colIdx)) {
          rec[field] = null;
          continue;
        }
        try {
          rec[field] = convertExtra(def.type, cells[colIdx[field]], spec.words, dateFormat);
          if (rec[field] === null && def.required) throw new ParseError(`${field} is blank but required`);
        } catch (e) {
          if (!(e instanceof ParseError)) throw e;
          out.errors.push({ file: label, row: n + 2, column: field, message: e.message });
          rec[field] = null;
          rec._bad = true;
        }
      }
      out.records[kind].push(rec);
    });
  }
  return out;
}

/** The importer's party identity rule, replicated read only (reconcile.mjs keeps it private): key:<account> else name:<normalised>, #n for a repeat. */
function parties(rows) {
  const list = [];
  const byName = new Map();
  const byKey = new Map();
  const seen = new Map();
  for (const c of rows.filter((r) => !r._bad)) {
    const nn = normaliseName(c.name);
    let identity = c.key ? `key:${c.key.trim().toLowerCase()}` : `name:${nn}`;
    const n = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, n);
    if (n > 1) identity = `${identity}#${n}`;
    // The reference used in reports: the account code when there is one, otherwise a short fingerprint. Never the name.
    const ref = c.key ? safeRef(c.key.trim()) : `name-${createHash("sha256").update(nn).digest("hex").slice(0, 8)}${n > 1 ? `#${n}` : ""}`;
    const entry = { ...c, nn, identity, ref };
    list.push(entry);
    if (!byName.has(nn)) byName.set(nn, []);
    byName.get(nn).push(entry);
    if (c.key) {
      const k = c.key.trim().toLowerCase();
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(entry);
    }
  }
  const resolve = (ref) => {
    if (!ref) return null;
    const k = byKey.get(String(ref).trim().toLowerCase());
    if (k) return k[0];
    const n = byName.get(normaliseName(ref));
    return n ? n[0] : null;
  };
  return { list, resolve, byName, byKey };
}

const group = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    const k = normNumber(r[key]);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
};

// What the importer and this loader report about a file or mapping is built from the operator's own file names, column headers and
// cell values. None of that is repeated: a problem is shown as the file (safeFile), the kind of problem (a fixed list), and a
// fingerprint of the detail, which still lets two runs be compared. Any other message from the loader is replaced by fixed text.
const PROBLEM_KINDS = new Set([
  "column ambiguous", "column mapped twice", "column missing", "file missing", "numeric identifier cell", "required field not mapped",
  "unknown canonical field", "unreadable CSV", "unreadable workbook", "unreadable file", "worksheet ambiguous", "worksheets ambiguous",
]);
const FIXED_MESSAGES = [
  [/^The dates cannot be read with one format/, "The dates in the SliQ files cannot be read with one format. Fix the export, or pass --date-format."],
  [/^The dates are ambiguous/, "The dates are ambiguous: every day-of-month is 12 or less, so DD/MM/YYYY and MM/DD/YYYY cannot be told apart. Pass --date-format explicitly, even for a dry run."],
  [/^--sheet /, "A --sheet option names a worksheet that was not found, or that more than one workbook has (use file.xlsx:Sheet)."],
  [/cannot be decoded as/, "A SliQ file cannot be decoded with the encoding that was used. Check --encoding."],
];

function withholdInputError(e, profile) {
  if (!(e instanceof MappingError)) return e;
  const problems = (e.problems ?? []).map((p) => ({
    file: safeFile(p.file),
    problem: PROBLEM_KINDS.has(p.problem) ? p.problem : `problem-${fingerprint(p.problem)}`,
    detail: `detail-${fingerprint(p.detail)}`,
  }));
  if (problems.length === 0) {
    const fixed = FIXED_MESSAGES.find(([re]) => re.test(e.message));
    return new MappingError(fixed ? fixed[1] : "The SliQ files could not be read (details withheld because they can quote the files). Check the files, --mapping, --encoding, --date-format and --sheet.");
  }
  const note = profile.isStub
    ? "The SliQ column mapping is a STUB: no headers are mapped. Nothing is guessed.\n"
    : profile.isProvisional
      ? "Provisional mapping, confirm against the real headers: these are the likely SliQ headers, not yet checked against the JNR controller's files.\n"
      : "";
  const hint = problems.some((p) => p.problem === "numeric identifier cell")
    ? "\nExport document numbers, item codes and account codes as text (format the column as Text, or save as CSV), then run again."
    : "";
  const shown = problems.slice(0, 25).map((p) => `  - ${p.file}: ${p.problem}: ${p.detail}`);
  return new MappingError(
    `Mapping ${safeRef(profile.id)} cannot read this folder (${problems.length} problem(s)). File names, column headers and values are withheld; "detail-<8 hex>" is a fingerprint of them.\n${note}${shown.join("\n")}${problems.length > 25 ? "\n  ..." : ""}${hint}\nNothing was compared and nothing was written.`,
    problems,
  );
}

/**
 * @param folder   the SliQ export folder
 * @param opts     { mapping, encoding, dateFormat, sheets }
 */
export async function loadSource(folder, opts = {}) {
  if (!existsSync(folder)) throw new MappingError("The SliQ folder was not found.");
  const mappingFile = resolveMappingFile(opts.mapping ?? "sliq");
  let profile;
  try {
    profile = getProfile(mappingFile);
  } catch (e) {
    if (!(e instanceof MappingError)) throw e;
    throw new MappingError(`The column mapping was not found or is not valid. See "Input formats, mapping files, encoding and dates" in docs/go-live/sliq-reconcile.md.`);
  }
  let workbooks;
  let loaded;
  try {
    workbooks = await readWorkbooks(folder);
    loaded = loadFolder(folder, profile, { workbooks, encoding: opts.encoding, dateFormat: opts.dateFormat, sheets: opts.sheets });
  } catch (e) {
    throw withholdInputError(e, profile);
  }
  const spec = readExtrasSpec(mappingFile);
  const extras = loadExtras(folder, spec, workbooks, loaded.formats.dateFormat.used);
  if (extras.problems.length > 0) throw withholdInputError(new MappingError("", extras.problems), profile);
  const rec = loaded.records;
  const good = (rows) => rows.filter((r) => !r._bad);
  const hasFile = (k) => loaded.inputs.some((i) => i.kind === k);

  const customers = parties(rec.customers);
  const suppliers = parties(rec.suppliers);

  const invoices = [];
  const creditNotes = [];
  for (const r of good(rec.invoices)) {
    if (r.docType === "credit_note") creditNotes.push({ ...r, origin: "invoice file (type column)" });
    else if (r.gross !== null && r.gross < 0) creditNotes.push({ ...r, origin: "negative total in the invoice file" });
    else invoices.push(r);
  }
  for (const r of good(rec.creditNotes)) creditNotes.push({ ...r, status: null, origin: "credit-notes file" });

  const lineRows = good(rec.invoiceLines).map((l) => ({ ...l, number: l.documentNumber }));
  return {
    profile,
    mappingFile: path.basename(mappingFile),
    loaded,
    extras,
    spec,
    customers,
    suppliers,
    invoices,
    creditNotes,
    quotes: good(rec.quotes),
    purchaseOrders: good(rec.purchaseOrders),
    linesByDoc: group(lineRows, "number"),
    payments: good(rec.payments),
    allocations: good(rec.allocations),
    refunds: extras.records.refunds.filter((r) => !r._bad),
    openingBalances: extras.records.openingBalances.filter((r) => !r._bad),
    supplierBills: extras.records.supplierBills.filter((r) => !r._bad),
    salesOrders: extras.records.salesOrders.filter((r) => !r._bad),
    jobs: extras.records.jobs.filter((r) => !r._bad),
    deliveries: extras.records.deliveries.filter((r) => !r._bad),
    // Which kinds the export actually contains. An absent kind is "not supplied", which is not the same as "empty".
    supplied: {
      customers: hasFile("customers"), invoices: hasFile("invoices"), invoiceLines: hasFile("invoiceLines"), payments: hasFile("payments"), creditNotes: hasFile("creditNotes"),
      allocations: hasFile("allocations"), quotes: hasFile("quotes"), purchaseOrders: hasFile("purchaseOrders"), suppliers: hasFile("suppliers"), ...extras.supplied,
    },
    unreadable: [
      ...loaded.errors.map((e) => ({ file: e.file, row: e.row, column: e.column, message: e.message })),
      ...extras.errors,
    ],
    inputs: [...loaded.inputs.map((i) => ({ kind: i.kind, file: i.file, sheet: i.sheet, sha256: i.sha256, bytes: i.bytes, rows: i.rows })), ...extras.inputs],
    group,
  };
}
