// Runs every comparison. Pure: files in (already loaded), rows out. No clock, no network, no database, no writes.
import { credits, openingAndPayables, receivableTotals, refundRows } from "./compare-credits.mjs";
import { partyChecks, sourceNumbering, sourceRelationships } from "./compare-identity.mjs";
import { isOpenSource, receivables } from "./compare-money.mjs";
import { commitments, deliveries, jobsAndWip, purchaseOrders, quotes, salesOrders } from "./compare-ops.mjs";
import { prepareSource } from "./prepare.mjs";
import { NOT_SUPPLIED, makeCollector, sortRows } from "./rows.mjs";
import { fingerprint, safeWord, stripQuoted } from "./safe.mjs";
import { buildTarget } from "./target.mjs";

// Optional SliQ files: each one that is absent makes the areas it feeds UNVERIFIED (never empty, never zero).
const SOURCE_KINDS = [
  ["suppliers", "the supplier list (suppliers cannot be matched to purchase orders or bills)"],
  ["invoiceLines", "invoice and quote lines (lines and VAT treatment per line)"],
  ["payments", "payments (what has been paid on every invoice)"],
  ["creditNotes", "credit notes"],
  ["allocations", "credit allocations (credits applied to invoices)"],
  ["refunds", "refunds"],
  ["openingBalances", "opening balances (receivables and payables)"],
  ["supplierBills", "supplier bills (supplier payables)"],
  ["quotes", "quotes"],
  ["salesOrders", "sales orders"],
  ["purchaseOrders", "purchase orders"],
  ["jobs", "jobs and work in progress"],
  ["deliveries", "delivery notes (part deliveries)"],
];
const SNAPSHOT_NEEDED = [
  "customers", "suppliers", "legacy_import_map", "invoices", "invoice_line_items", "invoice_payments", "credit_notes", "invoice_credit_allocations", "customer_credit_ledger",
  "quotes", "sales_orders", "jobs", "job_quantities", "delivery_notes", "delivery_note_items", "purchase_orders", "supplier_bills", "opening_balances",
];

function inputsChecks(ctx) {
  const { add, src, tgt } = ctx;
  if (src.profile.isProvisional || src.profile.isStub) {
    add({ area: "inputs", code: "mapping_provisional", ids: { mapping: src.profile.id }, field: "column mapping", source: src.profile.status, target: "", severity: "INFO", reason: "The column mapping is provisional: its headers were not confirmed against JNR's real SliQ files. A clean result with it proves little." });
  }
  for (const e of src.unreadable) {
    add({ area: "inputs", code: "source_row_unreadable", ids: { file: e.file, row: e.row, column: e.column }, field: "row", source: stripQuoted(e.message), target: "", severity: "UNVERIFIED", reason: "A SliQ row could not be read exactly (nothing is rounded or guessed). It is left out of every comparison." });
  }
  for (const [kind, what] of SOURCE_KINDS) {
    if (!src.supplied[kind]) add({ area: "inputs", code: "source_file_not_supplied", ids: { file: kind }, field: "SliQ file", source: NOT_SUPPLIED, target: "", severity: "UNVERIFIED", reason: `The SliQ export has no file for ${what}. What depends on it is UNVERIFIED, not zero.` });
  }
  for (const table of SNAPSHOT_NEEDED) {
    if (!tgt.has(table)) add({ area: "inputs", code: "snapshot_table_not_supplied", ids: { table }, field: "Tolra snapshot table", source: "", target: NOT_SUPPLIED, severity: "UNVERIFIED", reason: `The Tolra snapshot has no ${table} table. What depends on it is UNVERIFIED, not empty.` });
  }
  for (const name of tgt.snapshot.ignored) add({ area: "inputs", code: "snapshot_table_ignored", ids: { table: name }, field: "Tolra snapshot table", source: "", target: "ignored", severity: "INFO", reason: "This table is not part of the snapshot format and was not read." });
  if (tgt.has("legacy_import_map") && !tgt.organizationId) {
    add({ area: "inputs", code: "organization_missing", ids: { snapshot: "meta.organization_id" }, field: "organisation", source: "", target: NOT_SUPPLIED, severity: "UNVERIFIED", reason: "The snapshot has a legacy_import_map but no organization_id, so legacy ids cannot be recomputed: records are matched by document number only." });
  } else if (!tgt.has("legacy_import_map")) {
    add({ area: "inputs", code: "matching_by_number", ids: { matching: "document number" }, field: "record matching", source: "", target: "document numbers and names only", severity: "INFO", reason: "No legacy_import_map in the snapshot: records are matched by document number (and customers by name), not by the import's legacy ids." });
  }
}

const ISOLATION_TEXT = {
  foreign_company_row: "This snapshot row belongs to a different company than the one the snapshot declares (meta.organization_id). It was taken out and is NOT compared; a snapshot must hold one company only.",
  row_without_company: "This snapshot row does not say which company it belongs to although its table does. It was taken out and is NOT compared.",
  cross_company_join: "This row points at a record of a different company (the record was taken out as foreign). The row was taken out too and is NOT compared.",
  cross_company_number: "A row of a different company carries a document number that this company also uses: a numbering collision across companies. The foreign row was taken out.",
  duplicate_id: "Two rows of this table share one id, so joins to it cannot be trusted.",
  mixed_companies_no_meta: "The snapshot holds rows of more than one company and does not declare which one it is for (meta.organization_id). Nothing can be told apart.",
  no_company_declared: "The snapshot does not declare its company (meta.organization_id): that no row belongs to another company cannot be verified.",
  table_without_company: "This table carries no organization_id, so that its rows all belong to the declared company cannot be verified.",
};

