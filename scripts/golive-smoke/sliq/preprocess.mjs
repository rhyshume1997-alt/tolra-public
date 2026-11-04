// Pre-processor for SliQ report-style exports -> the Admin > Data importer's payload (public.import_company_data, 076/085), written
// fresh for the public repo from the rules in the private mapping docs (SLIQ-REPORT-FILES-IMPORT-MAPPING-2026-11-04 section 2,
// SLIQ-CUSTOMERS-IMPORT-MAPPING-2026-11-04 section 2). No private code. Nothing is guessed: a row it can't read is a refusal with its
// row number, and a refusal of a date refuses the WHOLE file.
//
//   * the header row is found by name (every expected header in one row, within the first 30; none or two is a refusal);
//   * blank and group-header rows (one text cell, no amount) are skipped; the totals row ("Total", "Totals", "Grand total") is taken
//     aside and checked against the sum of the records in every money column to the penny; any row after it is refused;
//   * a Quotes report offered as invoices is refused (its header has Status and Invoice, not Type and Customer);
//   * dates dd/mm/yyyy only: 31/02/2026, 12/31/2025, 01/02/26 and ISO dates are refused, never read month-first;
//   * money as integer pence (optional £, minus or brackets, thousands commas, at most 2 decimals);
//   * VAT-inclusive totals: Net + VAT = Total on every row (a mismatch is refused); VAT not 20% of Net is listed, never changed;
//   * credit notes ("Crd") become positive credit notes linked to the invoice John names (credit-links.csv); one without a link is
//     held out and listed, never netted into an invoice;
//   * payments: Num -> invoice_ref, the method mapped explicitly (unknown methods refused), Net + VAT = Amount checked;
//   * customers: an e-mail cell with several addresses is split: the first valid one is the e-mail, the others go to the notes
//     ("Other e-mails: ..."); a cell with no valid address keeps its text in the notes ("E-mail as in SliQ: ...") and is listed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class Refused extends Error {
  constructor(message, rows = []) { super(message); this.name = "Refused"; this.rows = rows; }
}

/** RFC 4180 CSV (quotes, doubled quotes, commas and newlines inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** dd/mm/yyyy -> YYYY-MM-DD, or null when it is not a real date written that way. */
export function parseUkDate(value) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return null;
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (d > days) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

