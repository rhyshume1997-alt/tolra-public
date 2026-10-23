// The Tolra snapshot: a plain JSON copy of the Tolra tables this reconciliation needs, produced LATER by a separate, reviewed
// step (not built here). This module only reads files, checks their shape and turns money into integer pence and quantities into
// thousandths. Nothing is guessed:
//   * a table that is not in the snapshot is "not supplied" (the comparison for it is UNVERIFIED), never "empty";
//   * a column that is not in a table's rows is "not supplied", while a column that is null is "known to be empty";
//   * any value that does not parse exactly (a money figure with more than two decimals, a bad date) stops the load.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { fingerprint, safeFile, stripQuoted } from "./safe.mjs";
import { ParseError, parseMoneyPence, parseQuantityMilli } from "../sliq-import/parse.mjs";

export const SNAPSHOT_FORMAT = "tolra-snapshot/1";

export class SnapshotError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = "SnapshotError";
    this.problems = problems;
  }
}

// type: text | id | money | qty | int | date | bool | json-less. `required` columns must be in every table that is supplied.
const T = (type, required = false) => ({ type, required });
export const TABLES = {
  meta: null, // handled separately
  customers: { id: T("id", true), name: T("text", true), status: T("text") },
  suppliers: { id: T("id", true), name: T("text", true), status: T("text") },
  legacy_import_map: { source: T("text", true), old_id: T("text", true), new_id: T("id", true) },
  invoices: {
    id: T("id", true), invoice_ref: T("text", true), customer: T("text"), subtotal: T("money"), vat: T("money"), total: T("money", true), status: T("text"),
    invoice_date: T("date"), due_date: T("date"), amount_paid: T("money"), credited_amount: T("money"), refunded_amount: T("money"),
    payment_unverified: T("bool"), vat_enabled: T("bool"), job_id: T("id"),
  },
  invoice_line_items: { id: T("id"), invoice_id: T("id", true), position: T("int"), description: T("text"), quantity: T("qty"), unit_price: T("money"), vat_pct: T("pct"), vat_exempt: T("bool") },
  invoice_payments: { id: T("id", true), invoice_id: T("id", true), amount: T("money", true), paid_on: T("date"), method: T("text"), reference: T("text"), source: T("text"), reverses_payment_id: T("id") },
  credit_notes: { id: T("id", true), invoice_id: T("id"), credit_ref: T("text"), status: T("text"), customer: T("text"), subtotal: T("money"), vat: T("money"), total: T("money", true), allocated_amount: T("money") },
  invoice_credit_allocations: { id: T("id"), invoice_id: T("id", true), credit_note_id: T("id", true), amount: T("money", true), allocated_on: T("date") },
  customer_credit_ledger: { id: T("id"), kind: T("text", true), invoice_id: T("id", true), to_invoice_id: T("id"), amount: T("money", true), paid_on: T("date") },
  quotes: { id: T("id", true), quote_ref: T("text", true), customer: T("text"), total_value: T("money"), status: T("text"), valid_until: T("date") },
  sales_orders: {
    id: T("id", true), so_number: T("text", true), customer: T("text"), status: T("text"), total_value: T("money"), order_date: T("date"), delivery_date: T("date"),
    quote_ref: T("text"), customer_po: T("text"), converted_to_job_id: T("id"),
  },
  jobs: {
    id: T("id", true), job_no: T("text", true), customer: T("text"), stage: T("text"), status: T("text"), quantity_required: T("qty"), value: T("money"),
    converted_from_sales_order_id: T("id"), finished_at: T("date"), due_date: T("date"),
  },
  // Not a Tolra table: one derived row per job, produced by the later snapshot step from the worksheet, inspections and rework
  // records. A null quantity means "Tolra cannot say", and is reported as UNVERIFIED, never as zero.
  job_quantities: { job_id: T("id", true), quantity_made: T("qty"), quantity_accepted: T("qty"), quantity_rejected: T("qty"), quantity_reworked: T("qty") },
  delivery_notes: { id: T("id", true), dn_number: T("text", true), sales_order_id: T("id"), job_id: T("id"), invoice_id: T("id"), status: T("text"), delivery_date: T("date") },
  delivery_note_items: { id: T("id"), delivery_note_id: T("id", true), quantity: T("qty", true), description: T("text"), sales_order_line_id: T("id") },
  purchase_orders: { id: T("id", true), po_ref: T("text", true), supplier: T("text"), total_value: T("money"), status: T("text"), order_date: T("date"), expected_delivery: T("date") },
  // Not in the Tolra schema today (migration 037): payables and opening balances. Defined so the comparison is ready when a
  // place for them exists; until then they are simply absent from the snapshot and the source figures are UNVERIFIED.
  supplier_bills: { bill_ref: T("text", true), supplier: T("text", true), total: T("money", true), outstanding: T("money") },
  opening_balances: { party_type: T("text", true), party_ref: T("text", true), document_ref: T("text"), amount: T("money", true) },
};

