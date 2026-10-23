// Open quotes, sales orders and purchase orders (and the outstanding commitments they add up to), open jobs and work in progress
// (stage and every quantity), and part deliveries.
//
// Work-in-progress VALUE is never derived here: SliQ does not hold what the accountant would book, and Tolra stores a job's sale
// value, not a cost. The quantities and status are compared; the valuation is reported as UNVERIFIED, "accountant to confirm".
import { normNumber } from "../sliq-import/ids.mjs";

import { partyPair } from "./compare-money.mjs";
import { matchDocuments, reportExtraTargets } from "./match.mjs";
import { NONE, NOT_SUPPLIED, P, Q } from "./rows.mjs";
import { safeWord } from "./safe.mjs";
import { cmpVal, sum } from "./util.mjs";

const OPEN_SO = new Set(["open", "confirmed", "in_production", "converted"]);
const OPEN_PO = new Set(["sent", "confirmed", "partial_received"]);

function simpleDocs(ctx, o) {
  // o: { area, label, sources, table, refCol, mapSource, hashKind, openS(s), openT(t), amountS(s), amountCol, customerKind, partyOfS(s), partyCol, fields: [...] }
  const { add, tgt } = ctx;
  if (!tgt.has(o.table)) {
    if (o.sources.length) add({ area: o.area, code: `${o.table}_not_supplied`, ids: { table: o.table }, field: `${o.label}s`, source: `${o.sources.length} in SliQ`, target: NOT_SUPPLIED, severity: "UNVERIFIED", reason: `The Tolra snapshot has no ${o.table} table: no SliQ ${o.label} can be verified.` });
    return null;
  }
  const spec = { area: o.area, label: o.label, sources: o.sources, targets: tgt.rows(o.table), refOf: (t) => tgt.g(o.table, t, o.refCol), mapSource: o.mapSource, hashKind: o.hashKind, openOfTarget: o.openT };
  const m = matchDocuments(ctx, spec);
  for (const x of m.missingSource) {
    if (x.skip) continue;
    const open = o.openS(x);
    add({ area: o.area, code: `${o.label.replace(/ /g, "_")}_missing_in_tolra`, ids: { [o.label]: x.ref }, field: "existence", source: `${safeWord(x.status) ?? "present"}${o.amountS(x) !== null ? `, ${P(o.amountS(x))}` : ""}`, target: NONE, diff: open && o.amountS(x) !== null ? -o.amountS(x) : null, unit: "p", severity: open ? "BLOCKER" : "WARN", reason: `This SliQ ${o.label} is not in Tolra (${x.reason}).${open ? " It is open, so a commitment would be lost." : " It is closed or not yet live, so only history is missing."}` });
  }
  reportExtraTargets(ctx, spec, m.extraTarget);
  for (const { s: x, t } of m.pairs) {
    const id = { [o.label]: x.ref };
    const open = o.openS(x);
    const sev = open ? "BLOCKER" : "WARN";
    if (o.basis && !o.basis()) {
      // Whether the figure is net or gross on either side is not known, so equal numbers prove nothing and different ones prove nothing.
      add({ area: o.area, code: `${o.label.replace(/ /g, "_")}_basis_unknown`, ids: id, field: `${o.amountField} (net or gross?)`, source: P(o.amountS(x)), target: P(tgt.g(o.table, t, o.amountCol) ?? null), severity: "UNVERIFIED", reason: `Whether the ${o.label} total is net or gross is not stated on both sides (mapping reconcile.purchaseOrderTotalBasis and snapshot meta.purchase_order_total_basis must agree), so the two figures are NOT compared as equal or different.` });
    } else cmpVal(ctx, { area: o.area, code: `${o.label.replace(/ /g, "_")}_amount`, ids: id, field: o.amountField, s: o.amountS(x), t: tgt.g(o.table, t, o.amountCol), unit: "p", sev, why: `The ${o.label} value differs, exact pence.` });
    const sParty = o.partyOfS(x);
    const pp = partyPair(ctx, sParty, o.partyText(x), tgt.g(o.table, t, o.partyCol), o.partyKind);
    cmpVal(ctx, { area: o.area, code: `${o.label.replace(/ /g, "_")}_party`, ids: id, field: o.partyKind === "suppliers" ? "supplier" : "customer", s: pp.s, t: pp.t, sev, why: `The ${o.label} belongs to someone else in Tolra.` });
    if (x.status !== null && x.status !== undefined) {
      const tStatus = tgt.g(o.table, t, "status");
      const tOpen = tStatus === undefined || tStatus === null ? undefined : o.openTStatus(tStatus);
      const sOpen = o.openS(x);
      if (tOpen === undefined) cmpVal(ctx, { area: o.area, code: `${o.label.replace(/ /g, "_")}_status`, ids: id, field: "status", s: safeWord(x.status), t: safeWord(tStatus), sev: "WARN" });
      else if (sOpen !== tOpen) add({ area: o.area, code: `${o.label.replace(/ /g, "_")}_openness`, ids: id, field: "status", source: `${safeWord(x.status)} (${sOpen ? "open" : "closed"})`, target: `${safeWord(tStatus)} (${tOpen ? "open" : "closed"})`, severity: "BLOCKER", reason: `The ${o.label} is ${sOpen ? "open" : "closed"} in SliQ and ${tOpen ? "open" : "closed"} in Tolra: the commitment would be ${sOpen ? "lost" : "invented"}.` });
      else if (x.status !== tStatus) add({ area: o.area, code: `${o.label.replace(/ /g, "_")}_status_wording`, ids: id, field: "status", source: safeWord(x.status), target: safeWord(tStatus), severity: "WARN", reason: "Both sides agree it is " + (sOpen ? "open" : "closed") + ", but the status differs." });
    } else {
      cmpVal(ctx, { area: o.area, code: `${o.label.replace(/ /g, "_")}_status`, ids: id, field: "status", s: x.status ?? null, t: safeWord(tgt.g(o.table, t, "status") ?? null), sev: "WARN" });
    }
    for (const f of o.fields) cmpVal(ctx, { area: o.area, code: `${o.label.replace(/ /g, "_")}_${f.name}`, ids: id, field: f.name.replace(/_/g, " "), s: f.s(x), t: tgt.g(o.table, t, f.col), sev: "WARN", why: `The ${f.name.replace(/_/g, " ")} differs.` });
  }
  return m;
}

