/**
 * SliQ go-live import (p152): the confirmed SliQ export files -> the payload import_sliq_preflight / import_sliq_batch read.
 *
 * Runs after lib/sliq-validate's validateSliqExport has answered ok for the same files and the same CONFIRMED mapping: this reads
 * the files the same way (decodeBytes, the mapping's or detected delimiter, parseCsv, the mapping's columns, parseDate, parsePence)
 * and assumes nothing about SliQ's real headers, encoding or date format. Browser-safe: hashes with WebCrypto, no node: imports.
 *
 * The source key: SHA-256 of the lines "<entity>:<file sha256>" sorted by entity, joined with "\n". p152 recomputes it from the
 * per-file hashes sent with every call, so every batch's audit row names the original files it came from.
 */
import { decodeBytes, detectDelimiter, parseCsv } from "@/lib/sliq-validate/csv";
import { parseDate, parsePence, penceToString } from "@/lib/sliq-validate/values";
import type { Entity, SliqMapping, SourceFiles } from "@/lib/sliq-validate/validate";
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
  const idx = Object.entries(mapping.entities[entity].columns).map(([field, name]) => [field, heads.indexOf(name.trim())] as const);
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
 * name from the customers file; status "sent", as 076 sets paid / part paid from the payments), payments (the receipt key when the
 * mapping has one, else invoice|date|amount|ordinal, the validator's own duplicate rule). Throws on anything the validator would
 * have refused: call it only after validateSliqExport(...).ok.
 */
export async function buildSliqPayload(files: SourceFiles, mapping: SliqMapping): Promise<{ payload: SliqPayload; sourceFiles: SourceFileHash[] }> {
  if ((mapping as { confirmed?: unknown }).confirmed !== true) throw new Error("The mapping is not confirmed: nothing is built from it.");
  for (const e of ["customers", "suppliers", "invoices", "payments"] as const) if (!files[e]) throw new Error(`The ${e} file is missing.`);
  const sourceFiles = await hashSourceFiles(files);
  const payload: SliqPayload = { source_sha256: await sha256Hex(sourceKeyText(sourceFiles)), source_files: sourceFiles };
  const get = (e: Entity) => (files[e] ? readRows(files[e]!, mapping, e) : []);

  const customers = get("customers");
  const nameByKey = new Map(customers.map((r) => [r.v.key, r.v.name]));
  payload.customers = customers.map((r) => ({ source_row_id: `C:${r.v.key}`, name: r.v.name, external_ref: r.v.key }));
  payload.suppliers = get("suppliers").map((r) => ({ source_row_id: `S:${r.v.key}`, name: r.v.name, external_ref: r.v.key }));

  const refByUpper = new Map<string, string>();
  payload.invoices = get("invoices").map((r) => {
    const d = parseDate(r.v.date, mapping.dateFormat);
    if (!d.ok) throw new Error(`invoices row ${r.row}: ${d.reason}`);
    const customer = nameByKey.get(r.v.customerKey);
    if (!customer) throw new Error(`invoices row ${r.row}: customer ${r.v.customerKey} is not in the customers file`);
    refByUpper.set(r.v.ref.toUpperCase(), r.v.ref);
    const row: SliqRow = { source_row_id: `I:${r.v.ref}`, invoice_ref: r.v.ref, customer, invoice_date: d.value, total: money(r.v.gross), status: "sent" };
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
    let id = r.v.key ? `P:${r.v.key}` : "";
    if (!id) {
      const base = `${ref.toUpperCase()}|${d.value}|${amount}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      id = `P:${base}|${n}`;
    }
    return { source_row_id: id, invoice_ref: ref, paid_on: d.value, amount };
  });
  return { payload, sourceFiles };
}

/**
 * lib/sliq-reconcile's SourceTotals from the payload this route sends (so the reconciliation compares the database with exactly what
 * was imported). Money in whole pence. Outstanding = invoiced - paid (no credits: this route imports none), as sliq_reconcile.sql
 * computes it; per customer by name. The invoice number range is the digits after the shared prefix.
 */
export function sourceTotalsFromPayload(payload: SliqPayload) {
  const pence = (v: unknown) => {
    const p = parsePence(String(v ?? ""));
    if (!p.ok) throw new Error(p.reason);
    return p.value;
  };
  const invoices = payload.invoices ?? [];
  const payments = payload.payments ?? [];
  const paidByRef = new Map<string, number>();
  for (const p of payments) paidByRef.set(String(p.invoice_ref), (paidByRef.get(String(p.invoice_ref)) ?? 0) + pence(p.amount));
  const customerBalancesPence: Record<string, number> = {};
  let invoiceTotalPence = 0;
  const nums: number[] = [];
  for (const i of invoices) {
    const total = pence(i.total);
    invoiceTotalPence += total;
    const name = String(i.customer);
    customerBalancesPence[name] = (customerBalancesPence[name] ?? 0) + total - (paidByRef.get(String(i.invoice_ref)) ?? 0);
    const m = /(\d+)$/.exec(String(i.invoice_ref));
    if (m) nums.push(Number(m[1]));
  }
  const paymentsTotalPence = payments.reduce((s, p) => s + pence(p.amount), 0);
  return {
    files: payload.source_files.map((f) => ({ name: f.name, sha256: f.sha256 })),
    counts: { customers: (payload.customers ?? []).length, invoices: invoices.length, payments: payments.length, credit_notes: 0 },
    invoiceTotalPence,
    paymentsTotalPence,
    creditsTotalPence: 0,
    outstandingPence: invoiceTotalPence - paymentsTotalPence,
    customerBalancesPence,
    ...(nums.length ? { invoiceRefMin: Math.min(...nums), invoiceRefMax: Math.max(...nums) } : {}),
  } satisfies SourceTotals;
}