/** "£1,234.50", "-£12.00", "(3.20)", "12" -> integer pence, or null when it is not money as written (12.345, 1,23, 1.234,50). */
export function parsePence(value) {
  let s = String(value ?? "").trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1).trim(); }
  s = s.replace(/^£/, "");
  if (s.startsWith("-")) { negative = !negative; s = s.slice(1); }
  if (!/^(\d{1,3}(,\d{3})*|\d+)(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.replaceAll(",", "").split(".");
  const pence = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return negative ? -pence : pence;
}

export const poundsText = (pence) => `${pence < 0 ? "-" : ""}${Math.floor(Math.abs(pence) / 100)}.${String(Math.abs(pence) % 100).padStart(2, "0")}`;
export const vat20 = (pence) => Math.sign(pence) * Math.floor((Math.abs(pence) * 20 + 50) / 100);

const norm = (s) => String(s ?? "").trim().toLowerCase();

/** The one row (0-based) within the first 30 that holds every expected header; refused when there is none or more than one. */
export function findHeader(rows, expected) {
  const want = expected.map(norm);
  const hits = [];
  rows.slice(0, 30).forEach((row, i) => { const cells = row.map(norm); if (want.every((h) => cells.includes(h))) hits.push(i); });
  if (hits.length === 0) throw new Refused(`no header row with all of: ${expected.join(", ")}`);
  if (hits.length > 1) throw new Refused(`more than one header row (rows ${hits.map((i) => i + 1).join(", ")})`);
  return hits[0];
}

const TOTAL_LABELS = new Set(["total", "totals", "grand total"]);

/**
 * The records of a report-style sheet. Returns { header, records: [{ row, cells }], skipped: { blank, group }, totals, reconciliation }.
 * moneyCols: header names whose sum must equal the totals row. keyCol: the record key (Num).
 */
export function stripReport(text, { expected, keyCol, moneyCols, dateCols = [] }) {
  const rows = parseCsv(text);
  const h = findHeader(rows, expected);
  const header = rows[h].map((c) => String(c).trim());
  const col = Object.fromEntries(header.map((c, i) => [norm(c), i]));
  const at = (cells, name) => String(cells[col[norm(name)]] ?? "").trim();
  const records = [];
  const skipped = { blank: 0, group: 0 };
  const rejected = [];
  let totals = null;
  for (let i = h + 1; i < rows.length; i++) {
    const cells = rows[i];
    const filled = cells.map((c) => String(c).trim()).filter(Boolean);
    if (filled.length === 0) { skipped.blank++; continue; }
    if (totals) { rejected.push({ row: i + 1, reason: "a row after the totals row" }); continue; }
    const label = norm(cells.find((c) => String(c).trim()) ?? "");
    const hasMoney = moneyCols.some((m) => at(cells, m) !== "");
    if (TOTAL_LABELS.has(label) && (at(cells, keyCol) === "" || TOTAL_LABELS.has(norm(at(cells, keyCol))) || TOTAL_LABELS.has(norm(cells[0])))) {
      totals = { row: i + 1, cells };
      continue;
    }
    if (filled.length === 1 && !hasMoney) { skipped.group++; continue; }
    if (!at(cells, keyCol)) { rejected.push({ row: i + 1, reason: `no ${keyCol}` }); continue; }
    if (dateCols.some((d) => !at(cells, d))) { rejected.push({ row: i + 1, reason: "no date" }); continue; }
    if (!hasMoney) { rejected.push({ row: i + 1, reason: "no amount" }); continue; }
    records.push({ row: i + 1, cells, get: (name) => at(cells, name) });
  }
  if (rejected.length) throw new Refused(`${rejected.length} row(s) can't be read`, rejected);
  if (!totals) throw new Refused("no totals row: the report may be cut short");
  const reconciliation = moneyCols.map((m) => {
    const sum = records.reduce((a, r) => a + (parsePence(r.get(m)) ?? 0), 0);
    const stated = parsePence(String(totals.cells[col[norm(m)]] ?? ""));
    return { column: m, sum, stated, equal: sum === stated };
  });
  const bad = reconciliation.filter((r) => !r.equal);
  if (bad.length) throw new Refused(`the records don't add up to the totals row: ${bad.map((b) => `${b.column} ${poundsText(b.sum)} vs ${b.stated === null ? "unreadable" : poundsText(b.stated)}`).join("; ")}`);
  return { header, headerRow: h + 1, records, skipped, totals, reconciliation };
}

/** Dates of every record in `cols`; ANY bad date refuses the whole file (nothing is imported from it). */
function datesOrRefuse(records, cols) {
  const bad = [];
  for (const r of records) for (const c of cols) if (!parseUkDate(r.get(c))) bad.push({ row: r.row, reason: `${c} "${r.get(c)}" is not a real dd/mm/yyyy date` });
  if (bad.length) throw new Refused(`invalid dates: the whole file is refused (${bad.length} row(s))`, bad);
}

function moneyOrRefuse(records, cols) {
  const bad = [];
  for (const r of records) for (const c of cols) if (parsePence(r.get(c)) === null) bad.push({ row: r.row, reason: `${c} "${r.get(c)}" is not money in pounds and pence` });
  if (bad.length) throw new Refused(`unreadable amounts (${bad.length} row(s))`, bad);
}

const INVOICE_HEADERS = ["Type", "Num", "Date", "Customer", "Net Total", "VAT", "Total"];
const QUOTE_HEADERS = ["Num", "Date", "Status", "Invoice", "Net Total", "VAT", "Total"];

/** Invoices report -> invoices and credit notes. creditLinks: Map Crd Num -> invoice Num (John's list). */
export function prepareInvoices(text, creditLinks = new Map()) {
  const rows = parseCsv(text);
  // A Quotes report has Num, Date, Net Total, VAT and Total too; offered as invoices it would become invoices keyed by its own numbers.
  let isQuotes = false;
  try { findHeader(rows, QUOTE_HEADERS); isQuotes = true; } catch { /* not a quotes header */ }
  if (isQuotes) throw new Refused("this is a Quotes report (Status and Invoice columns), not invoices: refused as invoices");
  const sheet = stripReport(text, { expected: INVOICE_HEADERS, keyCol: "Num", moneyCols: ["Net Total", "VAT", "Total"], dateCols: ["Date"] });
  datesOrRefuse(sheet.records, ["Date"]);
  moneyOrRefuse(sheet.records, ["Net Total", "VAT", "Total"]);
  const otherTypes = sheet.records.filter((r) => !["inv", "crd"].includes(norm(r.get("Type"))));
  if (otherTypes.length) throw new Refused(`rows that are neither Inv nor Crd`, otherTypes.map((r) => ({ row: r.row, reason: `Type "${r.get("Type")}"` })));
  const keys = sheet.records.map((r) => r.get("Num"));
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupes.length) throw new Refused(`the same Num twice: ${[...new Set(dupes)].join(", ")}`);
  const sumMismatch = [];
  const notTwentyPct = [];
  const invoices = [], creditNotes = [], heldOut = [];
  for (const r of sheet.records) {
    const net = parsePence(r.get("Net Total")), vat = parsePence(r.get("VAT")), total = parsePence(r.get("Total"));
    if (net + vat !== total) { sumMismatch.push({ row: r.row, num: r.get("Num") }); continue; }
    if (vat !== vat20(net)) notTwentyPct.push(r.get("Num"));
    const date = parseUkDate(r.get("Date"));
    if (norm(r.get("Type")) === "inv") {
      if (total < 0) { sumMismatch.push({ row: r.row, num: r.get("Num"), reason: "negative invoice" }); continue; }
      invoices.push({ row: r.row, invoice_ref: r.get("Num"), customer: r.get("Customer"), invoice_date: date, subtotal: poundsText(net), vat: poundsText(vat), total: poundsText(total) });
    } else {
      const link = creditLinks.get(r.get("Num"));
      // SliQ writes a credit note negative; Tolra keeps it positive, as its own record, applied to the invoice it credits.
      const credit = { row: r.row, credit_ref: r.get("Num"), customer: r.get("Customer"), credit_date: date, subtotal: poundsText(Math.abs(net)), vat: poundsText(Math.abs(vat)), total: poundsText(Math.abs(total)) };
      if (link) creditNotes.push({ ...credit, invoice_ref: link });
      else heldOut.push({ ...credit, reason: "no invoice link supplied: held out and listed, never netted into an invoice" });
    }
  }
  if (sumMismatch.length) throw new Refused(`Net + VAT is not Total (or a negative invoice)`, sumMismatch);
  return { invoices, creditNotes, heldOut, checks: { notTwentyPct, headerRow: sheet.headerRow, skipped: sheet.skipped, reconciliation: sheet.reconciliation } };
}

