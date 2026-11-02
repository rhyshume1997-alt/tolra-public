#!/usr/bin/env node
// Generates a SYNTHETIC SliQ export set for the import rehearsal. Every name, address, number and amount is made up here from a
// fixed seed, so two runs give byte-identical files. No real data is read or needed.
//
//   node scripts/sliq-import/rehearsal/generate.mjs <out folder>
//
// Writes:
//   <out>/export/          the import files, headers as mappings/synthetic.json (the confirmed fixture mapping)
//   <out>/export-sliq/     the same records under the PROVISIONAL mappings/sliq.json headers (dry run only: a write is refused)
//   <out>/sliq-reports/aged-debtors.csv   what SliQ's Aged Debtors report would print for this data (one row per open document)
//   <out>/manifest.json    the designed truth: counts, every awkward case, expected totals, the next numbers
//
// Volumes follow the cutover plan's counts: 79 customers, 52 suppliers, 2035 invoices + 2 credit notes, 1999 payments, 36 unpaid
// (nothing paid), 1410 quotes, 144 purchase orders; next numbers INV-2315, QUO-1483, PO-0159. Awkward cases are added on top
// (see manifest.awkward) and are expected to be held, excluded or flagged, never silently imported.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { normaliseName } from "../ids.mjs";

const out = process.argv[2];
if (!out) {
  console.error("Usage: generate.mjs <out folder>");
  process.exit(2);
}

// ---- deterministic randomness -------------------------------------------------------------------------------------------------
let seed = 0x5eed2026;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

