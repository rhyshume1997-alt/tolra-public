#!/usr/bin/env node
// Generates a SYNTHETIC SliQ export set for the import rehearsal. Every name, address, number and amount is made up here from a
// fixed seed, so two runs give byte-identical files. No real data is read or needed.
//
//   node scripts/sliq-import/rehearsal/generate.mjs <out folder>
//
// Writes:
//   <out>/export/          the import files, headers as mappings/synthetic.json (the confirmed fixture mapping)
//   <out>/export-sliq/     the same records under the PROVISIONAL mappings/sliq.json headers (dry run only: a write is refused)
//   <out>/export-names/    the same records with documents naming their customer by NAME, not account (as SliQ's invoice reports do),
//                          for <out>/synthetic-names.json (a confirmed fixture mapping): two customers share one name, so their
//                          documents are ambiguous until <out>/resolutions-names.json names each one's account (decision 3)
//   <out>/resolutions*.json  resolutions.json (credit notes + the Tolra name for one of the two same-name customers),
//                          resolutions-cn.json (credit notes only: the write is refused), resolutions-names.json (for export-names)
//   <out>/sliq-reports/aged-debtors.csv   what SliQ's Aged Debtors report would print for this data (one row per open document)
//   <out>/manifest.json    the designed truth: counts, every awkward case, expected totals, the next numbers
//
// Volumes follow the cutover plan's counts: 79 customers, 52 suppliers, 2035 invoices + 2 credit notes, 1999 payments, 36 unpaid
// (nothing paid), 1410 quotes, 144 purchase orders; next numbers INV-2315, QUO-1483, PO-0159. Awkward cases are added on top
// (see manifest.awkward) and are expected to be held, excluded or flagged, never silently imported.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  14: { name: "Riverside Engineering Ltd" },
  15: { name: "Riverside Engineering Ltd" }, // EXACTLY the same name, another account: Tolra links by name, so one needs its own name
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
  // A number SliQ used twice, for two customers: both are real, unpaid ledger documents (in Aged Debtors). The earlier keeps
  // INV-0100, the later becomes INV-0100-B; both keep INV-0100 as the SliQ reference. Their lines (under INV-0100) cannot be told
  // apart, so both are written header only.
  extras.push({ ...base("INV-0100", "2019-11-04", c, l1), case: "duplicate number (first copy)", ledger: true, tolraNumber: "INV-0100", expect: "written as INV-0100 (keeps the number)" });
  extras.push({ ...base("INV-0100", "2019-11-05", active[4], makeLines(1, () => 2000)), case: "duplicate number (second copy)", ledger: true, tolraNumber: "INV-0100-B", expect: "written as INV-0100-B" });
  extras.push({ ...base("INV-0101", "2019-11-06", c, makeLines(1, () => 2000), { discount: "5%" }), case: "header discount 5%", expect: "needs review: excluded with --exclude INV-0101" });
  extras.push({ ...base("INV-0102", "2019-11-07", { key: "C9999", name: "Not In The Customer File Ltd" }, makeLines(1, () => 2000)), customerKey: "C9999", case: "customer account not in the customers file", expect: "unmatched: stops the write; excluded with --exclude INV-0102" });
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
// A quote number SliQ used twice (below the range, so the next number is not affected): QUO-0050 and QUO-0050-B.
for (const [date, cust, tolraNumber] of [["2019-12-02", active[5], "QUO-0050"], ["2019-12-09", active[6], "QUO-0050-B"]]) {
  const lines = makeLines(1, () => 2000);
  const net = lines.reduce((a, l) => a + l.net, 0);
  const vat = lines.reduce((a, l) => a + l.vat, 0);
  quotes.unshift({ number: "QUO-0050", date, customer: cust, lines, net, vat, gross: net + vat, status: "Declined", validUntil: addDays(date, 30), notes: "", tolraNumber });
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
// A purchase order number SliQ used twice: PO-0010 and PO-0010-B.
pos.unshift(
  { number: "PO-0010", supplier: suppliers[0], date: "2019-12-03", delivery: "", total: 12345, status: "Cancelled", tolraNumber: "PO-0010" },
  { number: "PO-0010", supplier: suppliers[1], date: "2019-12-10", delivery: "", total: 67890, status: "Cancelled", tolraNumber: "PO-0010-B" },
);

// ---- Part B: open jobs, the sales orders that feed them, PO statuses and job links, opening WIP ----------------------------------
// Drawn AFTER every earlier random value, so the records above are byte-identical to the Part A rehearsal (except the PO statuses and
// the PO job column, set below without the random source).
const poStatus = (k) => (k % 47 === 5 ? "Cancelled" : k >= N_PO - 2 ? "Draft" : k < 120 ? "Received" : ["Confirmed", "Open", "Part Received"][k % 3]);
pos.forEach((p, k) => { p.status = poStatus(k); p.job = ""; });
const N_JOBS = 40; // J-1501 .. J-1540, the last one closed: the J counter must pass it
const JOB_STATUS = ["Open", "In Progress", "At Risk", "Late"];
const JOB_STAGE = ["Material", "Setup", "Machining", "Inspection", ""];
const SPECS = ["EN8 bright bar, turn to drawing, deburr", "316 stainless, 'polish' bearing faces, inspect first-off", "6082 aluminium, face both sides, drill M8 pattern", "Cast iron, bore and sleeve, \"H7\" fit"];
const closedAt = { 34: "Complete", 35: "Invoiced", 36: "Complete", 37: "Cancelled", 39: "Complete" }; // the finished / closed jobs
const jobs = [];
for (let k = 0; k < N_JOBS; k++) {
  const number = `J-${1501 + k}`;
  const c = pick(weighted);
  const theirs = quotes.filter((q) => q.customer.key === c.key && q.status === "Accepted");
  const status = closedAt[k] ?? JOB_STATUS[k % 4];
  const j = { number, customer: c, customerKey: c.key, quote: theirs.length ? theirs[theirs.length - 1].number : "", salesOrder: "", description: `${pick(PARTS)} x ${int(1, 40)}`,
    status, stage: closedAt[k] ? "" : JOB_STAGE[k % 5], due: addDays("2026-11-02", int(3, 60)), spec: pick(SPECS), started: "", finished: "", value: rnd() < 0.85 ? int(15000, 900000) : null, case: null };
  if (k % 4 === 1 || k % 4 === 2) j.started = addDays("2026-10-30", -int(1, 20));
  if (closedAt[k]) { j.started = addDays("2026-09-01", int(0, 20)); j.finished = addDays(j.started, int(2, 15)); j.case = `closed in SliQ (${status}): not imported`; }
  jobs.push(j);
}
jobs[5].quote = ""; jobs[5].case = "no quote"; // a job with no quote
jobs[6].quote = ""; jobs[6].case = "no quote";
jobs[7].customerKey = "C9999"; jobs[7].case = "customer not in the customers file: held";
jobs[8].started = "2026-10-12"; jobs[8].finished = "2026-10-28"; jobs[8].stage = ""; jobs[8].case = "finished in SliQ, still open: awaiting inspection";
jobs[9].value = null; jobs[9].case = "no value in SliQ";
// Sales orders SO-0201 .. SO-0220 feed jobs J-1511 .. J-1530; SO-0221/0222 are open with no job (keyed by hand); SO-0223/0224 closed.
const salesOrders = [];
for (let k = 0; k < 24; k++) {
  const number = `SO-${pad(201 + k, 4)}`;
  const feeds = k < 20 ? jobs[10 + k] : null;
  const c = feeds ? feeds.customer : pick(weighted);
  const so = { number, customer: c, quote: feeds ? feeds.quote : "", status: feeds ? pick(["Open", "Confirmed", "In Production"]) : k < 22 ? "Open" : "Closed",
    orderDate: addDays("2026-10-30", -int(5, 60)), delivery: addDays("2026-11-02", int(5, 50)), total: int(20000, 600000), notes: k === 3 ? "Call before delivery, gate code 1234" : "", job: feeds ? feeds.number : "" };
  if (feeds) feeds.salesOrder = number;
  salesOrders.push(so);
}
// PO job links: the 12 newest POs are bought for open jobs; one names a job not in the file, one a closed job (link not made, listed).
for (let k = 0; k < 12; k++) pos[N_PO - 3 - k].job = jobs[k === 7 ? 0 : k].number;
pos[N_PO - 15].job = "J-1499";
pos[N_PO - 16].job = "J-1536";
const extraPo = { number: "PO-0010", supplier: { name: "Unknown Supplier Ltd" }, date: "2019-12-02", delivery: "", total: 12345, status: "Open", job: "J-1501" }; // refused: supplier not in the file
// Opening WIP: one or two lines per open job (some not valued), one on a job not in the file, one on a closed job, one on no job.
const wip = [];
for (const j of jobs.slice(0, 20)) {
  wip.push({ job: j.number, description: "Material issued", qty: String(int(1, 12)), value: int(2000, 90000), asOf: LAST_DAY, ref: `WIP-${j.number}` });
  if (rnd() < 0.6) wip.push({ job: j.number, description: "Labour to date (hours)", qty: `${int(1, 30)}.5`, value: rnd() < 0.7 ? int(5000, 150000) : null, asOf: LAST_DAY, ref: "" });
}
wip[2].value = null; // a line on an open job that SliQ did not value: stays blank
wip.push({ job: "J-1450", description: "Bar stock cut for a job not in the export", qty: "4", value: 8000, asOf: LAST_DAY, ref: "" });
wip.push({ job: "J-1536", description: "Material left on a closed job", qty: "", value: 4321, asOf: LAST_DAY, ref: "" });
wip.push({ job: "", description: "General stock issued, no job", qty: "", value: null, asOf: LAST_DAY, ref: "" });

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
w(dir, "purchase-orders.csv", csv(["PO No", "Supplier", "Order Date", "Delivery Date", "Total", "Status", "Job No"],
  [extraPo, ...pos].map((p, n) => [p.number, p.supplier.name, day(p.date), p.delivery ? day(p.delivery) : "", money(p.total, fancy(n)), p.status, p.job])));
const jobKey = (j) => j.customerKey;
w(dir, "jobs.csv", csv(["Job No", "Account", "Quote No", "Order No", "Description", "Status", "Stage", "Due", "Specification", "Started", "Finished", "Value"],
  jobs.map((j, n) => [j.number, jobKey(j), j.quote, j.salesOrder, j.description, j.status, j.stage, day(j.due), j.spec, j.started ? day(j.started) : "", j.finished ? day(j.finished) : "", j.value === null ? "" : money(j.value, fancy(n))])));
w(dir, "sales-orders.csv", csv(["Order No", "Account", "Quote No", "Status", "Order Date", "Delivery Date", "Total", "Notes", "Job No"],
  salesOrders.map((s, n) => [s.number, s.customer.key, s.quote, s.status, day(s.orderDate), day(s.delivery), money(s.total, fancy(n)), s.notes, s.job])));
w(dir, "wip.csv", csv(["Job No", "Description", "Qty", "Value", "As At", "Reference"], wip.map((x, n) => [x.job, x.description, x.qty, x.value === null ? "" : money(x.value, fancy(n)), day(x.asOf), x.ref])));

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
w(dirSliq, "purchase-orders.csv", csv(["Number", "Supplier", "Order Date", "Delivery Date", "Total", "Status", "Job Number"],
  [extraPo, ...pos].map((p, n) => [p.number, p.supplier.name, day(p.date), p.delivery ? day(p.delivery) : "", money(p.total, fancy(n)), p.status, p.job])));
const nameOfKey = new Map(customers.map((c) => [c.key, c.name]));
w(dirSliq, "jobs.csv", csv(["Job Number", "Customer", "Quote Number", "Order Number", "Description", "Status", "Stage", "Due Date", "Specification", "Start Date", "Finish Date", "Value"],
  jobs.map((j, n) => [j.number, nameOfKey.get(j.customerKey) ?? "Not In The Customer File Ltd", j.quote, j.salesOrder, j.description, j.status, j.stage, day(j.due), j.spec, j.started ? day(j.started) : "", j.finished ? day(j.finished) : "", j.value === null ? "" : money(j.value, fancy(n))])));
w(dirSliq, "sales-orders.csv", csv(["Order Number", "Customer", "Quote Number", "Status", "Order Date", "Delivery Date", "Total", "Notes", "Job Number"],
  salesOrders.map((s, n) => [s.number, s.customer.name, s.quote, s.status, day(s.orderDate), day(s.delivery), money(s.total, fancy(n)), s.notes, s.job])));
w(dirSliq, "wip.csv", csv(["Job Number", "Description", "Quantity", "Value", "Date", "Reference"], wip.map((x, n) => [x.job, x.description, x.qty, x.value === null ? "" : money(x.value, fancy(n)), day(x.asOf), x.ref])));

// ---- the same records, documents naming the customer by NAME (decision 3: names are matched only when exactly one customer has them) --
const dirNames = path.join(out, "export-names");
mkdirSync(dirNames, { recursive: true });
for (const f of ["customers.csv", "suppliers.csv", "invoice-lines.csv", "payments.csv", "purchase-orders.csv"]) writeFileSync(path.join(dirNames, f), readFileSync(path.join(dir, f)));
w(dirNames, "invoices.csv", csv(["Invoice No", "Type", "Date", "Due", "Customer", "Net", "VAT", "Gross", "Status", "Paid", "Against", "Notes", "VAT Code", "Discount"],
  allInvoiceRows.map((i, n) => [i.number, "Invoice", day(i.date, i.unpadded), i.due ? day(i.due, i.unpadded) : "", i.customer.name,
    money(i.net, fancy(n)), money(i.vat, fancy(n)), money(i.gross, fancy(n)), i.status, i.paid ? money(i.paid, fancy(n)) : "", "", i.notes, "", i.discount ?? ""])));
w(dirNames, "credit-notes.csv", csv(["Credit No", "Date", "Customer", "Net", "VAT", "Gross", "Against", "Reason", "Notes"],
  creditNotes.map((c) => [c.number, day(c.date), c.customer.name, plain(c.net), plain(c.vat), plain(c.gross), "", c.reason, c.notes])));
w(dirNames, "quotes.csv", csv(["Quote No", "Date", "Customer", "Net", "VAT", "Gross", "Status", "Valid Until", "Notes"],
  quotes.map((q, n) => [q.number, day(q.date), q.customer.name, money(q.net, fancy(n)), money(q.vat, fancy(n)), money(q.gross, fancy(n)), q.status, day(q.validUntil), q.notes])));
const namesMapping = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "mappings", "synthetic.json"), "utf8"));
namesMapping.id = "synthetic-names";
namesMapping.label = "Synthetic fixtures, documents naming the customer (made-up headers)";
for (const k of ["invoices", "quotes", "creditNotes"]) namesMapping.files[k].columns.customer = "Customer";
w(out, "synthetic-names.json", `${JSON.stringify(namesMapping, null, 2)}\n`);
// The same name twice: the person doing the import names each such document's account (customerMatches), and gives one of the two
// customers its own Tolra name (customerNames). Generated here from the designed truth, as the reviewed answer would be.
const sameName = customers.filter((c) => customers.filter((d) => d.name === c.name).length > 1);
const tolraNames = { [sameName[1].key]: `${sameName[1].name} (${sameName[1].town})` };
const customerMatches = [
  ...allInvoiceRows.map((i, n) => ({ i, row: n + 2 })).filter(({ i }) => sameName.includes(i.customer)).map(({ i, row }) => ({ kind: "invoice", number: i.number, row, account: i.customer.key })),
  ...quotes.map((q, n) => ({ q, row: n + 2 })).filter(({ q }) => sameName.includes(q.customer)).map(({ q, row }) => ({ kind: "quote", number: q.number, row, account: q.customer.key })),
];

