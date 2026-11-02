#!/usr/bin/env node
// Data checks after a rehearsal import: row counts, totals to the penny, statuses, and the per-customer reconciliation against the
// Aged Debtors report. Reads the synthetic source files directly (strict parser only, not the importer's analysis), the dry-run
// report the importer's reconcile.mjs wrote, and the rehearsal database READ ONLY (one read-only transaction, rolled back).
//
//   node scripts/sliq-import/rehearsal/checks.mjs --work <generate.mjs out folder> --report <report.json> \
//        --database-url postgresql://postgres@127.0.0.1:5432/sliq_rehearsal [--org-slug rehearsal-a] [--json <results.json>]
//
// Every result line is PASS|FAIL|GAP <check> <detail>. GAP marks a difference that the importer makes by design (documented in
// the report), not a failure. Exit 1 on any FAIL.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import pg from "pg";

import { checkDatabaseUrl } from "../guard.mjs";
import { parseCsv, parseMoneyPence } from "../parse.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((a, t, i, xs) => (t.startsWith("--") ? [...a, [t.slice(2), xs[i + 1]]] : a), []));
const work = args.work;
const dbUrl = args["database-url"];
const slug = args["org-slug"] ?? "rehearsal-a";
if (!work || !dbUrl || !args.report) {
  console.error("Usage: checks.mjs --work <folder> --report <report.json> --database-url <local rehearsal url> [--org-slug s] [--json out]");
  process.exit(2);
}
checkDatabaseUrl(dbUrl); // the importer's own screening: loopback or a disposable/rehearsal name, never a hosted project
if (!/rehearsal/.test(new URL(dbUrl).pathname)) throw new Error("Refusing: these checks only run on a database whose name contains 'rehearsal'.");

const manifest = JSON.parse(readFileSync(path.join(work, "manifest.json"), "utf8"));
const report = JSON.parse(readFileSync(args.report, "utf8"));
const read = (f) => {
  const { headers, rows } = parseCsv(readFileSync(f, "utf8"));
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]])));
};
const src = (f) => read(path.join(work, "export", f));
const pence = (v) => parseMoneyPence(v) ?? 0;
const num = (v) => Math.round(Number(v) * 100); // numeric from pg as text -> pence
const fmt = (p) => `${p < 0 ? "-" : ""}£${(Math.abs(p) / 100).toFixed(2)}`;

const results = [];
const out = (status, check, detail) => {
  results.push({ status, check, detail });
  console.log(`${status}|${check}|${detail}`);
};
const eq = (check, got, want, show = (x) => x) => out(got === want ? "PASS" : "FAIL", check, `${show(got)} (expected ${show(want)})`);

// ---- the source, read directly ---------------------------------------------------------------------------------------------------
const customers = src("customers.csv");
const suppliers = src("suppliers.csv");
const invoiceRows = src("invoices.csv");
const lines = src("invoice-lines.csv");
const payments = src("payments.csv");
const quotes = src("quotes.csv");
const pos = src("purchase-orders.csv");
const credits = src("credit-notes.csv");
const aged = read(path.join(work, "sliq-reports", "aged-debtors.csv"));

const notWritten = new Set(manifest.expected.held.map((h) => h.number)); // duplicates, the excluded discount invoice, the orphan
const invoices = invoiceRows.filter((r) => !notWritten.has(r["Invoice No"]));
const invoiceNos = new Set(invoices.map((r) => r["Invoice No"]));
const quoteNos = new Set(quotes.map((r) => r["Quote No"]));
// From the importer's own dry-run report (reconcile.mjs): invoices whose line VAT is unresolved get their header only, and invoices
// whose payment is to be confirmed get no payment rows.
const headerOnly = new Set(report.unresolvedVat.filter((u) => u.kind === "line" && u.documentKind === "invoice").map((u) => u.number));
const toConfirmWithPayments = new Set(report.balances.items.filter((b) => b.paymentToConfirm && b.payments > 0).map((b) => b.number));
const accountOf = new Map(invoiceRows.map((r) => [r["Invoice No"], r.Account]));
const nameToAccount = new Map();
for (const c of customers) nameToAccount.set(c.Name, nameToAccount.has(c.Name) ? null : c.Account); // null = ambiguous name

