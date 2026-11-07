// SliQ import reconciliation (D1). Pure: compares the validator's source totals with the database totals
// (rows returned by supabase/verify/sliq_reconcile.sql) and returns a pass/fail table. No I/O.
// All money is whole pence (integers).

export type SourceTotals = {
  files: { name: string; sha256: string }[];
  /** Per-entity counts, keys as in the database rows: customers, invoices, payments, credit_notes. */
  counts: Record<string, number>;
  invoiceTotalPence: number;
  paymentsTotalPence: number;
  /** Credits applied to invoices. Defaults to 0 when the source has none. */
  creditsTotalPence?: number;
  /** Refunds (a SliQ file set carries none: anything in Tolra is a FAIL unless stated here). Default 0. */
  refundsTotalPence?: number;
  /** Invoices the app leaves out of what is owed (void, cancelled, written off, draft). Default 0. */
  excludedInvoices?: number;
  /** As the app (034): sum over live invoices of greatest(0, total - paid - credited + refunded). */
  outstandingPence: number;
  /** The excess (paid + credited - refunded above the total) as customer credit. Default 0. */
  customerCreditPence?: number;
  /**
   * Per customer, net (owed - customer credit). Keyed as the database rows are: "acct:<account code>" for customers in the route's
   * import map, else "name:<name as Tolra normalises it>" (lib/sliq-import-build.ts customerKey). Compared case-insensitively.
   */
  customerBalancesPence: Record<string, number>;
  invoiceRefMin?: number;
  invoiceRefMax?: number;
};

export type DbRow = { metric: string; key: string; value: string | number | null };

export type DbTotals = {
  counts: Record<string, number>;
  invoicedPence: number;
  paidPence: number;
  creditsPence: number;
  refundsPence: number;
  outstandingPence: number;
  customerCreditPence: number;
  /** Over live invoices: sum of (total - paid - credited + refunded), unfloored; outstanding - customer credit must equal it. */
  netLivePence: number;
  excludedInvoices: number;
  customerOutstandingPence: Record<string, number>;
  refMin: number | null;
  refMax: number | null;
  refNotInvFormat: number;
  countersLast: Record<string, number>;
  dupGroups: { customerName: number; customerEmail: number; invoiceRef: number; payment: number };
  dupDetail: string[];
  orphanPayments: number;
  overpaidInvoices: number;
  overpaidDetail: string[];
};

export type CheckRow = {
  check: string;
  source: string;
  database: string;
  difference: string;
  status: "PASS" | "FAIL";
};

export type ReconcileReport = {
  pass: boolean;
  rows: CheckRow[];
  countersBefore: Record<string, number>;
  countersAfter: Record<string, number>;
  db: DbTotals;
};

export type ReconcileOptions = {
  /** Counter rows (prefix to last used number) read before the import. */
  countersBefore: Record<string, number>;
  /** How many customers with the biggest balance difference to list. Default 10. */
  topN?: number;
};

const num = (v: string | number | null | undefined): number => {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) throw new Error(`Not a number in database rows: ${String(v)}`);
  return n;
};

export const normName = (s: string): string => s.trim().replace(/\s+/g, " ").toLowerCase();

