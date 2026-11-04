// SYNTHETIC SliQ report-style exports for the go-live smoke (written fresh for the public repo from the shapes in the private mapping
// docs SLIQ-REPORT-FILES-IMPORT-MAPPING-2026-11-04 and SLIQ-CUSTOMERS-IMPORT-MAPPING-2026-11-04; no real data, no private code).
// Every name is made up, every e-mail is @example.test or .invalid. Deterministic for a seed (mulberry32), so a run can be repeated.
//
// The files look like SliQ's report exports: title rows above the header, group-header rows (one text cell, no amount), a totals row
// at the bottom, dates dd/mm/yyyy, money with a pound sign and thousands commas, credit notes ("Crd") with NEGATIVE totals:
//   customers.csv        Business, Email, Phone, Account Number (several cells hold two e-mails; one holds none valid)
//   invoices-report.csv  Type, Num, Date, Customer, Net Total, VAT, Total (Inv and Crd rows; one VAT 1p off 20%, surfaced not changed)
//   payments-report.csv  Payment Date, Payment Method, Customer, Num, Payment Net, VAT, Payment Amount
//   credit-links.csv     Crd Num, Invoice Num: the invoice each credit note credits, as John supplies it (one Crd has no link)
//   quotes-report.csv    Num, Date, Status, Invoice, Net Total, VAT, Total (must be refused when offered as invoices)
//   unpaid-report.csv    Type, Num, Date, Total, Amount Paid, Outstanding (a reconciliation check only, never imported)
//   aged-debtors.csv     Customer, Current, 0 to 30, Over 30, Over 60, Over 90, Amount Due (a check only)
//
//   node scripts/golive-smoke/sliq/generate.mjs <out dir> [seed] [invoices]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 20% VAT on integer pence, half away from zero (Postgres round(numeric, 2)). */
export const vat20 = (pence) => Math.sign(pence) * Math.floor((Math.abs(pence) * 20 + 50) / 100);