export const SNAPSHOT_TABLES = Object.keys(TABLES).filter((t) => TABLES[t]);

// Company isolation. Every Tolra table that belongs to a company carries organization_id; a snapshot is for ONE company
// (meta.organization_id). A row of another company, or a row that does not say which company it belongs to, is never compared:
// it is taken out of the data and reported as a BLOCKER finding (never silently dropped).
export const ORG_TABLES = SNAPSHOT_TABLES.filter((t) => t !== "legacy_import_map" && t !== "job_quantities");
for (const t of ORG_TABLES) TABLES[t].organization_id = { type: "id", required: false };
TABLES.legacy_import_map.organization_id = { type: "id", required: false }; // not a column today; checked if a producer adds it

// child table . column -> parent table: a row pointing at a parent that belongs to another company is a cross-company join.
const JOINS = [
  ["invoices", "job_id", "jobs"], ["invoice_line_items", "invoice_id", "invoices"], ["invoice_payments", "invoice_id", "invoices"],
  ["invoice_payments", "reverses_payment_id", "invoice_payments"], ["credit_notes", "invoice_id", "invoices"],
  ["invoice_credit_allocations", "invoice_id", "invoices"], ["invoice_credit_allocations", "credit_note_id", "credit_notes"],
  ["customer_credit_ledger", "invoice_id", "invoices"], ["customer_credit_ledger", "to_invoice_id", "invoices"],
  ["sales_orders", "converted_to_job_id", "jobs"], ["jobs", "converted_from_sales_order_id", "sales_orders"], ["job_quantities", "job_id", "jobs"],
  ["delivery_notes", "sales_order_id", "sales_orders"], ["delivery_notes", "job_id", "jobs"], ["delivery_notes", "invoice_id", "invoices"],
  ["delivery_note_items", "delivery_note_id", "delivery_notes"],
];
// legacy_import_map.source -> the table its new_id points into
const MAP_TARGET = { customers: "customers", suppliers: "suppliers", invoices: "invoices", quotes: "quotes", purchase_orders: "purchase_orders", sliq_payments: "invoice_payments" };
// document-number columns, for number collisions across companies
const REF_COLUMN = { invoices: "invoice_ref", quotes: "quote_ref", credit_notes: "credit_ref", sales_orders: "so_number", jobs: "job_no", delivery_notes: "dn_number", purchase_orders: "po_ref", supplier_bills: "bill_ref" };

const orgFp = (v) => `org-${fingerprint(String(v ?? "").toLowerCase())}`;

