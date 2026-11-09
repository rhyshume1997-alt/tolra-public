/**
 * SliQ go-live import (p152): the confirmed SliQ export files -> the payload import_sliq_preflight / import_sliq_batch read.
 *
 * validateAndBuild runs lib/sliq-validate's validateSliqExport first (every file check, in the browser) and builds only when it is
 * ok; it reads the files the same way (decodeBytes, the mapping's or detected delimiter, parseCsv, the mapping's columns, parseDate,
 * parsePence) and assumes nothing about SliQ's real headers, encoding or date format. Browser-safe: Web Crypto, no node: imports.
 *
 * The source key: SHA-256 of the lines "<entity>:<file sha256>" sorted by entity, joined with "\n". p152 recomputes it from the
 * per-file hashes sent with every call, so every batch's audit row names the original files it came from.
 */
import { decodeBytes, detectDelimiter, parseCsv } from "@/lib/sliq-validate/csv";
import { parseDate, parsePence, penceToString } from "@/lib/sliq-validate/values";
import { type Entity, type SliqMapping, type SourceFiles, type ValidationReport, normaliseName, validateSliqExport } from "@/lib/sliq-validate/validate";
import type { SliqPayload, SliqRow } from "@/lib/sliq-import-route";
import type { SourceTotals } from "@/lib/sliq-reconcile/reconcile";

export type SourceFileHash = { entity: Entity; name: string; sha256: string };

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return hex(await crypto.subtle.digest("SHA-256", data as BufferSource));
}

/** The text the source key is the SHA-256 of (and p152 checks): sorted "<entity>:<sha256>" lines. */
export const sourceKeyText = (files: SourceFileHash[]) => [...files].map((f) => `${f.entity}:${f.sha256}`).sort().join("\n");

export async function hashSourceFiles(files: SourceFiles): Promise<SourceFileHash[]> {
  const out: SourceFileHash[] = [];
  for (const [entity, f] of Object.entries(files) as [Entity, { name: string; bytes: Uint8Array }][]) {
    if (f) out.push({ entity, name: f.name, sha256: await sha256Hex(f.bytes) });
  }
  return out.sort((a, b) => (a.entity < b.entity ? -1 : 1));
}

type Rows = { row: number; v: Record<string, string> }[];

function readRows(file: { name: string; bytes: Uint8Array }, mapping: SliqMapping, entity: Entity): Rows {
  const dec = decodeBytes(file.bytes);
  if ("error" in dec) throw new Error(`${file.name}: ${dec.error}`);
  const delimiter = mapping.delimiter ?? detectDelimiter(dec.text);
  if (!delimiter) throw new Error(`${file.name}: no delimiter`);
  const csv = parseCsv(dec.text, delimiter);
  if (csv.error) throw new Error(`${file.name}: ${csv.error}`);
  const [header, ...body] = csv.records;
  const heads = (header ?? []).map((h) => h.trim());
  const spec = mapping.entities[entity];
  if (!spec) throw new Error(`the mapping has no ${entity}`);
  const idx = Object.entries(spec.columns).map(([field, name]) => [field, heads.indexOf(name.trim())] as const);
  for (const [field, i] of idx) if (i < 0) throw new Error(`${file.name}: column for ${field} is missing`);
  body.forEach((rec, i) => { if (rec.length !== heads.length) throw new Error(`${file.name} row ${i + 2}: ${rec.length} fields, the header has ${heads.length}`); });
  return body.map((rec, i) => ({ row: i + 2, v: Object.fromEntries(idx.map(([field, ix]) => [field, (rec[ix] ?? "").trim()])) }));
}

const money = (raw: string) => {
  const p = parsePence(raw);
  if (!p.ok) throw new Error(p.reason);
  return penceToString(p.value);
};

/**
 * The payload: customers and suppliers (account code as source row id and external_ref), invoices (number as written; the customer's
 * name from the customers file, looked up by ACCOUNT CODE; status "sent", as 076 sets paid / part paid from the payments), payments
 * (the receipt key, when mapped, as source id and as the payment's reference; else invoice|date|amount|ordinal), credit notes (issued,
 * applied in full to their invoice by 085). Throws on anything the validator would have refused: use validateAndBuild.
 */