export function parseDbRows(rows: DbRow[]): DbTotals {
  const t: DbTotals = {
    counts: {},
    invoicedPence: 0,
    paidPence: 0,
    creditsPence: 0,
    refundsPence: 0,
    outstandingPence: 0,
    customerCreditPence: 0,
    netLivePence: 0,
    excludedInvoices: 0,
    customerOutstandingPence: {},
    refMin: null,
    refMax: null,
    refNotInvFormat: 0,
    countersLast: {},
    dupGroups: { customerName: 0, customerEmail: 0, invoiceRef: 0, payment: 0 },
    dupDetail: [],
    orphanPayments: 0,
    overpaidInvoices: 0,
    overpaidDetail: [],
  };
  for (const r of rows) {
    switch (r.metric) {
      case "count": t.counts[r.key] = num(r.value); break;
      case "total_pence":
        if (r.key === "invoiced") t.invoicedPence = num(r.value);
        else if (r.key === "paid") t.paidPence = num(r.value);
        else if (r.key === "credits") t.creditsPence = num(r.value);
        else if (r.key === "outstanding") t.outstandingPence = num(r.value);
        else if (r.key === "refunds") t.refundsPence = num(r.value);
        else if (r.key === "customer_credit") t.customerCreditPence = num(r.value);
        else if (r.key === "net_live") t.netLivePence = num(r.value);
        break;
      case "excluded_invoices": t.excludedInvoices = num(r.value);
        break;
      case "customer_outstanding_pence": {
        const k = normName(r.key);
        t.customerOutstandingPence[k] = (t.customerOutstandingPence[k] ?? 0) + num(r.value);
        break;
      }
      case "invoice_ref":
        if (r.key === "min_number") t.refMin = r.value === null || r.value === "" ? null : num(r.value);
        else if (r.key === "max_number") t.refMax = r.value === null || r.value === "" ? null : num(r.value);
        else if (r.key === "not_INV_format") t.refNotInvFormat = num(r.value);
        break;
      case "counter_last": t.countersLast[r.key] = num(r.value); break;
      case "dup_customer_name": t.dupGroups.customerName = num(r.value); break;
      case "dup_customer_email": t.dupGroups.customerEmail = num(r.value); break;
      case "dup_invoice_ref": t.dupGroups.invoiceRef = num(r.value); break;
      case "dup_payment": t.dupGroups.payment = num(r.value); break;
      case "orphan_payments": t.orphanPayments = num(r.value); break;
      case "overpaid_invoices": t.overpaidInvoices = num(r.value); break;
      case "overpaid_invoices_detail": t.overpaidDetail.push(`${r.key} over by ${num(r.value)}p`); break;
      default:
        if (r.metric.startsWith("dup_") && r.metric.endsWith("_detail")) t.dupDetail.push(`${r.metric.slice(4, -7)}: ${r.key} x${r.value}`);
    }
  }
  return t;
}

const diffRow = (check: string, source: number, database: number): CheckRow => ({
  check,
  source: String(source),
  database: String(database),
  difference: String(database - source),
  status: source === database ? "PASS" : "FAIL",
});

const zeroRow = (check: string, database: number): CheckRow => ({
  check,
  source: "0",
  database: String(database),
  difference: String(database),
  status: database === 0 ? "PASS" : "FAIL",
});