const METHODS = new Map([["bacs", "BACS"], ["bank transfer", "BACS"], ["cheque", "cheque"], ["check", "cheque"], ["card", "card"], ["cash", "cash"], ["other", "other"]]);

export function preparePayments(text) {
  const sheet = stripReport(text, { expected: ["Payment Date", "Payment Method", "Customer", "Num", "Payment Net", "VAT", "Payment Amount"], keyCol: "Num", moneyCols: ["Payment Net", "VAT", "Payment Amount"], dateCols: ["Payment Date"] });
  datesOrRefuse(sheet.records, ["Payment Date"]);
  moneyOrRefuse(sheet.records, ["Payment Net", "VAT", "Payment Amount"]);
  const bad = [];
  const payments = [];
  for (const r of sheet.records) {
    const method = METHODS.get(norm(r.get("Payment Method")));
    const net = parsePence(r.get("Payment Net")), vat = parsePence(r.get("VAT")), amount = parsePence(r.get("Payment Amount"));
    if (!method) { bad.push({ row: r.row, reason: `method "${r.get("Payment Method")}" is not mapped` }); continue; }
    if (net + vat !== amount) { bad.push({ row: r.row, reason: "Payment Net + VAT is not Payment Amount" }); continue; }
    if (amount <= 0) { bad.push({ row: r.row, reason: "not a positive amount" }); continue; }
    payments.push({ row: r.row, invoice_ref: r.get("Num"), paid_on: parseUkDate(r.get("Payment Date")), amount: poundsText(amount), method });
  }
  if (bad.length) throw new Refused(`payment rows refused`, bad);
  return { payments, checks: { headerRow: sheet.headerRow, skipped: sheet.skipped, reconciliation: sheet.reconciliation } };
}

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

