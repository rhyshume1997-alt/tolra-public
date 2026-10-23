// Money: invoices (net / VAT / gross, status, VAT treatment, lines), payments and reversals, credit notes and allocations,
// refunds, outstanding balances and the control totals, opening balances and supplier payables.
//
// Arithmetic is integer pence throughout. Outstanding = gross - payments (a reversal is a negative payment) - credits allocated
// + refunds, which is Tolra's own rule (lib/receivables.ts balanceDue, before the floor at zero; below zero it is customer credit).
import { legacyId, normaliseName, paymentIdentity } from "../sliq-import/ids.mjs";

import { matchDocuments, reportExtraTargets } from "./match.mjs";
import { NONE, NOT_SUPPLIED, P } from "./rows.mjs";
import { lifecycle, statusOf, VOID_FAMILY } from "./target.mjs";
import { safeText, safeWord } from "./safe.mjs";
import { cmpVal, nameRef, sum } from "./util.mjs";

/** The two sides' party as one comparable code each (account code, or a fingerprint of the name when SliQ has no such customer). */
function partyPair(ctx, sourceParty, sourceText, targetName, kind = "customers") {
  const { src } = ctx;
  const sNN = sourceParty ? sourceParty.nn : sourceText ? normaliseName(sourceText) : null;
  const sCode = sourceParty ? sourceParty.ref : sourceText ? nameRef(sourceText) : null;
  if (targetName === undefined) return { s: sCode, t: undefined };
  if (targetName === null || targetName === "") return { s: sCode, t: null };
  const tNN = normaliseName(targetName);
  if (sNN !== null && tNN === sNN) return { s: sCode, t: sCode };
  return { s: sCode, t: src[kind].byName.get(tNN)?.[0]?.ref ?? nameRef(targetName) };
}
export { partyPair };

const isOpenSource = (i) => i.state.issued && (i.state.balance === null || i.state.balance > 0);

/** Source integrity of one invoice's own figures. WARN: a fault in SliQ that Tolra will faithfully copy. */
function sourceIntegrity(ctx, i) {
  const { add, src } = ctx;
  const id = { invoice: i.ref };
  if (i.net !== null && i.vat !== null && i.gross !== null && i.net + i.vat !== i.gross) {
    add({ area: "receivables", code: "source_header_arithmetic", ids: id, field: "net + vat = gross", source: `${P(i.net)} + ${P(i.vat)} = ${P(i.net + i.vat)} vs gross ${P(i.gross)}`, target: "", diff: i.gross - (i.net + i.vat), severity: "WARN", reason: "The SliQ invoice header does not add up. Tolra will copy whatever it was given." });
  }
  const st = i.state;
  if (st.issued && st.paid !== null && st.payUnv.length === 0) {
    if (st.paid < 0) add({ area: "payments", code: "reversals_exceed_receipts", ids: id, field: "paid (receipts less reversals)", source: P(st.paid), target: "", severity: "WARN", reason: "SliQ reverses more than it received on this invoice: the net paid is negative, which cannot be right." });
    // Refunds: money paid back is limited to what the customer paid or was credited above the invoice. A credit that is both
    // allocated to this invoice and refunded from it is counted once in the balance (gross - paid - credits + refunds).
    const surplus = Math.max(0, st.paid + st.credited - (i.gross ?? 0));
    if (st.credUnv.length === 0 && st.refunded > surplus) add({ area: "refunds", code: "refund_exceeds_credit", ids: id, field: "refund vs customer credit", source: `refunded ${P(st.refunded)}, credit available ${P(surplus)}`, target: "", diff: st.refunded - surplus, unit: "p", severity: "WARN", reason: "SliQ refunds more than the receipts and credits above the invoice total: money paid back that was never over-paid. The balance counts the refund, so this invoice shows as owing more." });
  }
  const lines = src.linesByDoc.get(i.key) ?? [];
  if (lines.length === 0) return;
  const nets = lines.map((l) => l.net ?? (l.quantity !== null && l.unitPrice !== null && (l.quantity * l.unitPrice) % 1000 === 0 ? (l.quantity * l.unitPrice) / 1000 : null));
  if (nets.every((n) => n !== null) && i.net !== null && sum(nets) !== i.net) {
    add({ area: "receivables", code: "source_lines_vs_header_net", ids: id, field: "lines net vs header net", source: P(sum(nets)), target: P(i.net), diff: i.net - sum(nets), severity: "WARN", reason: "The SliQ lines do not add up to the SliQ header net (a discount or carriage, or an error). Nothing is adjusted here." });
  }
  if (lines.every((l) => l.vatAmount !== null) && i.vat !== null && sum(lines.map((l) => l.vatAmount)) !== i.vat) {
    add({ area: "receivables", code: "source_lines_vs_header_vat", ids: id, field: "lines VAT vs header VAT", source: P(sum(lines.map((l) => l.vatAmount))), target: P(i.vat), diff: i.vat - sum(lines.map((l) => l.vatAmount)), severity: "WARN", reason: "The VAT on the SliQ lines does not add up to the SliQ header VAT." });
  }
}

