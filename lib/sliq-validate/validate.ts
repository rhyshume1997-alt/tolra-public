/**
 * Pure validator for John's SliQ export files (gate D1). No database, no network, no filesystem: the caller passes the
 * file bytes and an explicit, confirmed mapping. Nothing about SliQ's real headers, encoding or date format is assumed;
 * the mapping states them, and without `confirmed: true` the report is never ok.
 *
 * Row numbers in errors are file rows: the header is row 1, the first data row is row 2.
 *
 * Browser-safe: hashing is Web Crypto (crypto.subtle), so validateSliqExport is async and runs in the Admin > Data card as well as in
 * Node (tests, scenarios). No node: imports.
 */

import { DELIMITERS, decodeBytes, detectDelimiter, detectLineEnding, parseCsv, type Delimiter, type DetectedEncoding, type LineEnding } from "./csv";
import { REF_SHAPE_MAX_LENGTH, compileRefShape } from "./ref-shape";
import { DATE_FORMATS, parseDate, parsePence, type DateFormat } from "./values";

export const ENTITIES = ["customers", "suppliers", "invoices", "payments"] as const;
/** creditNotes is optional: only when the mapping names a credit-notes file (state-machines/IMPORT-CREDIT-NOTES.md, option 1). */
export const ALL_ENTITIES = [...ENTITIES, "creditNotes"] as const;
export type Entity = (typeof ALL_ENTITIES)[number];

/** Canonical fields per entity. `required` fields must be mapped and present in the header. */
const FIELDS: Record<Entity, { required: string[]; optional: string[] }> = {
  customers: { required: ["key", "name"], optional: [] },
  suppliers: { required: ["key", "name"], optional: [] },
  invoices: { required: ["ref", "customerKey", "date", "gross"], optional: ["net", "vat"] },
  payments: { required: ["invoiceRef", "date", "amount"], optional: ["key"] },
  creditNotes: { required: ["ref", "invoiceRef", "date", "gross"], optional: ["net", "vat", "reason", "allocated"] },
};

export type SliqMapping = {
  version: number | string;
  confirmed: true;
  dateFormat: DateFormat;
  /** Optional: when given, the detected delimiter/encoding must agree. */
  delimiter?: Delimiter;
  encoding?: DetectedEncoding;
  /**
   * Optional shape every invoice ref must match in full (lib/sliq-validate/ref-shape.ts): literal letters, digits, space, - _ / . and
   * \d with {n}, {n,m}, +, * or ?; not a full regular expression, so it is checked in linear time. Default: one shared non-digit
   * prefix then digits.
   */
  invoiceRefPattern?: string;
  /**
   * A row John has looked at and signed off: the raw date text as it is in the file and the calendar date it means (YYYY-MM-DD).
   * Required when every date in the files has day and month both 12 or less (DD/MM and MM/DD would both read them); always checked
   * against dateFormat when given.
   */
  dateSample?: { file: string; row: number; raw: string; means: string; confirmedBy: string };
  entities: Record<(typeof ENTITIES)[number], { file: string; columns: Record<string, string> }> & { creditNotes?: { file: string; columns: Record<string, string> } };
};

export type SourceFiles = Partial<Record<Entity, { name: string; bytes: Uint8Array }>>;

export type ValidationError = { file: string; row: number | null; field: string | null; reason: string };

export type EntityTotals = {
  file: string;
  sha256: string;
  bytes: number;
  rows: number;
  encoding: DetectedEncoding;
  bom: boolean;
  delimiter: Delimiter;
  lineEnding: LineEnding;
  /** Integer pence totals, e.g. invoices: gross (and net, vat when mapped); payments: amount. */
  moneyPence: Record<string, number>;
};

