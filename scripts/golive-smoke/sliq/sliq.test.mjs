// node --test: the synthetic SliQ generator and the pre-processor (no database).
import assert from "node:assert/strict";
import { test } from "node:test";

import { generate, money, vat20 } from "./generate.mjs";
import { Refused, findHeader, parseCsv, parsePence, parseUkDate, prepareCustomers, prepareInvoices, preparePayments, splitEmails, stripReport } from "./preprocess.mjs";

const { files, expected } = generate();
const links = new Map([["CRD-9001", expected.creditedInvoice]]);

test("generator: deterministic for a seed, different for another", () => {
  assert.deepEqual(generate().files, files);
  assert.notDeepEqual(generate({ seed: 7 }).files["invoices-report.csv"], files["invoices-report.csv"]);
});

test("dates are dd/mm/yyyy only: impossible, month-first, two-digit and ISO dates refused", () => {
  assert.equal(parseUkDate("31/12/2025"), "2025-12-31");
  assert.equal(parseUkDate("01/02/2026"), "2026-02-01");
  assert.equal(parseUkDate("29/02/2028"), "2028-02-29");
  for (const bad of ["31/02/2026", "29/02/2025", "12/31/2025", "01/02/26", "2026-02-01", "1/2/2026", ""]) assert.equal(parseUkDate(bad), null, bad);
});

test("money is integer pence: pound sign, minus, brackets and thousands commas; fractions of a penny and foreign forms refused", () => {
  assert.equal(parsePence("£1,234.50"), 123450);
  assert.equal(parsePence("-£12.00"), -1200);
  assert.equal(parsePence("(3.20)"), -320);
  assert.equal(parsePence("0.29") + parsePence("0.01"), 30);
  for (const bad of ["12.345", "1,23", "1.234,50", "£", "abc"]) assert.equal(parsePence(bad), null, bad);
  assert.equal(money(-123456), "-£1,234.56");
  assert.equal(vat20(5), 1);
  assert.equal(vat20(14), 3); // 2.8p rounds to 3p
});

test("the header row is found by name, not by position; none or two is a refusal", () => {
  const rows = parseCsv(files["invoices-report.csv"]);
  assert.equal(findHeader(rows, ["Type", "Num", "Date"]), 5);
  assert.throws(() => findHeader(rows, ["Nope"]), Refused);
  assert.throws(() => findHeader([["Num", "Date"], ["Num", "Date"]], ["Num", "Date"]), /more than one header row/);
  const moved = `title\n\n\n${files["invoices-report.csv"]}`;
  assert.equal(findHeader(parseCsv(moved), ["Type", "Num", "Date"]), 8);
});

