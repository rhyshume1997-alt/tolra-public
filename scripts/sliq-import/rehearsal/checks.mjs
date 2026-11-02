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

const notWritten = new Set(manifest.expected.held.map((h) => h.number)); // excluded by number: the discount invoice and the orphan
const iso = (d) => (d ? d.split("/").map((x) => x.padStart(2, "0")).reverse().join("-") : null);
// Decision 2, worked out here independently of the importer: every copy of a number used twice is written; the earliest by date
// (then source row) keeps it, the others get -B, -C ...
function tolraNumbers(rows, numberCol, dateCol) {
  const by = new Map();
  rows.forEach((r, i) => by.set(r[numberCol], [...(by.get(r[numberCol]) ?? []), { r, i }]));
  const shared = new Set([...by].filter(([, v]) => v.length > 1).map(([k]) => k));
  for (const [k, v] of by) {
    if (v.length < 2) {
      v[0].r._tolra = k;
      continue;
    }
    v.sort((x, y) => String(iso(x.r[dateCol])).localeCompare(String(iso(y.r[dateCol]))) || x.i - y.i).forEach((x, j) => (x.r._tolra = j === 0 ? k : `${k}-${String.fromCharCode(65 + j)}`));
  }
  return shared;
}
const sharedInv = tolraNumbers(invoiceRows, "Invoice No", "Date");
const sharedQuote = tolraNumbers(quotes, "Quote No", "Date");
const sharedPo = tolraNumbers(pos, "PO No", "Order Date");
const invoices = invoiceRows.filter((r) => !notWritten.has(r["Invoice No"]));
const invoiceNos = new Set(invoices.map((r) => r["Invoice No"])); // SliQ numbers
const quoteNos = new Set(quotes.map((r) => r["Quote No"]));
// From the importer's own dry-run report (reconcile.mjs): invoices whose line VAT is unresolved get their header only.
const headerOnly = new Set(report.unresolvedVat.filter((u) => u.kind === "line" && u.documentKind === "invoice").map((u) => u.number));
const accountOf = new Map(invoiceRows.map((r) => [r._tolra, r.Account])); // Tolra number -> account (the truth)
const quoteAccount = new Map(quotes.map((r) => [r._tolra, r.Account]));
const tolraName = manifest.expected.tolraNames; // account -> the name the customer must have in Tolra
const nameToAccount = new Map(Object.entries(tolraName).map(([k, v]) => [v, k]));
const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);