export type ValidationReport = {
  ok: boolean;
  mappingConfirmed: boolean;
  errors: ValidationError[];
  /** Never stop the import, but are shown: a zero-total invoice, a payment dated before its invoice, a file read as Windows-1252. */
  warnings: ValidationError[];
  /** The signed-off date example, as it was checked, for the card to display. */
  dateSample?: { raw: string; means: string; confirmedBy: string };
  /** True when more errors existed than maxErrors. */
  truncated: boolean;
  totals: { entities: Partial<Record<Entity, EntityTotals>> };
};

export type ValidateInput = { files: SourceFiles; mapping: unknown; maxErrors?: number };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Returns the typed mapping, or the reasons it is not acceptable. */
export function checkMapping(m: unknown): { mapping: SliqMapping | null; problems: string[] } {
  const problems: string[] = [];
  if (!isObj(m)) return { mapping: null, problems: ["mapping is not an object"] };
  if (m.version === undefined || m.version === null || m.version === "") problems.push("mapping.version is required");
  else if (typeof m.version !== "number" && typeof m.version !== "string") problems.push("mapping.version must be a number or string");
  if (m.confirmed !== true) problems.push("mapping.confirmed must be true (the mapping has not been confirmed against the real files)");
  if (typeof m.dateFormat !== "string" || !(DATE_FORMATS as readonly string[]).includes(m.dateFormat)) {
    problems.push(`mapping.dateFormat must be one of ${DATE_FORMATS.join(", ")}`);
  }
  if (m.delimiter !== undefined && !(DELIMITERS as readonly unknown[]).includes(m.delimiter)) problems.push("mapping.delimiter is not a supported delimiter");
  if (m.encoding !== undefined && !["utf-8", "utf-16le", "windows-1252"].includes(String(m.encoding))) problems.push("mapping.encoding is not supported");
  if (m.invoiceRefPattern !== undefined && compileRefShape(String(m.invoiceRefPattern)) === null) {
    problems.push(`mapping.invoiceRefPattern is not an accepted ref shape: use only letters, digits, space, - _ / . and \\d with {n}, {n,m}, +, * or ? (at most ${REF_SHAPE_MAX_LENGTH} characters; no groups, alternation or classes)`);
  }
  const ents = isObj(m.entities) ? m.entities : null;
  if (!ents) problems.push("mapping.entities is required");
  else {
    for (const e of ALL_ENTITIES) {
      const spec = ents[e];
      if (e === "creditNotes" && spec === undefined) continue;
      if (!isObj(spec)) {
        problems.push(`mapping.entities.${e} is required`);
        continue;
      }
      if (typeof spec.file !== "string" || spec.file === "") problems.push(`mapping.entities.${e}.file is required`);
      const cols = isObj(spec.columns) ? spec.columns : null;
      if (!cols) {
        problems.push(`mapping.entities.${e}.columns is required`);
        continue;
      }
      for (const f of FIELDS[e].required) {
        if (typeof cols[f] !== "string" || cols[f] === "") problems.push(`mapping.entities.${e}.columns.${f} is required`);
      }
      for (const [f, h] of Object.entries(cols)) {
        if (!FIELDS[e].required.includes(f) && !FIELDS[e].optional.includes(f)) problems.push(`mapping.entities.${e}.columns.${f} is not a known field`);
        else if (typeof h !== "string") problems.push(`mapping.entities.${e}.columns.${f} must be a header name`);
      }
    }
  }
  if (m.dateSample !== undefined) {
    const d = m.dateSample;
    if (!isObj(d) || typeof d.file !== "string" || typeof d.row !== "number" || typeof d.raw !== "string" || typeof d.means !== "string"
        || !/^\d{4}-\d{2}-\d{2}$/.test(String(d.means)) || typeof d.confirmedBy !== "string" || d.confirmedBy.trim() === "") {
      problems.push("mapping.dateSample must be { file, row, raw, means: YYYY-MM-DD, confirmedBy }");
    }
  }
  return { mapping: problems.length === 0 ? (m as unknown as SliqMapping) : null, problems };
}