function isolationRows(ctx) {
  const { add, tgt } = ctx;
  for (const f of tgt.snapshot.isolation.findings) {
    const id = { table: f.table, row: f.row !== undefined ? String(f.row) : undefined, "row id": f.id ?? undefined, number: f.ref ?? undefined };
    const text = f.column ? ` The link is ${f.table}.${f.column} -> ${f.parent}.` : "";
    add({
      area: "company-isolation", code: f.code, ids: id, field: f.code === "foreign_company_row" || f.code === "row_without_company" ? "company (organization_id)" : "company isolation",
      source: f.expected ?? (tgt.organizationId ? `org-${fingerprint(tgt.organizationId)}` : NOT_SUPPLIED), target: f.company ?? (f.code === "row_without_company" ? "(blank)" : ""),
      severity: f.severity, reason: `${ISOLATION_TEXT[f.code]}${text}${f.companies ? ` (${f.companies} companies seen.)` : ""}`,
    });
  }
}

export function reconcile(src, snapshot) {
  const tgt = buildTarget(snapshot);
  const s = prepareSource(src);
  const { rows, add } = makeCollector();
  const ctx = { add, src, s, tgt, org: tgt.organizationId };

  // Who has something open in SliQ (decides whether a missing customer or supplier blocks).
  const openCustomers = new Set();
  const openSuppliers = new Set();
  const mark = (set, party) => party && set.add(party.ref);
  for (const i of s.invoices) if (isOpenSource(i)) mark(openCustomers, s.customerOf(i.customer));
  for (const q of s.quotes) if (s.openQuote(q)) mark(openCustomers, s.customerOf(q.customer));
  for (const o of s.salesOrders) if (s.OPEN_SO.has(o.status)) mark(openCustomers, s.customerOf(o.customer));
  for (const j of s.jobs) if (j.customer && s.jobOpen(j)) mark(openCustomers, s.customerOf(j.customer));
  for (const p of s.pos) if (s.OPEN_PO.has(p.status)) mark(openSuppliers, s.supplierOf(p.supplier));
  for (const b of s.bills) if ((b.outstanding ?? b.gross) > 0) mark(openSuppliers, s.supplierOf(b.supplier));

  inputsChecks(ctx);
  isolationRows(ctx);
  sourceNumbering(ctx);
  sourceRelationships(ctx);
  partyChecks(ctx, "customers", openCustomers);
  if (src.supplied.suppliers) partyChecks(ctx, "suppliers", openSuppliers);
  receivables(ctx);
  credits(ctx);
  refundRows(ctx);
  openingAndPayables(ctx);
  receivableTotals(ctx);
  quotes(ctx);
  salesOrders(ctx);
  purchaseOrders(ctx);
  commitments(ctx);
  deliveries(ctx);
  jobsAndWip(ctx);

  const stats = {
    source: {
      customers: src.customers.list.length, suppliers: src.suppliers.list.length, invoices: s.invoices.length, creditNotes: s.credits.length, payments: src.payments.length,
      allocations: src.allocations.length, refunds: src.refunds.length, openingBalances: src.openingBalances.length, supplierBills: s.bills.length, quotes: s.quotes.length,
      salesOrders: s.salesOrders.length, purchaseOrders: s.pos.length, jobs: s.jobs.length, deliveryLines: src.deliveries.length,
    },
    tolra: {
      customers: tgt.rows("customers").length, suppliers: tgt.rows("suppliers").length, invoices: tgt.rows("invoices").length, creditNotes: tgt.rows("credit_notes").length,
      payments: tgt.rows("invoice_payments").length, allocations: tgt.rows("invoice_credit_allocations").length, refunds: tgt.rows("customer_credit_ledger").filter((l) => l.kind === "refund").length,
      supplierBills: tgt.rows("supplier_bills").length, quotes: tgt.rows("quotes").length, salesOrders: tgt.rows("sales_orders").length, purchaseOrders: tgt.rows("purchase_orders").length,
      jobs: tgt.rows("jobs").length, deliveryNotes: tgt.rows("delivery_notes").length,
    },
    receivables: ctx.totals ?? null,
    commitments: ctx.commitments ?? {},
    matching: {
      invoices: { byLegacyId: (ctx.invoiceMatch?.pairs ?? []).filter((p) => p.via.startsWith("legacy")).length, byNumber: (ctx.invoiceMatch?.pairs ?? []).filter((p) => p.via === "document number").length },
      legacyIdsUsed: !!(tgt.organizationId && tgt.has("legacy_import_map")),
    },
    wip: wipByStage(ctx),
  };
  return { rows: sortRows(rows), stats };
}

function wipByStage(ctx) {
  const { s, tgt } = ctx;
  const count = (items) => {
    const m = {};
    for (const x of items) {
      const k = x === null || x === undefined ? "(unknown)" : safeWord(x);
      m[k] = (m[k] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(m).sort());
  };
  const srcOpen = s.jobs.filter((j) => s.jobOpen(j));
  const tgtOpen = tgt.has("jobs") ? tgt.rows("jobs").filter((j) => tgt.g("jobs", j, "finished_at") === null || tgt.g("jobs", j, "finished_at") === undefined) : null;
  return {
    sourceOpenJobs: srcOpen.length,
    tolraOpenJobs: tgtOpen ? tgtOpen.length : null,
    sourceByStage: count(srcOpen.map((j) => j.stage)),
    tolraByStage: tgtOpen ? count(tgtOpen.map((j) => tgt.g("jobs", j, "stage"))) : null,
    valuation: "valuation: accountant to confirm",
  };
}