/** One customer e-mail cell -> { email, notes, listed } (the split rule; nothing valid is dropped). */
export function splitEmails(cell) {
  const raw = String(cell ?? "").trim();
  if (!raw) return { email: null, notes: [], listed: false };
  const tokens = raw.split(/[;,\s]+/).filter(Boolean);
  const valid = tokens.filter((t) => EMAIL.test(t));
  if (!valid.length) return { email: null, notes: [`E-mail as in SliQ: ${raw}`], listed: true };
  return { email: valid[0], notes: valid.length > 1 ? [`Other e-mails: ${valid.slice(1).join(", ")}`] : [], listed: false };
}

export function prepareCustomers(text) {
  const rows = parseCsv(text);
  const h = findHeader(rows, ["Business", "Email"]);
  const header = rows[h].map(norm);
  const at = (cells, name) => String(cells[header.indexOf(norm(name))] ?? "").trim();
  const customers = [];
  const listed = [];
  for (let i = h + 1; i < rows.length; i++) {
    const cells = rows[i];
    if (!cells.some((c) => String(c).trim())) continue;
    const name = at(cells, "Business");
    if (!name) throw new Refused(`customer row ${i + 1} has no Business name`);
    const split = splitEmails(at(cells, "Email"));
    if (split.listed) listed.push({ row: i + 1, name });
    const acct = at(cells, "Account Number");
    const notes = [...(acct ? [`SliQ account: ${acct}`] : []), ...split.notes];
    customers.push({ row: i + 1, name, ...(split.email ? { email: split.email } : {}), ...(at(cells, "Phone") ? { phone: at(cells, "Phone") } : {}), ...(acct ? { external_ref: acct } : {}), ...(notes.length ? { notes: notes.join("\n") } : {}) });
  }
  return { customers, listed };
}

/** The whole folder of synthetic exports -> { payload, report } for public.import_company_data. Throws Refused on any refusal. */
export function prepareFolder(dir) {
  const read = (f) => readFileSync(path.join(dir, f), "utf8");
  const links = new Map(parseCsv(read("credit-links.csv")).slice(1).filter((r) => r[0]).map((r) => [r[0].trim(), r[1].trim()]));
  const customers = prepareCustomers(read("customers.csv"));
  const inv = prepareInvoices(read("invoices-report.csv"), links);
  const pay = preparePayments(read("payments-report.csv"));
  const known = new Set(inv.invoices.map((i) => i.invoice_ref));
  const orphanPayments = pay.payments.filter((p) => !known.has(p.invoice_ref));
  if (orphanPayments.length) throw new Refused("payments for invoices not in this file", orphanPayments.map((p) => ({ row: p.row, reason: p.invoice_ref })));
  const strip = (record) => { const rest = { ...record }; delete rest.row; return rest; };
  return {
    payload: {
      customers: customers.customers.map(strip),
      invoices: inv.invoices.map(strip),
      payments: pay.payments.map(strip),
      credit_notes: inv.creditNotes.map(strip),
    },
    report: { listedCustomers: customers.listed, heldOut: inv.heldOut, invoiceChecks: inv.checks, paymentChecks: pay.checks },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = process.argv[2];
  try {
    const { payload, report } = prepareFolder(dir);
    console.log(JSON.stringify({ counts: Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, v.length])), report }, null, 2));
  } catch (e) {
    console.error(`REFUSED: ${e.message}`);
    for (const r of e.rows ?? []) console.error(`  row ${r.row}: ${r.reason}`);
    process.exit(1);
  }
}
