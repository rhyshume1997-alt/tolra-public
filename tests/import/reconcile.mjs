// Test-only, read-only snapshot and scoped report. Never an import/write command.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normaliseName } from '../../scripts/sliq-import/ids.mjs';
import { parseMoneyPence } from '../../scripts/sliq-import/parse.mjs';

export function sourceHashes(folder) {
  return Object.fromEntries(readdirSync(folder).filter(n => n.endsWith('.csv')).sort().map(n => [n, createHash('sha256').update(readFileSync(path.join(folder, n))).digest('hex')]));
}

/** Caller must first prove the backend's isolation using existing test guards. */
export async function readOnlySnapshot(db, org) {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const mode = (await db.query('SHOW transaction_read_only')).rows[0].transaction_read_only;
    if (mode !== 'on') throw new Error('Read-only snapshot transaction required');
    const rows = async (sql) => (await db.query(sql, [org])).rows;
    return {
      readOnly: true,
      customers: await rows('SELECT id,name,email FROM public.customers WHERE organization_id=$1 ORDER BY id'),
      invoices: await rows('SELECT id,invoice_ref,customer,subtotal::text,vat::text,total::text,amount_paid::text,payment_unverified,status FROM public.invoices WHERE organization_id=$1 ORDER BY invoice_ref'),
      payments: await rows('SELECT p.invoice_id,p.amount::text,p.paid_on::text,p.source,p.reference FROM public.invoice_payments p WHERE p.organization_id=$1 ORDER BY p.invoice_id,p.id'),
      quotes: await rows('SELECT id,quote_ref,total_value::text FROM public.quotes WHERE organization_id=$1 ORDER BY quote_ref'),
      counters: await rows('SELECT prefix,last FROM public.doc_counters WHERE organization_id=$1 ORDER BY prefix'),
    };
  } finally { await db.query('ROLLBACK'); }
}

export function writeScopedReport({ snapshot, plan, folder, out, organizationId, subjectSha }) {
  if (snapshot.readOnly !== true) throw new Error('A read-only snapshot is required');
  const money = parseMoneyPence;
  const matches = plan.invoices.map(i => {
    const target = snapshot.invoices.filter(t => t.invoice_ref === i.number);
    const row = target[0];
    const payments = row ? snapshot.payments.filter(p => p.invoice_id === row.id) : [];
    const expectedPaid = i.payments.reduce((s, p) => s + p.amountPence, 0);
    const actualPaid = payments.reduce((s, p) => s + money(p.amount), 0);
    return { number: i.number, exactlyOneTarget: target.length === 1, customer: row?.customer ?? null,
      expectedNetPence: i.net, actualNetPence: row ? money(row.subtotal) : null,
      expectedVatPence: i.vat, actualVatPence: row ? money(row.vat) : null,
      expectedGrossPence: i.gross, actualGrossPence: row ? money(row.total) : null,
      expectedPaidPence: expectedPaid, actualPaymentRowsPence: actualPaid, actualHeaderPaidPence: row ? money(row.amount_paid) : null,
      paymentEvidenceCount: payments.length, paymentUnverified: row?.payment_unverified ?? null,
      ok: target.length === 1 && row.customer === i.customerName && money(row.subtotal) === i.net && money(row.vat) === i.vat && money(row.total) === i.gross && actualPaid === expectedPaid && money(row.amount_paid) === actualPaid && row.status === i.final.status && row.payment_unverified === i.final.unverified };
  });
  const byName = new Map();
  for (const c of snapshot.customers) { const n = normaliseName(c.name); byName.set(n, [...(byName.get(n) ?? []), c]); }
  const customerReview = [...byName.values()].filter(rows => rows.length > 1).map(rows => ({ reason: 'Similar names remain separate; human identity review required, no merge approved', rows }));
  const totals = keys => Object.fromEntries(keys.map(k => [k, matches.reduce((n, row) => n + (row[k] ?? 0), 0)]));
  const report = { syntheticOnly: true, subjectSha, organizationId, databaseReadOnly: true, sourceHashes: sourceHashes(folder),
    invoiceCount: { expected: plan.invoices.length, actual: snapshot.invoices.length },
    paymentCount: { expected: plan.invoices.reduce((n, i) => n + i.payments.length, 0), actual: snapshot.payments.length },
    totals: totals(['expectedNetPence','actualNetPence','expectedVatPence','actualVatPence','expectedGrossPence','actualGrossPence','expectedPaidPence','actualPaymentRowsPence']),
    invoices: matches, counters: snapshot.counters, customerReview,
    scopedFinancialResult: matches.length > 0 && matches.every(r => r.ok) && snapshot.invoices.length === plan.invoices.length && snapshot.payments.length === plan.invoices.reduce((n, i) => n + i.payments.length, 0) ? 'PASS' : 'FAIL',
    overallSignOff: 'NOT SIGNED OFF: synthetic rehearsal only; customer identity review and real export reconciliation remain outstanding',
    unchecked: ['Real JNR exports/header mapping', 'Report-style .xls workbooks', 'Credit notes/allocations', 'Aged debtors', 'Full operational/WIP reconciliation', 'Human approval'] };
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'reconciliation.json'), JSON.stringify(report, null, 2)+'\n');
  const lines = ['# Synthetic disposable SliQ rehearsal', '', `Scoped financial checks: ${report.scopedFinancialResult}`, report.overallSignOff, '',
    'The database was read in REPEATABLE READ READ ONLY; this report cannot write or repair business rows.', '',
    '| Invoice | Net pence | VAT pence | Gross pence | Evidenced payment pence | Exact check |', '| --- | ---: | ---: | ---: | ---: | --- |',
    ...matches.map(r => `| ${r.number} | ${r.actualNetPence} | ${r.actualVatPence} | ${r.actualGrossPence} | ${r.actualPaymentRowsPence} | ${r.ok ? 'PASS' : 'FAIL'} |`), '',
    `Customer name groups requiring human review: ${customerReview.length}. No customer was merged.`,
    'A source Paid label without a payment row is kept as Payment to confirm; no payment is invented.', '',
    'Unchecked: '+report.unchecked.join('; ')+'.', '', 'Tester: __________  Date: __________  Signature: __________'];
  writeFileSync(path.join(out, 'reconciliation.md'), lines.join('\n')+'\n');
  return report;
}