function vatChecks(ctx, i, t) {
  const { add, src, tgt } = ctx;
  const id = { invoice: i.ref };
  if (i.rc) add({ area: "receivables", code: "reverse_charge", ids: id, field: "VAT treatment", source: "reverse charge (code or wording)", target: tgt.g("invoices", t, "vat_enabled") === false ? "VAT off" : "VAT on", severity: "UNVERIFIED", reason: "Tolra has no reverse-charge VAT treatment. Whether and how this document is carried over is for the accountant to confirm." });
  const venabled = tgt.g("invoices", t, "vat_enabled");
  if (venabled === false && i.vat !== null && i.vat > 0) add({ area: "receivables", code: "vat_switched_off", ids: id, field: "VAT treatment", source: `VAT ${P(i.vat)}`, target: "VAT off", severity: "BLOCKER", reason: "SliQ charged VAT on this invoice but Tolra has VAT switched off for it." });
  if (!src.supplied.invoiceLines || !tgt.has("invoice_line_items")) return;
  const sl = src.linesByDoc.get(i.key) ?? [];
  const tl = [...(tgt.linesByInvoice.get(t.id) ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || (a._i - b._i));
  if (sl.length === 0 && tl.length === 0) return;
  if (sl.length !== tl.length) {
    add({ area: "receivables", code: "line_count", ids: id, field: "number of lines", source: String(sl.length), target: String(tl.length), diff: null, severity: "WARN", reason: sl.length === 0 ? "Tolra has lines that SliQ does not list." : tl.length === 0 ? "SliQ lists lines that Tolra does not hold (the header total may still agree)." : "The two sides list a different number of lines; lines are not compared one by one." });
    return;
  }
  sl.forEach((l, n) => {
    const tr = tl[n];
    const lid = { invoice: i.ref, line: n + 1 };
    cmpVal(ctx, { area: "receivables", code: "line_description", ids: lid, field: "line description", s: l.description === null ? null : safeText(l.description.trim()), t: typeof tgt.g("invoice_line_items", tr, "description") === "string" ? safeText(tgt.g("invoice_line_items", tr, "description").trim()) : tgt.g("invoice_line_items", tr, "description"), sev: "WARN", why: "The line text differs." });
    cmpVal(ctx, { area: "receivables", code: "line_quantity", ids: lid, field: "line quantity", s: l.quantity, t: tgt.g("invoice_line_items", tr, "quantity"), unit: "q", sev: "WARN", why: "The line quantity differs." });
    cmpVal(ctx, { area: "receivables", code: "line_unit_price", ids: lid, field: "line unit price", s: l.unitPrice, t: tgt.g("invoice_line_items", tr, "unit_price"), unit: "p", sev: "WARN", why: "The line unit price differs." });
    const exempt = tgt.g("invoice_line_items", tr, "vat_exempt");
    const pct = tgt.g("invoice_line_items", tr, "vat_pct");
    const tRate = pct === undefined ? undefined : exempt === true ? 0 : pct;
    let sRate = l.vatRate;
    if (sRate === null && l.vatAmount !== null) {
      const net = l.net ?? (l.quantity !== null && l.unitPrice !== null && (l.quantity * l.unitPrice) % 1000 === 0 ? (l.quantity * l.unitPrice) / 1000 : null);
      if (net && net > 0 && (l.vatAmount * 10000) % net === 0) sRate = (l.vatAmount * 10000) / net;
      else if (net === 0 && l.vatAmount === 0) sRate = 0;
    }
    const fmt = (r) => (r === undefined || r === null ? r : r % 100 === 0 ? String(r / 100) : (r / 100).toFixed(2));
    const sTxt = fmt(sRate);
    const tTxt = fmt(tRate);
    cmpVal(ctx, { area: "receivables", code: "line_vat_rate", ids: lid, field: "line VAT rate %", s: sTxt, t: tTxt, sev: "BLOCKER", why: "The VAT rate on the line differs (this is the VAT treatment, not a rounding)." });
  });
}

/** Payment rows of one invoice, source against Tolra. Returns nothing; adds rows. */
function paymentRows(ctx, i, t) {
  const { add, src, tgt, org } = ctx;
  if (!tgt.has("invoice_payments") || !src.supplied.payments) return;
  const id = { invoice: i.ref };
  const srcPays = [...(i.state.payments ?? [])];
  const tgtPays = [...(tgt.paymentsByInvoice.get(t.id) ?? [])];
  if (i.state.payUnv.length > 0) return; // the source itself is unsure: reported once in "historical"
  const used = new Set();
  const matchedSrc = new Set();
  const canMap = !!(org && tgt.has("legacy_import_map"));
  const byTid = tgt.paymentById;
  // 1. the legacy id of each receipt (the import's own route)
  if (canMap) {
    for (const p of srcPays) {
      const newId = tgt.map.get(`sliq_payments|${legacyId(org, "payments", paymentIdentity(i.key, p.date, p.amount, p.ordinal))}`);
      const tp = newId ? byTid.get(newId) : null;
      if (!tp) continue;
      if (tp.invoice_id !== t.id) {
        add({ area: "payments", code: "payment_on_other_invoice", ids: { ...id, payment: p.ordinal + 1 }, field: "invoice", source: i.ref, target: "a different Tolra invoice", severity: "BLOCKER", reason: "The legacy id of this receipt leads to a payment that Tolra holds against a different invoice." });
        matchedSrc.add(p);
        continue;
      }
      used.add(tp.id);
      matchedSrc.add(p);
      cmpVal(ctx, { area: "payments", code: "payment_amount", ids: { ...id, payment: p.ordinal + 1 }, field: "payment amount", s: p.amount, t: tp.amount, unit: "p", why: "Same receipt (by legacy id), different amount." });
      if (p.date && tp.paid_on) cmpVal(ctx, { area: "payments", code: "payment_date", ids: { ...id, payment: p.ordinal + 1 }, field: "payment date", s: p.date, t: tp.paid_on, sev: "WARN", why: "Same receipt (by legacy id), different date." });
    }
  }
  // 2. the rest by amount, then date (same date first, then a side with no date)
  const left = srcPays.filter((p) => !matchedSrc.has(p)).sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.amount - b.amount || a.ordinal - b.ordinal);
  for (const p of left) {
    const cands = tgtPays.filter((tp) => !used.has(tp.id) && tp.amount === p.amount);
    const exact = cands.find((tp) => p.date && tp.paid_on === p.date);
    const tp = exact ?? cands.find((c) => !p.date || !c.paid_on) ?? null;
    const pid = { ...id, payment: p.ordinal + 1 };
    if (!tp) {
      const sameAmount = cands[0];
      if (sameAmount) {
        used.add(sameAmount.id);
        add({ area: "payments", code: "payment_date", ids: pid, field: "payment date", source: p.date ?? "(none)", target: sameAmount.paid_on ?? "(none)", severity: "WARN", reason: "A Tolra payment has this amount but a different date." });
      } else {
        add({ area: "payments", code: p.amount < 0 ? "reversal_missing_in_tolra" : "payment_missing_in_tolra", ids: pid, field: p.amount < 0 ? "reversal" : "payment", source: `${P(p.amount)}${p.date ? ` on ${p.date}` : ""}`, target: NONE, diff: -p.amount, unit: "p", severity: "BLOCKER", reason: p.amount < 0 ? "SliQ records a reversal (negative receipt) that Tolra does not hold against this invoice." : "SliQ records a receipt that Tolra does not hold against this invoice." });
      }
      continue;
    }
    used.add(tp.id);
    if (!p.date || !tp.paid_on) {
      add({ area: "historical", code: "payment_date_unknown", ids: pid, field: "payment date", source: p.date ?? "(no date in SliQ)", target: tp.paid_on ?? "(no date in Tolra)", severity: "UNVERIFIED", reason: `The amount ${P(p.amount)} agrees but a date is missing on ${!p.date && !tp.paid_on ? "both sides" : !p.date ? "the SliQ side" : "the Tolra side"}; it is not guessed.` });
    }
  }
  for (const tp of tgtPays) {
    if (used.has(tp.id)) continue;
    add({ area: "payments", code: tp.amount < 0 ? "reversal_only_in_tolra" : "payment_only_in_tolra", ids: { ...id, "tolra payment": `${tp.amount < 0 ? "reversal" : "payment"} ${P(tp.amount)}${tp.paid_on ? ` on ${tp.paid_on}` : ""}` }, field: tp.amount < 0 ? "reversal" : "payment", source: NONE, target: `${P(tp.amount)}${tp.paid_on ? ` on ${tp.paid_on}` : ""}`, diff: tp.amount, unit: "p", severity: "BLOCKER", reason: "Tolra holds a payment (or reversal) against this invoice that SliQ does not list." });
  }
}