/** Takes foreign / unlabelled rows out of out.tables and records them in out.isolation. Mutates `out`. */
function isolate(out) {
  const findings = [];
  const quarantined = {}; // table -> Set of ids taken out
  const note = (f) => findings.push(f);
  const mine = out.organizationId;
  const take = (table, row, finding) => {
    (quarantined[table] ??= new Set()).add(row.id ?? `#${row._i}`);
    note({ table, row: row._i, id: row.id ?? null, ref: REF_COLUMN[table] ? row[REF_COLUMN[table]] ?? null : null, ...finding });
  };
  // 1. the company column
  const orgValues = new Set();
  for (const table of [...ORG_TABLES, "legacy_import_map"]) {
    const rows = out.tables[table];
    if (!rows) continue;
    const carries = out.columns[table].has("organization_id");
    if (rows.length > 0 && !carries) {
      if (table !== "legacy_import_map") note({ table, code: "table_without_company", severity: "UNVERIFIED" });
      continue;
    }
    for (const r of rows) if (r.organization_id) orgValues.add(String(r.organization_id).toLowerCase());
  }
  if (!mine) {
    if (orgValues.size > 1) note({ table: "(all)", code: "mixed_companies_no_meta", severity: "BLOCKER", companies: orgValues.size });
    else note({ table: "(all)", code: "no_company_declared", severity: "UNVERIFIED" });
  }
  for (const table of [...ORG_TABLES, "legacy_import_map"]) {
    const rows = out.tables[table];
    if (!rows || !out.columns[table].has("organization_id")) continue;
    out.tables[table] = rows.filter((r) => {
      const org = r.organization_id;
      if (org === null || org === undefined || org === "") {
        take(table, r, { code: "row_without_company", severity: "BLOCKER" });
        return false;
      }
      if (mine && String(org).toLowerCase() !== mine) {
        take(table, r, { code: "foreign_company_row", severity: "BLOCKER", company: orgFp(org), expected: orgFp(mine) });
        return false;
      }
      return true;
    });
  }
  // 2. cross-company joins: a child pointing at a parent that was taken out (repeat: a child's child points at it in turn)
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const [child, col, parent] of JOINS) {
      const rows = out.tables[child];
      const gone = quarantined[parent];
      if (!rows || !gone || !gone.size) continue;
      out.tables[child] = rows.filter((r) => {
        const v = r[col];
        if (v === null || v === undefined || !gone.has(v)) return true;
        take(child, r, { code: "cross_company_join", severity: "BLOCKER", column: col, parent });
        changed = true;
        return false;
      });
    }
    const map = out.tables.legacy_import_map;
    if (map) {
      out.tables.legacy_import_map = map.filter((r) => {
        const target = MAP_TARGET[r.source];
        if (!target || !quarantined[target]?.has(r.new_id)) return true;
        take("legacy_import_map", r, { code: "cross_company_join", severity: "BLOCKER", column: "new_id", parent: target });
        changed = true;
        return false;
      });
    }
    if (!changed) break;
  }
  // 3. a number that exists in this company and also on a foreign row; a duplicated id
  for (const [table, col] of Object.entries(REF_COLUMN)) {
    const kept = new Set((out.tables[table] ?? []).map((r) => r[col]).filter(Boolean));
    for (const f of findings) if (f.table === table && f.code === "foreign_company_row" && f.ref && kept.has(f.ref)) note({ table, row: f.row, id: f.id, ref: f.ref, code: "cross_company_number", severity: "BLOCKER" });
  }
  for (const table of [...ORG_TABLES]) {
    const seen = new Set();
    for (const r of out.tables[table] ?? []) {
      if (r.id === undefined || r.id === null) continue;
      if (seen.has(r.id)) note({ table, row: r._i, id: r.id, code: "duplicate_id", severity: "BLOCKER" });
      seen.add(r.id);
    }
  }
  out.isolation = { companyDeclared: !!mine, findings };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function convertCell(type, v, where, problems) {
  if (v === null) return null;
  try {
    switch (type) {
      case "text":
        if (typeof v !== "string") throw new ParseError(`expected text, got ${typeof v}`);
        return v;
      case "id":
        if (typeof v !== "string" && typeof v !== "number") throw new ParseError("expected an id (text)");
        return String(v);
      case "money":
        if (typeof v !== "string" && typeof v !== "number") throw new ParseError("expected a money figure");
        return parseMoneyPence(typeof v === "number" ? (Number.isFinite(v) ? String(v) : "x") : v);
      case "qty":
        if (typeof v !== "string" && typeof v !== "number") throw new ParseError("expected a quantity");
        return parseQuantityMilli(typeof v === "number" ? String(v) : v);
      case "int":
        if (!Number.isInteger(v)) throw new ParseError("expected a whole number");
        return v;
      case "pct": {
        // vat_pct is NUMERIC(5,2): a percentage such as 20 or 5.00, kept as hundredths of a percent.
        if (typeof v !== "string" && typeof v !== "number") throw new ParseError("expected a percentage");
        const s = String(v);
        if (!/^\d{1,3}(\.\d{1,2})?$/.test(s)) throw new ParseError("is not a percentage with at most two decimals");
        const [i, f = ""] = s.split(".");
        return Number(i) * 100 + Number(f.padEnd(2, "0"));
      }
      case "date": {
        if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(v)) throw new ParseError("expected an ISO date (YYYY-MM-DD)");
        const day = v.slice(0, 10);
        const d = new Date(`${day}T00:00:00Z`);
        if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== day) throw new ParseError("is not a real calendar date");
        return day;
      }
      case "bool":
        if (typeof v !== "boolean") throw new ParseError("expected true or false");
        return v;
      default:
        throw new ParseError(`unknown type ${type}`);
    }
  } catch (e) {
    if (!(e instanceof ParseError)) throw e;
    problems.push({ ...where, problem: stripQuoted(e.message) });
    return null;
  }
}