test("furniture: group rows and the totals row are skipped, never records; the totals row reconciles to the penny", () => {
  const r = prepareInvoices(files["invoices-report.csv"], links);
  assert.equal(r.invoices.length, expected.invoices);
  assert.equal(r.creditNotes.length + r.heldOut.length, expected.credits);
  assert.ok(r.checks.skipped.group > 0);
  assert.ok(r.invoices.every((i) => /^SINV-\d+$/.test(i.invoice_ref)));
  assert.ok(r.checks.reconciliation.every((c) => c.equal));
  // A 1p change in one record no longer adds up to the totals row: refused.
  const tampered = files["invoices-report.csv"].replace(/^(Inv,SINV-1001,[^,]*,[^,]*,"?)£1/m, "$1£2");
  assert.notEqual(tampered, files["invoices-report.csv"]);
  assert.throws(() => prepareInvoices(tampered, links), /don't add up to the totals row/);
  // A row after the totals row is refused with its row number.
  assert.throws(() => prepareInvoices(`${files["invoices-report.csv"]}Inv,SINV-9999,01/01/2026,X,£1.00,£0.20,£1.20\n`, links), (e) => e instanceof Refused && e.rows.some((row) => /after the totals/.test(row.reason)));
});

test("a Quotes report offered as invoices is refused", () => {
  assert.throws(() => prepareInvoices(files["quotes-report.csv"], links), /Quotes report .* refused as invoices/);
});

test("one invalid date refuses the WHOLE invoices file", () => {
  const bad = files["invoices-report.csv"].replace(/^(Inv,SINV-1002,)11\/01\/2026/m, "$131/02/2026");
  assert.notEqual(bad, files["invoices-report.csv"]);
  assert.throws(() => prepareInvoices(bad, links), (e) => e instanceof Refused && /whole file is refused/.test(e.message) && e.rows.length === 1);
});

test("VAT-inclusive totals: Net + VAT must be Total; VAT not 20% of net is listed, not changed", () => {
  const r = prepareInvoices(files["invoices-report.csv"], links);
  assert.deepEqual(r.checks.notTwentyPct, expected.notTwentyPct);
  const odd = r.invoices.find((i) => i.invoice_ref === expected.notTwentyPct[0]);
  assert.equal(parsePence(odd.vat), vat20(parsePence(odd.subtotal)) + 1);
  // A row whose Net + VAT is not its Total (the totals row still adding up) is refused with its row number.
  const small = "Type,Num,Date,Customer,Net Total,VAT,Total\nInv,X-1,01/03/2026,A Ltd,£10.00,£2.00,£12.01\nTotal,,,,£10.00,£2.00,£12.01\n";
  assert.throws(() => prepareInvoices(small), (e) => e instanceof Refused && /Net \+ VAT is not Total/.test(e.message) && e.rows[0].row === 2);
  assert.equal(stripReport(small, { expected: ["Num", "Total"], keyCol: "Num", moneyCols: ["Total"] }).records.length, 1);
});

test("credit notes: negative in SliQ, positive in the payload, linked to the invoice John named; an unlinked one held out", () => {
  const r = prepareInvoices(files["invoices-report.csv"], links);
  assert.deepEqual(r.creditNotes.map((c) => [c.credit_ref, c.invoice_ref]), [["CRD-9001", expected.creditedInvoice]]);
  assert.equal(parsePence(r.creditNotes[0].total), expected.creditTotal);
  assert.ok(r.creditNotes.every((c) => parsePence(c.total) > 0 && parsePence(c.vat) >= 0));
  assert.deepEqual(r.heldOut.map((c) => c.credit_ref), [expected.orphanCredit]);
});

test("payments: Num is the invoice, methods mapped (unknown refused), net + VAT = amount, equal twins both kept", () => {
  const p = preparePayments(files["payments-report.csv"]);
  assert.equal(p.payments.length, expected.payments);
  assert.ok(p.payments.every((x) => ["BACS", "cheque", "card", "cash", "other"].includes(x.method)));
  assert.equal(p.payments.filter((x) => x.invoice_ref === expected.twinInvoice).length, 2);
  assert.equal(p.payments.reduce((a, x) => a + parsePence(x.amount), 0), expected.paymentsTotal);
  assert.throws(() => preparePayments(files["payments-report.csv"].replace(/,BACS,/, ",Bitcoin,")), /payment rows refused/);
});

test("customers: several e-mails split (first valid one kept, the rest in the notes); none valid listed with the raw text kept", () => {
  assert.deepEqual(splitEmails("ap@b.example.test; orders@b.example.test"), { email: "ap@b.example.test", notes: ["Other e-mails: orders@b.example.test"], listed: false });
  assert.deepEqual(splitEmails("x@c.example.test y@c.example.test"), { email: "x@c.example.test", notes: ["Other e-mails: y@c.example.test"], listed: false });
  assert.deepEqual(splitEmails("accounts @d.example.test"), { email: null, notes: ["E-mail as in SliQ: accounts @d.example.test"], listed: true });
  const c = prepareCustomers(files["customers.csv"]);
  assert.equal(c.customers.length, expected.customers);
  assert.ok(c.customers.every((x) => !x.email || !/[;,\s]/.test(x.email)));
  assert.deepEqual(c.listed.map((x) => x.name), ["Delta Pretend Products"]);
});

test("expected balances: payments + credit + outstanding = invoiced total, to the penny", () => {
  const invoiced = prepareInvoices(files["invoices-report.csv"], links).invoices.reduce((a, i) => a + parsePence(i.total), 0);
  assert.equal(expected.paymentsTotal + expected.creditTotal + expected.outstanding, invoiced);
  assert.equal(Object.values(expected.byCustomer).reduce((a, b) => a + b, 0), expected.outstanding);
});
