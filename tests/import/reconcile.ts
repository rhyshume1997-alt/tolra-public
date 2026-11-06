/**
 * READ-ONLY reconciliation of a SliQ import: what the source said against what the database now holds, as counts and a discrepancy list.
 *
 * Read only means: every statement this file sends is a SELECT (a guard refuses anything else before it reaches the server), and
 * `reconcileReadOnly` runs the whole thing inside BEGIN READ ONLY ... ROLLBACK, so even a bug here could not write. tests/import/reconcile.test.ts
 * proves both, and proves the database is byte-for-byte unchanged by a run.
 *
 * It does NOT re-use the importer's own analysis (scripts/sliq-import/reconcile.mjs, the pre-write report): that report says what the importer
 * PLANS. This one looks at what is actually in the tables afterwards, with the source figures supplied separately (a SourceSnapshot), so a
 * defect in the importer's planning cannot hide itself. The only importer code shared is the customer-name normaliser, because "the same
 * customer" has one definition; it is injectable.
 *
 * Scope: one organisation (every query is filtered by organization_id) and only invoices the import created (rows in public.legacy_import_map),
 * so the company's own documents are never reported as stray imports.
 */
import { Client } from "pg";

import { normaliseName } from "../../scripts/sliq-import/ids.mjs";

export type SourceSnapshot = {
  customers: { name: string }[];
  invoices: { number: string; customerRef: string; netP: number | null; vatP: number | null; grossP: number | null; status?: string | null }[];
  /** Lines of invoices (and quotes); quantity in thousandths, money in pence, vatRateCenti in hundredths of a percent. */
  lines: { doc: string; netP: number | null }[];
  payments: { invoice: string; amountP: number; date?: string | null }[];
  quotes: { number: string; grossP: number | null }[];
};

export type Severity = "error" | "warning" | "info";
export type Discrepancy = {
  check: string;
  severity: Severity;
  entity: "customer" | "invoice" | "quote" | "payment" | "number" | "counter";
  key: string;
  expected?: string | number | null;
  actual?: string | number | null;
  detail: string;
  /** Set when the importer's own report already accounts for it (held, excluded, payment to confirm). Still listed, never hidden. */
  explained?: string;
};
export type ReconciliationReport = {
  format: "sliq-import-reconciliation/1";
  readOnly: true;
  organizationId: string;
  counts: {
    customers: { source: number; sourceDistinctNormalised: number; database: number };
    invoices: { source: number; sourceDistinctNumbers: number; database: number; importedByMap: number };
    invoiceLines: { source: number; database: number };
    payments: { source: number; database: number };
    quotes: { source: number; database: number };
  };
  totalsPence: { sourceGrossOfImportedInvoices: number; databaseGross: number; databasePayments: number; databaseAmountPaid: number };
  discrepancies: Discrepancy[];
  summary: Record<string, number>;
};
export type ReconcileOptions = {
  organizationId: string;
  /** number -> reason the importer did not write it (from the importer's report; see heldFromReport). */
  held?: Record<string, string>;
  normalise?: (name: string) => string;
};

const SELECT_ONLY = /^\s*(select|with)\b/i;
/** The only way this file talks to the database. A statement that is not a single SELECT/WITH is refused before it is sent. */
export async function selectOnly<T = Record<string, unknown>>(db: Pick<Client, "query">, sql: string, params: unknown[] = []): Promise<T[]> {
  if (!SELECT_ONLY.test(sql) || /;\s*\S/.test(sql) || /\b(insert|update|delete|truncate|alter|drop|create|grant|revoke|call|nextval|setval|next_doc_number)\b/i.test(sql.replace(/'[^']*'/g, "''"))) {
    throw new Error(`reconcile is read only: refused to send "${sql.slice(0, 60)}"`);
  }
  return (await db.query(sql, params)).rows as T[];
}

const pence = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Math.round(Number(v) * 100));
const gbp = (p: number | null | undefined) => (p === null || p === undefined ? "blank" : `${p < 0 ? "-" : ""}£${(Math.abs(p) / 100).toFixed(2)}`);
const norm = (s: string) => s.trim();

/** Reads the importer's report for what it chose not to write: held documents and operator exclusions. */
export function heldFromReport(report: { held?: { documentKind: string; number: string; reasons: string[] }[]; excludeNumbers?: string[] }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of report.held ?? []) if (h.documentKind === "invoice" || h.documentKind === "quote") out[h.number] = h.reasons.join("; ");
  for (const n of report.excludeNumbers ?? []) out[n] = out[n] ? `${out[n]}; excluded by number (operator)` : "excluded by number (operator)";
  return out;
}