export async function buildSliqPayload(files: SourceFiles, mapping: SliqMapping): Promise<{ payload: SliqPayload; sourceFiles: SourceFileHash[] }> {
  if ((mapping as { confirmed?: unknown }).confirmed !== true) throw new Error("The mapping is not confirmed: nothing is built from it.");
  for (const e of ["customers", "suppliers", "invoices", "payments"] as const) if (!files[e]) throw new Error(`The ${e} file is missing.`);
  if (mapping.entities.creditNotes && !files.creditNotes) throw new Error("The credit notes file is missing.");
  const sourceFiles = await hashSourceFiles(files);
  const payload: SliqPayload = { source_sha256: await sha256Hex(sourceKeyText(sourceFiles)), source_files: sourceFiles };
  const get = (e: Entity) => (files[e] ? readRows(files[e]!, mapping, e) : []);

  const customers = get("customers");
  const nameByKey = new Map(customers.map((r) => [r.v.key.toUpperCase(), r.v.name]));
  payload.customers = customers.map((r) => ({ source_row_id: `C:${r.v.key}`, name: r.v.name, external_ref: r.v.key }));
  payload.suppliers = get("suppliers").map((r) => ({ source_row_id: `S:${r.v.key}`, name: r.v.name, external_ref: r.v.key }));

  const refByUpper = new Map<string, string>();
  payload.invoices = get("invoices").map((r) => {
    const d = parseDate(r.v.date, mapping.dateFormat);
    if (!d.ok) throw new Error(`invoices row ${r.row}: ${d.reason}`);
    // By account code, never by a name the invoice file may carry: a renamed customer can't move an invoice to another account.
    const customer = nameByKey.get(r.v.customerKey.toUpperCase());
    if (!customer) throw new Error(`invoices row ${r.row}: customer ${r.v.customerKey} is not in the customers file`);
    refByUpper.set(r.v.ref.toUpperCase(), r.v.ref);
    const row: SliqRow = { source_row_id: `I:${r.v.ref}`, invoice_ref: r.v.ref, customer, customer_key: r.v.customerKey, invoice_date: d.value, total: money(r.v.gross), status: "sent" };
    if (r.v.net !== undefined && r.v.net !== "") row.subtotal = money(r.v.net);
    if (r.v.vat !== undefined && r.v.vat !== "") row.vat = money(r.v.vat);
    return row;
  });

  const seen = new Map<string, number>();
  payload.payments = get("payments").map((r) => {
    const d = parseDate(r.v.date, mapping.dateFormat);
    if (!d.ok) throw new Error(`payments row ${r.row}: ${d.reason}`);
    const ref = refByUpper.get(r.v.invoiceRef.toUpperCase()) ?? r.v.invoiceRef;
    const amount = money(r.v.amount);
    if (r.v.key) return { source_row_id: `P:${r.v.key}`, invoice_ref: ref, paid_on: d.value, amount, reference: r.v.key };
    const base = `${ref.toUpperCase()}|${d.value}|${amount}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { source_row_id: `P:${base}|${n}`, invoice_ref: ref, paid_on: d.value, amount };
  });

  if (mapping.entities.creditNotes) {
    payload.credit_notes = get("creditNotes").map((r) => {
      const d = parseDate(r.v.date, mapping.dateFormat);
      if (!d.ok) throw new Error(`credit notes row ${r.row}: ${d.reason}`);
      const row: SliqRow = { source_row_id: `N:${r.v.ref}`, credit_ref: r.v.ref, invoice_ref: refByUpper.get(r.v.invoiceRef.toUpperCase()) ?? r.v.invoiceRef,
        credit_date: d.value, total: money(r.v.gross), status: "issued" };
      if (r.v.net) row.subtotal = money(r.v.net);
      if (r.v.vat) row.vat = money(r.v.vat);
      if (r.v.reason) row.reason = r.v.reason;
      return row;
    });
  }
  return { payload, sourceFiles };
}

const SECTIONS = [["customers", "customers"], ["suppliers", "suppliers"], ["invoices", "invoices"], ["payments", "payments"], ["creditNotes", "credit_notes"]] as const;

/**
 * Where the built payload does not match the validator's report (candidate 2F, final pass): every file's row count per section
 * (suppliers included: the database's reconciliation does not count them, so this is their only count check), and every file's
 * name and SHA-256 (64 hex characters, the very hash the file checks recorded; the signing sheet prints these). Empty when it matches.
 */
export function payloadReportProblems(report: ValidationReport, payload: SliqPayload): string[] {
  const out: string[] = [];
  const t = report.totals.entities;
  for (const [e, k] of SECTIONS) {
    const rows = t[e]?.rows;
    const built = (payload[k] ?? []).length;
    if (rows === undefined ? built !== 0 : built !== rows) out.push(`${e}: the files have ${rows ?? 0} rows but ${built} were built to send`);
  }
  const named = new Set<string>();
  for (const f of payload.source_files ?? []) {
    named.add(f.entity);
    const r = t[f.entity as Entity];
    if (!/^[0-9a-f]{64}$/.test(String(f.sha256)) || !r || r.sha256 !== f.sha256 || r.file !== f.name) out.push(`${f.name}: its SHA-256 is not the one the file checks recorded`);
  }
  for (const e of Object.keys(t)) if (!named.has(e)) out.push(`${e}: the file checked is not among the files sent`);
  return out;
}

/** Every file check (lib/sliq-validate, in the browser), then the payload, only when the report is ok and the payload matches it. */
export async function validateAndBuild(files: SourceFiles, mapping: unknown): Promise<{ report: ValidationReport; payload: SliqPayload | null }> {
  const report = await validateSliqExport({ files, mapping });
  if (!report.ok) return { report, payload: null };
  const { payload } = await buildSliqPayload(files, mapping as SliqMapping);
  const problems = payloadReportProblems(report, payload);
  if (problems.length) {
    return { report: { ...report, ok: false, errors: [...report.errors, ...problems.map((reason) => ({ file: "build", row: null, field: null, reason: `${reason}: nothing can be imported` }))] }, payload: null };
  }
  return { report, payload };
}

/** An invoice number the INV counter follows: exactly the database's '^INV-(\d{1,9})$'. Any other ref is kept as written and moves no counter. */
const INV_NUMBER = /^INV-(\d{1,9})$/;

/** The per-customer key both sides use: the account code ("acct:<code>", what the route's map stores) or, without the map, the name. */
export const customerKey = (by: "account" | "name", code: string, name: string) => (by === "account" ? `acct:${code.toUpperCase()}` : `name:${normaliseName(name)}`);

/**
 * lib/sliq-reconcile's SourceTotals from the VALIDATOR's report and the payload built from the same files (adapter, review D1 item 1).
 * Counts and money come from the report (rows, moneyPence), and must agree with the payload or this throws. Outstanding follows the
 * app (034): per invoice greatest(0, total - paid - credited) (SliQ files carry no refunds, no void or draft invoices), the excess as
 * customer credit; per customer net (owed - credit), keyed as customerKey says.
 */
export function sourceTotalsFromValidated(report: ValidationReport, payload: SliqPayload, by: "account" | "name" = "account"): SourceTotals {
  if (!report.ok) throw new Error("The validator's report is not ok: no source totals are made from it.");
  const pence = (v: unknown) => {
    const p = parsePence(String(v ?? ""));
    if (!p.ok) throw new Error(p.reason);
    return p.value;
  };
  const t = report.totals.entities;
  const invoices = payload.invoices ?? [];
  const payments = payload.payments ?? [];
  const credits = payload.credit_notes ?? [];
  const check = (what: string, a: number, b: number) => { if (a !== b) throw new Error(`source totals: ${what} is ${a} in the validator's report but ${b} in the payload`); };
  check("customers", t.customers?.rows ?? 0, (payload.customers ?? []).length);
  check("invoices", t.invoices?.rows ?? 0, invoices.length);
  check("payments", t.payments?.rows ?? 0, payments.length);
  check("credit notes", t.creditNotes?.rows ?? 0, credits.length);
  const invoiceTotalPence = t.invoices?.moneyPence.gross ?? 0;
  const paymentsTotalPence = t.payments?.moneyPence.amount ?? 0;
  const creditsTotalPence = t.creditNotes?.moneyPence.gross ?? 0;
  check("invoice total", invoiceTotalPence, invoices.reduce((s, i) => s + pence(i.total), 0));
  check("payments total", paymentsTotalPence, payments.reduce((s, p) => s + pence(p.amount), 0));
  check("credits total", creditsTotalPence, credits.reduce((s, c) => s + pence(c.total), 0));
  // Suppliers and the file hashes the sheet prints (candidate 2F, final pass).
  const problems = payloadReportProblems(report, payload);
  if (problems.length) throw new Error(`source totals: ${problems.join("; ")}`);

  const sumBy = (list: SliqRow[], field: string) => {
    const m = new Map<string, number>();
    for (const x of list) m.set(String(x.invoice_ref).toUpperCase(), (m.get(String(x.invoice_ref).toUpperCase()) ?? 0) + pence(x[field]));
    return m;
  };
  const paidBy = sumBy(payments, "amount");
  const creditBy = sumBy(credits, "total");
  const customerBalancesPence: Record<string, number> = {};
  let outstandingPence = 0;
  let customerCreditPence = 0;
  const nums: number[] = [];
  let notInv = 0;
  for (const i of invoices) {
    const ref = String(i.invoice_ref).toUpperCase();
    const left = pence(i.total) - (paidBy.get(ref) ?? 0) - (creditBy.get(ref) ?? 0);
    outstandingPence += Math.max(0, left);
    customerCreditPence += Math.max(0, -left);
    const k = customerKey(by, String(i.customer_key ?? ""), String(i.customer));
    customerBalancesPence[k] = (customerBalancesPence[k] ?? 0) + left;
    // The INV-number rule the database uses (076/085's INV counter, import_sliq_reconcile_rows): only "INV-<1..9 digits>", as written.
    const m = INV_NUMBER.exec(String(i.invoice_ref));
    if (m) nums.push(Number(m[1]));
    else notInv += 1;
  }
  return {
    files: payload.source_files.map((f) => ({ name: f.name, sha256: f.sha256 })),
    counts: { customers: t.customers?.rows ?? 0, invoices: invoices.length, payments: payments.length, credit_notes: credits.length },
    invoiceTotalPence,
    paymentsTotalPence,
    creditsTotalPence,
    refundsTotalPence: 0,
    excludedInvoices: 0,
    outstandingPence,
    customerCreditPence,
    customerBalancesPence,
    ...(nums.length ? { invoiceRefMin: Math.min(...nums), invoiceRefMax: Math.max(...nums) } : {}),
    invoiceRefsNotInvFormat: notInv,
  };
}
