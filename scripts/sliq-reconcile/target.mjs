// Indexes over the typed Tolra snapshot, and the one place that says what "not supplied" means:
//   g(table, row, column) is undefined when the snapshot has no such column at all, null when the column is there and the row's
//   value is empty. Callers treat both as "cannot compare" (UNVERIFIED), but only the first as "the snapshot did not carry it".
import { normaliseName } from "../sliq-import/ids.mjs";

export const NOT_COLLECTIBLE = new Set(["draft", "void", "voided", "cancelled", "canceled", "credited", "written_off"]);
export const VOID_FAMILY = new Set(["void", "voided", "cancelled", "canceled", "written_off"]);

/** The same rule as lib/receivables.ts invoiceLifecycle: paid | closed (draft, void, credited...) | collectible. A missing status is a draft. */
export function lifecycle(status) {
  const s = String(status ?? "").trim().toLowerCase() || "draft";
  if (s === "paid") return "paid";
  return NOT_COLLECTIBLE.has(s) ? "closed" : "collectible";
}
export const statusOf = (status) => String(status ?? "").trim().toLowerCase() || "draft";

export function buildTarget(snapshot) {
  const has = (t) => snapshot.supplied.has(t);
  const col = (t, c) => snapshot.columns[t]?.has(c) ?? false;
  const rows = (t) => snapshot.tables[t] ?? [];
  const g = (t, row, c) => {
    if (!col(t, c)) return undefined;
    const v = row[c];
    return v === undefined ? null : v;
  };
  const byId = (t) => new Map(rows(t).map((r) => [r.id, r]));
  const groupBy = (t, key) => {
    const m = new Map();
    for (const r of rows(t)) {
      const k = r[key];
      if (k === undefined || k === null) continue;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };

  const map = new Map();
  const rev = new Map();
  for (const r of rows("legacy_import_map")) {
    map.set(`${r.source}|${r.old_id}`, r.new_id);
    rev.set(r.new_id, { source: r.source, old_id: r.old_id });
  }

  // Customers and suppliers: resolved from the free-text name a document carries, the same way the importer matches (normalised).
  const nameIndex = (t) => {
    const m = new Map();
    for (const r of rows(t)) {
      const k = normaliseName(r.name);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  return {
    snapshot, has, col, rows, g, byId, groupBy, map, rev,
    organizationId: snapshot.organizationId,
    customerNames: nameIndex("customers"),
    supplierNames: nameIndex("suppliers"),
    invoiceById: byId("invoices"),
    paymentById: byId("invoice_payments"),
    paymentsByInvoice: groupBy("invoice_payments", "invoice_id"),
    linesByInvoice: groupBy("invoice_line_items", "invoice_id"),
    allocationsByInvoice: groupBy("invoice_credit_allocations", "invoice_id"),
    allocationsByCredit: groupBy("invoice_credit_allocations", "credit_note_id"),
    ledgerByInvoice: groupBy("customer_credit_ledger", "invoice_id"),
    ledgerToInvoice: groupBy("customer_credit_ledger", "to_invoice_id"),
  };
}