const db = new pg.Client({ connectionString: dbUrl });
await db.connect();
await db.query("begin read only");
try {
  const org = (await db.query("select id from public.organizations where slug = $1", [slug])).rows[0]?.id;
  if (!org) throw new Error(`no organisation with slug ${slug}`);
  const q = async (sql, params = []) => (await db.query(sql, [org, ...params])).rows;
  const count = async (t, where = "") => Number((await q(`select count(*)::int as n from public.${t} where organization_id = $1 ${where}`))[0].n);

  // ---- 1. row counts per table: source, the designed expectation, the database ---------------------------------------------
  const srcCounts = {
    customers: customers.length,
    suppliers: suppliers.length,
    invoices: invoices.length,
    invoice_line_items: lines.filter((l) => invoiceNos.has(l["Invoice No"]) && !headerOnly.has(l["Invoice No"])).length,
    invoice_payments: payments.filter((p) => invoiceNos.has(p["Invoice No"]) && !toConfirmWithPayments.has(p["Invoice No"])).length,
    quotes: quotes.length,
    quote_line_items: lines.filter((l) => quoteNos.has(l["Invoice No"])).length,
    purchase_orders: pos.length,
  };
  const want = { customers: manifest.expected.customers, suppliers: manifest.expected.suppliers, invoices: manifest.expected.invoices, invoice_line_items: manifest.expected.invoiceLines,
    invoice_payments: manifest.expected.invoicePayments, quotes: manifest.expected.quotes, quote_line_items: manifest.expected.quoteLines, purchase_orders: manifest.expected.purchaseOrders };
  for (const [t, n] of Object.entries(srcCounts)) {
    const got = await count(t);
    out(got === n && n === want[t] ? "PASS" : "FAIL", `count: ${t}`, `database ${got}, source ${n}, designed ${want[t]}`);
  }
  eq("count: invoice_payments are all marked legacy", await count("invoice_payments", "and source = 'legacy'"), srcCounts.invoice_payments);
  eq("count: credit notes written (Tolra has no credit-note import)", await count("credit_notes"), 0);
  eq("count: source invoice rows not written (2 duplicates, 1 excluded, 1 unknown customer)", invoiceRows.length - invoices.length, manifest.expected.held.length);
  eq("count: source payments 1999", payments.length, 1999);
  eq("count: source invoices 2035 + 2 credit notes", `${invoices.length} + ${credits.length}`, "2035 + 2");

  // ---- 2. totals to the penny ------------------------------------------------------------------------------------------------
  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  const [t] = await q("select sum(subtotal)::text n, sum(vat)::text v, sum(total)::text g, sum(amount_paid)::text p from public.invoices where organization_id = $1");
  eq("totals: invoice net", num(t.n), sum(invoices, (r) => pence(r.Net)), fmt);
  eq("totals: invoice VAT", num(t.v), sum(invoices, (r) => pence(r.VAT)), fmt);
  eq("totals: invoice gross", num(t.g), sum(invoices, (r) => pence(r.Gross)), fmt);
  eq("totals: invoice gross = designed", num(t.g), manifest.expected.totalsPence.invoicesGross, fmt);
  const importedPays = payments.filter((p) => invoiceNos.has(p["Invoice No"]) && !toConfirmWithPayments.has(p["Invoice No"]));
  const [pp] = await q("select coalesce(sum(amount), 0)::text s from public.invoice_payments where organization_id = $1");
  eq("totals: legacy payments", num(pp.s), sum(importedPays, (p) => pence(p.Amount)), fmt);
  eq("totals: amount_paid on invoices = the payments", num(t.p), num(pp.s), fmt);
  const [qs] = await q("select sum(total_value)::text s from public.quotes where organization_id = $1");
  eq("totals: quote gross", num(qs.s), sum(quotes, (r) => pence(r.Gross)), fmt);
  const [ps] = await q("select sum(total_value)::text s from public.purchase_orders where organization_id = $1");
  eq("totals: purchase order totals", num(ps.s), sum(pos, (r) => pence(r.Total)), fmt);
  // Per document, not only in sum: every invoice's net / VAT / gross as stated in the source.
  const dbInv = new Map((await q("select invoice_ref, subtotal::text s, vat::text v, total::text g, amount_paid::text p, status, payment_unverified u, invoice_date::text d, due_date::text dd, customer from public.invoices where organization_id = $1")).map((r) => [r.invoice_ref, r]));
  const iso = (d) => (d ? d.split("/").map((x) => x.padStart(2, "0")).reverse().join("-") : null);
  const bad = invoices.filter((r) => {
    const d = dbInv.get(r["Invoice No"]);
    return !d || num(d.s) !== pence(r.Net) || num(d.v) !== pence(r.VAT) || num(d.g) !== pence(r.Gross) || d.d !== iso(r.Date) || d.dd !== iso(r.Due);
  });
  eq("per invoice: net, VAT, gross, invoice date and due date as in the source", bad.length, 0, (n) => `${n} differ${bad.length ? ` (${bad.slice(0, 5).map((r) => r["Invoice No"]).join(", ")})` : ""}`);
  const dbQ = new Map((await q("select quote_ref, total_value::text g from public.quotes where organization_id = $1")).map((r) => [r.quote_ref, r]));
  eq("per quote: gross as in the source", quotes.filter((r) => num(dbQ.get(r["Quote No"])?.g ?? "NaN") !== pence(r.Gross)).length, 0, (n) => `${n} differ`);
  const lineSum = await q("select i.invoice_ref, sum(round(l.quantity * l.unit_price, 2))::text n from public.invoice_line_items l join public.invoices i on i.id = l.invoice_id where l.organization_id = $1 group by 1");
  eq("per invoice: lines add up to the stated net", lineSum.filter((r) => num(r.n) !== num(dbInv.get(r.invoice_ref).s)).length, 0, (n) => `${n} differ`);

  // ---- 3. statuses ---------------------------------------------------------------------------------------------------------------
  const st = Object.fromEntries((await q("select status || case when payment_unverified then '/to-confirm' else '' end k, count(*)::int n from public.invoices where organization_id = $1 group by 1")).map((r) => [r.k, r.n]));
  eq("status: paid", st.paid ?? 0, manifest.expected.statuses.paid);
  eq("status: partial (part paid, balance owed)", st.partial ?? 0, manifest.expected.statuses.partial);
  eq("status: Payment to confirm (36 unpaid + 1 overpaid)", st["sent/to-confirm"] ?? 0, manifest.expected.statuses.sentPaymentToConfirm);
  eq("status: nothing else", Object.keys(st).filter((k) => !["paid", "partial", "sent/to-confirm"].includes(k)).length, 0);
  const op = manifest.awkward.overpaid;
  const opDb = dbInv.get(op.number);
  out(opDb?.u && num(opDb.p) === 0 ? "PASS" : "FAIL", "status: the overpaid invoice is Payment to confirm, its payment not imported", `${op.number}: unverified ${opDb?.u}, amount_paid ${opDb?.p}`);
  const partOk = manifest.awkward.partPaid.every((x) => dbInv.get(x.number)?.status === "partial" && num(dbInv.get(x.number).p) === x.paid);
  out(partOk ? "PASS" : "FAIL", "status: each part-paid invoice keeps its exact part payment", manifest.awkward.partPaid.map((x) => `${x.number} ${fmt(x.paid)} of ${fmt(x.gross)}`).join("; "));

  // ---- 4. per-customer balances against the Aged Debtors report ---------------------------------------------------------------
  const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);
  const sliq = new Map();
  for (const a of aged) add(sliq, a.Account, pence(a.Outstanding));
  const agedTotal = sum(aged, (a) => pence(a.Outstanding));
  eq("aged debtors: SliQ report total = designed", agedTotal, manifest.expected.agedDebtorsPence, fmt);
  // (a) reconcile.mjs (the importer's dry run) against the SliQ report: invoice balances + credit notes, per customer.
  const rec = new Map();
  // Held rows (duplicates, the excluded and the orphan invoice) are not written and are not in this ledger: left out.
  for (const b of report.balances.items) if (b.balance && !b.held) add(rec, accountOf.get(b.number), b.balance);
  for (const c of report.creditNotes.items ?? report.creditNotes) add(rec, c.customer, c.proposedGross);
  const accounts = [...new Set([...sliq.keys(), ...rec.keys()])].sort();
  const recOff = accounts.filter((k) => (sliq.get(k) ?? 0) !== (rec.get(k) ?? 0));
  out(recOff.length === 0 ? "PASS" : "FAIL", "aged debtors: reconcile.mjs balances = SliQ Aged Debtors, per customer", `${accounts.length} customers, ${recOff.length} differ; total ${fmt(sum([...rec.values()], (x) => x))} vs ${fmt(agedTotal)}`);
  // (b) the Tolra ledger (total - amount_paid of every imported invoice) against the SliQ report, per customer. The only allowed
  // differences are the ones the importer makes by design: credit notes are not written (SliQ shows them as credits) and an
  // overpaid invoice's payment is held (SliQ shows a credit; Tolra the full amount, Payment to confirm).
  const ambiguous = [...nameToAccount.entries()].filter(([, v]) => v === null).map(([k]) => k);
  eq("aged debtors: customer names are unique as written (ledger maps by name)", ambiguous.length, 0, (n) => `${n} ambiguous`);
  const ledger = new Map();
  for (const d of dbInv.values()) {
    const bal = num(d.g) - num(d.p);
    if (bal !== 0) add(ledger, nameToAccount.get(d.customer) ?? `?${d.customer}`, bal);
  }
  const explained = new Map();
  for (const c of manifest.awkward.creditNotes) add(explained, c.account, c.gross);
  add(explained, accountOf.get(op.number), op.paid);
  const all = [...new Set([...sliq.keys(), ...ledger.keys(), ...explained.keys()])].sort();
  const off = all.filter((k) => (ledger.get(k) ?? 0) - (sliq.get(k) ?? 0) !== (explained.get(k) ?? 0));
  const ledgerTotal = sum([...ledger.values()], (x) => x);
  out(off.length === 0 ? "PASS" : "FAIL", "aged debtors: Tolra ledger = SliQ Aged Debtors per customer, to the penny, after the designed differences",
    `${all.length} customers, ${off.length} unexplained; ledger ${fmt(ledgerTotal)} = SliQ ${fmt(agedTotal)} + credit notes not written ${fmt(sum(manifest.awkward.creditNotes, (c) => c.gross))} + overpaid payment held ${fmt(op.paid)}${off.length ? `; differ: ${off.slice(0, 5).join(", ")}` : ""}`);
  // (c) what Tolra shows as money owed (lib/receivables.ts owed(): Payment to confirm counts as nothing owed until confirmed).
  const [ow] = await q(`select coalesce(sum(greatest(0, total - coalesce(amount_paid,0) - coalesce(credited_amount,0) + coalesce(refunded_amount,0))), 0)::text s
                        from public.invoices where organization_id = $1 and not coalesce(payment_unverified, false) and coalesce(status, 'draft') not in ('paid','draft','void','voided','cancelled','canceled','credited','written_off')`);
  const [uv] = await q("select count(*)::int n, coalesce(sum(total), 0)::text s from public.invoices where organization_id = $1 and payment_unverified");
  out(num(ow.s) === agedTotal ? "PASS" : "GAP", "aged debtors: Tolra money owed (receivables) on day one",
    `${fmt(num(ow.s))} owed (the 6 part-paid balances) vs SliQ ${fmt(agedTotal)}: ${uv.n} invoices (${fmt(num(uv.s))}) are Payment to confirm and count as nothing owed until someone confirms them`);
  const partBal = sum(manifest.awkward.partPaid, (x) => x.gross - x.paid);
  eq("aged debtors: the owed figure is exactly the part-paid balances", num(ow.s), partBal, fmt);
} finally {
  await db.query("rollback").catch(() => {});
  await db.end();
}

const fails = results.filter((r) => r.status === "FAIL").length;
console.log(`checks: ${results.filter((r) => r.status === "PASS").length} PASS, ${fails} FAIL, ${results.filter((r) => r.status === "GAP").length} GAP`);
if (args.json) writeFileSync(args.json, `${JSON.stringify(results, null, 2)}\n`);
process.exit(fails ? 1 : 0);