export function quotes(ctx) {
  const { src, s } = ctx;
  if (!src.supplied.quotes) return;
  return simpleDocs(ctx, {
    area: "quotes", label: "quote", sources: s.quotes.filter((q) => !s.dup.quotes.has(q.key)), table: "quotes", refCol: "quote_ref", mapSource: "quotes", hashKind: "quotes",
    openS: (q) => s.openQuote(q), openT: (t) => t.status === "sent", openTStatus: (st) => st === "sent", amountS: (q) => q.gross, amountCol: "total_value", amountField: "gross (total value)",
    partyOfS: (q) => s.customerOf(q.customer), partyText: (q) => q.customer, partyCol: "customer", partyKind: "customers",
    fields: [{ name: "valid_until", col: "valid_until", s: (q) => q.validUntil }],
  });
}

export function salesOrders(ctx) {
  const { src, s } = ctx;
  if (!src.supplied.salesOrders) return;
  return simpleDocs(ctx, {
    area: "sales-orders", label: "sales order", sources: s.salesOrders.filter((o) => !s.dup.salesOrders.has(o.key)), table: "sales_orders", refCol: "so_number", mapSource: null, hashKind: null,
    openS: (o) => OPEN_SO.has(o.status), openT: (t) => OPEN_SO.has(t.status), openTStatus: (st) => OPEN_SO.has(st), amountS: (o) => o.total, amountCol: "total_value", amountField: "total value",
    partyOfS: (o) => s.customerOf(o.customer), partyText: (o) => o.customer, partyCol: "customer", partyKind: "customers",
    fields: [
      { name: "order_date", col: "order_date", s: (o) => o.orderDate }, { name: "delivery_date", col: "delivery_date", s: (o) => o.deliveryDate },
      { name: "quote_ref", col: "quote_ref", s: (o) => (o.quoteNumber ? String(o.quoteNumber).trim() : null) }, { name: "customer_po", col: "customer_po", s: (o) => o.customerPo },
    ],
  });
}

