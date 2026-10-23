// Identities: customers and suppliers (duplicates, missing, ambiguous), document numbering collisions, and the relationships a
// SliQ record claims (a document's customer, a payment's invoice, a credit allocation's two ends, ...). Source side first, then
// the Tolra side where it can be checked.
import { legacyId, normNumber, normaliseName } from "../sliq-import/ids.mjs";

import { P } from "./rows.mjs";
import { safeRef } from "./safe.mjs";
import { cmpVal, nameRef } from "./util.mjs";

/** Customers or suppliers. `open` is the set of party refs that have something open in SliQ (decides BLOCKER or WARN for a missing one). */
export function partyChecks(ctx, kind, open) {
  const { add, src, tgt, org } = ctx;
  const side = src[kind];
  const table = kind;
  const label = kind === "customers" ? "customer" : "supplier";
  const mapSource = kind;
  const nameIndex = kind === "customers" ? tgt.customerNames : tgt.supplierNames;
  const canMap = !!(org && tgt.has("legacy_import_map"));

  for (const [key, list] of side.byKey) {
    if (list.length > 1) {
      add({ area: "identity", code: `duplicate_${label}_account`, ids: { [label]: list[0].ref }, field: "account code", source: `${list.length} records with the same code`, target: "", severity: "BLOCKER", reason: `Two or more SliQ ${label}s share the account code ${safeRef(key)}: which one is meant cannot be known (the import keeps them as separate records).` });
    }
  }
  for (const [nn, list] of side.byName) {
    if (list.length > 1) {
      add({ area: "identity", code: `duplicate_${label}_name`, ids: { [`${label}s`]: list.map((p) => p.ref).join("+") }, field: "name (normalised)", source: `${list.length} records`, target: "", severity: list.some((p) => open.has(p.ref)) ? "BLOCKER" : "WARN", reason: `Several SliQ ${label}s have the same name once case, punctuation, "&"/"and" and Ltd/Limited are ignored (${nameRef(nn)}). They are separate records until a person merges them; one of them has open items: ${list.filter((p) => open.has(p.ref)).map((p) => p.ref).join(", ") || "none"}.` });
    }
  }
  if (!tgt.has(table)) {
    if (side.list.length > 0) add({ area: "identity", code: `${label}s_not_supplied`, ids: { table }, field: `${label} list`, source: `${side.list.length} in SliQ`, target: "(not supplied)", severity: "UNVERIFIED", reason: `The Tolra snapshot has no ${table} table, so no SliQ ${label} can be checked.` });
    return new Map();
  }
  const byId = new Map(tgt.rows(table).map((r) => [r.id, r]));
  const matched = new Map();
  const claimed = new Set();
  for (const p of side.list) {
    let t = null;
    let via = null;
    if (canMap) {
      const newId = tgt.map.get(`${mapSource}|${legacyId(org, table, p.identity)}`);
      if (newId && byId.has(newId)) {
        t = byId.get(newId);
        via = "legacy id";
      }
    }
    if (!t) {
      const hits = nameIndex.get(normaliseName(p.name)) ?? [];
      if (hits.length === 1 && !claimed.has(hits[0].id)) {
        t = hits[0];
        via = "name";
      } else if (hits.length > 1 || (hits.length === 1 && claimed.has(hits[0].id))) {
        add({ area: "identity", code: `ambiguous_${label}`, ids: { [label]: p.ref }, field: "match", source: p.ref, target: `${hits.length} Tolra ${label}s with the same name`, severity: "UNVERIFIED", reason: `More than one Tolra ${label} could be this record (same normalised name) and the legacy map does not settle it: not compared.` });
        continue;
      }
    }
    if (!t) {
      add({ area: "identity", code: `${label}_missing`, ids: { [label]: p.ref }, field: "existence", source: "present", target: "(none)", severity: open.has(p.ref) ? "BLOCKER" : "WARN", reason: `This SliQ ${label} is not in Tolra${open.has(p.ref) ? " and it has open items, so they cannot be attached to it" : " (it has nothing open in SliQ)"}.` });
      continue;
    }
    claimed.add(t.id);
    matched.set(p.identity, t);
    if (via === "legacy id") cmpVal(ctx, { area: "identity", code: `${label}_name_differs`, ids: { [label]: p.ref }, field: "name (normalised)", s: nameRef(p.name), t: nameRef(t.name), sev: "WARN", why: `The legacy id leads to a Tolra ${label} whose name is different (names are shown as fingerprints, not in full).` });
  }
  for (const [nn, list] of nameIndex) {
    if (list.length > 1) add({ area: "identity", code: `tolra_duplicate_${label}`, ids: { [label]: nameRef(nn) }, field: "name (normalised)", source: "", target: `${list.length} Tolra records`, severity: "WARN", reason: `Tolra has ${list.length} ${label}s with the same normalised name.` });
  }
  for (const t of tgt.rows(table)) {
    if (claimed.has(t.id)) continue;
    const tag = tgt.rev.get(t.id);
    const imported = tag && tag.source === mapSource;
    add({ area: "identity", code: imported ? `tolra_only_imported_${label}` : `tolra_only_${label}`, ids: { [label]: nameRef(t.name) }, field: "existence", source: "(not in this SliQ export)", target: "present", severity: imported ? "WARN" : "INFO", reason: imported ? `Tolra holds this ${label}, created by the SliQ import, but it is not in the SliQ export given to this run.` : `Only in Tolra (created there, demo data or imported another way).` });
  }
  return matched;
}