export function receivables(ctx) {
  const { add, s, tgt } = ctx;
  if (!tgt.has("invoices")) {
    add({ area: "receivables", code: "invoices_not_supplied", ids: { table: "invoices" }, field: "invoice list", source: `${s.invoices.length} in SliQ`, target: NOT_SUPPLIED, severity: "UNVERIFIED", reason: "The Tolra snapshot has no invoices table: no invoice, balance or payment can be verified." });
    return;
  }
  for (const i of s.invoices) sourceIntegrity(ctx, i);
  const usable = s.invoices.filter((i) => !s.dup.invoices.has(i.key));
  const spec = { area: "receivables", label: "invoice", sources: usable, targets: tgt.rows("invoices"), refOf: (t) => tgt.g("invoices", t, "invoice_ref"), mapSource: "invoices", hashKind: "invoices", openOfTarget: (t) => lifecycle(t.status) === "collectible" };
  const m = matchDocuments(ctx, spec);
  ctx.invoiceMatch = m;
  for (const x of m.missingSource) {
    if (x.skip) continue;
    const open = isOpenSource(x);
    add({ area: "receivables", code: "invoice_missing_in_tolra", ids: { invoice: x.ref }, field: "existence", source: `${safeWord(x.status)}${x.state.balance !== null ? `, outstanding ${P(Math.max(0, x.state.balance))}` : ""}`, target: NONE, diff: x.state.balance !== null && open ? -x.state.balance : null, unit: "p", severity: open ? "BLOCKER" : "WARN", reason: `This SliQ invoice is not in Tolra (${x.reason}).${open ? " It is open (or its balance is unknown), so money owed would be lost." : " It is settled, void or a draft, so only history is missing."}` });
  }
  reportExtraTargets(ctx, spec, m.extraTarget);

  for (const { s: i, t } of m.pairs) {
    const id = { invoice: i.ref };
    const sc = s.customerOf(i.customer);
    const pp = partyPair(ctx, sc, i.customer, tgt.g("invoices", t, "customer"));
    cmpVal(ctx, { area: "receivables", code: "invoice_customer", ids: id, field: "customer", s: pp.s, t: pp.t, sev: isOpenSource(i) ? "BLOCKER" : "WARN", why: "The invoice belongs to a different customer in Tolra." });
    cmpVal(ctx, { area: "receivables", code: "invoice_net", ids: id, field: "net", s: i.net, t: tgt.g("invoices", t, "subtotal"), unit: "p", why: "Net (subtotal) differs, exact pence." });
    cmpVal(ctx, { area: "receivables", code: "invoice_vat", ids: id, field: "vat", s: i.vat, t: tgt.g("invoices", t, "vat"), unit: "p", why: "VAT differs, exact pence." });
    cmpVal(ctx, { area: "receivables", code: "invoice_gross", ids: id, field: "gross", s: i.gross, t: tgt.g("invoices", t, "total"), unit: "p", why: "Gross (total) differs, exact pence." });
    cmpVal(ctx, { area: "receivables", code: "invoice_date", ids: id, field: "invoice date", s: i.date, t: tgt.g("invoices", t, "invoice_date"), sev: "WARN", why: "Invoice date differs." });
    if (i.dueDate !== null) cmpVal(ctx, { area: "receivables", code: "invoice_due_date", ids: id, field: "due date", s: i.dueDate, t: tgt.g("invoices", t, "due_date"), sev: "WARN", why: "Due date differs." });
    vatChecks(ctx, i, t);

    // status
    const tStatus = tgt.g("invoices", t, "status");
    const tLife = lifecycle(t.status);
    const st = i.state;
    if (tgt.col("invoices", "status")) {
      if (i.status === "draft" && tLife !== "closed") add({ area: "receivables", code: "status_draft_issued", ids: id, field: "status", source: "draft", target: safeWord(statusOf(tStatus)), severity: "BLOCKER", reason: "A draft in SliQ is an issued, collectible invoice in Tolra." });
      else if (i.status === "void" && !VOID_FAMILY.has(statusOf(tStatus))) add({ area: "receivables", code: "status_void", ids: id, field: "status", source: "void or cancelled", target: safeWord(statusOf(tStatus)), severity: tLife === "closed" ? "WARN" : "BLOCKER", reason: "A void or cancelled invoice in SliQ is not void in Tolra." });
    }

    if (!st.issued) {
      if ((st.payments ?? []).length) add({ area: "payments", code: "payments_on_unissued", ids: id, field: "payments", source: `${st.payments.length} receipt(s) on a ${safeWord(i.status)} invoice`, target: "", severity: "WARN", reason: "SliQ records receipts against a draft or void invoice." });
      continue;
    }
    sourceStateRows(ctx, i, t, tLife);
    paymentRows(ctx, i, t);
  }
  targetIntegrity(ctx);
}