export function purchaseOrders(ctx) {
  const { src, s } = ctx;
  if (!src.supplied.purchaseOrders) return;
  return simpleDocs(ctx, {
    area: "purchase-orders", label: "purchase order", sources: s.pos.filter((p) => !s.dup.pos.has(p.key)), table: "purchase_orders", refCol: "po_ref", mapSource: "purchase_orders", hashKind: "purchase_orders",
    openS: (p) => OPEN_PO.has(p.status), openT: (t) => OPEN_PO.has(t.status), openTStatus: (st) => OPEN_PO.has(st), amountS: (p) => p.total, amountCol: "total_value", amountField: "total value",
    partyOfS: (p) => s.supplierOf(p.supplier), partyText: (p) => p.supplier, partyCol: "supplier", partyKind: "suppliers", basis: () => poBasisKnown(ctx),
    fields: [{ name: "order_date", col: "order_date", s: (p) => p.orderDate }, { name: "expected_delivery", col: "expected_delivery", s: (p) => p.deliveryDate }],
  });
}

/** The purchase-order total is net or gross: known only when the mapping and the snapshot both say so, and say the same. */
const poBasisKnown = (ctx) => !!ctx.src.spec.poTotalBasis && ctx.src.spec.poTotalBasis === ctx.tgt.snapshot.poTotalBasis;