/** Document numbering inside the SliQ export: one number, two documents. */
export function sourceNumbering(ctx) {
  const { add, s } = ctx;
  const emit = (kind, key, list) => add({ area: "numbering", code: "source_duplicate_number", ids: { [kind]: key }, field: `${kind} number`, source: `${list} records`, target: "", severity: "BLOCKER", reason: `The number ${safeRef(key)} is used ${list} times in the SliQ ${kind} data: which record is meant cannot be known, so none of them is compared against Tolra.` });
  const count = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(r.key, (m.get(r.key) ?? 0) + 1);
    return m;
  };
  for (const [k, n] of count([...s.invoices, ...s.credits])) if (n > 1) emit("invoice/credit note", k, n);
  for (const [k, n] of count(s.quotes)) if (n > 1) emit("quote", k, n);
  for (const [k, n] of count(s.pos)) if (n > 1) emit("purchase order", k, n);
  for (const [k, n] of count(s.salesOrders)) if (n > 1) emit("sales order", k, n);
  for (const [k, n] of count(s.jobs)) if (n > 1) emit("job", k, n);
  for (const [k, n] of count(s.bills)) if (n > 1) emit("supplier bill", k, n);
  // The same number as an invoice and as a quote: separate numbering in Tolra, but the one lines file cannot say which it is for.
  const quoteKeys = new Set(s.quotes.map((q) => q.key));
  for (const i of [...s.invoices, ...s.credits]) {
    if (quoteKeys.has(i.key)) add({ area: "numbering", code: "cross_type_number", ids: { number: i.ref }, field: "document number", source: "invoice or credit note and quote", target: "", severity: "WARN", reason: `The number ${i.ref} is used by an invoice (or credit note) and by a quote: the shared lines file cannot say which it belongs to.` });
  }
}