function sourceStateRows(ctx, i, t, tLife) {
  const { add, tgt, src } = ctx;
  const st = i.state;
  const id = { invoice: i.ref };
  const flagged = tgt.g("invoices", t, "payment_unverified") === true;
  const tStatus = safeWord(statusOf(tgt.g("invoices", t, "status")));
  if (flagged) {
    add({ area: "historical", code: "tolra_payment_unverified", ids: id, field: "payment state", source: st.balance === null ? UNKNOWN_TXT : `outstanding ${P(st.balance)}`, target: "flagged: payment to confirm", severity: "UNVERIFIED", reason: "Tolra flags this invoice as 'payment to confirm' (imported with no payment evidence): it is neither owed nor paid until a person decides. Not compared." });
  }
  if (st.unverified.length) {
    add({ area: "historical", code: "source_payment_state_unverified", ids: id, field: "payment state", source: st.unverified.join("; "), target: tgt.col("invoices", "amount_paid") ? `paid ${P(t.amount_paid ?? 0)}` : NOT_SUPPLIED, severity: "UNVERIFIED", reason: "SliQ does not settle what was paid on this invoice, so no payment, credit or balance figure is compared for it. A person must confirm the real position." });
  }
  const tPaid = tgt.g("invoices", t, "amount_paid");
  const tCred = tgt.g("invoices", t, "credited_amount");
  const tRef = tgt.g("invoices", t, "refunded_amount");
  const paidKnown = st.paid !== null && st.payUnv.length === 0;
  // A component whose SliQ file was not supplied is only treated as agreeing when Tolra also shows none; otherwise it is UNVERIFIED.
  const credKnown = st.credUnv.length === 0 && (src.supplied.allocations || tCred === 0);
  const refKnown = st.refUnv.length === 0 && (src.supplied.refunds || tRef === 0);
  if (!flagged && paidKnown) cmpVal(ctx, { area: "receivables", code: "invoice_paid", ids: id, field: "paid (receipts less reversals)", s: st.paid, t: tPaid, unit: "p", why: "Receipts net of reversals differ, exact pence." });
  if (!flagged) {
    if (src.supplied.allocations && st.credUnv.length === 0) cmpVal(ctx, { area: "credits", code: "invoice_credited", ids: id, field: "credits allocated", s: st.credited, t: tCred, unit: "p", why: "Credit notes applied to this invoice differ, exact pence." });
    else if (!credKnown && typeof tCred === "number" && tCred > 0) add({ area: "credits", code: "credited_unverified", ids: id, field: "credits allocated", source: src.supplied.allocations ? UNKNOWN_TXT : NOT_SUPPLIED, target: P(tCred), severity: "UNVERIFIED", reason: "Tolra shows credit applied to this invoice but SliQ cannot confirm it (no allocations file, or its rows are unclear)." });
    if (src.supplied.refunds && st.refUnv.length === 0) cmpVal(ctx, { area: "refunds", code: "invoice_refunded", ids: id, field: "refunded", s: st.refunded, t: tRef, unit: "p", why: "Refunds on this invoice differ, exact pence." });
    else if (!refKnown && typeof tRef === "number" && tRef > 0) add({ area: "refunds", code: "refunded_unverified", ids: id, field: "refunded", source: NOT_SUPPLIED, target: P(tRef), severity: "UNVERIFIED", reason: "Tolra shows a refund on this invoice but the SliQ export has no refunds file to confirm it." });
  }
  const numeric = typeof tPaid === "number" && typeof tCred === "number" && typeof tRef === "number";
  const balanceKnown = !flagged && st.balance !== null && credKnown && refKnown && numeric;
  if (balanceKnown) {
    const tBal = (t.total ?? 0) - tPaid - tCred + tRef;
    cmpVal(ctx, { area: "receivables", code: "invoice_outstanding", ids: id, field: "outstanding (gross - paid - credits + refunds)", s: st.balance, t: tBal, unit: "p", why: "The amount still owed differs, exact pence." });
    if (st.balance < 0) add({ area: "receivables", code: "customer_credit", ids: id, field: "customer credit", source: P(-st.balance), target: P(Math.max(0, -tBal)), severity: "INFO", reason: "Receipts and credits exceed the invoice: the surplus is customer credit, not a negative debt. Tolra keeps it until refunded or applied." });
    if (tgt.col("invoices", "status")) {
      if (st.balance > 0 && tLife !== "collectible") add({ area: "receivables", code: "status_settled_but_owed", ids: id, field: "status", source: `owed ${P(st.balance)}`, target: tStatus, severity: "BLOCKER", reason: "SliQ says money is still owed; the Tolra status (paid, credited, draft or void) means it will not be collected." });
      if (st.balance <= 0 && tLife === "collectible") add({ area: "receivables", code: "status_owed_but_settled", ids: id, field: "status", source: "settled", target: tStatus, severity: "BLOCKER", reason: "SliQ says nothing is owed; Tolra still treats the invoice as collectible." });
      if (st.balance > 0 && st.paid > 0 && st.credited === 0 && st.refunded === 0 && tLife === "collectible" && tStatus !== "partial") {
        add({ area: "receivables", code: "status_not_partial", ids: id, field: "status", source: "part paid", target: tStatus, severity: "WARN", reason: "The invoice is part paid but Tolra's status does not say partial." });
      }
    }
  } else if (st.issued && tgt.col("invoices", "status") && tLife === "closed" && tStatus !== "credited" && !flagged) {
    add({ area: "receivables", code: "status_issued_closed", ids: id, field: "status", source: "issued", target: tStatus, severity: "BLOCKER", reason: "An issued invoice in SliQ is a draft, void or cancelled invoice in Tolra." });
  }
}
const UNKNOWN_TXT = "(unknown)";