/** Integer pence as SliQ prints it: "£1,234.50", "-£12.00". */
export function money(pence) {
  const sign = pence < 0 ? "-" : "";
  const abs = Math.abs(pence);
  const pounds = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}£${pounds}.${String(abs % 100).padStart(2, "0")}`;
}

const ukDate = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const csvCell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
const csv = (rows) => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

const CUSTOMERS = [
  { name: "Acme Synthetic Fixings Ltd", email: "accounts@acme-fixings.example.test", acct: "ACM001" },
  { name: "Brook Example Engineering", email: "ap@brook.example.test; orders@brook.example.test", acct: "BRO002" },
  { name: "Cobalt Made-Up Machining", email: "buyer@cobalt.example.test buyer2@cobalt.example.test", acct: "COB003" },
  { name: "Delta Pretend Products", email: "accounts @delta.example.test", acct: "DEL004" },
  { name: "Echo Fictional Fabrications", email: "ledger@echo.example.test", acct: "ECH005" },
  { name: "Foxtrot Invented Tools", email: "", acct: "FOX006" },
];
const METHODS = ["BACS", "Cheque", "Card", "Bank Transfer", "Cash"];

/** The synthetic data set, plus the expected outcome the checks compare against (integer pence throughout). */
export function generate({ seed = 20261104, invoices: count = 40, prefix = "SINV" } = {}) {
  const rnd = mulberry32(seed);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const day = (start, span) => { const d = new Date(Date.UTC(2026, 0, 1) + Math.floor(start + rnd() * span) * 86_400_000); return d.toISOString().slice(0, 10); };

  const invoices = [];
  for (let i = 0; i < count; i++) {
    const net = 1_000 + Math.floor(rnd() * 250_000);
    const vat = vat20(net);
    invoices.push({ type: "Inv", num: `${prefix}-${String(1001 + i)}`, date: day(i * 6, 5), customer: CUSTOMERS[i % CUSTOMERS.length].name, net, vat, total: net + vat });
  }
  // One invoice whose VAT is 1p off 20% of net: surfaced by the pre-step, imported as SliQ states it (Net + VAT = Total still holds).
  invoices[7].vat += 1; invoices[7].total += 1;

  const payments = [];
  invoices.forEach((inv, i) => {
    const kind = i % 4; // 0 paid in one, 1 paid in two parts, 2 part paid, 3 unpaid
    if (kind === 3 || i === 9) return; // invoice 9 is credited instead (below)
    const when = (k) => { const d = new Date(Date.parse(inv.date) + (10 + k * 7) * 86_400_000); return d.toISOString().slice(0, 10); };
    if (kind === 0) payments.push({ num: inv.num, date: when(0), method: pick(METHODS), customer: inv.customer, amount: inv.total });
    if (kind === 1) {
      const first = Math.floor(inv.total / 3);
      payments.push({ num: inv.num, date: when(0), method: pick(METHODS), customer: inv.customer, amount: first });
      payments.push({ num: inv.num, date: when(1), method: pick(METHODS), customer: inv.customer, amount: inv.total - first });
    }
    if (kind === 2) payments.push({ num: inv.num, date: when(0), method: pick(METHODS), customer: inv.customer, amount: Math.floor(inv.total / 2) });
  });
  // Two equal payments on the same day for one invoice (both must import: the match key carries an ordinal).
  const twin = invoices[10]; // part paid (kind 2): its one payment is replaced by the two equal ones
  payments.splice(payments.findIndex((p) => p.num === twin.num), 1);
  payments.push({ num: twin.num, date: "2026-03-31", method: "BACS", customer: twin.customer, amount: Math.floor(twin.total / 4) });
  payments.push({ num: twin.num, date: "2026-03-31", method: "BACS", customer: twin.customer, amount: Math.floor(twin.total / 4) });
  payments.forEach((p) => { p.vat = Math.round(p.amount / 6); p.net = p.amount - p.vat; });

  // Two credit notes, NEGATIVE as the synthetic SliQ report writes them. CRD-9001 credits a quarter of invoice 9 (link supplied);
  // CRD-9002 has no link at all: it must be held out and listed, never netted into an invoice, and refused if sent unlinked.
  const credited = invoices[9];
  const crNet = Math.floor(credited.net / 4);
  const credits = [
    { type: "Crd", num: "CRD-9001", date: day(200, 10), customer: credited.customer, net: -crNet, vat: -vat20(crNet), total: -(crNet + vat20(crNet)), link: credited.num },
    { type: "Crd", num: "CRD-9002", date: day(210, 10), customer: CUSTOMERS[4].name, net: -2_000, vat: -400, total: -2_400, link: null },
  ];

  // Expected balances: total - payments - credit.
  const paidBy = new Map();
  for (const p of payments) paidBy.set(p.num, (paidBy.get(p.num) ?? 0) + p.amount);
  const balances = new Map(invoices.map((inv) => [inv.num, inv.total - (paidBy.get(inv.num) ?? 0)]));
  balances.set(credited.num, balances.get(credited.num) - (crNet + vat20(crNet)));
  const byCustomer = new Map();
  for (const inv of invoices) byCustomer.set(inv.customer, (byCustomer.get(inv.customer) ?? 0) + balances.get(inv.num));

  // --- the report files -------------------------------------------------------------------------------------------------------
  const title = (what) => [["JNR Synthetic Example Ltd"], [what], ["From 01/01/2026 to 13/10/2026"], [""], [""]];
  const invRows = [...title("Invoices"), ["Type", "Num", "Date", "Customer", "Net Total", "VAT", "Total"]];
  let month = "";
  const sums = { net: 0, vat: 0, total: 0 };
  for (const r of [...invoices, ...credits].sort((a, b) => a.date.localeCompare(b.date) || a.num.localeCompare(b.num))) {
    const m = r.date.slice(0, 7);
    if (m !== month) { month = m; invRows.push([`${new Date(`${m}-01T00:00:00Z`).toLocaleString("en-GB", { month: "long", timeZone: "UTC" })} ${m.slice(0, 4)}`]); }
    invRows.push([r.type, r.num, ukDate(r.date), r.customer, money(r.net), money(r.vat), money(r.total)]);
    sums.net += r.net; sums.vat += r.vat; sums.total += r.total;
  }
  invRows.push([""], ["Total", "", "", "", money(sums.net), money(sums.vat), money(sums.total)]);

  const payRows = [...title("Payments"), ["Payment Date", "Payment Method", "Customer", "Num", "Payment Net", "VAT", "Payment Amount"]];
  const psums = { net: 0, vat: 0, amount: 0 };
  let group = "";
  for (const p of [...payments].sort((a, b) => a.customer.localeCompare(b.customer) || a.date.localeCompare(b.date) || a.num.localeCompare(b.num))) {
    if (p.customer !== group) { group = p.customer; payRows.push(["", "", p.customer]); }
    payRows.push([ukDate(p.date), p.method, p.customer, p.num, money(p.net), money(p.vat), money(p.amount)]);
    psums.net += p.net; psums.vat += p.vat; psums.amount += p.amount;
  }
  payRows.push(["Totals", "", "", "", money(psums.net), money(psums.vat), money(psums.amount)]);

  const quoteRows = [...title("Quotes"), ["Num", "Date", "Status", "Invoice", "Net Total", "VAT", "Total"],
    ["SQ-2001", "02/02/2026", "Accepted", invoices[0].num, money(invoices[0].net), money(invoices[0].vat), money(invoices[0].total)],
    ["SQ-2002", "03/02/2026", "Open", "", money(10_000), money(2_000), money(12_000)],
    ["Total", "", "", "", money(invoices[0].net + 10_000), money(invoices[0].vat + 2_000), money(invoices[0].total + 12_000)]];

  const unpaidRows = [...title("Unpaid Invoices"), ["Type", "Num", "Date", "Total", "Amount Paid", "Outstanding"]];
  let outstanding = 0;
  for (const inv of invoices) {
    const bal = balances.get(inv.num);
    if (bal > 0) { unpaidRows.push(["Inv", inv.num, ukDate(inv.date), money(inv.total), money(paidBy.get(inv.num) ?? 0), money(bal)]); outstanding += bal; }
  }
  unpaidRows.push(["Total", "", "", "", "", money(outstanding)]);
  const agedRows = [...title("Aged Debtors"), ["Customer", "Current", "0 to 30", "Over 30", "Over 60", "Over 90", "Amount Due"]];
  for (const [c, due] of [...byCustomer].sort()) if (due) agedRows.push([c, "", "", "", "", "", money(due)]);
  agedRows.push(["Total", "", "", "", "", "", money(outstanding)]);

  const files = {
    "customers.csv": csv([["Business", "Email", "Phone", "Account Number"], ...CUSTOMERS.map((c) => [c.name, c.email, "01000 000123", c.acct])]),
    "invoices-report.csv": csv(invRows),
    "payments-report.csv": csv(payRows),
    "credit-links.csv": csv([["Crd Num", "Invoice Num"], ["CRD-9001", credited.num]]),
    "quotes-report.csv": csv(quoteRows),
    "unpaid-report.csv": csv(unpaidRows),
    "aged-debtors.csv": csv(agedRows),
  };
  return {
    files,
    expected: {
      invoices: invoices.length, credits: credits.length, payments: payments.length, customers: CUSTOMERS.length,
      notTwentyPct: [invoices[7].num], creditedInvoice: credited.num, linkedCredit: "CRD-9001", orphanCredit: "CRD-9002",
      creditTotal: crNet + vat20(crNet), balances: Object.fromEntries(balances), byCustomer: Object.fromEntries(byCustomer), outstanding,
      paymentsTotal: psums.amount, twinInvoice: twin.num,
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir, seed, count] = process.argv.slice(2);
  if (!dir) { console.error("usage: generate.mjs <out dir> [seed] [invoices]"); process.exit(2); }
  const { files, expected } = generate({ seed: seed ? Number(seed) : undefined, invoices: count ? Number(count) : undefined });
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text);
  writeFileSync(path.join(dir, "expected.json"), JSON.stringify(expected, null, 2));
  console.log(`synthetic SliQ files in ${dir}: ${Object.keys(files).join(", ")}; ${expected.invoices} Inv + ${expected.credits} Crd, ${expected.payments} payments`);
}
