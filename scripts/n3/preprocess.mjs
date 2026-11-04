// REHEARSAL COPY: fresh, synthetic-only report preprocessor for N3's small public fixtures.
// Independently written for this rehearsal. No private source, CLI, real-data support or production-import approval.
const invoiceHeaders = ["Type", "Num", "Date", "Customer", "Net Total", "VAT", "Total"];
const paymentHeaders = ["Payment Date", "Payment Method", "Customer", "Num", "Payment Net", "VAT", "Payment Amount"];
const quoteHeaders = ["Num", "Date", "Status", "Invoice", "Net Total", "VAT", "Total"];
export function parseCsv(text) {
  const rows = []; let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === "," || c === "\n" || c === "\r")) {
      row.push(cell); cell = "";
      if (c !== ",") { rows.push(row); row = []; if (c === "\r" && text[i + 1] === "\n") i++; }
    } else cell += c;
  }
  if (quoted) throw new Error("Unclosed CSV quote");
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}
const csv = rows => rows.map(r => r.map(c => `"${String(c).replaceAll('"', '""')}"`).join(",")).join("\r\n");
function pence(value) {
  if (!/^-?\d+\.\d{2}$/.test(value)) throw new Error("Money needs exact pence");
  const n = Number(value.replace(".", ""));
  if (!Number.isSafeInteger(n)) throw new Error("Money outside rehearsal range");
  return n;
}
const pounds = n => `${n < 0 ? "-" : ""}${Math.floor(Math.abs(n) / 100)}.${String(Math.abs(n) % 100).padStart(2, "0")}`;
function date(value) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!m) throw new Error("Date must be dd/mm/yyyy");
  const [, d, mo, y] = m; const v = new Date(Date.UTC(+y, +mo - 1, +d));
  if (v.getUTCFullYear() !== +y || v.getUTCMonth() !== +mo - 1 || v.getUTCDate() !== +d) throw new Error("Invalid date");
  return `${y}-${mo}-${d}`;
}
export function preprocess(text, opts = {}) {
  const rows = parseCsv(text), same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (opts.kind === "invoices" && rows.some(r => same(r, quoteHeaders))) throw new Error("Quotes are not Invoices");
  if (!["invoices", "payments"].includes(opts.kind)) throw new Error("Only synthetic invoice/payment reports supported");
  const headers = opts.kind === "invoices" ? invoiceHeaders : paymentHeaders;
  const hits = rows.flatMap((r, i) => same(r, headers) ? [i] : []);
  if (hits.length !== 1) throw new Error("Need one unambiguous report header");
  const h = hits[0], records = [], totals = [], counts = {
    inputRows: rows.length, rowsAboveAndIncludingHeader: h + 1, blankRows: 0, groupRows: 0,
    totalsRows: 0, records: 0, rejected: 0, out: 0, held: 0,
  };
  for (const r of rows.slice(h + 1)) {
    const cells = r.filter(c => c.trim());
    if (!cells.length) { counts.blankRows++; continue; }
    if (totals.length) throw new Error("Unexpected row after totals");
    if (r[0] === "Total") { totals.push(...[4, 5, 6].map(i => pence(r[i]))); counts.totalsRows++; continue; }
    if (cells.length === 1 && r[0] === "Year 2026") { counts.groupRows++; continue; }
    if (r.length !== headers.length) throw new Error("Unexpected report row");
    date(r[opts.kind === "invoices" ? 2 : 0]);
    records.push(r);
  }
  if (counts.totalsRows !== 1) throw new Error("Missing totals");
  for (let i = 0; i < 3; i++) if (records.reduce((n, r) => n + pence(r[i + 4]), 0) !== totals[i]) throw new Error("Totals do not reconcile");
  const flags = [], files = {}, reconciliation = Object.fromEntries([4, 5, 6].map(i => [headers[i], { equal: true }]));
  counts.records = records.length;
  if (opts.kind === "invoices") {
    const keys = records.map(r => r[1].trim().toLowerCase());
    if (keys.some(k => !k) || new Set(keys).size !== keys.length) throw new Error("Invoice numbers not unique; repeated or conflicting number");
    const out = [], held = [];
    for (const r of records) {
      if (!["Inv", "Crd"].includes(r[0])) throw new Error("Unknown invoice type");
      if (pence(r[4]) + pence(r[5]) !== pence(r[6])) throw new Error("Invoice money mismatch");
      if (r[0] === "Crd") { held.push([r[1], "", r[3], date(r[2]), ...r.slice(4).map(v => pounds(Math.abs(pence(v))))]); continue; }
      if ([4, 5, 6].some(i => pence(r[i]) < 0)) throw new Error("Negative invoice");
      out.push([r[1], date(r[2]), r[3], ...r.slice(4)]);
    }
    files["invoices.csv"] = csv([["Invoice number", "Invoice date", "Customer", "Net", "VAT", "Total"], ...out]);
    if (held.length) files["held-credit_notes.csv"] = csv([["Credit note number", "Invoice number", "Customer", "Credit note date", "Net", "VAT", "Total"], ...held]);
    counts.out = out.length; counts.held = held.length;
  } else {
    if (!opts.invoicesClean) throw new Error("Payments need clean invoices");
    const invoices = new Map(parseCsv(opts.invoicesClean).slice(1).map(r => [r[0], r]));
    const out = [], held = [], methods = { "Bank Transfer": "BACS", "Cash": "cash" };
    for (const r of records) {
      if (pence(r[4]) + pence(r[5]) !== pence(r[6]) || pence(r[6]) < 0) throw new Error("Payment money mismatch");
      if (!invoices.has(r[3]) || !methods[r[1]]) { held.push(r); continue; }
      out.push([r[3], date(r[0]), r[6], methods[r[1]]]);
    }
    files["payments.csv"] = csv([["Invoice number", "Date paid", "Amount", "Method"], ...out]);
    if (held.length) files["held-payments.csv"] = csv([headers, ...held]);
    counts.out = out.length; counts.held = held.length;
  }
  if (counts.records !== counts.out + counts.held) throw new Error("Held/output count mismatch");
  return { files, flags, counts, reconciliation };
}