/** The source side built from the importer's parsed records (loadFolder). The synthetic tests build theirs from the generator instead and compare the two. */
// The importer is untyped .mjs: its parsed records are plain objects.
type ParsedRow = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export function snapshotFromLoaded(loaded: { records: Record<string, ParsedRow[]> }): SourceSnapshot {
  const rec = loaded.records;
  const ok = (rows: ParsedRow[]) => rows.filter((r) => !r._bad);
  return {
    customers: ok(rec.customers).map((c) => ({ name: c.name })),
    invoices: ok(rec.invoices).filter((r) => r.docType !== "credit_note").map((r) => ({ number: r.number, customerRef: r.customer, netP: r.net, vatP: r.vat, grossP: r.gross, status: r.status })),
    lines: ok(rec.invoiceLines).map((l) => ({ doc: l.documentNumber, netP: l.net ?? (l.quantity !== null && l.unitPrice !== null && (l.quantity * l.unitPrice) % 1000 === 0 ? (l.quantity * l.unitPrice) / 1000 : null) })),
    payments: ok(rec.payments).map((p) => ({ invoice: p.invoiceNumber, amountP: p.amount, date: p.date })),
    quotes: ok(rec.quotes).map((q) => ({ number: q.number, grossP: q.gross })),
  };
}

/** "INV-0100" -> { prefix: "INV", n: 100 }; anything else is not part of a numeric sequence. */
const seq = (ref: string) => {
  const m = /^([A-Z]+)-(\d{1,9})$/.exec(ref);
  return m ? { prefix: m[1], n: Number(m[2]) } : null;
};
const ranges = (ns: number[]) => {
  const out: string[] = [];
  for (let i = 0; i < ns.length; ) {
    let j = i;
    while (j + 1 < ns.length && ns[j + 1] === ns[j] + 1) j++;
    out.push(i === j ? String(ns[i]) : `${ns[i]}-${ns[j]}`);
    i = j + 1;
  }
  return out.join(", ");
};