/** Tolra's own books must agree with themselves, or comparing them against SliQ proves nothing. */
export function targetIntegrity(ctx) {
  const { add, tgt } = ctx;
  for (const t of tgt.rows("invoices")) {
    const ref = tgt.g("invoices", t, "invoice_ref") ?? `#${t.id}`;
    const id = { invoice: ref };
    const sub = tgt.g("invoices", t, "subtotal");
    const vat = tgt.g("invoices", t, "vat");
    if (typeof sub === "number" && typeof vat === "number" && t.total !== null && sub + vat !== t.total) {
      add({ area: "target-integrity", code: "tolra_header_arithmetic", ids: id, field: "subtotal + vat = total", source: "", target: `${P(sub)} + ${P(vat)} vs ${P(t.total)}`, diff: t.total - (sub + vat), unit: "p", severity: "BLOCKER", reason: "The Tolra invoice does not add up by itself." });
    }
    if (tgt.has("invoice_payments") && tgt.col("invoices", "amount_paid") && tgt.g("invoices", t, "payment_unverified") !== true) {
      const rows = tgt.paymentsByInvoice.get(t.id) ?? [];
      const total = sum(rows.map((p) => p.amount));
      if (total !== (t.amount_paid ?? 0)) add({ area: "target-integrity", code: "tolra_paid_vs_rows", ids: id, field: "amount_paid vs payment rows", source: "", target: `${P(t.amount_paid ?? 0)} vs rows ${P(total)}`, diff: total - (t.amount_paid ?? 0), unit: "p", severity: "BLOCKER", reason: "In Tolra, the invoice's amount_paid is not the sum of its payment rows (a reversal counts as negative)." });
    }
    if (tgt.has("invoice_credit_allocations") && tgt.col("invoices", "credited_amount")) {
      const allocs = sum((tgt.allocationsByInvoice.get(t.id) ?? []).map((a) => a.amount));
      const transfers = tgt.has("customer_credit_ledger") ? sum((tgt.ledgerToInvoice.get(t.id) ?? []).filter((l) => l.kind === "transfer").map((l) => l.amount)) : 0;
      if (allocs + transfers !== (t.credited_amount ?? 0)) add({ area: "target-integrity", code: "tolra_credited_vs_rows", ids: id, field: "credited_amount vs allocations", source: "", target: `${P(t.credited_amount ?? 0)} vs rows ${P(allocs + transfers)}`, diff: allocs + transfers - (t.credited_amount ?? 0), unit: "p", severity: "BLOCKER", reason: "In Tolra, the invoice's credited_amount is not the sum of its credit allocations and credit transfers in." });
    }
    if (tgt.has("customer_credit_ledger") && tgt.col("invoices", "refunded_amount")) {
      const out = sum((tgt.ledgerByInvoice.get(t.id) ?? []).map((l) => l.amount));
      if (out !== (t.refunded_amount ?? 0)) add({ area: "target-integrity", code: "tolra_refunded_vs_ledger", ids: id, field: "refunded_amount vs ledger", source: "", target: `${P(t.refunded_amount ?? 0)} vs ledger ${P(out)}`, diff: out - (t.refunded_amount ?? 0), unit: "p", severity: "BLOCKER", reason: "In Tolra, the invoice's refunded_amount is not the sum of its customer-credit ledger rows (refunds and transfers out)." });
    }
  }
  if (tgt.has("invoice_payments")) {
    const byId = new Map(tgt.rows("invoice_payments").map((p) => [p.id, p]));
    for (const p of tgt.rows("invoice_payments")) {
      const rid = tgt.g("invoice_payments", p, "reverses_payment_id");
      if (rid === undefined || rid === null) {
        if (p.amount < 0) add({ area: "target-integrity", code: "tolra_reversal_unlinked", ids: { "tolra payment": p.id }, field: "reversal", source: "", target: P(p.amount), severity: "BLOCKER", reason: "A negative Tolra payment does not say which payment it reverses." });
        continue;
      }
      const orig = byId.get(rid);
      if (!orig || orig.invoice_id !== p.invoice_id || orig.amount !== -p.amount) add({ area: "target-integrity", code: "tolra_reversal_mismatch", ids: { "tolra payment": p.id }, field: "reversal", source: "", target: `${P(p.amount)} reverses ${orig ? P(orig.amount) : "(missing payment)"}`, severity: "BLOCKER", reason: "A Tolra reversal is not the exact negative of an existing payment on the same invoice." });
    }
  }
  if (tgt.has("credit_notes") && tgt.has("invoice_credit_allocations") && tgt.col("credit_notes", "allocated_amount")) {
    for (const c of tgt.rows("credit_notes")) {
      const tot = sum((tgt.allocationsByCredit.get(c.id) ?? []).map((a) => a.amount));
      if (tot !== (c.allocated_amount ?? 0)) add({ area: "target-integrity", code: "tolra_credit_allocated_vs_rows", ids: { "credit note": tgt.g("credit_notes", c, "credit_ref") ?? `#${c.id}` }, field: "allocated_amount vs allocations", source: "", target: `${P(c.allocated_amount ?? 0)} vs rows ${P(tot)}`, diff: tot - (c.allocated_amount ?? 0), unit: "p", severity: "BLOCKER", reason: "In Tolra, a credit note's allocated_amount is not the sum of its allocation rows." });
      if (tot > c.total) add({ area: "target-integrity", code: "tolra_credit_over_allocated", ids: { "credit note": tgt.g("credit_notes", c, "credit_ref") ?? `#${c.id}` }, field: "allocations vs total", source: "", target: `${P(tot)} allocated of ${P(c.total)}`, diff: tot - c.total, unit: "p", severity: "BLOCKER", reason: "In Tolra, more of a credit note is allocated than it is worth." });
    }
  }
}

export { isOpenSource };