/** Relationships a SliQ record claims that the export itself cannot satisfy. */
export function sourceRelationships(ctx) {
  const { add, src, s } = ctx;
  const sev = (open) => (open ? "BLOCKER" : "WARN");
  const noParty = (kind, ref, what, open, field = "customer") =>
    add({ area: "relationships", code: `${kind}_${field}_not_found`, ids: { [kind]: ref }, field, source: what || "(blank)", target: "", severity: sev(open), reason: `The ${kind} names a ${field} that is not in the SliQ ${field === "supplier" ? "suppliers" : "customers"} file${open ? "; it is open, so what is owed or committed cannot be attached to anyone" : ""}.` });
  for (const i of s.invoices) if (!s.customerOf(i.customer)) noParty("invoice", i.ref, i.customer ? nameRef(i.customer) : "", i.state.issued && (i.state.balance === null || i.state.balance > 0));
  for (const c of s.credits) if (!s.customerOf(c.customer)) noParty("credit note", c.ref, c.customer ? nameRef(c.customer) : "", (c.absGross ?? 0) - c.allocated > 0);
  for (const q of s.quotes) if (!s.customerOf(q.customer)) noParty("quote", q.ref, q.customer ? nameRef(q.customer) : "", s.openQuote(q));
  for (const o of s.salesOrders) if (!s.customerOf(o.customer)) noParty("sales order", o.ref, o.customer ? nameRef(o.customer) : "", s.OPEN_SO.has(o.status));
  for (const po of s.pos) if (!s.supplierOf(po.supplier)) noParty("purchase order", po.ref, po.supplier ? nameRef(po.supplier) : "", s.OPEN_PO.has(po.status), "supplier");
  for (const b of s.bills) if (!s.supplierOf(b.supplier)) noParty("supplier bill", b.ref, b.supplier ? nameRef(b.supplier) : "", (b.outstanding ?? b.gross) > 0, "supplier");
  for (const [k, list] of s.payByInv) {
    if (s.invByKey.has(k)) continue;
    for (const p of list) add({ area: "relationships", code: "payment_without_invoice", ids: { payment: `${safeRef(k)}#${p.ordinal + 1}` }, field: "invoice", source: safeRef(k), target: "", severity: "BLOCKER", reason: `A SliQ payment of ${P(p.amount)} points at ${s.creditByKey.has(k) ? "a credit note, not an invoice" : "an invoice that is not in the export"}: money with no document.` });
  }
  for (const a of src.allocations) {
    if (a.ok) continue;
    add({ area: "relationships", code: "allocation_missing_link", ids: { allocation: `${safeRef(a.creditNoteNumber)}>${safeRef(a.invoiceNumber)}` }, field: "credit note / invoice", source: `${s.creditByKey.has(String(a.creditNoteNumber).trim()) ? "credit note found" : "credit note NOT found"}; ${s.invByKey.has(String(a.invoiceNumber).trim()) ? "invoice found" : "invoice NOT found"}`, target: "", severity: "BLOCKER", reason: "A credit allocation names a credit note or an invoice that is not in the export, so it cannot be applied or checked." });
  }
  for (const r of src.refunds) if (!s.invByKey.has(String(r.invoiceNumber).trim())) add({ area: "relationships", code: "refund_without_invoice", ids: { refund: safeRef(r.invoiceNumber) }, field: "invoice", source: safeRef(r.invoiceNumber), target: "", severity: "BLOCKER", reason: "A SliQ refund names an invoice that is not in the export." });
  for (const c of s.credits) {
    if (c.relatedInvoice && !s.invByKey.has(String(c.relatedInvoice).trim())) add({ area: "relationships", code: "credit_note_invoice_not_found", ids: { "credit note": c.ref }, field: "against invoice", source: safeRef(c.relatedInvoice), target: "", severity: "WARN", reason: "The credit note names an invoice that is not in the export." });
    if (!c.relatedInvoice) add({ area: "relationships", code: "credit_note_unlinked", ids: { "credit note": c.ref }, field: "against invoice", source: "(none)", target: "", severity: "WARN", reason: "The SliQ credit note is not linked to an invoice. Tolra requires a credit note to belong to one invoice, so it cannot be carried over as it stands." });
  }
  const lineDocs = new Set([...s.invoices, ...s.credits, ...s.quotes].map((d) => d.key));
  for (const [k, ls] of src.linesByDoc) if (!lineDocs.has(k)) add({ area: "relationships", code: "orphan_lines", ids: { document: k }, field: "lines", source: `${ls.length} line(s)`, target: "", severity: "WARN", reason: "Lines in the lines file belong to a document number that is not in any file." });
  const soKeys = new Set(s.salesOrders.map((o) => o.key));
  const quoteKeys = new Set(s.quotes.map((q) => q.key));
  for (const o of s.salesOrders) if (o.quoteNumber && src.supplied.quotes && !quoteKeys.has(String(o.quoteNumber).trim())) add({ area: "relationships", code: "order_quote_not_found", ids: { "sales order": o.ref }, field: "quote", source: safeRef(o.quoteNumber), target: "", severity: "WARN", reason: "The sales order names a quote that is not in the quotes export." });
  for (const j of s.jobs) {
    if (j.salesOrder && src.supplied.salesOrders && !soKeys.has(String(j.salesOrder).trim())) add({ area: "relationships", code: "job_order_not_found", ids: { job: j.ref }, field: "sales order", source: safeRef(j.salesOrder), target: "", severity: "WARN", reason: "The job names a sales order that is not in the export." });
    if (j.customer && !s.customerOf(j.customer)) noParty("job", j.ref, nameRef(j.customer), s.jobOpen(j));
  }
  const jobKeys = new Set(s.jobs.map((j) => j.key));
  const dnLinked = new Set();
  for (const d of src.deliveries) {
    const dkey = normNumber(d.number);
    const dref = safeRef(d.number);
    const links = [d.jobNumber, d.salesOrderNumber, d.invoiceNumber].filter(Boolean);
    if (links.length === 0) {
      if (!dnLinked.has(dkey)) add({ area: "deliveries", code: "delivery_unlinked", ids: { "delivery note": dref }, field: "job / sales order / invoice", source: "(none)", target: "", severity: "UNVERIFIED", reason: "The delivery has no job, sales order or invoice reference: its quantity cannot be attributed to anything. Not read as zero and not guessed." });
      dnLinked.add(dkey);
      continue;
    }
    if (d.jobNumber && src.supplied.jobs && !jobKeys.has(String(d.jobNumber).trim())) add({ area: "relationships", code: "delivery_job_not_found", ids: { "delivery note": dref }, field: "job", source: safeRef(d.jobNumber), target: "", severity: "WARN", reason: "The delivery names a job that is not in the export." });
    if (d.salesOrderNumber && src.supplied.salesOrders && !soKeys.has(String(d.salesOrderNumber).trim())) add({ area: "relationships", code: "delivery_order_not_found", ids: { "delivery note": dref }, field: "sales order", source: safeRef(d.salesOrderNumber), target: "", severity: "WARN", reason: "The delivery names a sales order that is not in the export." });
    if (d.invoiceNumber && !s.invByKey.has(String(d.invoiceNumber).trim())) add({ area: "relationships", code: "delivery_invoice_not_found", ids: { "delivery note": dref }, field: "invoice", source: safeRef(d.invoiceNumber), target: "", severity: "WARN", reason: "The delivery names an invoice that is not in the export." });
  }
  for (const o of src.openingBalances) {
    const table = o.partyType === "supplier" ? s.supplierOf(o.party) : s.customerOf(o.party);
    if (!table) add({ area: "relationships", code: "opening_party_not_found", ids: { [o.partyType]: o.party }, field: "account", source: safeRef(o.party), target: "", severity: "BLOCKER", reason: `An opening balance names a ${o.partyType} that is not in the ${o.partyType === "supplier" ? "suppliers" : "customers"} file.` });
  }
}