/** Runs every check. `db` may be any connected client; this function only ever SELECTs. */
export async function reconcile(db: Pick<Client, "query">, src: SourceSnapshot, opts: ReconcileOptions): Promise<ReconciliationReport> {
  const org = opts.organizationId;
  const held = opts.held ?? {};
  const nm = opts.normalise ?? normaliseName;
  const d: Discrepancy[] = [];
  const add = (x: Discrepancy) => d.push(x);

  // ---- database side ----
  const dbCustomers = await selectOnly<{ name: string }>(db, "select name from public.customers where organization_id = $1", [org]);
  const dbInvoices = await selectOnly<{ id: string; ref: string; customer: string | null; subtotal: string; vat: string; total: string; status: string; amount_paid: string; unverified: boolean; imported: boolean; lines: string; lines_net_diff: string; lines_vat: string }>(
    db,
    `select i.id, i.invoice_ref as ref, i.customer, i.subtotal::text, i.vat::text, i.total::text, i.status, i.amount_paid::text,
            coalesce(i.payment_unverified, false) as unverified,
            exists (select 1 from public.legacy_import_map m where m.source = 'invoices' and m.new_id = i.id) as imported,
            (select count(*) from public.invoice_line_items l where l.invoice_id = i.id)::text as lines,
            ((select coalesce(sum(l.quantity * l.unit_price), 0) from public.invoice_line_items l where l.invoice_id = i.id) - i.subtotal)::text as lines_net_diff,
            (select coalesce(sum(round(l.quantity * l.unit_price * l.vat_pct / 100, 2)), 0) from public.invoice_line_items l where l.invoice_id = i.id)::text as lines_vat
       from public.invoices i where i.organization_id = $1 order by i.invoice_ref`,
    [org],
  );
  const dbPayments = await selectOnly<{ invoice_id: string; amount: string; source: string | null; invoice_ref: string | null }>(
    db,
    `select p.invoice_id, p.amount::text, p.source, i.invoice_ref from public.invoice_payments p left join public.invoices i on i.id = p.invoice_id where p.organization_id = $1`,
    [org],
  );
  const dbQuotes = await selectOnly<{ ref: string; total: string; imported: boolean }>(
    db,
    `select q.quote_ref as ref, q.total_value::text as total, exists (select 1 from public.legacy_import_map m where m.source = 'quotes' and m.new_id = q.id) as imported from public.quotes q where q.organization_id = $1`,
    [org],
  );
  const dbLineCount = Number((await selectOnly<{ n: string }>(db, "select count(*)::text as n from public.invoice_line_items where organization_id = $1 and invoice_id in (select new_id from public.legacy_import_map where source = 'invoices')", [org]))[0].n);
  const counters = await selectOnly<{ prefix: string; last: number }>(db, "select prefix, last from public.doc_counters where organization_id = $1", [org]);

  const imported = dbInvoices.filter((i) => i.imported);
  const importedByRef = new Map(imported.map((i) => [i.ref, i]));

  // ---- source side, grouped ----
  const srcByNo = new Map<string, SourceSnapshot["invoices"]>();
  for (const i of src.invoices) srcByNo.set(norm(i.number), [...(srcByNo.get(norm(i.number)) ?? []), i]);
  const srcNos = new Set(srcByNo.keys());
  const payBySrc = new Map<string, number[]>();
  for (const p of src.payments) payBySrc.set(norm(p.invoice), [...(payBySrc.get(norm(p.invoice)) ?? []), p.amountP]);
  const dbPayByInvoice = new Map<string, number>();
  const dbPayCount = new Map<string, number>();
  for (const p of dbPayments) {
    dbPayByInvoice.set(p.invoice_id, (dbPayByInvoice.get(p.invoice_id) ?? 0) + (pence(p.amount) ?? 0));
    dbPayCount.set(p.invoice_id, (dbPayCount.get(p.invoice_id) ?? 0) + 1);
  }
  const explain = (n: string) => held[n];

  // ---- customers ----
  const srcNorm = new Map<string, string[]>();
  for (const c of src.customers) srcNorm.set(nm(c.name), [...(srcNorm.get(nm(c.name)) ?? []), c.name]);
  for (const [k, names] of srcNorm) {
    if (names.length > 1) add({ check: "customer_duplicate_in_source", severity: "warning", entity: "customer", key: names[0], expected: 1, actual: names.length, detail: `the customers file lists the same customer ${names.length} times (${names.map((n) => `"${n}"`).join(", ")}); the importer keeps every record, so invoices are matched to the first. Normalised: "${k}"` });
  }
  const dbNameCount = new Map<string, number>();
  for (const c of dbCustomers) dbNameCount.set(c.name, (dbNameCount.get(c.name) ?? 0) + 1);
  const dbNorm = new Map<string, string[]>();
  for (const c of dbCustomers) dbNorm.set(nm(c.name), [...(dbNorm.get(nm(c.name)) ?? []), c.name]);
  for (const [k, names] of dbNorm) {
    if (names.length > 1) add({ check: "customer_duplicate_in_database", severity: "warning", entity: "customer", key: names[0], expected: 1, actual: names.length, detail: `${names.length} customer records normalise to "${k}" (${names.map((n) => `"${n}"`).join(", ")}): review before merging` });
  }
  for (const c of src.customers) {
    if (!dbNameCount.has(c.name)) add({ check: "customer_missing", severity: "error", entity: "customer", key: c.name, expected: c.name, actual: null, detail: "a customer in the source file is not in the database" });
  }
  // How many source spellings reach each database customer: a spelling that reaches no customer, or a customer reached by spellings that normalise apart, is a mismatch.
  for (const i of imported) {
    const n = i.customer ?? "";
    const c = dbNameCount.get(n) ?? 0;
    if (c === 0) add({ check: "invoice_customer_unknown", severity: "error", entity: "invoice", key: i.ref, expected: "an existing customer", actual: n, detail: `invoice ${i.ref} names "${n}", which is not a customer of this company` });
    else if (c > 1) add({ check: "invoice_customer_ambiguous", severity: "warning", entity: "invoice", key: i.ref, expected: 1, actual: c, detail: `invoice ${i.ref} names "${n}", and ${c} customer records carry exactly that name` });
    const s = srcByNo.get(i.ref);
    if (s && s.length === 1) {
      if (nm(s[0].customerRef) !== nm(n)) add({ check: "invoice_customer_changed", severity: "error", entity: "invoice", key: i.ref, expected: s[0].customerRef, actual: n, detail: `the source names "${s[0].customerRef}" but the database invoice names "${n}", and they do not normalise alike: a different customer` });
    }
  }

  // ---- invoices: presence ----
  for (const [no, rows] of srcByNo) {
    if (rows.length > 1) add({ check: "invoice_duplicate_in_source", severity: "warning", entity: "invoice", key: no, expected: 1, actual: rows.length, detail: `the source lists ${no} ${rows.length} times`, explained: explain(no) });
    const have = importedByRef.get(no);
    if (!have) {
      add({ check: "invoice_missing", severity: explain(no) ? "info" : "error", entity: "invoice", key: no, expected: no, actual: null, detail: `source invoice ${no} is not in the database`, explained: explain(no) });
    }
  }
  for (const i of imported) {
    if (!srcNos.has(i.ref)) add({ check: "invoice_unexpected", severity: "error", entity: "invoice", key: i.ref, expected: null, actual: i.ref, detail: `database invoice ${i.ref} was created by the import but is not in the source` });
  }

  // ---- invoices: figures, to the penny ----
  const srcLinesByDoc = new Map<string, number[]>();
  for (const l of src.lines) if (l.netP !== null) srcLinesByDoc.set(norm(l.doc), [...(srcLinesByDoc.get(norm(l.doc)) ?? []), l.netP]);
  let sourceGrossOfImported = 0;
  for (const i of imported) {
    const rows = srcByNo.get(i.ref);
    const s = rows && rows.length === 1 ? rows[0] : null;
    const net = pence(i.subtotal);
    const vat = pence(i.vat);
    const total = pence(i.total);
    if (s) {
      sourceGrossOfImported += s.grossP ?? 0;
      for (const [field, want, got] of [["net", s.netP, net], ["vat", s.vatP, vat], ["gross", s.grossP, total]] as const) {
        if (want !== null && want !== got) add({ check: "invoice_total", severity: "error", entity: "invoice", key: i.ref, expected: want, actual: got, detail: `${i.ref} ${field}: source ${gbp(want)}, database ${gbp(got)}` });
      }
      const sl = srcLinesByDoc.get(i.ref);
      if (sl && sl.length !== Number(i.lines)) add({ check: "invoice_line_count", severity: "warning", entity: "invoice", key: i.ref, expected: sl.length, actual: Number(i.lines), detail: `${i.ref}: the source has ${sl.length} line(s), the database ${i.lines}` });
    }
    if (net !== null && vat !== null && total !== null && net + vat !== total) {
      add({ check: "invoice_internal_total", severity: "error", entity: "invoice", key: i.ref, expected: net + vat, actual: total, detail: `${i.ref}: net ${gbp(net)} + VAT ${gbp(vat)} = ${gbp(net + vat)}, but the invoice total is ${gbp(total)}` });
    }
    if (Number(i.lines) > 0) {
      const diff = Math.round(Number(i.lines_net_diff) * 100 * 1000) / 1000;
      if (diff !== 0) add({ check: "invoice_lines_vs_net", severity: "error", entity: "invoice", key: i.ref, expected: net, actual: net === null ? null : Math.round(net + diff), detail: `${i.ref}: the lines add up to ${gbp(net === null ? null : Math.round(net + diff))} against a net of ${gbp(net)}` });
      const lv = pence(i.lines_vat);
      if (vat !== null && lv !== null && lv !== vat) {
        const within = Math.abs(lv - vat) <= Number(i.lines);
        add({ check: within ? "invoice_vat_rounding" : "invoice_vat_vs_lines", severity: within ? "info" : "error", entity: "invoice", key: i.ref, expected: vat, actual: lv, detail: `${i.ref}: VAT worked out line by line is ${gbp(lv)}, the header says ${gbp(vat)}${within ? " (within a penny a line: rounding)" : ""}` });
      }
    }
  }

  // ---- payments ----
  const bySrcNo = new Map(imported.map((i) => [i.ref, i]));
  for (const [no, amounts] of payBySrc) {
    const srcTotal = amounts.reduce((a, b) => a + b, 0);
    const inv = bySrcNo.get(no);
    if (!srcNos.has(no)) {
      add({ check: "payment_unallocated", severity: "warning", entity: "payment", key: no, expected: "an invoice", actual: null, detail: `${amounts.length} payment(s) totalling ${gbp(srcTotal)} name invoice ${no}, which is not in the source invoice file: cash with nothing to allocate it to` });
      continue;
    }
    const gross = (srcByNo.get(no)?.[0]?.grossP) ?? null;
    if (gross !== null && srcTotal > gross) add({ check: "payment_overpaid_in_source", severity: "warning", entity: "payment", key: no, expected: gross, actual: srcTotal, detail: `payments for ${no} total ${gbp(srcTotal)} against an invoice of ${gbp(gross)}: ${gbp(srcTotal - gross)} over`, explained: explain(no) });
    if (!inv) continue; // not imported at all: already reported as invoice_missing
    const got = dbPayByInvoice.get(inv.id) ?? 0;
    if (got === srcTotal) continue;
    if (got === 0 && (inv.status === "draft" || inv.status === "void")) {
      add({ check: "payment_on_unissued_invoice", severity: "warning", entity: "payment", key: no, expected: srcTotal, actual: 0, detail: `${amounts.length} payment(s) totalling ${gbp(srcTotal)} are recorded against ${no}, which is ${inv.status} in Tolra: not imported, needs a decision` });
    } else if (got === 0) {
      add({ check: "payment_not_imported", severity: inv.unverified ? "info" : "error", entity: "payment", key: no, expected: srcTotal, actual: 0, detail: `${amounts.length} payment(s) totalling ${gbp(srcTotal)} for ${no} are in the source but no payment row was created${inv.unverified ? " (invoice marked Payment to confirm)" : ""}`, explained: inv.unverified ? "payment to confirm" : undefined });
    } else {
      add({ check: "payment_sum", severity: "error", entity: "payment", key: no, expected: srcTotal, actual: got, detail: `${no}: source payments ${gbp(srcTotal)}, database payments ${gbp(got)}` });
    }
  }
  for (const i of imported) {
    const paid = dbPayByInvoice.get(i.id) ?? 0;
    const total = pence(i.total) ?? 0;
    if (!i.unverified && pence(i.amount_paid) !== paid) add({ check: "amount_paid_vs_payments", severity: "error", entity: "payment", key: i.ref, expected: paid, actual: pence(i.amount_paid), detail: `${i.ref}: amount paid ${gbp(pence(i.amount_paid))} but its payments add up to ${gbp(paid)}` });
    if (paid > total) add({ check: "payments_exceed_invoice", severity: "error", entity: "payment", key: i.ref, expected: total, actual: paid, detail: `${i.ref}: payments ${gbp(paid)} exceed the invoice ${gbp(total)}` });
    if (i.status === "partial") add({ check: "invoice_part_paid", severity: "info", entity: "payment", key: i.ref, expected: total, actual: paid, detail: `${i.ref}: part paid, ${gbp(total - paid)} still owed` });
    if (i.status === "paid" && paid !== total) add({ check: "paid_but_not_settled", severity: "error", entity: "payment", key: i.ref, expected: total, actual: paid, detail: `${i.ref} is marked paid but its payments are ${gbp(paid)} of ${gbp(total)}` });
  }
  for (const p of dbPayments) {
    if (!p.invoice_ref) add({ check: "payment_without_invoice", severity: "error", entity: "payment", key: p.invoice_id ?? "null", expected: "an invoice", actual: null, detail: "a payment row points at no invoice" });
  }

  // ---- quotes ----
  const dbQuoteByRef = new Map(dbQuotes.map((q) => [q.ref, q]));
  for (const q of src.quotes) {
    const have = dbQuoteByRef.get(norm(q.number));
    if (!have) add({ check: "quote_missing", severity: explain(q.number) ? "info" : "error", entity: "quote", key: q.number, expected: q.number, actual: null, detail: `source quote ${q.number} is not in the database`, explained: explain(q.number) });
    else if (q.grossP !== null && pence(have.total) !== q.grossP) add({ check: "quote_total", severity: "error", entity: "quote", key: q.number, expected: q.grossP, actual: pence(have.total), detail: `quote ${q.number}: source ${gbp(q.grossP)}, database ${gbp(pence(have.total))}` });
  }

  // ---- numbering: duplicates, gaps, counters ----
  const refs = [...dbInvoices.map((i) => i.ref), ...dbQuotes.map((q) => q.ref)];
  const lower = new Map<string, string[]>();
  for (const r of refs) lower.set(r.toLowerCase(), [...(lower.get(r.toLowerCase()) ?? []), r]);
  for (const [k, rs] of lower) if (rs.length > 1) add({ check: "number_duplicate_in_database", severity: rs[0] === rs[1] ? "error" : "warning", entity: "number", key: k, expected: 1, actual: rs.length, detail: `${rs.length} documents carry ${rs.map((r) => `"${r}"`).join(" and ")}` });
  const present = new Map<string, Set<number>>();
  for (const [prefixOf, list] of [["invoice", dbInvoices.map((i) => i.ref)], ["quote", dbQuotes.map((q) => q.ref)]] as const) {
    for (const r of list) {
      const s = seq(r);
      if (!s) continue;
      const k = `${prefixOf}:${s.prefix}`;
      if (!present.has(k)) present.set(k, new Set());
      present.get(k)!.add(s.n);
    }
  }
  const srcSeq = new Map<string, Set<number>>();
  for (const no of srcNos) {
    const s = seq(no);
    if (s) srcSeq.set(`invoice:${s.prefix}`, (srcSeq.get(`invoice:${s.prefix}`) ?? new Set()).add(s.n));
  }
  for (const q of src.quotes) {
    const s = seq(q.number);
    if (s) srcSeq.set(`quote:${s.prefix}`, (srcSeq.get(`quote:${s.prefix}`) ?? new Set()).add(s.n));
  }
  for (const [k, set] of present) {
    const ns = [...set].sort((a, b) => a - b);
    const missing: number[] = [];
    for (let n = ns[0]; n <= ns.at(-1)!; n++) if (!set.has(n)) missing.push(n);
    if (missing.length) {
      const [kind, prefix] = k.split(":");
      const inSource = srcSeq.get(k);
      const notInSource = missing.filter((n) => !inSource?.has(n));
      add({
        check: "number_gap", severity: "info", entity: "number", key: k, expected: 0, actual: missing.length,
        detail: `${prefix} ${kind} numbers missing between ${ns[0]} and ${ns.at(-1)}: ${ranges(missing.slice(0, 500))}${missing.length > 500 ? " ..." : ""}; of these ${notInSource.length} are not in the source either (gaps in SliQ's own sequence: ${ranges(notInSource.slice(0, 500))}), ${missing.length - notInSource.length} are in the source but were not written`,
      });
    }
  }
  const counterByPrefix = new Map(counters.map((c) => [c.prefix, Number(c.last)]));
  for (const [k, set] of present) {
    const [kind, prefix] = k.split(":");
    const counterPrefix = kind === "quote" ? "QUO" : prefix;
    if (!["INV", "QUO"].includes(counterPrefix) || (kind === "quote" && prefix !== "QUO")) continue;
    const max = Math.max(...set);
    const last = counterByPrefix.get(counterPrefix);
    if (last === undefined || last < max) add({ check: "counter_behind", severity: "error", entity: "counter", key: counterPrefix, expected: `>= ${max}`, actual: last ?? null, detail: `the ${counterPrefix} counter is ${last ?? "missing"} but ${counterPrefix}-${max} exists: the next number the company takes could collide` });
  }
  const summary: Record<string, number> = {};
  for (const x of d) summary[x.check] = (summary[x.check] ?? 0) + 1;
  const srcDistinctCust = new Set(src.customers.map((c) => nm(c.name))).size;
  return {
    format: "sliq-import-reconciliation/1",
    readOnly: true,
    organizationId: org,
    counts: {
      customers: { source: src.customers.length, sourceDistinctNormalised: srcDistinctCust, database: dbCustomers.length },
      invoices: { source: src.invoices.length, sourceDistinctNumbers: srcNos.size, database: dbInvoices.length, importedByMap: imported.length },
      invoiceLines: { source: src.lines.filter((l) => importedByRef.has(norm(l.doc))).length, database: dbLineCount },
      payments: { source: src.payments.length, database: dbPayments.length },
      quotes: { source: src.quotes.length, database: dbQuotes.length },
    },
    totalsPence: {
      sourceGrossOfImportedInvoices: sourceGrossOfImported,
      databaseGross: imported.reduce((a, i) => a + (pence(i.total) ?? 0), 0),
      databasePayments: dbPayments.reduce((a, p) => a + (pence(p.amount) ?? 0), 0),
      databaseAmountPaid: imported.reduce((a, i) => a + (pence(i.amount_paid) ?? 0), 0),
    },
    discrepancies: d,
    summary,
  };
}

/** The shipped entry point: connect, BEGIN READ ONLY, reconcile, ROLLBACK. A write attempted anywhere inside would fail with SQLSTATE 25006. */
export async function reconcileReadOnly(connectionString: string, src: SourceSnapshot, opts: ReconcileOptions): Promise<ReconciliationReport> {
  const db = new Client({ connectionString });
  await db.connect();
  try {
    await db.query("begin read only");
    const r = await reconcile(db, src, opts);
    await db.query("rollback");
    return r;
  } finally {
    await db.end();
  }
}