/** The SQL import_norm_name (076), ported: what Tolra treats as the same customer or supplier name. */
export function normaliseName(name: string): string {
  return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ").replace(/\blimited\b/g, "ltd").replace(/ +/g, " ").trim();
}

async function sha256(b: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", b as BufferSource);
  return Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Shape of an invoice ref: its non-digit prefix and trailing digits. */
const REF_SHAPE = /^(\D*)(\d+)$/;

/** Browser and Node: hashes every file with Web Crypto, then validates. */
export async function validateSliqExport(input: ValidateInput): Promise<ValidationReport> {
  const hashes = new Map<Uint8Array, string>();
  for (const f of Object.values(input.files)) if (f) hashes.set(f.bytes, await sha256(f.bytes));
  return validateSliqExportWith(input, (b) => hashes.get(b) ?? "");
}

/** The same checks with a given synchronous SHA-256 (hex) function, e.g. node:crypto in a script or test. */
export function validateSliqExportWith(input: ValidateInput, hash: (bytes: Uint8Array) => string): ValidationReport {
  const max = input.maxErrors ?? 1000;
  const errors: ValidationError[] = [];
  let truncated = false;
  const err = (file: string, row: number | null, field: string | null, reason: string) => {
    if (errors.length >= max) truncated = true;
    else errors.push({ file, row, field, reason });
  };
  const warnings: ValidationError[] = [];
  const warn = (file: string, row: number | null, field: string | null, reason: string) => { if (warnings.length < max) warnings.push({ file, row, field, reason }); };
  const totals: ValidationReport["totals"] = { entities: {} };
  const { mapping, problems } = checkMapping(input.mapping);
  const mappingConfirmed = isObj(input.mapping) && input.mapping.confirmed === true && problems.length === 0;
  for (const p of problems) err("mapping", null, null, p);
  if (!mapping) return { ok: false, mappingConfirmed: false, errors, warnings, truncated, totals };

  // Parsed rows by entity: field -> raw value, with their file row number.
  type Row = { row: number; v: Record<string, string> };
  const parsed: Partial<Record<Entity, Row[]>> = {};

  const present = ALL_ENTITIES.filter((e) => e !== "creditNotes" || mapping.entities.creditNotes !== undefined);
  for (const e of present) {
    const spec = mapping.entities[e]!;
    const src = input.files[e];
    if (!src) {
      err(spec.file, null, null, `file for ${e} was not supplied`);
      continue;
    }
    const fname = src.name;
    if (fname !== spec.file) err(fname, null, null, `file name "${fname}" does not match the mapping (${spec.file})`);
    if (src.bytes.length === 0) {
      err(fname, null, null, "file is empty");
      continue;
    }
    const dec = decodeBytes(src.bytes);
    if ("error" in dec) {
      err(fname, null, null, dec.error);
      continue;
    }
    if (dec.encoding === "windows-1252") warn(fname, null, null, "not valid UTF-8: read as Windows-1252 (check accented names on screen before importing)");
    if (mapping.encoding && mapping.encoding !== dec.encoding) {
      err(fname, null, null, `detected encoding ${dec.encoding} but the mapping says ${mapping.encoding}`);
    }
    const detected = detectDelimiter(dec.text);
    const delimiter = mapping.delimiter ?? detected;
    if (!delimiter) {
      err(fname, 1, null, "cannot detect a single delimiter in the header row");
      continue;
    }
    if (mapping.delimiter && detected && detected !== mapping.delimiter) {
      err(fname, 1, null, `detected delimiter ${JSON.stringify(detected)} but the mapping says ${JSON.stringify(mapping.delimiter)}`);
    }
    const csv = parseCsv(dec.text, delimiter);
    if (csv.error) {
      err(fname, null, null, csv.error);
      continue;
    }
    const [header, ...body] = csv.records;
    if (!header) {
      err(fname, null, null, "file has no header row");
      continue;
    }
    if (csv.trailingBlankRows) warn(fname, null, null, `${csv.trailingBlankRows} empty row${csv.trailingBlankRows === 1 ? "" : "s"} at the end of the file (every field blank, as Excel leaves them) ignored`);
    const heads = header.map((h) => h.trim());
    const idx: Record<string, number> = {};
    let headerOk = true;
    for (const [field, name] of Object.entries(spec.columns)) {
      const hits = heads.flatMap((h, i) => (h === name.trim() ? [i] : []));
      if (hits.length === 0) {
        err(fname, 1, field, `required column "${name}" is not in the header`);
        headerOk = false;
      } else if (hits.length > 1) {
        err(fname, 1, field, `column "${name}" appears more than once in the header`);
        headerOk = false;
      } else idx[field] = hits[0];
    }
    totals.entities[e] = {
      file: fname,
      sha256: hash(src.bytes),
      bytes: src.bytes.length,
      rows: body.length,
      encoding: dec.encoding,
      bom: dec.bom,
      delimiter,
      lineEnding: detectLineEnding(dec.text),
      moneyPence: {},
    };
    if (!headerOk) continue;
    const rows: Row[] = [];
    body.forEach((rec, i) => {
      const row = i + 2;
      if (rec.every((x) => x.trim() === "")) {
        err(fname, row, null, "row is empty (every field blank) with data after it: delete the empty row and save the file again");
        return;
      }
      if (rec.length !== heads.length) {
        err(fname, row, null, `row has ${rec.length} fields but the header has ${heads.length}`);
        return;
      }
      const v: Record<string, string> = {};
      for (const [field, ix] of Object.entries(idx)) v[field] = rec[ix].trim();
      rows.push({ row, v });
    });
    parsed[e] = rows;
  }

  // A file set with headers but not one data row anywhere (candidate 2F, F4): nothing to import, most likely an export cut short.
  const read = present.map((e) => totals.entities[e]).filter((t): t is EntityTotals => t !== undefined);
  if (read.length === present.length && read.every((t) => t.rows === 0)) {
    err("files", null, null, "every file has its header row but no data rows: there is nothing to import. Check the export was not cut short and export again.");
  }

  const fileOf = (e: Entity) => totals.entities[e]?.file ?? mapping.entities[e]!.file;
  const dateFormat = mapping.dateFormat;

  /** Required text present; duplicate key / duplicate whole row detection. */
  const checkBlank = (e: Entity, r: Row) => {
    for (const f of FIELDS[e].required) if (r.v[f] === "") err(fileOf(e), r.row, f, "required value is blank");
  };
  const checkDupKeys = (e: Entity, field: string, norm: (s: string) => string = (s) => s) => {
    const seen = new Map<string, number>();
    for (const r of parsed[e] ?? []) {
      const val = r.v[field];
      if (!val) continue;
      const k = norm(val);
      const first = seen.get(k);
      if (first !== undefined) err(fileOf(e), r.row, field, `duplicate ${field} "${val}" (first at row ${first})`);
      else seen.set(k, r.row);
    }
  };

  for (const e of ["customers", "suppliers"] as const) {
    for (const r of parsed[e] ?? []) checkBlank(e, r);
    // Keys case-insensitively (C1 and c1 are one account to a person), and names as Tolra matches them (import_norm_name): two
    // accounts with the same name would be one customer to an invoice, which names its customer, so they are refused, not merged.
    checkDupKeys(e, "key", (s) => s.toUpperCase());
    checkDupKeys(e, "name", normaliseName);
  }

  // Invoices
  const invoiceTotals = new Map<string, { gross: number; row: number; date: string | null }>();
  const customerKeys = new Set((parsed.customers ?? []).map((r) => r.v.key).filter(Boolean));
  const invoices = parsed.invoices;
  if (invoices) {
    const f = fileOf("invoices");
    let grossSum = 0;
    let netSum = 0;
    let vatSum = 0;
    const hasNet = "net" in (mapping.entities.invoices.columns);
    const hasVat = "vat" in (mapping.entities.invoices.columns);
    const custOk = parsed.customers !== undefined;
    const custre = mapping.invoiceRefPattern ? compileRefShape(mapping.invoiceRefPattern) : null;
    const prefixes = new Map<string, number>();
    for (const r of invoices) {
      checkBlank("invoices", r);
      const d = parseDate(r.v.date, dateFormat);
      if (r.v.date !== "" && !d.ok) err(f, r.row, "date", d.reason);
      const g = r.v.gross === "" ? null : parsePence(r.v.gross);
      if (g && !g.ok) err(f, r.row, "gross", g.reason);
      else if (g && g.value < 0) err(f, r.row, "gross", "negative invoice total (credit notes are not part of this file set)");
      else if (g) {
        grossSum += g.value;
        if (g.value === 0) warn(f, r.row, "gross", `invoice "${r.v.ref}" has a zero total`);
        if (r.v.ref !== "") invoiceTotals.set(r.v.ref.toUpperCase(), invoiceTotals.get(r.v.ref.toUpperCase()) ?? { gross: g.value, row: r.row, date: d.ok ? d.value : null });
      }
      let n: number | null = null;
      let v: number | null = null;
      if (hasNet && r.v.net !== "") {
        const p = parsePence(r.v.net);
        if (!p.ok) err(f, r.row, "net", p.reason);
        else {
          n = p.value;
          netSum += n;
        }
      }
      if (hasVat && r.v.vat !== "") {
        const p = parsePence(r.v.vat);
        if (!p.ok) err(f, r.row, "vat", p.reason);
        else {
          v = p.value;
          vatSum += v;
        }
      }
      if (n !== null && v !== null && g && g.ok && n + v !== g.value) err(f, r.row, "gross", `net ${n} + vat ${v} pence does not equal gross ${g.value} pence`);
      if (custOk && r.v.customerKey !== "" && !customerKeys.has(r.v.customerKey)) {
        err(f, r.row, "customerKey", `customer "${r.v.customerKey}" is not in the customers file`);
      }
      if (r.v.ref !== "") {
        if (custre) {
          if (!custre.test(r.v.ref)) err(f, r.row, "ref", `invoice ref "${r.v.ref}" does not match the confirmed pattern`);
        } else {
          const m = REF_SHAPE.exec(r.v.ref);
          if (!m) err(f, r.row, "ref", `invoice ref "${r.v.ref}" is not a prefix followed by digits`);
          // Case-sensitive (candidate 2F): "INV-100" and "inv-102" are two families, as the database's INV rule ('^INV-') reads them.
          else prefixes.set(m[1], (prefixes.get(m[1]) ?? 0) + 1);
        }
      }
    }
    checkDupKeys("invoices", "ref", (s) => s.toUpperCase());
    if (!custre && prefixes.size > 1) {
      const main = [...prefixes.entries()].sort((a, b) => b[1] - a[1])[0][0];
      for (const r of invoices) {
        const m = REF_SHAPE.exec(r.v.ref);
        if (m && m[1] !== main) err(f, r.row, "ref", `invoice ref "${r.v.ref}" has prefix "${m[1]}" but most refs use "${main}"`);
      }
    }
    const t = totals.entities.invoices;
    if (t) {
      t.moneyPence.gross = grossSum;
      if (hasNet) t.moneyPence.net = netSum;
      if (hasVat) t.moneyPence.vat = vatSum;
    }
  }

  // Payments (per invoice, in pence, kept for the credit-note check below)
  const perInvoice = new Map<string, number>();
  const payments = parsed.payments;
  if (payments) {
    const f = fileOf("payments");
    let sum = 0;
    const wholeRows = new Map<string, number>();
    const hasKey = "key" in mapping.entities.payments.columns;
    for (const r of payments) {
      checkBlank("payments", r);
      const d = parseDate(r.v.date, dateFormat);
      if (r.v.date !== "" && !d.ok) err(f, r.row, "date", d.reason);
      const a = r.v.amount === "" ? null : parsePence(r.v.amount);
      if (a && !a.ok) err(f, r.row, "amount", a.reason);
      else if (a && a.value <= 0) err(f, r.row, "amount", "payment amount must be greater than zero");
      else if (a) sum += a.value;
      if (!hasKey) {
        // Normalised, not raw text: "10" and "10.00", "1/2/2026" and "01/02/2026" are the same payment.
        const k = `${r.v.invoiceRef.toUpperCase()}|${d.ok ? d.value : r.v.date}|${a && a.ok ? a.value : r.v.amount}`;
        const first = wholeRows.get(k);
        if (first !== undefined) err(f, r.row, null, `duplicate payment row (same invoice, date and amount as row ${first})`);
        else wholeRows.set(k, r.row);
      }
      if (r.v.invoiceRef !== "" && invoices) {
        const inv = invoiceTotals.get(r.v.invoiceRef.toUpperCase());
        if (!inv) err(f, r.row, "invoiceRef", `payment references invoice "${r.v.invoiceRef}" which is not in the invoices file`);
        else {
          // The early-date warning is separate (candidate 2F, F1): an early payment still counts towards its invoice's paid total and
          // the overpayment and credits-over-total checks.
          if (d.ok && inv.date && d.value < inv.date) warn(f, r.row, "date", `payment dated ${d.value}, before its invoice "${r.v.invoiceRef}" (${inv.date})`);
          if (a && a.ok && a.value > 0) {
            const next = (perInvoice.get(r.v.invoiceRef.toUpperCase()) ?? 0) + a.value;
            perInvoice.set(r.v.invoiceRef.toUpperCase(), next);
            if (next > inv.gross) err(f, r.row, "amount", `payments for invoice "${r.v.invoiceRef}" total ${next} pence, more than the invoice total ${inv.gross} pence`);
          }
        }
      }
    }
    if (hasKey) checkDupKeys("payments", "key");
    const t = totals.entities.payments;
    if (t) t.moneyPence.amount = sum;
  }

  // Credit notes (optional file; IMPORT-CREDIT-NOTES.md option 1: each one an issued credit note applied in full to one invoice).
  const credits = parsed.creditNotes;
  if (credits) {
    const f = fileOf("creditNotes");
    const hasNet = "net" in (mapping.entities.creditNotes?.columns ?? {});
    const hasVat = "vat" in (mapping.entities.creditNotes?.columns ?? {});
    const hasAllocated = "allocated" in (mapping.entities.creditNotes?.columns ?? {});
    const perInvoiceCredit = new Map<string, number>();
    let sum = 0;
    for (const r of credits) {
      checkBlank("creditNotes", r);
      const d = parseDate(r.v.date, dateFormat);
      if (r.v.date !== "" && !d.ok) err(f, r.row, "date", d.reason);
      const g = r.v.gross === "" ? null : parsePence(r.v.gross);
      if (g && !g.ok) err(f, r.row, "gross", g.reason);
      else if (g && g.value <= 0) err(f, r.row, "gross", "credit note total must be greater than zero (state the sign convention in the mapping if SliQ writes credits negative)");
      else if (g) sum += g.value;
      let n: number | null = null;
      let v: number | null = null;
      if (hasNet && r.v.net !== "") { const x = parsePence(r.v.net); if (!x.ok) err(f, r.row, "net", x.reason); else n = x.value; }
      if (hasVat && r.v.vat !== "") { const x = parsePence(r.v.vat); if (!x.ok) err(f, r.row, "vat", x.reason); else v = x.value; }
      if (n !== null && v !== null && g && g.ok && n + v !== g.value) err(f, r.row, "gross", `net ${n} + vat ${v} pence does not equal gross ${g.value} pence`);
      if (hasAllocated && g && g.ok) {
        const al = parsePence(r.v.allocated ?? "");
        if (!al.ok || al.value !== g.value) err(f, r.row, "allocated", "credit note is not applied in full to one invoice: a person must decide (part-applied, spread over invoices or unapplied credit is not imported)");
      }
      if (r.v.reason && r.v.reason.length > 500) err(f, r.row, "reason", "reason is longer than 500 characters");
      if (r.v.ref.length > 60) err(f, r.row, "ref", "credit note number is longer than 60 characters");
      if (r.v.ref !== "" && invoiceTotals.has(r.v.ref.toUpperCase())) err(f, r.row, "ref", `credit note number "${r.v.ref}" is also an invoice number`);
      const inv = r.v.invoiceRef === "" ? undefined : invoiceTotals.get(r.v.invoiceRef.toUpperCase());
      if (r.v.invoiceRef !== "" && !inv) err(f, r.row, "invoiceRef", `credit note is against invoice "${r.v.invoiceRef}" which is not in the invoices file`);
      else if (inv && g && g.ok && g.value > 0) {
        const key = r.v.invoiceRef.toUpperCase();
        const next = (perInvoiceCredit.get(key) ?? 0) + g.value;
        perInvoiceCredit.set(key, next);
        const paid = perInvoice.get(key) ?? 0;
        if (next + paid > inv.gross) err(f, r.row, "gross", `credits ${next} + payments ${paid} pence for invoice "${r.v.invoiceRef}" are more than its total ${inv.gross} pence (customer credit is not imported: a person must decide)`);
        if (d.ok && inv.date && d.value < inv.date) warn(f, r.row, "date", `credit note dated ${d.value}, before its invoice "${r.v.invoiceRef}" (${inv.date})`);
      }
    }
    checkDupKeys("creditNotes", "ref", (s2) => s2.toUpperCase());
    const t = totals.entities.creditNotes;
    if (t) t.moneyPence.gross = sum;
  }

  // Dates: when every date could be read day-first or month-first, the format is only as good as a person's look at one row.
  let dateSample: ValidationReport["dateSample"];
  if (dateFormat !== "YYYY-MM-DD") {
    const raws: string[] = [];
    for (const e of ["invoices", "payments", "creditNotes"] as const) for (const r of parsed[e] ?? []) if (r.v.date) raws.push(r.v.date);
    const ambiguous = raws.length > 0 && raws.every((raw) => {
      const m = /^(\d{1,2})\D(\d{1,2})\D\d{4}$/.exec(raw.trim());
      return m !== null && Number(m[1]) <= 12 && Number(m[2]) <= 12;
    });
    const sample = mapping.dateSample;
    if (sample) {
      const d = parseDate(sample.raw, dateFormat);
      const ent = (["invoices", "payments", "creditNotes"] as const).find((e) => totals.entities[e]?.file === sample.file);
      const row = ent ? (parsed[ent] ?? []).find((r) => r.row === sample.row) : undefined;
      if (!d.ok || d.value !== sample.means) err("mapping", null, "dateSample", `the signed-off example "${sample.raw}" does not read as ${sample.means} in ${dateFormat}`);
      else if (!row || row.v.date !== sample.raw.trim()) err("mapping", null, "dateSample", `the signed-off example is not the date in ${sample.file} row ${sample.row}`);
      else dateSample = { raw: sample.raw, means: sample.means, confirmedBy: sample.confirmedBy };
    } else if (ambiguous) {
      err("mapping", null, "dateFormat", `every date could be day-first or month-first: add mapping.dateSample (a row John has signed off) before ${dateFormat} is trusted`);
    }
  }

  const ok = errors.length === 0 && !truncated && mappingConfirmed;
  return { ok, mappingConfirmed, errors, warnings, ...(dateSample ? { dateSample } : {}), truncated, totals };
}