// ---- 0. the dry-run report: renames logged, nothing ambiguous left, no payment exception, nothing to confirm ---------------------
const want = manifest.expected.renames.map((x) => `${x.kind}|${x.sourceNumber}|${x.number}`).sort();
const gotRen = report.renames.map((x) => `${x.kind}|${x.sourceNumber}|${x.number}`).sort();
out(JSON.stringify(gotRen) === JSON.stringify(want) ? "PASS" : "FAIL", "duplicates: every copy logged in the dry-run report with its designed Tolra number", `${gotRen.join(", ")} (expected ${want.join(", ")})`);
const indep = [...invoiceRows.filter((r) => sharedInv.has(r["Invoice No"])).map((r) => `invoice|${r["Invoice No"]}|${r._tolra}`), ...quotes.filter((r) => sharedQuote.has(r["Quote No"])).map((r) => `quote|${r["Quote No"]}|${r._tolra}`), ...pos.filter((r) => sharedPo.has(r["PO No"])).map((r) => `purchase_order|${r["PO No"]}|${r._tolra}`)].sort();
eq("duplicates: the importer's numbering = the rule worked out here (earliest keeps, then -B)", JSON.stringify(gotRen), JSON.stringify(indep));
eq("customer matching: nothing ambiguous or unmatched is left in the approved report", report.unresolvedMatchCount, 0);
eq("payments: no payment exception in the approved report", report.unresolvedPaymentCount, 0);
eq("payments: the approved report leaves no invoice Payment to confirm", report.writePlan.invoicesPaymentToConfirm, 0);

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
    invoice_line_items: lines.filter((l) => invoiceNos.has(l["Invoice No"]) && !sharedInv.has(l["Invoice No"]) && !headerOnly.has(l["Invoice No"])).length,
    invoice_payments: payments.filter((p) => invoiceNos.has(p["Invoice No"])).length,
    quotes: quotes.length,
    quote_line_items: lines.filter((l) => quoteNos.has(l["Invoice No"]) && !sharedQuote.has(l["Invoice No"])).length,
    purchase_orders: pos.length,
  };
  const designed = { customers: manifest.expected.customers, suppliers: manifest.expected.suppliers, invoices: manifest.expected.invoices, invoice_line_items: manifest.expected.invoiceLines,
    invoice_payments: manifest.expected.invoicePayments, quotes: manifest.expected.quotes, quote_line_items: manifest.expected.quoteLines, purchase_orders: manifest.expected.purchaseOrders };
  for (const [t, n] of Object.entries(srcCounts)) {
    const got = await count(t);
    out(got === n && n === designed[t] ? "PASS" : "FAIL", `count: ${t}`, `database ${got}, source ${n}, designed ${designed[t]}`);
  }
  eq("count: invoice_payments are all marked legacy", await count("invoice_payments", "and source = 'legacy'"), srcCounts.invoice_payments);
  eq("count: credit notes written (issued, imported as customer credit)", await count("credit_notes", "and status = 'issued'"), manifest.expected.creditNotesWritten);
  const cnDb = await q(`select c.credit_ref, c.total::text t, c.allocated_amount::text a, c.customer, i.invoice_ref, i.status, i.customer ic,
                          (select sum(x.amount) from public.invoice_credit_allocations x where x.credit_note_id = c.id)::text al
                        from public.credit_notes c join public.invoices i on i.id = c.invoice_id where c.organization_id = $1 order by 1`);
  const cnOk = manifest.awkward.creditNotes.every((x) => {
    const d = cnDb.find((r) => r.credit_ref === x.number);
    return d && num(d.t) === x.gross && num(d.a) === x.gross && num(d.al) === x.gross && d.customer === tolraName[x.account] && d.ic === d.customer && d.status === "paid";
  });
  out(cnOk ? "PASS" : "FAIL", "credit notes: each is applied in full to a paid invoice of the same customer (its credit)", cnDb.map((r) => `${r.credit_ref} ${fmt(num(r.t))} on ${r.invoice_ref} (${r.customer})`).join("; "));
  const [crd] = await q("select last from public.doc_counters where organization_id = $1 and prefix = 'CRD'");
  eq("credit notes: the CRD counter continues after the highest imported number", crd?.last ?? null, Math.max(...manifest.awkward.creditNotes.map((c) => Number(c.number.replace(/\D/g, "")))));
  eq("count: source invoice rows not written (only the 2 excluded by number: discount, unknown customer)", invoiceRows.length - invoices.length, manifest.expected.held.length);
  eq("count: source payments 1999, every one imported", payments.length, 1999);
  eq("count: source invoices 2035 + the duplicate number's 2 copies + 2 credit notes", `${invoices.length} + ${credits.length}`, "2037 + 2");

  // ---- 2. totals to the penny ------------------------------------------------------------------------------------------------
  const [t] = await q("select sum(subtotal)::text n, sum(vat)::text v, sum(total)::text g, sum(amount_paid)::text p from public.invoices where organization_id = $1");
  eq("totals: invoice net", num(t.n), sum(invoices, (r) => pence(r.Net)), fmt);
  eq("totals: invoice VAT", num(t.v), sum(invoices, (r) => pence(r.VAT)), fmt);
  eq("totals: invoice gross", num(t.g), sum(invoices, (r) => pence(r.Gross)), fmt);
  eq("totals: invoice gross = designed", num(t.g), manifest.expected.totalsPence.invoicesGross, fmt);
  const importedPays = payments.filter((p) => invoiceNos.has(p["Invoice No"]));
  const [pp] = await q("select coalesce(sum(amount), 0)::text s from public.invoice_payments where organization_id = $1");
  eq("totals: legacy payments", num(pp.s), sum(importedPays, (p) => pence(p.Amount)), fmt);
  eq("totals: legacy payments = designed", num(pp.s), manifest.expected.totalsPence.paymentsImported, fmt);
  eq("totals: amount_paid on invoices = the payments", num(t.p), num(pp.s), fmt);
  const [qs] = await q("select sum(total_value)::text s from public.quotes where organization_id = $1");
  eq("totals: quote gross", num(qs.s), sum(quotes, (r) => pence(r.Gross)), fmt);
  const [ps] = await q("select sum(total_value)::text s from public.purchase_orders where organization_id = $1");
  eq("totals: purchase order totals", num(ps.s), sum(pos, (r) => pence(r.Total)), fmt);
  // Per document, not only in sum: every invoice's net / VAT / gross as stated in the source, under its Tolra number.
  const dbInv = new Map((await q("select invoice_ref, source_ref, subtotal::text s, vat::text v, total::text g, amount_paid::text p, status, payment_unverified u, invoice_date::text d, due_date::text dd, customer from public.invoices where organization_id = $1")).map((r) => [r.invoice_ref, r]));
  const bad = invoices.filter((r) => {
    const d = dbInv.get(r._tolra);
    return !d || num(d.s) !== pence(r.Net) || num(d.v) !== pence(r.VAT) || num(d.g) !== pence(r.Gross) || d.d !== iso(r.Date) || d.dd !== iso(r.Due);
  });
  eq("per invoice: net, VAT, gross, invoice date and due date as in the source", bad.length, 0, (n) => `${n} differ${bad.length ? ` (${bad.slice(0, 5).map((r) => r._tolra).join(", ")})` : ""}`);
  const dbQ = new Map((await q("select quote_ref, source_ref, total_value::text g, customer from public.quotes where organization_id = $1")).map((r) => [r.quote_ref, r]));
  eq("per quote: gross as in the source", quotes.filter((r) => num(dbQ.get(r._tolra)?.g ?? "NaN") !== pence(r.Gross)).length, 0, (n) => `${n} differ`);
  const lineSum = await q("select i.invoice_ref, sum(round(l.quantity * l.unit_price, 2))::text n from public.invoice_line_items l join public.invoices i on i.id = l.invoice_id where l.organization_id = $1 group by 1");
  eq("per invoice: lines add up to the stated net", lineSum.filter((r) => num(r.n) !== num(dbInv.get(r.invoice_ref).s)).length, 0, (n) => `${n} differ`);

  // ---- 3. decision 2: duplicates kept, numbered deterministically, the SliQ number kept as source_ref -------------------------
  const dbPo = new Map((await q("select po_ref, source_ref, supplier, total_value::text t from public.purchase_orders where organization_id = $1")).map((r) => [r.po_ref, r]));
  for (const r of manifest.expected.renames) {
    const d = r.kind === "invoice" ? dbInv.get(r.number) : r.kind === "quote" ? dbQ.get(r.number) : dbPo.get(r.number);
    out(d && d.source_ref === r.sourceNumber ? "PASS" : "FAIL", `duplicates: ${r.kind} ${r.number} written, SliQ number kept as source_ref`, d ? `source_ref ${d.source_ref}` : "missing");
  }
  const refOff = [...[...dbInv.values()].filter((d) => d.source_ref !== invoiceRows.find((r) => r._tolra === d.invoice_ref)?.["Invoice No"]), ...[...dbQ.values()].filter((d) => d.source_ref !== quotes.find((r) => r._tolra === d.quote_ref)?.["Quote No"]),
    ...[...dbPo.values()].filter((d) => d.source_ref !== pos.find((r) => r._tolra === d.po_ref)?.["PO No"])];
  eq("duplicates: every imported invoice, quote and purchase order carries its SliQ number (source_ref)", refOff.length, 0, (n) => `${n} wrong${refOff.length ? ` (${refOff.slice(0, 5).map((d) => d.invoice_ref ?? d.quote_ref ?? d.po_ref).join(", ")})` : ""}`);
  const dupLines = await q("select count(*)::int n from public.invoice_line_items l join public.invoices i on i.id = l.invoice_id where l.organization_id = $1 and i.source_ref = any($2::text[])", [[...sharedInv]]);
  eq("duplicates: copies of a shared number are header only (their lines cannot be told apart)", dupLines[0].n, 0);

  // ---- 4. decision 3: every document on the right customer (Tolra links by name), every name unique --------------------------
  const wrongInv = [...dbInv.values()].filter((d) => d.customer !== tolraName[accountOf.get(d.invoice_ref)]);
  const wrongQ = [...dbQ.values()].filter((d) => d.customer !== tolraName[quoteAccount.get(d.quote_ref)]);
  const wrongPo = [...dbPo.values()].filter((d) => d.supplier !== pos.find((r) => r._tolra === d.po_ref)?.Supplier);
  eq("customer matching: wrong attachments (invoices, quotes, purchase orders)", wrongInv.length + wrongQ.length + wrongPo.length, 0,
    (n) => `${n} wrong of ${dbInv.size} invoices, ${dbQ.size} quotes, ${dbPo.size} POs${n ? ` (${[...wrongInv.map((d) => d.invoice_ref), ...wrongQ.map((d) => d.quote_ref), ...wrongPo.map((d) => d.po_ref)].slice(0, 5).join(", ")})` : ""}`);
  const same = manifest.expected.sameNameCustomers;
  const sameDocs = [...dbInv.values()].filter((d) => same.includes(accountOf.get(d.invoice_ref))).length + [...dbQ.values()].filter((d) => same.includes(quoteAccount.get(d.quote_ref))).length;
  out(sameDocs > 0 ? "PASS" : "FAIL", "customer matching: the two customers SliQ names the same have their documents, each on its own customer", `${sameDocs} documents for ${same.join(" and ")} (${same.map((k) => tolraName[k]).join(" / ")})`);
  const names = await q("select name, notes from public.customers where organization_id = $1");
  eq("customer matching: Tolra customer names are unique", new Set(names.map((r) => r.name.toLowerCase())).size, names.length);
  const renamedC = names.find((r) => r.name === tolraName[same[1]]);
  out(renamedC && /Name in SliQ: Riverside Engineering Ltd/.test(renamedC.notes ?? "") ? "PASS" : "FAIL", "customer matching: the customer given its own name keeps its SliQ name in the notes", renamedC ? `${renamedC.name}: ${(renamedC.notes ?? "").split("\n").at(-1)}` : "missing");

  // ---- 5. decision 1: real statuses and balances, nothing Payment to confirm ----------------------------------------------------
  const st = Object.fromEntries((await q("select status || case when payment_unverified then '/to-confirm' else '' end k, count(*)::int n from public.invoices where organization_id = $1 group by 1")).map((r) => [r.k, r.n]));
  eq("status: paid (paid in full, and the overpaid one)", st.paid ?? 0, manifest.expected.statuses.paid);
  eq("status: partial (part paid, balance owed)", st.partial ?? 0, manifest.expected.statuses.partial);
  eq("status: unpaid (issued, owed in full)", st.sent ?? 0, manifest.expected.statuses.sentUnpaid);
  eq("status: Payment to confirm", Object.keys(st).filter((k) => k.endsWith("/to-confirm")).reduce((a, k) => a + st[k], 0), 0);
  eq("status: nothing else", Object.keys(st).filter((k) => !["paid", "partial", "sent"].includes(k)).length, 0);
  const op = manifest.awkward.overpaid;
  const opDb = dbInv.get(op.number);
  out(opDb && !opDb.u && opDb.status === "paid" && num(opDb.p) === op.paid ? "PASS" : "FAIL", "status: the overpaid invoice is paid with its whole payment (the surplus is the customer's credit)", `${op.number}: ${opDb?.status}, amount_paid ${opDb?.p} of ${fmt(op.gross)}`);
  const partOk = manifest.awkward.partPaid.every((x) => dbInv.get(x.number)?.status === "partial" && num(dbInv.get(x.number).p) === x.paid);
  out(partOk ? "PASS" : "FAIL", "status: each part-paid invoice keeps its exact part payment", manifest.awkward.partPaid.map((x) => `${x.number} ${fmt(x.paid)} of ${fmt(x.gross)}`).join("; "));
  const unpaidOk = manifest.awkward.unpaid.every((n) => dbInv.get(n)?.status === "sent" && num(dbInv.get(n).p) === 0 && !dbInv.get(n).u);
  out(unpaidOk ? "PASS" : "FAIL", "status: each unpaid invoice is issued and owed in full", `${manifest.awkward.unpaid.length} unpaid`);

  // ---- 6. against the Aged Debtors report, to the penny ---------------------------------------------------------------------
  const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);
  const sliq = new Map();
  for (const a of aged) add(sliq, a.Account, pence(a.Outstanding));
  const agedTotal = sum(aged, (a) => pence(a.Outstanding));
  eq("aged debtors: SliQ report total = designed", agedTotal, manifest.expected.agedDebtorsPence, fmt);
  const accountByRef = (ref) => (tolraName[ref] ? ref : customers.filter((c) => c.Name === ref).length === 1 ? customers.find((c) => c.Name === ref).Account : `?${ref}`);
  // (a) reconcile.mjs (the importer's dry run) against the SliQ report: invoice balances + credit notes, per customer.
  const rec = new Map();
  for (const b of report.balances.items) if (b.balance && !b.held) add(rec, accountOf.get(b.number), b.balance);
  for (const c of report.creditNotes) add(rec, accountByRef(c.customer), c.proposedGross);
  const accounts = [...new Set([...sliq.keys(), ...rec.keys()])].sort();
  const recOff = accounts.filter((k) => (sliq.get(k) ?? 0) !== (rec.get(k) ?? 0));
  out(recOff.length === 0 ? "PASS" : "FAIL", "aged debtors: reconcile.mjs balances = SliQ Aged Debtors, per customer", `${accounts.length} customers, ${recOff.length} differ; total ${fmt(sum([...rec.values()], (x) => x))} vs ${fmt(agedTotal)}`);
  // (b) each customer's NET balance in Tolra (owed less credit: total - amount_paid - credited_amount over every imported invoice;
  // an overpayment or a credit note makes it negative) against the SliQ report, per customer and in total, to the penny. No
  // designed difference is left: credit notes are imported as customer credit.
  const net = new Map();
  for (const r of await q("select customer, sum(total - amount_paid - credited_amount + refunded_amount)::text b from public.invoices where organization_id = $1 group by 1")) {
    if (num(r.b) !== 0) add(net, nameToAccount.get(r.customer) ?? `?${r.customer}`, num(r.b));
  }
  const all = [...new Set([...sliq.keys(), ...net.keys()])].sort();
  const off = all.filter((k) => (net.get(k) ?? 0) !== (sliq.get(k) ?? 0));
  const netTotal = sum([...net.values()], (x) => x);
  out(off.length === 0 ? "PASS" : "FAIL", "aged debtors: each customer's net balance in Tolra (owed less credit) = SliQ Aged Debtors, to the penny",
    `${all.length} customers, ${off.length} differ${off.length ? `: ${off.slice(0, 5).map((k) => `${k} ${fmt(net.get(k) ?? 0)} vs ${fmt(sliq.get(k) ?? 0)}`).join(", ")}` : ""}`);
  eq("aged debtors: Tolra net balance in total = SliQ Aged Debtors total, to the penny", netTotal, agedTotal, fmt);
  // (c) what Tolra shows as money owed (lib/receivables.ts owed() and customerCredit()), straight after the import.
  const [ow] = await q(`select coalesce(sum(greatest(0, total - coalesce(amount_paid,0) - coalesce(credited_amount,0) + coalesce(refunded_amount,0))), 0)::text s
                        from public.invoices where organization_id = $1 and not coalesce(payment_unverified, false) and coalesce(status, 'draft') not in ('paid','draft','void','voided','cancelled','canceled','credited','written_off')`);
  const [cr] = await q(`select coalesce(sum(greatest(0, coalesce(amount_paid,0) + coalesce(credited_amount,0) - coalesce(refunded_amount,0) - total)), 0)::text s
                        from public.invoices where organization_id = $1 and not coalesce(payment_unverified, false) and coalesce(status, 'draft') not in ('draft','void','voided','cancelled','canceled','written_off')`);
  eq("aged debtors: Tolra money owed = what SliQ's Aged Debtors shows owed on invoices, to the penny", num(ow.s), manifest.expected.agedDebtorsOwedPence, fmt);
  eq("aged debtors: Tolra money owed = the importer's dry-run figure", num(ow.s), report.balances.owedAfterImport, fmt);
  eq("aged debtors: Tolra customer credit = SliQ's credits (the overpayment and the credit notes)", num(cr.s), -manifest.expected.agedDebtorsOverpaidPence - manifest.expected.agedDebtorsCreditNotesPence, fmt);
  eq("aged debtors: Tolra customer credit = the importer's dry-run figure", num(cr.s), report.balances.creditAfterImport, fmt);
  eq("aged debtors: SliQ total = Tolra money owed - Tolra customer credit, to the penny", num(ow.s) - num(cr.s), agedTotal, fmt);
} finally {
  await db.query("rollback").catch(() => {});
  await db.end();
}

const fails = results.filter((r) => r.status === "FAIL").length;
console.log(`checks: ${results.filter((r) => r.status === "PASS").length} PASS, ${fails} FAIL, ${results.filter((r) => r.status === "GAP").length} GAP`);
if (args.json) writeFileSync(args.json, `${JSON.stringify(results, null, 2)}\n`);
process.exit(fails ? 1 : 0);