export function reconcile(source: SourceTotals, dbRows: DbRow[], opts: ReconcileOptions): ReconcileReport {
  const db = parseDbRows(dbRows);
  const rows: CheckRow[] = [];
  const topN = opts.topN ?? 10;

  const entities = Array.from(new Set([...Object.keys(source.counts), ...Object.keys(db.counts)])).sort();
  for (const e of entities) rows.push(diffRow(`count: ${e}`, source.counts[e] ?? 0, db.counts[e] ?? 0));

  const srcCredits = source.creditsTotalPence ?? 0;
  rows.push(diffRow("invoice total (pence)", source.invoiceTotalPence, db.invoicedPence));
  rows.push(diffRow("payments total (pence)", source.paymentsTotalPence, db.paidPence));
  rows.push(diffRow("credits total (pence)", srcCredits, db.creditsPence));
  // What the app does that a SliQ file set can't carry: refunds and void / cancelled / written-off / draft invoices. Any in Tolra
  // that the source did not state is a FAIL (loud), never folded into a balance.
  rows.push(diffRow("refunds total (pence)", source.refundsTotalPence ?? 0, db.refundsPence));
  rows.push(diffRow("invoices left out of what is owed (void, cancelled, written off, draft)", source.excludedInvoices ?? 0, db.excludedInvoices));
  rows.push(diffRow("outstanding (pence)", source.outstandingPence, db.outstandingPence));
  rows.push(diffRow("customer credit (pence)", source.customerCreditPence ?? 0, db.customerCreditPence));
  // The outstanding figure must also follow from its own parts on both sides (034: per invoice floored at 0, the rest customer credit).
  rows.push(diffRow(
    "source outstanding - customer credit = invoiced - paid - credits + refunds",
    source.invoiceTotalPence - source.paymentsTotalPence - srcCredits + (source.refundsTotalPence ?? 0),
    source.outstandingPence - (source.customerCreditPence ?? 0),
  ));
  rows.push(diffRow(
    "database outstanding - customer credit = live invoiced - paid - credits + refunds",
    db.netLivePence,
    db.outstandingPence - db.customerCreditPence,
  ));

  // Per-customer outstanding: every customer on either side, biggest absolute difference first.
  const src: Record<string, number> = {};
  for (const [k, v] of Object.entries(source.customerBalancesPence)) src[normName(k)] = (src[normName(k)] ?? 0) + v;
  const names = Array.from(new Set([...Object.keys(src), ...Object.keys(db.customerOutstandingPence)]));
  const diffs = names
    .map((n) => ({ n, s: src[n] ?? 0, d: db.customerOutstandingPence[n] ?? 0 }))
    .filter((x) => x.s !== x.d)
    .sort((a, b) => Math.abs(b.d - b.s) - Math.abs(a.d - a.s) || a.n.localeCompare(b.n));
  rows.push({
    check: "customer balances differing (count)",
    source: "0",
    database: String(diffs.length),
    difference: String(diffs.length),
    status: diffs.length === 0 ? "PASS" : "FAIL",
  });
  for (const x of diffs.slice(0, topN)) rows.push({ ...diffRow(`customer balance: ${x.n}`, x.s, x.d) });

  // Invoice ref range, then counters.
  if (source.invoiceRefMin !== undefined) rows.push(diffRow("invoice ref min", source.invoiceRefMin, db.refMin ?? -1));
  if (source.invoiceRefMax !== undefined) rows.push(diffRow("invoice ref max", source.invoiceRefMax, db.refMax ?? -1));
  rows.push(zeroRow("invoice refs not in INV-number format", db.refNotInvFormat));

  const after = db.countersLast;
  const before = opts.countersBefore;
  const invLast = after["INV"];
  if (db.refMax === null) {
    rows.push({ check: "INV counter above highest ref", source: "n/a", database: "no invoices", difference: "n/a", status: "FAIL" });
  } else {
    const ok = invLast !== undefined && invLast >= db.refMax;
    rows.push({
      check: "INV counter next value above highest ref",
      source: `> ${db.refMax}`,
      database: invLast === undefined ? "no counter row" : `next ${invLast + 1}`,
      difference: invLast === undefined ? "n/a" : String(invLast - db.refMax),
      status: ok ? "PASS" : "FAIL",
    });
  }
  for (const p of Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort()) {
    if (p === "INV") continue;
    rows.push(diffRow(`counter unchanged: ${p}`, before[p] ?? 0, after[p] ?? 0));
  }

  rows.push(zeroRow("duplicate customer names (groups)", db.dupGroups.customerName));
  rows.push(zeroRow("duplicate customer emails (groups)", db.dupGroups.customerEmail));
  rows.push(zeroRow("duplicate invoice refs (groups)", db.dupGroups.invoiceRef));
  rows.push(zeroRow("duplicate payments (invoice, date, amount, reference) (groups)", db.dupGroups.payment));
  rows.push(zeroRow("orphan payments", db.orphanPayments));
  rows.push(zeroRow("invoices with paid + credits above total", db.overpaidInvoices));

  return { pass: rows.every((r) => r.status === "PASS"), rows, countersBefore: before, countersAfter: after, db };
}