/** Reads one raw snapshot (the parsed JSON: { meta?, tables }) into typed tables. */
export function buildSnapshot(raw, label) {
  const problems = [];
  const tables = raw?.tables ?? {};
  if (typeof tables !== "object" || Array.isArray(tables) || tables === null) throw new SnapshotError(`${label}: "tables" must be an object of arrays.`);
  const meta = raw?.meta ?? {};
  if (meta.format !== undefined && meta.format !== SNAPSHOT_FORMAT) throw new SnapshotError(`${label}: meta.format is not ${SNAPSHOT_FORMAT}.`);
  if (meta.organization_id !== undefined && meta.organization_id !== null && !UUID.test(String(meta.organization_id))) {
    throw new SnapshotError(`${label}: meta.organization_id is not a UUID.`);
  }
  const out = { format: SNAPSHOT_FORMAT, organizationId: meta.organization_id ? String(meta.organization_id).toLowerCase() : null, tables: {}, columns: {}, supplied: new Set(), ignored: [], poTotalBasis: ["net", "gross"].includes(meta.purchase_order_total_basis) ? meta.purchase_order_total_basis : null };
  for (const name of Object.keys(tables).sort()) {
    const spec = TABLES[name];
    if (!spec) {
      out.ignored.push(name);
      continue;
    }
    const rows = tables[name];
    if (!Array.isArray(rows)) {
      problems.push({ table: name, problem: "must be an array of rows" });
      continue;
    }
    const known = new Set(Object.keys(spec));
    const present = new Set();
    const typed = rows.map((r, i) => {
      if (r === null || typeof r !== "object" || Array.isArray(r)) {
        problems.push({ table: name, row: i + 1, problem: "a row must be an object" });
        return {};
      }
      const t = { _i: i + 1 };
      for (const [col, v] of Object.entries(r)) {
        if (!known.has(col)) continue; // extra columns are ignored, never read
        if (v === undefined) continue;
        present.add(col);
        t[col] = convertCell(spec[col].type, v, { table: name, row: i + 1, column: col }, problems);
      }
      return t;
    });
    if (rows.length > 0) {
      for (const [col, def] of Object.entries(spec)) {
        if (def.required && !present.has(col)) problems.push({ table: name, column: col, problem: "required column is not in the snapshot rows" });
      }
    }
    out.tables[name] = typed;
    out.columns[name] = present;
    out.supplied.add(name);
  }
  if (problems.length > 0) {
    const shown = problems.slice(0, 25).map((p) => `  - ${p.table}${p.row ? ` row ${p.row}` : ""}${p.column ? ` column ${p.column}` : ""}: ${p.problem}`);
    throw new SnapshotError(`${label} cannot be read as a ${SNAPSHOT_FORMAT} snapshot (${problems.length} problem(s)):\n${shown.join("\n")}${problems.length > 25 ? "\n  ..." : ""}\nNothing was compared.`, problems);
  }
  isolate(out);
  return out;
}

/**
 * Loads a snapshot from a single JSON file ({ meta, tables }) or a folder: meta.json plus one <table>.json per table (each an
 * array of rows). Returns { snapshot, files: [{ file, sha256, bytes }] } so the report can state exactly what was read.
 */
export async function loadSnapshot(target) {
  const { createHash } = await import("node:crypto");
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  if (!existsSync(target)) throw new SnapshotError("The Tolra snapshot was not found.");
  const read = (file) => {
    const bytes = readFileSync(file);
    try {
      return { json: JSON.parse(bytes.toString("utf8")), info: { file: safeFile(path.basename(file)), sha256: sha(bytes), bytes: bytes.length } };
    } catch {
      throw new SnapshotError(`${safeFile(path.basename(file))} is not valid JSON.`);
    }
  };
  if (statSync(target).isFile()) {
    const { json, info } = read(target);
    return { snapshot: buildSnapshot(json, info.file), files: [info] };
  }
  const names = readdirSync(target).filter((f) => f.endsWith(".json")).sort();
  const raw = { meta: {}, tables: {} };
  const files = [];
  for (const f of names) {
    const base = f.slice(0, -5);
    if (base !== "meta" && !TABLES[base]) continue;
    const { json, info } = read(path.join(target, f));
    files.push(info);
    if (base === "meta") raw.meta = json;
    else raw.tables[base] = json;
  }
  const ignored = names.map((f) => f.slice(0, -5)).filter((b) => b !== "meta" && !TABLES[b]);
  if (files.length === 0) throw new SnapshotError(`Tolra snapshot folder has no <table>.json files (expected for example invoices.json, customers.json).`);
  const snapshot = buildSnapshot(raw, "the snapshot folder");
  snapshot.ignored.push(...ignored);
  snapshot.ignored.sort();
  return { snapshot, files };
}