/** What is still committed: open quotes, open sales orders, open purchase orders (count and value, both sides). */
export function commitments(ctx) {
  const { add, src, s, tgt } = ctx;
  const sets = [
    { name: "open_quotes", kind: "quotes", docs: s.quotes.filter((q) => !s.dup.quotes.has(q.key) && s.openQuote(q)), amt: (q) => q.gross, table: "quotes", tOpen: (t) => t.status === "sent", tAmt: "total_value" },
    { name: "open_sales_orders", kind: "salesOrders", docs: s.salesOrders.filter((o) => !s.dup.salesOrders.has(o.key) && OPEN_SO.has(o.status)), amt: (o) => o.total, table: "sales_orders", tOpen: (t) => OPEN_SO.has(t.status), tAmt: "total_value" },
    { name: "open_purchase_orders", kind: "purchaseOrders", docs: s.pos.filter((p) => !s.dup.pos.has(p.key) && OPEN_PO.has(p.status)), amt: (p) => p.total, table: "purchase_orders", tOpen: (t) => OPEN_PO.has(t.status), tAmt: "total_value" },
  ];
  ctx.commitments = {};
  for (const c of sets) {
    if (!src.supplied[c.kind] || !tgt.has(c.table)) continue;
    const tRows = tgt.rows(c.table).filter((t) => c.tOpen(t));
    const sUnknown = c.docs.filter((d) => c.amt(d) === null).length;
    const tUnknown = tRows.filter((t) => tgt.g(c.table, t, c.tAmt) === null || tgt.g(c.table, t, c.tAmt) === undefined).length;
    const sTotal = sUnknown ? null : sum(c.docs.map((d) => c.amt(d)));
    const tTotal = tUnknown || !tgt.col(c.table, c.tAmt) ? null : sum(tRows.map((t) => t[c.tAmt]));
    ctx.commitments[c.name] = { sourceCount: c.docs.length, targetCount: tRows.length, sourceTotal: sTotal, targetTotal: tTotal };
    const id = { commitments: c.name };
    cmpVal(ctx, { area: "commitments", code: `${c.name}_count`, ids: id, field: "number open", s: c.docs.length, t: tRows.length, unit: "t", why: "The number of open documents differs." });
    if (c.name === "open_purchase_orders" && !poBasisKnown(ctx)) {
      add({ area: "commitments", code: "open_purchase_orders_basis_unknown", ids: id, field: "value open (net or gross?)", source: sTotal === null ? "(unknown)" : P(sTotal), target: tTotal === null ? "(unknown)" : P(tTotal), severity: "UNVERIFIED", reason: "Whether purchase-order totals are net or gross is not stated on both sides, so the open purchase-order value is NOT compared." });
      continue;
    }
    cmpVal(ctx, { area: "commitments", code: `${c.name}_total`, ids: id, field: "value open (control total)", s: sTotal, t: tTotal, unit: "p", why: `The value of open documents differs, exact pence.${sUnknown || tUnknown ? ` (${sUnknown} SliQ and ${tUnknown} Tolra document(s) have no value and are not read as zero.)` : ""}` });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Jobs, work in progress, part deliveries
// ---------------------------------------------------------------------------------------------------------------------------

/** Source deliveries grouped by delivery note number. */
function sourceDeliveries(ctx) {
  const { src } = ctx;
  const m = new Map();
  for (const d of src.deliveries) {
    const k = normNumber(d.number);
    if (!m.has(k)) m.set(k, { key: k, ref: String(d.number).trim(), lines: [] });
    m.get(k).lines.push(d);
  }
  const out = [];
  for (const d of m.values()) {
    const qtys = d.lines.map((l) => l.quantity);
    d.quantity = qtys.some((q) => q === null) ? null : sum(qtys);
    const pick = (f) => [...new Set(d.lines.map((l) => l[f]).filter(Boolean).map((v) => String(v).trim()))];
    const jobs = pick("jobNumber");
    const orders = pick("salesOrderNumber");
    const invoices = pick("invoiceNumber");
    d.job = jobs.length === 1 ? jobs[0] : null;
    d.salesOrder = orders.length === 1 ? orders[0] : null;
    d.invoice = invoices.length === 1 ? invoices[0] : null;
    d.ambiguousLink = jobs.length > 1 || orders.length > 1 || invoices.length > 1;
    d.date = [...new Set(d.lines.map((l) => l.date).filter(Boolean))].sort()[0] ?? null;
    d.dateAmbiguous = new Set(d.lines.map((l) => l.date).filter(Boolean)).size > 1;
    out.push(d);
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

export function deliveries(ctx) {
  const { add, src, tgt } = ctx;
  const sd = sourceDeliveries(ctx);
  ctx.sourceDeliveries = sd;
  if (!src.supplied.deliveries) return;
  if (!tgt.has("delivery_notes")) {
    if (sd.length) add({ area: "deliveries", code: "delivery_notes_not_supplied", ids: { table: "delivery_notes" }, field: "delivery notes", source: `${sd.length} in SliQ`, target: NOT_SUPPLIED, severity: "UNVERIFIED", reason: "The Tolra snapshot has no delivery_notes table: part deliveries cannot be verified." });
    return;
  }
  const spec = { area: "deliveries", label: "delivery note", sources: sd, targets: tgt.rows("delivery_notes"), refOf: (t) => tgt.g("delivery_notes", t, "dn_number"), mapSource: null, hashKind: null };
  const m = matchDocuments(ctx, spec);
  for (const x of m.missingSource) if (!x.skip) add({ area: "deliveries", code: "delivery_missing_in_tolra", ids: { "delivery note": x.ref }, field: "existence", source: `quantity ${Q(x.quantity)}`, target: NONE, diff: x.quantity === null ? null : -x.quantity, unit: "q", severity: "BLOCKER", reason: "This SliQ delivery is not in Tolra: what has been despatched, and so what remains to deliver, would be wrong." });
  reportExtraTargets(ctx, spec, m.extraTarget);
  const jobById = new Map(tgt.rows("jobs").map((j) => [j.id, j]));
  const soById = new Map(tgt.rows("sales_orders").map((o) => [o.id, o]));
  const invById = new Map(tgt.rows("invoices").map((o) => [o.id, o]));
  const itemsByDn = tgt.groupBy("delivery_note_items", "delivery_note_id");
  for (const { s: d, t } of m.pairs) {
    const id = { "delivery note": d.ref };
    if (d.ambiguousLink) add({ area: "deliveries", code: "delivery_link_ambiguous", ids: id, field: "job / sales order / invoice", source: "several different references on one delivery note", target: "", severity: "UNVERIFIED", reason: "The delivery note's lines name different jobs, orders or invoices: it cannot be attributed to one." });
    const tQty = tgt.has("delivery_note_items") && tgt.col("delivery_note_items", "quantity") ? sum((itemsByDn.get(t.id) ?? []).map((i) => i.quantity ?? 0)) : undefined;
    cmpVal(ctx, { area: "deliveries", code: "delivery_quantity", ids: id, field: "quantity despatched", s: d.quantity, t: tQty, unit: "q", why: "The quantity on the delivery note differs (a part delivery)." });
    if (d.date && !d.dateAmbiguous) cmpVal(ctx, { area: "deliveries", code: "delivery_date", ids: id, field: "delivery date", s: d.date, t: tgt.g("delivery_notes", t, "delivery_date"), sev: "WARN", why: "The delivery date differs." });
    if (!d.ambiguousLink) {
      if (d.job) cmpVal(ctx, { area: "deliveries", code: "delivery_job", ids: id, field: "job", s: d.job, t: tgt.col("delivery_notes", "job_id") ? (t.job_id ? tgt.g("jobs", jobById.get(t.job_id) ?? {}, "job_no") ?? null : null) : undefined, sev: "BLOCKER", why: "The delivery is attached to a different job (or none) in Tolra." });
      if (d.salesOrder) cmpVal(ctx, { area: "deliveries", code: "delivery_order", ids: id, field: "sales order", s: d.salesOrder, t: tgt.col("delivery_notes", "sales_order_id") ? (t.sales_order_id ? tgt.g("sales_orders", soById.get(t.sales_order_id) ?? {}, "so_number") ?? null : null) : undefined, sev: "BLOCKER", why: "The delivery is attached to a different sales order (or none) in Tolra." });
      if (d.invoice) cmpVal(ctx, { area: "deliveries", code: "delivery_invoice", ids: id, field: "invoice", s: d.invoice, t: tgt.col("delivery_notes", "invoice_id") ? (t.invoice_id ? tgt.g("invoices", invById.get(t.invoice_id) ?? {}, "invoice_ref") ?? null : null) : undefined, sev: "WARN", why: "The delivery is attached to a different invoice (or none) in Tolra." });
    }
  }
}

export function jobsAndWip(ctx) {
  const { add, src, s, tgt } = ctx;
  const openSrc = s.jobs.filter((j) => !s.dup.jobs.has(j.key) && s.jobOpen(j));
  if (!src.supplied.jobs) {
    if (tgt.has("jobs") && tgt.rows("jobs").length) add({ area: "jobs", code: "jobs_not_in_source", ids: { file: "jobs" }, field: "jobs", source: NOT_SUPPLIED, target: `${tgt.rows("jobs").length} jobs`, severity: "UNVERIFIED", reason: "Tolra holds jobs but the SliQ export has no jobs file: open jobs, work in progress and quantities cannot be verified." });
    return;
  }
  if (!tgt.has("jobs")) {
    if (s.jobs.length) add({ area: "jobs", code: "jobs_not_supplied", ids: { table: "jobs" }, field: "jobs", source: `${s.jobs.length} in SliQ`, target: NOT_SUPPLIED, severity: "UNVERIFIED", reason: "The Tolra snapshot has no jobs table: no job can be verified." });
    return;
  }
  const jobFinished = (t) => tgt.g("jobs", t, "finished_at") !== null && tgt.g("jobs", t, "finished_at") !== undefined;
  const spec = { area: "jobs", label: "job", sources: s.jobs.filter((j) => !s.dup.jobs.has(j.key)), targets: tgt.rows("jobs"), refOf: (t) => tgt.g("jobs", t, "job_no"), mapSource: null, hashKind: null, openOfTarget: (t) => !jobFinished(t) };
  const m = matchDocuments(ctx, spec);
  for (const x of m.missingSource) if (!x.skip) add({ area: "jobs", code: "job_missing_in_tolra", ids: { job: x.ref }, field: "existence", source: `${safeWord(x.status) ?? "present"}, ordered ${Q(x.qtyOrdered)}`, target: NONE, severity: s.jobOpen(x) ? "BLOCKER" : "WARN", reason: `This SliQ job is not in Tolra (${x.reason}).${s.jobOpen(x) ? " It is open: work in progress would be lost." : ""}` });
  reportExtraTargets(ctx, spec, m.extraTarget);

  const soById = new Map(tgt.rows("sales_orders").map((o) => [o.id, o]));
  const jobsByOrder = tgt.groupBy("jobs", "converted_from_sales_order_id");
  const dnByJob = tgt.groupBy("delivery_notes", "job_id");
  const dnByOrder = tgt.groupBy("delivery_notes", "sales_order_id");
  const itemsByDn = tgt.groupBy("delivery_note_items", "delivery_note_id");
  const qtyByJob = tgt.has("job_quantities") ? new Map(tgt.rows("job_quantities").map((q) => [q.job_id, q])) : null;
  const dnQty = (dn) => sum((itemsByDn.get(dn.id) ?? []).map((i) => i.quantity ?? 0));
  const canDespatch = tgt.has("delivery_notes") && tgt.has("delivery_note_items") && tgt.col("delivery_note_items", "quantity") && tgt.col("delivery_notes", "job_id");
  const tDespatched = (t) => {
    if (!canDespatch) return undefined;
    let notes = dnByJob.get(t.id) ?? [];
    const order = tgt.g("jobs", t, "converted_from_sales_order_id");
    if (order && tgt.col("delivery_notes", "sales_order_id")) {
      const loose = (dnByOrder.get(order) ?? []).filter((d) => d.job_id === null || d.job_id === undefined);
      if (loose.length) {
        if ((jobsByOrder.get(order) ?? []).length === 1) notes = [...notes, ...loose];
        else return null; // an order with several jobs and a delivery that names no job: cannot be attributed
      }
    }
    return sum(notes.map(dnQty)) * 1;
  };

  const sdByJob = new Map();
  for (const d of ctx.sourceDeliveries ?? []) {
    if (d.job && !d.ambiguousLink) sdByJob.set(normNumber(d.job), (sdByJob.get(normNumber(d.job)) ?? []).concat(d));
  }

  for (const { s: j, t } of m.pairs) {
    const id = { job: j.ref };
    const open = s.jobOpen(j);
    const sev = open ? "BLOCKER" : "WARN";
    if (j.customer) {
      const pp = partyPair(ctx, s.customerOf(j.customer), j.customer, tgt.g("jobs", t, "customer"));
      cmpVal(ctx, { area: "jobs", code: "job_customer", ids: id, field: "customer", s: pp.s, t: pp.t, sev, why: "The job belongs to a different customer in Tolra." });
    }
    if (j.salesOrder) {
      const order = tgt.g("jobs", t, "converted_from_sales_order_id");
      const tSo = order === undefined || !tgt.has("sales_orders") ? undefined : order === null ? null : tgt.g("sales_orders", soById.get(order) ?? {}, "so_number") ?? null;
      cmpVal(ctx, { area: "jobs", code: "job_sales_order", ids: id, field: "sales order", s: String(j.salesOrder).trim(), t: tSo, sev: open ? "BLOCKER" : "WARN", why: "The job is made from a different sales order (or none) in Tolra." });
    }
    // stage and finished state
    cmpVal(ctx, { area: "wip", code: "job_stage", ids: id, field: "stage", s: safeWord(j.stage), t: safeWord(tgt.g("jobs", t, "stage")), sev, why: "The job is at a different stage in Tolra." });
    if (j.status === "cancelled") add({ area: "wip", code: "job_cancelled", ids: id, field: "job state", source: "cancelled", target: jobFinished(t) ? "finished" : "open", severity: "UNVERIFIED", reason: "Tolra has no cancelled job state: how a cancelled SliQ job should appear is for a person to confirm." });
    else cmpVal(ctx, { area: "wip", code: "job_finished", ids: id, field: "job state", s: j.status === null ? null : j.status === "finished" ? "finished" : "open", t: tgt.col("jobs", "finished_at") ? (jobFinished(t) ? "finished" : "open") : undefined, sev: "BLOCKER", why: "The job is finished on one side and open on the other." });
    // quantities
    const q = qtyByJob ? qtyByJob.get(t.id) ?? null : undefined;
    const qv = (col) => (qtyByJob === null ? undefined : q === null ? null : q[col] === undefined ? undefined : q[col]);
    cmpVal(ctx, { area: "wip", code: "qty_ordered", ids: id, field: "quantity ordered", s: j.qtyOrdered, t: tgt.g("jobs", t, "quantity_required"), unit: "q", sev, why: "The quantity ordered differs." });
    cmpVal(ctx, { area: "wip", code: "qty_made", ids: id, field: "quantity made", s: j.qtyMade, t: qv("quantity_made"), unit: "q", sev, why: "The quantity made differs." });
    cmpVal(ctx, { area: "wip", code: "qty_accepted", ids: id, field: "quantity accepted", s: j.qtyAccepted, t: qv("quantity_accepted"), unit: "q", sev, why: "The quantity accepted at inspection differs." });
    cmpVal(ctx, { area: "wip", code: "qty_rejected", ids: id, field: "quantity rejected", s: j.qtyRejected, t: qv("quantity_rejected"), unit: "q", sev, why: "The quantity rejected differs." });
    cmpVal(ctx, { area: "wip", code: "qty_reworked", ids: id, field: "quantity reworked", s: j.qtyReworked, t: qv("quantity_reworked"), unit: "q", sev, why: "The quantity reworked differs." });
    // despatched and remaining
    const sdl = sdByJob.get(j.key);
    const fromDeliveries = src.supplied.deliveries && sdl && sdl.every((d) => d.quantity !== null) ? sum(sdl.map((d) => d.quantity)) : null;
    if (j.qtyDespatched !== null && fromDeliveries !== null && j.qtyDespatched !== fromDeliveries) {
      add({ area: "wip", code: "source_despatched_vs_deliveries", ids: id, field: "quantity despatched (SliQ job vs SliQ deliveries)", source: Q(j.qtyDespatched), target: `deliveries add up to ${Q(fromDeliveries)}`, diff: fromDeliveries - j.qtyDespatched, unit: "q", severity: "WARN", reason: "Inside SliQ, the job's despatched quantity is not what its delivery notes add up to." });
    }
    const sDes = j.qtyDespatched ?? fromDeliveries;
    const tDes = tDespatched(t);
    cmpVal(ctx, { area: "wip", code: "qty_despatched", ids: id, field: "quantity despatched", s: sDes, t: tDes, unit: "q", sev, why: "The quantity despatched (all part deliveries added up) differs." });
    const tOrdered = tgt.g("jobs", t, "quantity_required");
    const sRem = j.qtyRemaining ?? (j.qtyOrdered !== null && sDes !== null ? j.qtyOrdered - sDes : null);
    const tRem = typeof tOrdered === "number" && typeof tDes === "number" ? tOrdered - tDes : tOrdered === undefined || tDes === undefined ? undefined : null;
    if (j.qtyRemaining !== null && j.qtyOrdered !== null && sDes !== null && j.qtyRemaining !== j.qtyOrdered - sDes) {
      add({ area: "wip", code: "source_remaining_inconsistent", ids: id, field: "quantity remaining (stated vs ordered - despatched)", source: Q(j.qtyRemaining), target: Q(j.qtyOrdered - sDes), diff: j.qtyOrdered - sDes - j.qtyRemaining, unit: "q", severity: "WARN", reason: "Inside SliQ, the stated quantity remaining is not quantity ordered less quantity despatched." });
    }
    cmpVal(ctx, { area: "wip", code: "qty_remaining", ids: id, field: "quantity remaining to despatch", s: sRem, t: tRem, unit: "q", sev, why: "The quantity still to despatch differs." });
    if (j.value !== null || tgt.col("jobs", "value")) cmpVal(ctx, { area: "jobs", code: "job_value", ids: id, field: "job sale value", s: j.value, t: tgt.g("jobs", t, "value"), unit: "p", sev: "WARN", why: "The job's sale value differs. This is not a work-in-progress valuation." });
    if (j.dueDate) cmpVal(ctx, { area: "jobs", code: "job_due_date", ids: id, field: "due date", s: j.dueDate, t: tgt.g("jobs", t, "due_date"), sev: "WARN", why: "The due date differs." });
  }
  const openTgt = tgt.rows("jobs").filter((t) => !jobFinished(t));
  if (openSrc.length || openTgt.length) {
    add({ area: "wip", code: "wip_valuation", ids: { "open jobs": `${openSrc.length} in SliQ / ${openTgt.length} in Tolra` }, field: "work-in-progress valuation", source: "(not derivable)", target: "(not derivable)", severity: "UNVERIFIED", reason: "valuation: accountant to confirm. Quantities and stage are compared above; no WIP value is derived, estimated or compared here (a job's sale value is not its cost)." });
  }
}