// ---- formatting ---------------------------------------------------------------------------------------------------------------
const pad = (n, w) => String(n).padStart(w, "0");
const plain = (p) => `${p < 0 ? "-" : ""}${Math.floor(Math.abs(p) / 100)}.${pad(Math.abs(p) % 100, 2)}`;
const pounds = (p) => {
  // "£1,234.56": a pound sign and thousands commas, always with two decimals (the importer refuses "1,234" as ambiguous).
  const a = Math.abs(p);
  const whole = String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${p < 0 ? "-" : ""}£${whole}.${pad(a % 100, 2)}`;
};
const money = (p, fancy) => (fancy ? pounds(p) : plain(p));
const day = (iso, unpadded = false) => {
  const [y, m, d] = iso.split("-");
  return unpadded ? `${Number(d)}/${Number(m)}/${y}` : `${d}/${m}/${y}`;
};
const addDays = (iso, n) => {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const LAST_DAY = "2026-10-30";
const minIso = (a, b) => (a < b ? a : b);
const cell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};
const csv = (headers, rows) => `${[headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
const vatOf = (net, rateCenti) => Math.round((net * rateCenti) / 10000);

// ---- customers (79) -----------------------------------------------------------------------------------------------------------
const PLACES = ["Ashby", "Brookfield", "Calderside", "Dunmore", "Elmfield", "Fernhill", "Glenrock", "Hollinwood", "Ironside", "Kestrel",
  "Larchmont", "Moorside", "Netherby", "Oakvale", "Pennant", "Quarrybank", "Ravensholme", "Sandholme", "Thornley", "Upland", "Valebridge",
  "Westgate", "Yarrowby", "Zenmoor", "Abbotsford", "Birchley", "Cranmore", "Daleview", "Eastwick", "Foxcote"];
const TRADES = ["Fabrication", "Engineering", "Precision", "Marine", "Hydraulics", "Plant Hire", "Steelwork", "Pumps", "Valves", "Tooling", "Castings", "Process"];
const FORMS = ["Ltd", "Limited", "& Co", "Ltd", "Services Ltd", "Group Ltd"];
const TOWNS = [["Testbury", "TB"], ["Sampleton", "SM"], ["Mocktown", "MK"], ["Fictionfield", "FF"], ["Placeholder Bay", "PB"]];
const FIRST = ["Alex", "Sam", "Jo", "Chris", "Pat", "Robin", "Morgan", "Jamie", "Casey", "Drew", "Ellis", "Frankie"];
const LAST = ["Archer", "Baxter", "Cole", "Dyer", "Fowler", "Garner", "Hale", "Ingram", "Joyce", "Kemp", "Lowe", "Marsh"];

const customers = [];
const usedNames = new Set();
const special = {
  10: { name: "Harbour Fabrication Ltd" },
  11: { name: "Harbour Fabrication Limited" }, // same name once "Ltd"/"Limited" is ignored: a duplicate for review, written separately
  12: { name: "Smith & Sons Engineering" },
  13: { name: "Smith and Sons Engineering" }, // "&" / "and": the same normalised name
  20: { name: "Müller Präzisionsteile GmbH", export: true }, // non-ASCII (UTF-8), an EU customer: zero-rated invoices
  21: { name: "O'Neill, Byrne & Co" }, // a comma and an apostrophe in the name (quoted CSV field)
  79: { name: "Dormant Holdings Ltd", dormant: true }, // a customer with no invoices and no quotes
};
for (let i = 1; i <= 79; i++) {
  let name = special[i]?.name;
  // Only the designed duplicates may share a normalised name ("Ltd"/"Limited", "&"/"and" ignored, as the importer compares).
  while (!name || (!special[i] && usedNames.has(normaliseName(name)))) name = `${pick(PLACES)} ${pick(TRADES)} ${pick(FORMS)}`;
  usedNames.add(normaliseName(name));
  const [town, pc] = pick(TOWNS);
  const contact = rnd() < 0.8 ? `${pick(FIRST)} ${pick(LAST)}` : "";
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "").slice(0, 18);
  customers.push({
    key: `C${pad(i, 4)}`, name, contact,
    address1: `${int(1, 199)} ${pick(["Mill Lane", "Dock Road", "Works Street", "Forge Way", "Quay Side"])}`,
    address2: rnd() < 0.3 ? `Unit ${int(1, 40)}` : "", town, postcode: `${pc}${int(1, 9)} ${int(1, 9)}${pick(["AA", "BD", "EF", "GH", "JK"])}`,
    email: rnd() < 0.85 ? `accounts@${slug}.example.test` : "", phone: rnd() < 0.8 ? `01110 ${pad(int(0, 999999), 6)}` : "",
    vat: special[i]?.export ? "DE000000000" : rnd() < 0.6 ? `GB${pad(int(0, 999999999), 9)}` : "",
    export: !!special[i]?.export, dormant: !!special[i]?.dormant,
  });
}
const active = customers.filter((c) => !c.dormant);
// A few big customers carry most of the work, as in a small engineering firm.
const weighted = active.flatMap((c, i) => Array(i < 8 ? 12 : i < 25 ? 3 : 1).fill(c));

// ---- suppliers (52) -----------------------------------------------------------------------------------------------------------
const SUPPLY = ["Steel Stockholders", "Fasteners", "Bearings", "Gases", "Abrasives", "Paints", "Tool Supply", "Plastics", "Transport", "Calibration"];
const suppliers = [];
const supNames = new Set();
for (let i = 1; i <= 52; i++) {
  let name;
  do name = `${pick(PLACES)} ${pick(SUPPLY)} ${pick(["Ltd", "Limited", "Co"])}`; while (supNames.has(name));
  supNames.add(name);
  const [town] = pick(TOWNS);
  suppliers.push({
    key: `S${pad(i, 4)}`, name, contact: rnd() < 0.7 ? `${pick(FIRST)} ${pick(LAST)}` : "", address: rnd() < 0.8 ? `${int(1, 99)} Trade Park, ${town}` : "",
    email: rnd() < 0.8 ? `sales@${name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16)}.example.test` : "", phone: rnd() < 0.7 ? `01110 ${pad(int(0, 999999), 6)}` : "",
    notes: rnd() < 0.3 ? pick(["Net 30", "Pro forma", "Account on hold if over £5,000", "Collect only"]) : "",
  });
}

// ---- document lines -------------------------------------------------------------------------------------------------------------
const PARTS = ["Machined bracket", "Flange plate", "Shaft, turned and ground", "Bush (bronze)", "Weld repair", "Pump impeller balance", "Valve body reface",
  "Keyway cut", "Bore and sleeve", "Base frame", "Gearbox overhaul", "Coupling guard", "Labour (hours)", "Carriage", "Inspection report"];
function makeLines(n, rateFn) {
  const lines = [];
  for (let i = 0; i < n; i++) {
    const half = rnd() < 0.15; // some half quantities (2.5 hours)
    const qtyMilli = half ? int(1, 8) * 1000 + 500 : int(1, 20) * 1000;
    let unit = rnd() < 0.75 ? int(500, 15000) : int(15000, 120000); // £5 to £1,200
    if (half && unit % 2) unit += 1; // keeps quantity x unit price exact to the penny
    const net = (qtyMilli * unit) / 1000;
    const rate = rateFn(i);
    lines.push({ description: pick(PARTS), qtyMilli, unit, net, rate, vat: vatOf(net, rate) });
  }
  return lines;
}
const qtyText = (m) => (m % 1000 === 0 ? String(m / 1000) : (m / 1000).toFixed(m % 100 === 0 ? 1 : 3));

// ---- invoices (2035, INV-0280 .. INV-2314) ----------------------------------------------------------------------------------------
const START = "2020-01-06";
const SPAN_DAYS = 2489; // to 2026-10-30
const N_INV = 2035;
const invoices = [];
for (let k = 0; k < N_INV; k++) {
  const number = `INV-${pad(280 + k, 4)}`;
  const date = addDays(START, Math.floor((k * SPAN_DAYS) / N_INV));
  const c = pick(weighted);
  const nLines = rnd() < 0.6 ? 1 : rnd() < 0.7 ? 2 : 3;
  const lines = makeLines(nLines, () => (c.export ? 0 : 2000));
  invoices.push({ number, date, due: addDays(date, 30), customer: c, lines, notes: "", statedLineVat: true, headerVatOverride: null, case: null });
}
// Odd dates: a leap day, a year end, dates written without leading zeros.
const odd = [];
const setCase = (inv, label) => {
  inv.case = inv.case ? `${inv.case}; ${label}` : label;
  odd.push({ number: inv.number, case: label });
};
{
  const leap = invoices.find((i) => i.date >= "2024-02-26");
  leap.date = "2024-02-29";
  leap.due = "2024-03-30";
  setCase(leap, "leap-day date 29/02/2024");
  const ye = invoices.find((i) => i.date >= "2025-12-29");
  ye.date = "2025-12-31";
  ye.due = "2026-01-30";
  setCase(ye, "year-end date 31/12/2025");
  for (const i of invoices.filter((x) => x.number.endsWith("7")).slice(0, 40)) i.unpadded = true;
  const noDue = invoices[500];
  noDue.due = null;
  setCase(noDue, "no due date");
}
// VAT edge cases.
const vatCases = [];
{
  // Zero-rated: every invoice of the EU customer is 0% (already). Record one.
  const zr = invoices.find((i) => i.customer.export);
  vatCases.push({ number: zr.number, case: "zero-rated (0%) export invoice" });
  // Mixed 20% and 5% lines.
  for (const inv of invoices.filter((i) => !i.customer.export).slice(100, 103)) {
    inv.lines = makeLines(2, (j) => (j === 0 ? 2000 : 500));
    vatCases.push({ number: inv.number, case: "mixed 20% and 5% lines" });
  }
  // VAT on the total vs per line: header VAT rounded on the total, lines rounded each (1p apart). Line VAT blank: within rounding.
  const mk = (inv, stated) => {
    inv.lines = [0, 1, 2].map(() => ({ description: "Small part", qtyMilli: 1000, unit: 1003, net: 1003, rate: 2000, vat: vatOf(1003, 2000) }));
    inv.headerVatOverride = vatOf(3 * 1003, 2000); // 6.02 on the total; the lines give 3 x 2.01 = 6.03
    inv.statedLineVat = stated;
  };
  const r1 = invoices[1200];
  mk(r1, false);
  vatCases.push({ number: r1.number, case: "header VAT on the total (6.02) vs lines rounded each (6.03); line VAT blank: within rounding, lines kept" });
  const r2 = invoices[1201];
  mk(r2, true);
  vatCases.push({ number: r2.number, case: "same 1p difference with line VAT stated: listed as unresolved VAT; header kept as stated, lines kept" });
  // A line whose stated VAT does not match its rate: the line VAT is unresolved, so the invoice gets its header only (no lines).
  const r3 = invoices[1202];
  r3.lines = [{ description: "Gearbox overhaul", qtyMilli: 1000, unit: 10000, net: 10000, rate: 2000, vat: 1500 }];
  vatCases.push({ number: r3.number, case: "line VAT 15.00 on a 100.00 line at 20%: unresolved, header only (no lines written)" });
}
for (const inv of invoices) {
  inv.net = inv.lines.reduce((a, l) => a + l.net, 0);
  inv.vat = inv.headerVatOverride ?? inv.lines.reduce((a, l) => a + l.vat, 0);
  inv.gross = inv.net + inv.vat;
}

// ---- payment state: 36 unpaid (nothing paid), 6 part paid, 1 overpaid, the rest paid in full; 1999 payment rows in all --------------
const N_UNPAID = 36;
const N_PARTIAL = 6;
const recent = invoices.slice(-28); // the latest 28 are simply not yet paid
const older = invoices.slice(0, -28).filter((i) => !i.case);
const unpaid = new Set(recent);
while (unpaid.size < N_UNPAID) unpaid.add(pick(older.slice(-600))); // 8 older ones: overdue
const partial = new Set();
while (partial.size < N_PARTIAL) {
  const c = pick(older.slice(-400));
  if (!unpaid.has(c)) partial.add(c);
}
let overpaid;
do overpaid = pick(older.slice(-900)); while (unpaid.has(overpaid) || partial.has(overpaid));
const payments = [];
const METHODS = ["BACS", "BACS", "BACS", "BACS", "BACS", "Cheque", "Card", "Cash"];
const payRef = (m) => (m === "BACS" ? `BACS ${pad(int(0, 999999), 6)}` : m === "Cheque" ? `CHQ ${int(100000, 199999)}` : rnd() < 0.5 ? "" : `${m.toUpperCase()} ${int(1000, 9999)}`);
for (const inv of invoices) {
  if (unpaid.has(inv)) {
    inv.state = "unpaid";
    inv.paid = 0;
    inv.status = "Unpaid";
    continue;
  }
  const m = pick(METHODS);
  let amount = inv.gross;
  if (partial.has(inv)) {
    amount = Math.round((inv.gross * int(30, 70)) / 100);
    inv.state = "partial";
    inv.status = "Unpaid"; // SliQ reads "Unpaid" until settled
    setCase(inv, "part paid");
  } else if (inv === overpaid) {
    amount = inv.gross + 1000; // paid £10.00 too much
    inv.state = "overpaid";
    inv.status = "Paid";
    setCase(inv, "overpaid by £10.00");
  } else {
    inv.state = "paid";
    inv.status = "Paid";
  }
  inv.paid = amount;
  const when = minIso(addDays(inv.date, rnd() < 0.05 ? 0 : int(3, 75)), LAST_DAY);
  payments.push({ invoice: inv.number, date: when, amount, method: m, reference: payRef(m) });
}
if (payments.length !== 1999) throw new Error(`payments ${payments.length}, expected 1999`);
if (invoices.filter((i) => i.state === "unpaid").length !== N_UNPAID) throw new Error("unpaid count");

// ---- awkward extra invoice rows (on top of the 2035; numbers below INV-0280 so the next number is not affected) ---------------
const extras = [];
{
  const c = active[3];
  const base = (number, date, cust, lines, more = {}) => {
    const net = lines.reduce((a, l) => a + l.net, 0);
    const vat = lines.reduce((a, l) => a + l.vat, 0);
    return { number, date, due: addDays(date, 30), customer: cust, customerKey: cust.key, lines, net, vat, gross: net + vat, status: "Unpaid", paid: 0, notes: "", statedLineVat: true, ...more };
  };
  const l1 = makeLines(1, () => 2000);
  extras.push({ ...base("INV-0100", "2019-11-04", c, l1), case: "duplicate number (first copy)", expect: "held: duplicate document number" });
  extras.push({ ...base("INV-0100", "2019-11-05", active[4], makeLines(1, () => 2000)), case: "duplicate number (second copy)", expect: "held: duplicate document number" });
  extras.push({ ...base("INV-0101", "2019-11-06", c, makeLines(1, () => 2000), { discount: "5%" }), case: "header discount 5%", expect: "needs review: excluded with --exclude INV-0101" });
  extras.push({ ...base("INV-0102", "2019-11-07", { key: "C9999", name: "Not In The Customer File Ltd" }, makeLines(1, () => 2000)), customerKey: "C9999", case: "customer account not in the customers file", expect: "held: customer not found" });
}

// ---- credit notes (2, no invoice link, as in SliQ) ------------------------------------------------------------------------------
const creditNotes = [
  { number: "CRD-0150", date: "2021-03-15", customer: active[1], net: 12000, vat: 2400, reason: "Goods returned", notes: "" },
  { number: "CRD-2150", date: "2026-02-11", customer: active[2], net: 4550, vat: 910, reason: "Price adjustment", notes: "" },
].map((c) => ({ ...c, gross: c.net + c.vat }));

// ---- quotes (1410, QUO-0073 .. QUO-1482) ----------------------------------------------------------------------------------------
const N_Q = 1410;
const quotes = [];
for (let k = 0; k < N_Q; k++) {
  const number = `QUO-${pad(73 + k, 4)}`;
  const date = addDays(START, Math.floor((k * SPAN_DAYS) / N_Q));
  const c = pick(weighted);
  const lines = makeLines(rnd() < 0.7 ? 1 : 2, () => (c.export ? 0 : 2000));
  const net = lines.reduce((a, l) => a + l.net, 0);
  const vat = lines.reduce((a, l) => a + l.vat, 0);
  const status = date < "2026-06-01" ? pick(["Accepted", "Accepted", "Declined", "Sent"]) : pick(["Sent", "Sent", "Draft", "Accepted"]);
  quotes.push({ number, date, customer: c, lines, net, vat, gross: net + vat, status, validUntil: addDays(date, 30), notes: "" });
}

// ---- purchase orders (144, PO-0015 .. PO-0158) ------------------------------------------------------------------------------------
const N_PO = 144;
const pos = [];
for (let k = 0; k < N_PO; k++) {
  const number = `PO-${pad(15 + k, 4)}`;
  const date = addDays(START, Math.floor((k * SPAN_DAYS) / N_PO));
  const s = pick(suppliers);
  const total = rnd() < 0.8 ? int(2000, 300000) : int(300000, 1200000);
  const status = k % 47 === 5 ? "Cancelled" : k >= N_PO - 2 ? "Draft" : "Open";
  pos.push({ number, supplier: s, date, delivery: rnd() < 0.85 ? addDays(date, int(3, 28)) : "", total, status });
}

// ---- write the synthetic-mapping files ------------------------------------------------------------------------------------------
const fancy = (i) => i % 9 === 4; // about one row in nine is written "£1,234.56"
const dir = path.join(out, "export");
const dirSliq = path.join(out, "export-sliq");
const dirRep = path.join(out, "sliq-reports");
for (const d of [dir, dirSliq, dirRep]) mkdirSync(d, { recursive: true });
const allInvoiceRows = [...extras, ...invoices];
const w = (d, f, s) => writeFileSync(path.join(d, f), s);

w(dir, "customers.csv", csv(["Account", "Name", "Contact", "Address 1", "Address 2", "Town", "Postcode", "Email", "Phone", "VAT No"],
  customers.map((c) => [c.key, c.name, c.contact, c.address1, c.address2, c.town, c.postcode, c.email, c.phone, c.vat])));
w(dir, "suppliers.csv", csv(["Account", "Name", "Contact", "Address", "Email", "Phone", "Notes"],
  suppliers.map((s) => [s.key, s.name, s.contact, s.address, s.email, s.phone, s.notes])));
w(dir, "invoices.csv", csv(["Invoice No", "Type", "Date", "Due", "Account", "Net", "VAT", "Gross", "Status", "Paid", "Against", "Notes", "VAT Code", "Discount"],
  allInvoiceRows.map((i, n) => [i.number, "Invoice", day(i.date, i.unpadded), i.due ? day(i.due, i.unpadded) : "", i.customerKey ?? i.customer.key,
    money(i.net, fancy(n)), money(i.vat, fancy(n)), money(i.gross, fancy(n)), i.status, i.paid ? money(i.paid, fancy(n)) : "", "", i.notes, "", i.discount ?? ""])));
const lineRows = [];
for (const d of [...allInvoiceRows, ...quotes]) {
  for (const l of d.lines) {
    lineRows.push([d.number, l.description, qtyText(l.qtyMilli), plain(l.unit), plain(l.net), String(l.rate / 100), d.statedLineVat === false ? "" : plain(l.vat), "", ""]);
  }
}
w(dir, "invoice-lines.csv", csv(["Invoice No", "Description", "Qty", "Unit Price", "Line Net", "VAT %", "Line VAT", "VAT Code", "Discount"], lineRows));
w(dir, "payments.csv", csv(["Invoice No", "Received", "Amount", "Method", "Reference"], payments.map((p, n) => [p.invoice, day(p.date), money(p.amount, fancy(n)), p.method, p.reference])));
w(dir, "credit-notes.csv", csv(["Credit No", "Date", "Account", "Net", "VAT", "Gross", "Against", "Reason", "Notes"],
  creditNotes.map((c) => [c.number, day(c.date), c.customer.key, plain(c.net), plain(c.vat), plain(c.gross), "", c.reason, c.notes])));
w(dir, "quotes.csv", csv(["Quote No", "Date", "Account", "Net", "VAT", "Gross", "Status", "Valid Until", "Notes"],
  quotes.map((q, n) => [q.number, day(q.date), q.customer.key, money(q.net, fancy(n)), money(q.vat, fancy(n)), money(q.gross, fancy(n)), q.status, day(q.validUntil), q.notes])));
w(dir, "purchase-orders.csv", csv(["PO No", "Supplier", "Order Date", "Delivery Date", "Total", "Status"],
  pos.map((p, n) => [p.number, p.supplier.name, day(p.date), p.delivery ? day(p.delivery) : "", money(p.total, fancy(n)), p.status])));

// ---- the same records under the provisional SliQ headers (customer by NAME: SliQ's likely export has no account code) ----------
w(dirSliq, "customers.csv", csv(["Company Name", "Contact Name", "Email Address", "Phone Number", "Address", "Notes"],
  customers.map((c) => [c.name, c.contact, c.email, c.phone, [c.address1, c.address2, c.town, c.postcode].filter(Boolean).join(", "), ""])));
w(dirSliq, "suppliers.csv", csv(["Company Name", "Contact Name", "Email Address", "Phone Number", "Address", "Notes"],
  suppliers.map((s) => [s.name, s.contact, s.email, s.phone, s.address, s.notes])));
w(dirSliq, "invoices.csv", csv(["Number", "Customer", "Invoice Date", "Due Date", "Net", "VAT", "Gross", "Status", "Discount"], [
  ...allInvoiceRows.map((i, n) => [i.number, i.customer.name, day(i.date, i.unpadded), i.due ? day(i.due, i.unpadded) : "", money(i.net, fancy(n)), money(i.vat, fancy(n)), money(i.gross, fancy(n)), i.status, i.discount ?? ""]),
  // no credit-note file in this layout: credit notes are negative rows in the invoice list
  ...creditNotes.map((c) => [c.number, c.customer.name, day(c.date), "", plain(-c.net), plain(-c.vat), plain(-c.gross), "Paid", ""]),
]));
w(dirSliq, "invoice-lines.csv", csv(["Document Number", "Description", "Quantity", "Unit Price", "VAT Rate", "Discount"],
  [...allInvoiceRows, ...quotes].flatMap((d) => d.lines.map((l) => [d.number, l.description, qtyText(l.qtyMilli), plain(l.unit), String(l.rate / 100), ""]))));
w(dirSliq, "payments.csv", csv(["Invoice Number", "Date", "Amount", "Method", "Reference"], payments.map((p, n) => [p.invoice, day(p.date), money(p.amount, fancy(n)), p.method, p.reference])));
w(dirSliq, "quotes.csv", csv(["Number", "Customer", "Quote Date", "Gross", "Status"], quotes.map((q, n) => [q.number, q.customer.name, day(q.date), money(q.gross, fancy(n)), q.status])));
w(dirSliq, "purchase-orders.csv", csv(["Number", "Supplier", "Order Date", "Delivery Date", "Total"],
  pos.map((p, n) => [p.number, p.supplier.name, day(p.date), p.delivery ? day(p.delivery) : "", money(p.total, fancy(n))])));

// ---- SliQ's Aged Debtors report for this data: every open document; a credit (overpayment, unallocated credit note) is negative --
const aged = [];
for (const i of invoices) {
  const open = i.gross - i.paid;
  if (open !== 0) aged.push({ account: i.customer.key, name: i.customer.name, document: i.number, date: i.date, outstanding: open });
}
for (const c of creditNotes) aged.push({ account: c.customer.key, name: c.customer.name, document: c.number, date: c.date, outstanding: -c.gross });
// The awkward extras are not real SliQ documents of this ledger (a duplicate, an excluded and an orphan row): they are not in it.
w(dirRep, "aged-debtors.csv", csv(["Account", "Name", "Document", "Date", "Outstanding"], aged.map((a) => [a.account, a.name, a.document, day(a.date), plain(a.outstanding)])));

// ---- manifest: the designed truth the checks compare against -----------------------------------------------------------------
const total = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
const importedInvoices = invoices; // all 2035; every extra row is held or excluded
const manifest = {
  format: "sliq-rehearsal-manifest/1",
  synthetic: true,
  note: "Synthetic data generated from a fixed seed. No real customer, supplier or document.",
  source: {
    customers: customers.length, suppliers: suppliers.length, invoices: invoices.length, invoiceRowsInFile: allInvoiceRows.length, creditNotes: creditNotes.length,
    payments: payments.length, unpaidNothingPaid: N_UNPAID, partPaid: N_PARTIAL, overpaid: 1, quotes: quotes.length, purchaseOrders: pos.length,
    invoiceLines: invoices.reduce((a, i) => a + i.lines.length, 0), quoteLines: quotes.reduce((a, q) => a + q.lines.length, 0),
  },
  expected: {
    customers: 79, suppliers: 52, invoices: 2035, quotes: 1410, purchaseOrders: 144, creditNotesWritten: 0,
    // the overpaid invoice is Payment to confirm: its one payment is not imported
    invoicePayments: payments.length - 1,
    // the invoice whose line VAT is unresolved is written header only
    invoiceLines: invoices.reduce((a, i) => a + i.lines.length, 0) - 1,
    quoteLines: quotes.reduce((a, q) => a + q.lines.length, 0),
    statuses: { paid: invoices.filter((i) => i.state === "paid").length, partial: N_PARTIAL, sentPaymentToConfirm: N_UNPAID + 1 },
    paymentToConfirm: N_UNPAID + 1,
    totalsPence: {
      invoicesNet: total(importedInvoices, (i) => i.net), invoicesVat: total(importedInvoices, (i) => i.vat), invoicesGross: total(importedInvoices, (i) => i.gross),
      paymentsImported: total(payments.filter((p) => p.invoice !== overpaid.number), (p) => p.amount), quotesGross: total(quotes, (q) => q.gross),
      purchaseOrders: total(pos, (p) => p.total),
    },
    agedDebtorsPence: total(aged, (a) => a.outstanding),
    agedDebtorsDocuments: aged.length,
    nextNumbers: { invoice: "INV-2315", quote: "QUO-1483", purchaseOrder: "PO-0159" },
    held: extras.map((e) => ({ number: e.number, expect: e.expect })),
    exclude: ["INV-0101"],
  },
  awkward: {
    duplicateCustomerNames: [["C0010", "C0011"], ["C0012", "C0013"]],
    customerWithNoInvoices: "C0079",
    nonAsciiCustomer: "C0020",
    quotedCommaCustomer: "C0021",
    partPaid: [...partial].map((i) => ({ number: i.number, gross: i.gross, paid: i.paid })),
    overpaid: { number: overpaid.number, gross: overpaid.gross, paid: overpaid.paid },
    unpaid: [...unpaid].map((i) => i.number).sort(),
    creditNotes: creditNotes.map((c) => ({ number: c.number, account: c.customer.key, gross: c.gross })),
    extraInvoiceRows: extras.map((e) => ({ number: e.number, case: e.case, expect: e.expect })),
    oddDates: odd.filter((o) => /date/.test(o.case)),
    unpaddedDates: invoices.filter((i) => i.unpadded).length,
    vat: vatCases,
    poundSignAmounts: "about one row in nine in invoices, payments, quotes and purchase orders is written £1,234.56",
    purchaseOrderStatuses: { Open: pos.filter((p) => p.status === "Open").length, Cancelled: pos.filter((p) => p.status === "Cancelled").length, Draft: pos.filter((p) => p.status === "Draft").length },
  },
};
w(out, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
w(out, "resolutions.json", `${JSON.stringify({
  format: "sliq-credit-note-resolutions/1",
  resolutions: creditNotes.map((c) => ({ number: c.number, decision: "record-outside-tolra", allocation: null, note: "Synthetic rehearsal: no invoice link in SliQ; recorded by hand after go-live (cutover plan section 1)." })),
}, null, 2)}\n`);
console.log(`Synthetic export written to ${out}: ${customers.length} customers, ${suppliers.length} suppliers, ${allInvoiceRows.length} invoice rows (${invoices.length} + ${extras.length} awkward), ${creditNotes.length} credit notes, ${payments.length} payments, ${quotes.length} quotes, ${pos.length} purchase orders, ${lineRows.length} lines.`);