// ---- SliQ's Aged Debtors report for this data: every open document; a credit (overpayment, unallocated credit note) is negative --
const aged = [];
for (const i of invoices) {
  const open = i.gross - i.paid;
  if (open !== 0) aged.push({ account: i.customer.key, name: i.customer.name, document: i.number, date: i.date, outstanding: open });
}
for (const i of extras.filter((x) => x.ledger)) aged.push({ account: i.customer.key, name: i.customer.name, document: i.number, date: i.date, outstanding: i.gross });
for (const c of creditNotes) aged.push({ account: c.customer.key, name: c.customer.name, document: c.number, date: c.date, outstanding: -c.gross });
// The other extras are not documents of this ledger (an excluded discount invoice and an orphan row): they are not in it.
w(dirRep, "aged-debtors.csv", csv(["Account", "Name", "Document", "Date", "Outstanding"], aged.map((a) => [a.account, a.name, a.document, day(a.date), plain(a.outstanding)])));

// ---- manifest: the designed truth the checks compare against -----------------------------------------------------------------
const total = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
const dupInvoices = extras.filter((x) => x.ledger); // INV-0100 and INV-0100-B: written, header only, unpaid
const importedInvoices = [...invoices, ...dupInvoices]; // 2035 + the two copies; INV-0101 and INV-0102 are excluded
const dupQuotes = quotes.filter((q) => q.tolraNumber);
const manifest = {
  format: "sliq-rehearsal-manifest/1",
  synthetic: true,
  note: "Synthetic data generated from a fixed seed. No real customer, supplier or document.",
  source: {
    customers: customers.length, suppliers: suppliers.length, invoices: invoices.length, invoiceRowsInFile: allInvoiceRows.length, creditNotes: creditNotes.length,
    payments: payments.length, unpaidNothingPaid: N_UNPAID + dupInvoices.length, partPaid: N_PARTIAL, overpaid: 1, quotes: quotes.length, purchaseOrders: pos.length,
    invoiceLines: invoices.reduce((a, i) => a + i.lines.length, 0), quoteLines: quotes.reduce((a, q) => a + q.lines.length, 0),
  },
  expected: {
    customers: 79, suppliers: 52, invoices: importedInvoices.length, quotes: quotes.length, purchaseOrders: pos.length, creditNotesWritten: creditNotes.length,
    // decision 1: every payment is imported, the overpaid invoice's too (it is paid; the surplus is the customer's credit)
    invoicePayments: payments.length,
    // header only: the invoice whose line VAT is unresolved, and both copies of INV-0100 (their lines cannot be told apart)
    invoiceLines: invoices.reduce((a, i) => a + i.lines.length, 0) - 1,
    quoteLines: quotes.filter((q) => !q.tolraNumber).reduce((a, q) => a + q.lines.length, 0),
    // paid includes the overpaid one; unpaid invoices are issued ('sent') and owed in full; nothing is Payment to confirm
    statuses: { paid: invoices.filter((i) => i.state === "paid").length + 1, partial: N_PARTIAL, sentUnpaid: N_UNPAID + dupInvoices.length, sentPaymentToConfirm: 0 },
    paymentToConfirm: 0,
    totalsPence: {
      invoicesNet: total(importedInvoices, (i) => i.net), invoicesVat: total(importedInvoices, (i) => i.vat), invoicesGross: total(importedInvoices, (i) => i.gross),
      paymentsImported: total(payments, (p) => p.amount), quotesGross: total(quotes, (q) => q.gross),
      purchaseOrders: total(pos, (p) => p.total),
    },
    agedDebtorsPence: total(aged, (a) => a.outstanding),
    // Aged Debtors split: what is owed on invoices, the overpayment credit, the credit notes (imported as customer credit)
    agedDebtorsOwedPence: total(aged.filter((a) => a.outstanding > 0), (a) => a.outstanding),
    agedDebtorsOverpaidPence: overpaid.gross - overpaid.paid,
    agedDebtorsCreditNotesPence: -total(creditNotes, (c) => c.gross),
    agedDebtorsDocuments: aged.length,
    nextNumbers: { invoice: "INV-2315", quote: "QUO-1483", purchaseOrder: "PO-0159" },
    held: extras.filter((e) => !e.ledger).map((e) => ({ number: e.number, expect: e.expect })),
    exclude: extras.filter((e) => !e.ledger).map((e) => e.number),
    // decision 2: every copy of a number SliQ used twice, with the Tolra number it must get (the same every run)
    renames: [
      ...dupInvoices.map((i) => ({ kind: "invoice", sourceNumber: i.number, number: i.tolraNumber, account: i.customer.key })),
      ...dupQuotes.map((q) => ({ kind: "quote", sourceNumber: q.number, number: q.tolraNumber, account: q.customer.key })),
      ...pos.filter((p) => p.tolraNumber).map((p) => ({ kind: "purchase_order", sourceNumber: p.number, number: p.tolraNumber, supplier: p.supplier.name })),
    ],
    // decision 3: the Tolra name of every customer (one of the two same-name customers gets its own), and how many documents of
    // export-names are ambiguous until resolved
    tolraNames: Object.fromEntries(customers.map((c) => [c.key, tolraNames[c.key] ?? c.name])),
    sameNameCustomers: sameName.map((c) => c.key),
    namesLayoutAmbiguousDocuments: customerMatches.length,
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
    purchaseOrderStatuses: Object.fromEntries([...new Set(pos.map((p) => p.status))].sort().map((st) => [st, pos.filter((p) => p.status === st).length])),
  },
};
// Part B: what the jobs import must do with the jobs, sales orders, PO links and WIP above.
{
  const open = jobs.filter((j) => !Object.values(closedAt).includes(j.status));
  const imported = open.filter((j) => j.customerKey !== "C9999");
  const importedNos = new Set(imported.map((j) => j.number));
  const linked = wip.filter((x) => importedNos.has(x.job));
  const sumv = (xs) => xs.reduce((a, x) => a + (x.value ?? 0), 0);
  const TOLRA_PO = { Open: "sent", Draft: "draft", Cancelled: "cancelled", Confirmed: "confirmed", "Part Received": "partial_received", Received: "received" };
  const OPEN_PO = new Set(["draft", "sent", "confirmed", "partial_received"]);
  manifest.jobs = {
    note: "Part B (reviewer decisions 4-6): open jobs, the sales orders that feed them, PO statuses and job links, opening WIP.",
    openInFile: open.length, closedInFile: jobs.length - open.length, imported: imported.length, held: open.filter((j) => j.customerKey === "C9999").map((j) => j.number),
    closed: jobs.filter((j) => !open.includes(j)).map((j) => ({ number: j.number, status: j.status })),
    importedJobs: imported.map((j) => ({ number: j.number, account: j.customerKey, customer: j.customer.name, quote: j.quote || null, salesOrder: j.salesOrder || null,
      status: j.status, stage: j.stage || null, due: j.due, started: j.started || null, finished: j.finished || null, valuePence: j.value, spec: j.spec, description: j.description })),
    noQuote: imported.filter((j) => !j.quote).map((j) => j.number),
    salesOrders: { inFile: salesOrders.length, imported: salesOrders.filter((so) => so.job && importedNos.has(so.job)).map((so) => ({ number: so.number, job: so.job, account: so.customer.key })),
      notImported: salesOrders.filter((so) => !so.job).map((so) => so.number) },
    purchaseOrders: {
      written: pos.length, refusedUnknownSupplier: [extraPo.number], heldPurchaseOrders: [extraPo.number],
      open: pos.filter((p) => OPEN_PO.has(TOLRA_PO[p.status])).length, byTolraStatus: Object.fromEntries(Object.values(TOLRA_PO).sort().map((st) => [st, pos.filter((p) => TOLRA_PO[p.status] === st).length]).filter(([, n]) => n > 0)),
      linked: pos.filter((p) => importedNos.has(p.job)).map((p) => ({ number: p.number, job: p.job })), linkNotMade: pos.filter((p) => p.job && !importedNos.has(p.job)).map((p) => ({ number: p.number, job: p.job })),
    },
    wip: { rows: wip.length, totalPence: sumv(wip), linkedRows: linked.length, linkedPence: sumv(linked), unlinkedRows: wip.length - linked.length, unlinkedPence: sumv(wip) - sumv(linked),
      notValued: wip.filter((x) => x.value === null).length, unlinked: wip.filter((x) => !importedNos.has(x.job)).map((x) => x.job || "(none)") },
    nextNumbers: { job: `J-${1501 + N_JOBS}`, salesOrder: `SO-${pad(201 + salesOrders.length, 4)}` },
  };
}
w(out, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
// Imported as customer credit (no invoice link in SliQ): each customer's balance then equals Aged Debtors.
const cnResolutions = creditNotes.map((c) => ({ number: c.number, decision: "import-as-credit", allocation: null, note: "Synthetic rehearsal: no invoice link in SliQ; imported as the customer's credit." }));
const customerNames = Object.entries(tolraNames).map(([account, name]) => ({ account, name, note: "Synthetic rehearsal: two customers are called the same in SliQ; this one is told apart by its town." }));
const resolutions = (extra) => `${JSON.stringify({ format: "sliq-credit-note-resolutions/1", resolutions: cnResolutions, ...extra }, null, 2)}\n`;
w(out, "resolutions-cn.json", resolutions({}));
w(out, "resolutions.json", resolutions({ customerNames }));
w(out, "resolutions-names.json", resolutions({ customerNames, customerMatches }));
console.log(`Synthetic export written to ${out}: ${customers.length} customers, ${suppliers.length} suppliers, ${allInvoiceRows.length} invoice rows (${invoices.length} + ${extras.length} awkward), ${creditNotes.length} credit notes, ${payments.length} payments, ${quotes.length} quotes, ${pos.length} purchase orders (+1 awkward), ${lineRows.length} lines; ${jobs.length} jobs, ${salesOrders.length} sales orders, ${wip.length} WIP rows.`);
