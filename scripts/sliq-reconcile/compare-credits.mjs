// Credit notes and allocations, refund rows, opening balances (customer receivables and supplier payables, account level and
// document level), supplier bills, and the receivables control totals.
import { normNumber, normaliseName } from "../sliq-import/ids.mjs";

import { matchDocuments, reportExtraTargets } from "./match.mjs";
import { NONE, NOT_SUPPLIED, P } from "./rows.mjs";
import { lifecycle } from "./target.mjs";
import { safeRef } from "./safe.mjs";
import { cmpVal, nameRef, sum } from "./util.mjs";

import { partyPair } from "./compare-money.mjs";

export function credits(ctx) {
  const { add, src, s, tgt } = ctx;
  const usable = s.credits.filter((c) => !s.dup.credits.has(c.key));
  // Signs. Tolra holds a credit note as positive amounts (CHECK >= 0). A sign is never absorbed silently: a credit whose own figures
  // disagree in sign is a BLOCKER, a credit-notes file that holds negatives is a WARN, an invoice-file credit stored as a negative
  // invoice is an INFO (magnitude is then what is compared), and a negative amount in Tolra is a BLOCKER.
  const signs = new Map();
  for (const c of s.credits) {
    const present = [c.net, c.vat, c.gross].filter((v) => v !== null && v !== 0);
    const neg = present.filter((v) => v < 0).length;
    const pos = present.length - neg;
    const id = { "credit note": c.ref };
    const shown = `net ${P(c.net)}, VAT ${P(c.vat)}, gross ${P(c.gross)}`;
    if (neg > 0 && pos > 0) {
      add({ area: "credits", code: "credit_sign_inconsistent", ids: id, field: "sign of net, VAT and gross", source: shown, target: "", severity: "BLOCKER", reason: "The SliQ credit note's own figures disagree in sign (a sign error): it is not compared as if it were a clean credit." });
      signs.set(c.key, "bad");
    } else if (neg > 0) {
      signs.set(c.key, "negative");
      if (c.origin === "credit-notes file") add({ area: "credits", code: "credit_sign_unexpected", ids: id, field: "sign of the credit note", source: shown, target: "", severity: "WARN", reason: "The SliQ credit-notes file holds negative amounts; Tolra holds a credit note as positive amounts. The magnitude is compared; the sign is for a person to confirm." });
      else add({ area: "credits", code: "credit_sign_convention", ids: id, field: "sign of the credit note", source: shown, target: "(Tolra holds credits as positive)", severity: "INFO", reason: "SliQ holds this credit as a negative invoice; Tolra holds it as positive amounts. The magnitude is compared." });
    } else signs.set(c.key, "positive");
  }
  // Over-allocation inside SliQ itself.
  for (const c of s.credits) {
    if (c.absGross !== null && c.allocated > c.absGross) add({ area: "credits", code: "source_credit_over_allocated", ids: { "credit note": c.ref }, field: "allocated vs credit note total", source: `${P(c.allocated)} of ${P(c.absGross)}`, target: "", diff: c.allocated - c.absGross, unit: "p", severity: "BLOCKER", reason: "SliQ allocates more of this credit note than it is worth." });
  }
  if (!tgt.has("credit_notes")) {
    if (s.credits.length) add({ area: "credits", code: "credit_notes_not_supplied", ids: { table: "credit_notes" }, field: "credit notes", source: `${s.credits.length} in SliQ`, target: NOT_SUPPLIED, severity: "UNVERIFIED", reason: "The Tolra snapshot has no credit_notes table: no SliQ credit note can be verified." });
    return;
  }
  const spec = { area: "credits", label: "credit note", sources: usable, targets: tgt.rows("credit_notes"), refOf: (t) => tgt.g("credit_notes", t, "credit_ref"), mapSource: null, hashKind: null };
  const m = matchDocuments(ctx, spec);
  for (const x of m.missingSource) {
    if (x.skip) continue;
    const residual = x.absGross === null ? null : x.absGross - x.allocated;
    add({ area: "credits", code: "credit_note_missing_in_tolra", ids: { "credit note": x.ref }, field: "existence", source: `${P(x.absGross)} (allocated ${P(x.allocated)})`, target: NONE, diff: residual === null ? null : -residual, unit: "p", severity: residual === null || residual > 0 ? "BLOCKER" : "WARN", reason: residual === null ? "The credit note has no readable total, so what the customer is owed cannot be known." : residual > 0 ? `This SliQ credit note has ${P(residual)} not yet applied to any invoice, and Tolra does not hold it: the customer's credit would be lost.` : "This credit note is fully applied to invoices in SliQ; only the document is missing in Tolra (the invoice balances are compared separately)." });
  }
  reportExtraTargets(ctx, { ...spec, area: "credits" }, m.extraTarget);
  const invRefById = new Map(tgt.rows("invoices").map((r) => [r.id, tgt.g("invoices", r, "invoice_ref")]));
  for (const { s: c, t } of m.pairs) {
    const id = { "credit note": c.ref };
    for (const col of ["subtotal", "vat", "total"]) {
      const v = tgt.g("credit_notes", t, col);
      if (typeof v === "number" && v < 0) add({ area: "credits", code: "tolra_credit_negative", ids: id, field: `${col} (sign)`, source: "", target: P(v), severity: "BLOCKER", reason: "A credit note amount is negative in Tolra, which holds credits as positive amounts: a sign error." });
    }
    // Signed comparison: a positive SliQ credit against a negative Tolra one is a difference. Only a SliQ credit that is wholly negative
    // (reported above) is compared by magnitude.
    const flip = signs.get(c.key) === "negative" ? -1 : 1;
    const bad = signs.get(c.key) === "bad";
    if (!bad) {
      cmpVal(ctx, { area: "credits", code: "credit_net", ids: id, field: "net", s: c.net === null ? null : c.net * flip, t: tgt.g("credit_notes", t, "subtotal"), unit: "p", why: "Credit note net differs (signed values), exact pence." });
      cmpVal(ctx, { area: "credits", code: "credit_vat", ids: id, field: "vat", s: c.vat === null ? null : c.vat * flip, t: tgt.g("credit_notes", t, "vat"), unit: "p", why: "Credit note VAT differs (signed values), exact pence." });
      cmpVal(ctx, { area: "credits", code: "credit_gross", ids: id, field: "gross", s: c.gross === null ? null : c.gross * flip, t: t.total, unit: "p", why: "Credit note total differs (signed values), exact pence." });
    }
    const pp = partyPair(ctx, s.customerOf(c.customer), c.customer, tgt.g("credit_notes", t, "customer"));
    cmpVal(ctx, { area: "credits", code: "credit_customer", ids: id, field: "customer", s: pp.s, t: pp.t, sev: "BLOCKER", why: "The credit note belongs to a different customer in Tolra." });
    if (tgt.col("credit_notes", "invoice_id")) {
      const tInv = t.invoice_id === null ? null : invRefById.get(t.invoice_id) ?? null;
      const sInv = c.relatedInvoice ? String(c.relatedInvoice).trim() : null;
      if (sInv === null) {
        add({ area: "credits", code: "credit_link_not_in_source", ids: id, field: "against invoice", source: "(none)", target: tInv ?? "(none)", severity: "WARN", reason: "Tolra links this credit note to an invoice; SliQ does not say which one. The link cannot be confirmed." });
      } else cmpVal(ctx, { area: "credits", code: "credit_invoice_link", ids: id, field: "against invoice", s: sInv, t: tInv, sev: "BLOCKER", why: "The credit note is linked to a different invoice in Tolra." });
    }
    if (tgt.col("credit_notes", "status") && t.status === "draft") add({ area: "credits", code: "credit_note_draft", ids: id, field: "status", source: "issued", target: "draft", severity: "WARN", reason: "The credit note is only a draft in Tolra." });
  }

  // Allocations: (credit note, invoice) pairs, summed.
  if (!tgt.has("invoice_credit_allocations")) {
    if (src.allocations.length) add({ area: "credits", code: "allocations_not_supplied", ids: { table: "invoice_credit_allocations" }, field: "allocations", source: `${src.allocations.length} in SliQ`, target: NOT_SUPPLIED, severity: "UNVERIFIED", reason: "The Tolra snapshot has no invoice_credit_allocations table: no allocated credit can be verified row by row." });
    return;
  }
  if (!src.supplied.allocations) {
    if (tgt.rows("invoice_credit_allocations").length) add({ area: "credits", code: "allocations_not_in_source", ids: { file: "allocations" }, field: "allocations", source: NOT_SUPPLIED, target: `${tgt.rows("invoice_credit_allocations").length} rows`, severity: "UNVERIFIED", reason: "Tolra holds credit allocations but the SliQ export has no allocations file to compare them with." });
    return;
  }
  for (const a of src.allocations) {
    if (a.amount <= 0) add({ area: "credits", code: "source_allocation_not_positive", ids: { allocation: `${safeRef(a.creditNoteNumber)}>${safeRef(a.invoiceNumber)}` }, field: "allocation amount", source: P(a.amount), target: "", severity: "BLOCKER", reason: "A SliQ credit allocation is zero or negative: a credit is applied as a positive amount, so this is a sign error (or a reversal that Tolra cannot hold)." });
  }
  const creditRef = new Map(tgt.rows("credit_notes").map((c) => [c.id, normNumber(tgt.g("credit_notes", c, "credit_ref") ?? "")]));
  const srcSum = new Map();
  for (const a of src.allocations) {
    if (!a.ok) continue;
    const k = `${normNumber(a.creditNoteNumber)}\u0000${normNumber(a.invoiceNumber)}`;
    srcSum.set(k, (srcSum.get(k) ?? 0) + a.amount);
  }
  const tgtSum = new Map();
  for (const a of tgt.rows("invoice_credit_allocations")) {
    const k = `${creditRef.get(a.credit_note_id) ?? "?"}\u0000${normNumber(invRefById.get(a.invoice_id) ?? "?")}`;
    tgtSum.set(k, (tgtSum.get(k) ?? 0) + a.amount);
  }
  for (const k of [...new Set([...srcSum.keys(), ...tgtSum.keys()])].sort()) {
    const id = { allocation: k.split("\u0000").map((x) => safeRef(x)).join(">") };
    if (!tgtSum.has(k)) add({ area: "credits", code: "allocation_missing_in_tolra", ids: id, field: "allocation", source: P(srcSum.get(k)), target: NONE, diff: -srcSum.get(k), unit: "p", severity: "BLOCKER", reason: "SliQ applies this credit note to this invoice; Tolra does not." });
    else if (!srcSum.has(k)) add({ area: "credits", code: "allocation_only_in_tolra", ids: id, field: "allocation", source: NONE, target: P(tgtSum.get(k)), diff: tgtSum.get(k), unit: "p", severity: "BLOCKER", reason: "Tolra applies this credit note to this invoice; SliQ does not." });
    else cmpVal(ctx, { area: "credits", code: "allocation_amount", ids: id, field: "allocation", s: srcSum.get(k), t: tgtSum.get(k), unit: "p", why: "The amount of credit applied differs, exact pence." });
  }
}

export function refundRows(ctx) {
  const { add, src, s, tgt } = ctx;
  if (!tgt.has("customer_credit_ledger")) {
    if (src.refunds.length) add({ area: "refunds", code: "ledger_not_supplied", ids: { table: "customer_credit_ledger" }, field: "refunds", source: `${src.refunds.length} in SliQ`, target: NOT_SUPPLIED, severity: "UNVERIFIED", reason: "The Tolra snapshot has no customer_credit_ledger table: refunds cannot be checked row by row." });
    return;
  }
  if (!src.supplied.refunds) {
    if (tgt.rows("customer_credit_ledger").length) add({ area: "refunds", code: "ledger_not_in_source", ids: { file: "refunds" }, field: "refunds", source: NOT_SUPPLIED, target: `${tgt.rows("customer_credit_ledger").length} ledger rows`, severity: "UNVERIFIED", reason: "Tolra holds customer-credit ledger rows but the SliQ export has no refunds file to compare them with." });
    return;
  }
  for (const r of src.refunds) {
    if (r.amount <= 0) add({ area: "refunds", code: "source_refund_not_positive", ids: { refund: safeRef(r.invoiceNumber) }, field: "refund amount", source: P(r.amount), target: "", severity: "BLOCKER", reason: "A SliQ refund is zero or negative: a refund is a positive amount paid out, so this is a sign error." });
  }
  for (const { s: i, t } of ctx.invoiceMatch?.pairs ?? []) {
    const id = { invoice: i.ref };
    const sRef = [...(s.refundByInv.get(i.key) ?? [])].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.amount - b.amount);
    const ledger = tgt.ledgerByInvoice.get(t.id) ?? [];
    const tRef = ledger.filter((l) => l.kind === "refund");
    for (const l of ledger.filter((x) => x.kind === "transfer")) add({ area: "refunds", code: "transfer_only_in_tolra", ids: id, field: "credit transferred to another invoice", source: NONE, target: P(l.amount), diff: l.amount, unit: "p", severity: "WARN", reason: "Tolra moved customer credit from this invoice to another; SliQ records no such transfer." });
    const used = new Set();
    for (const r of sRef) {
      const cands = tRef.filter((l) => !used.has(l.id ?? l._i) && l.amount === r.amount);
      const hit = cands.find((l) => r.date && l.paid_on === r.date) ?? cands[0];
      if (!hit) {
        add({ area: "refunds", code: "refund_missing_in_tolra", ids: id, field: "refund", source: `${P(r.amount)}${r.date ? ` on ${r.date}` : ""}`, target: NONE, diff: -r.amount, unit: "p", severity: "BLOCKER", reason: "SliQ records a refund of this amount that Tolra does not hold against this invoice." });
        continue;
      }
      used.add(hit.id ?? hit._i);
      if (r.date && hit.paid_on && r.date !== hit.paid_on) add({ area: "refunds", code: "refund_date", ids: id, field: "refund date", source: r.date, target: hit.paid_on, severity: "WARN", reason: "The refund amount agrees but the date differs." });
      if (!r.date || !hit.paid_on) add({ area: "historical", code: "refund_date_unknown", ids: id, field: "refund date", source: r.date ?? "(no date in SliQ)", target: hit.paid_on ?? "(no date in Tolra)", severity: "UNVERIFIED", reason: "The refund amount agrees but a date is missing; it is not guessed." });
    }
    for (const l of tRef) if (!used.has(l.id ?? l._i)) add({ area: "refunds", code: "refund_only_in_tolra", ids: id, field: "refund", source: NONE, target: `${P(l.amount)}${l.paid_on ? ` on ${l.paid_on}` : ""}`, diff: l.amount, unit: "p", severity: "BLOCKER", reason: "Tolra holds a refund against this invoice that SliQ does not list." });
  }
}

/** Opening balances (customer receivables, supplier payables) and supplier bills. */
export function openingAndPayables(ctx) {
  const { add, src, s, tgt } = ctx;
  const tgtOpening = tgt.has("opening_balances") ? tgt.rows("opening_balances") : null;
  const invByRef = new Map(tgt.rows("invoices").map((r) => [normNumber(tgt.g("invoices", r, "invoice_ref") ?? ""), r]));
  const tBalance = (t) => {
    const paid = tgt.g("invoices", t, "amount_paid");
    const cred = tgt.g("invoices", t, "credited_amount");
    const ref = tgt.g("invoices", t, "refunded_amount");
    if (![paid, cred, ref].every((v) => typeof v === "number")) return undefined;
    return (t.total ?? 0) - paid - cred + ref;
  };

  // Supplier bills against a snapshot that may not carry them.
  const bySupplier = new Map();
  for (const b of s.bills) {
    const sp = s.supplierOf(b.supplier);
    const code = sp ? sp.ref : b.supplier ? nameRef(b.supplier) : "(no supplier)";
    if (!bySupplier.has(code)) bySupplier.set(code, []);
    bySupplier.get(code).push(b);
  }
  if (!tgt.has("supplier_bills")) {
    for (const [code, list] of [...bySupplier.entries()].sort()) {
      const out = list.filter((b) => b.outstanding !== null);
      add({ area: "payables", code: "supplier_bills_not_supplied", ids: { supplier: code }, field: "supplier payables", source: `${list.length} bill(s), outstanding ${out.length === list.length ? P(sum(out.map((b) => b.outstanding))) : "partly unknown"}`, target: NOT_SUPPLIED, severity: "UNVERIFIED", reason: "Tolra has no supplier-payables ledger and the snapshot carries none: supplier payables cannot be verified. How they are carried over is for the accountant to confirm." });
    }
  } else {
    const usable = s.bills.filter((b) => !s.dup.bills.has(b.key));
    const spec = { area: "payables", label: "supplier bill", sources: usable, targets: tgt.rows("supplier_bills").map((r, n) => ({ ...r, id: r.id ?? `bill-${n}` })), refOf: (t) => tgt.g("supplier_bills", t, "bill_ref"), mapSource: null, hashKind: null };
    const m = matchDocuments(ctx, spec);
    for (const x of m.missingSource) if (!x.skip) add({ area: "payables", code: "supplier_bill_missing", ids: { "supplier bill": x.ref }, field: "existence", source: `outstanding ${P(x.outstanding ?? x.gross)}`, target: NONE, severity: (x.outstanding ?? x.gross ?? 1) > 0 ? "BLOCKER" : "WARN", reason: "This SliQ supplier bill is not in the Tolra snapshot." });
    reportExtraTargets(ctx, spec, m.extraTarget);
    for (const { s: b, t } of m.pairs) {
      const id = { "supplier bill": b.ref };
      cmpVal(ctx, { area: "payables", code: "supplier_bill_gross", ids: id, field: "gross", s: b.gross, t: t.total, unit: "p", why: "Supplier bill total differs, exact pence." });
      cmpVal(ctx, { area: "payables", code: "supplier_bill_outstanding", ids: id, field: "outstanding", s: b.outstanding, t: tgt.g("supplier_bills", t, "outstanding"), unit: "p", why: "Supplier bill balance differs, exact pence." });
      const sp = s.supplierOf(b.supplier);
      const tn = tgt.g("supplier_bills", t, "supplier");
      const pp = tn === undefined ? undefined : normaliseName(tn) === (sp ? sp.nn : normaliseName(b.supplier)) ? (sp ? sp.ref : nameRef(b.supplier)) : (src.suppliers.byName.get(normaliseName(tn))?.[0]?.ref ?? nameRef(tn));
      cmpVal(ctx, { area: "payables", code: "supplier_bill_supplier", ids: id, field: "supplier", s: sp ? sp.ref : nameRef(b.supplier), t: pp, sev: "BLOCKER", why: "The bill belongs to a different supplier in Tolra." });
    }
  }

  // Opening balances.
  const accountLevel = new Map();
  for (const o of src.openingBalances) {
    const sp = o.partyType === "supplier" ? s.supplierOf(o.party) : s.customerOf(o.party);
    const code = sp ? sp.ref : safeRef(o.party);
    if (!o.document) {
      const k = `${o.partyType}|${code}`;
      accountLevel.set(k, (accountLevel.get(k) ?? 0) + o.amount);
      continue;
    }
    const id = { [o.partyType]: code, document: o.document };
    if (o.partyType === "supplier") {
      if (!tgt.has("supplier_bills")) {
        add({ area: "opening", code: "opening_supplier_document_unverified", ids: id, field: "document-level opening payable", source: P(o.amount), target: NOT_SUPPLIED, severity: "UNVERIFIED", reason: "Tolra has no supplier-payables ledger and the snapshot carries none: a document-level opening payable cannot be verified." });
        continue;
      }
      const hit = tgt.rows("supplier_bills").find((r) => normNumber(tgt.g("supplier_bills", r, "bill_ref") ?? "") === normNumber(o.document));
      if (!hit) add({ area: "opening", code: "opening_document_missing", ids: id, field: "document-level opening payable", source: P(o.amount), target: NONE, diff: -o.amount, unit: "p", severity: "BLOCKER", reason: "The supplier bill carrying this opening payable is not in Tolra." });
      else cmpVal(ctx, { area: "opening", code: "opening_supplier_document", ids: id, field: "document-level opening payable", s: o.amount, t: tgt.g("supplier_bills", hit, "outstanding"), unit: "p", why: "The supplier bill's outstanding amount in Tolra differs from the opening payable." });
      continue;
    }
    const sInv = s.invByKey.get(normNumber(o.document));
    if (sInv && sInv.state.balance !== null && sInv.state.balance !== o.amount) {
      add({ area: "opening", code: "opening_vs_source_invoice", ids: id, field: "opening amount vs SliQ invoice outstanding", source: `opening ${P(o.amount)}`, target: `invoice outstanding ${P(sInv.state.balance)}`, diff: sInv.state.balance - o.amount, unit: "p", severity: "WARN", reason: "Inside SliQ, the opening balance of this document is not what the invoice shows as outstanding (receipts after the opening date, or an error)." });
    }
    if (!tgt.has("invoices")) continue;
    const hit = invByRef.get(normNumber(o.document));
    if (!hit) {
      add({ area: "opening", code: "opening_document_missing", ids: id, field: "document-level opening receivable", source: P(o.amount), target: NONE, diff: -o.amount, unit: "p", severity: "BLOCKER", reason: "The invoice carrying this opening receivable is not in Tolra." });
      continue;
    }
    if (tgt.g("invoices", hit, "payment_unverified") === true) {
      add({ area: "opening", code: "opening_payment_unverified", ids: id, field: "document-level opening receivable", source: P(o.amount), target: "flagged: payment to confirm", severity: "UNVERIFIED", reason: "Tolra flags this invoice's payment as 'to confirm', so its outstanding amount is not asserted." });
      continue;
    }
    cmpVal(ctx, { area: "opening", code: "opening_receivable_document", ids: id, field: "document-level opening receivable", s: o.amount, t: tBalance(hit), unit: "p", why: "The invoice's outstanding amount in Tolra differs from the opening receivable." });
  }
  const targetAccount = new Map();
  if (tgtOpening) {
    for (const r of tgtOpening) {
      if (tgt.g("opening_balances", r, "document_ref") !== null && tgt.g("opening_balances", r, "document_ref") !== undefined) continue;
      const k = `${safeRef(r.party_type)}|${safeRef(r.party_ref)}`;
      targetAccount.set(k, (targetAccount.get(k) ?? 0) + r.amount);
    }
  }
  for (const [k, amount] of [...accountLevel.entries()].sort()) {
    const [type, code] = k.split("|");
    const id = { [type]: code, level: "account" };
    if (!tgtOpening) add({ area: "opening", code: "opening_account_unverified", ids: id, field: `account-level opening ${type === "supplier" ? "payable" : "receivable"}`, source: P(amount), target: NOT_SUPPLIED, severity: "UNVERIFIED", reason: "Tolra has no account-level opening balance and the snapshot carries none. How a balance brought forward is carried (for example as an opening-balance invoice) is for the accountant to confirm." });
    else if (!targetAccount.has(k)) add({ area: "opening", code: "opening_account_missing", ids: id, field: "account-level opening balance", source: P(amount), target: NONE, diff: -amount, unit: "p", severity: "BLOCKER", reason: "The snapshot carries opening balances but none for this account." });
    else cmpVal(ctx, { area: "opening", code: "opening_account", ids: id, field: "account-level opening balance", s: amount, t: targetAccount.get(k), unit: "p", why: "The opening balance for this account differs, exact pence." });
  }
  if (tgtOpening && src.supplied.openingBalances) {
    for (const [k, amount] of [...targetAccount.entries()].sort()) {
      if (!accountLevel.has(k)) add({ area: "opening", code: "opening_account_only_in_tolra", ids: { [k.split("|")[0]]: k.split("|")[1], level: "account" }, field: "account-level opening balance", source: NONE, target: P(amount), diff: amount, unit: "p", severity: "BLOCKER", reason: "The snapshot carries an opening balance for an account that has none in SliQ." });
    }
  }
  if (!src.supplied.openingBalances) {
    add({ area: "opening", code: "opening_not_in_source", ids: { file: "openingBalances" }, field: "opening balances", source: NOT_SUPPLIED, target: tgtOpening ? `${tgtOpening.length} rows` : NOT_SUPPLIED, severity: "UNVERIFIED", reason: "The SliQ export has no opening-balances file: opening receivables and payables (account level and document level) cannot be verified." });
  }
  if (!src.supplied.supplierBills && !src.supplied.openingBalances) {
    add({ area: "payables", code: "payables_not_in_source", ids: { file: "supplierBills" }, field: "supplier payables", source: NOT_SUPPLIED, target: tgt.has("supplier_bills") ? `${tgt.rows("supplier_bills").length} rows` : NOT_SUPPLIED, severity: "UNVERIFIED", reason: "The SliQ export carries no supplier bills or supplier opening balances: what JNR owes suppliers cannot be verified." });
  }
}

/** Outstanding receivables per customer and overall, both sides, over the same set of invoices. */
export function receivableTotals(ctx) {
  const { add, src, s, tgt } = ctx;
  const out = { source: 0, target: 0, sourceExcluded: 0, targetExcluded: 0, sourceInvoices: 0, targetInvoices: 0 };
  ctx.totals = out;
  if (!tgt.has("invoices")) return;
  const excludedSource = new Set();
  const bySrc = new Map();
  const byTgt = new Map();
  const bump = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v);
  const pairByTarget = new Map((ctx.invoiceMatch?.pairs ?? []).map((p) => [p.t.id, p.s]));
  for (const i of s.invoices) {
    if (!i.state.issued || s.dup.invoices.has(i.key)) continue;
    if (i.state.balance === null) {
      excludedSource.add(i.key);
      out.sourceExcluded++;
      continue;
    }
    const sc = s.customerOf(i.customer);
    const code = sc ? sc.ref : i.customer ? nameRef(i.customer) : "(no customer)";
    if (i.state.balance > 0) {
      bump(bySrc, code, i.state.balance);
      out.sourceInvoices++;
    }
  }
  for (const t of tgt.rows("invoices")) {
    const partner = pairByTarget.get(t.id);
    if (lifecycle(t.status) !== "collectible") continue;
    const paid = tgt.g("invoices", t, "amount_paid");
    const cred = tgt.g("invoices", t, "credited_amount");
    const ref = tgt.g("invoices", t, "refunded_amount");
    if (tgt.g("invoices", t, "payment_unverified") === true || (partner && excludedSource.has(partner.key)) || ![paid, cred, ref].every((v) => typeof v === "number")) {
      out.targetExcluded++;
      continue;
    }
    const bal = (t.total ?? 0) - paid - cred + ref;
    if (bal <= 0) continue;
    const name = tgt.g("invoices", t, "customer");
    const nn = name ? normaliseName(name) : null;
    const code = nn === null ? "(no customer)" : src.customers.byName.get(nn)?.[0]?.ref ?? nameRef(name);
    bump(byTgt, code, bal);
    out.targetInvoices++;
  }
  // Account-level opening receivables sit beside the invoices on both sides (only when the snapshot carries them).
  if (tgt.has("opening_balances") && src.supplied.openingBalances) {
    for (const o of src.openingBalances) if (o.partyType === "customer" && !o.document) bump(bySrc, (s.customerOf(o.party)?.ref) ?? String(o.party), o.amount);
    for (const r of tgt.rows("opening_balances")) if (r.party_type === "customer" && (r.document_ref ?? null) === null) bump(byTgt, String(r.party_ref), r.amount);
  }
  out.source = sum([...bySrc.values()]);
  out.target = sum([...byTgt.values()]);
  for (const code of [...new Set([...bySrc.keys(), ...byTgt.keys()])].sort()) {
    const a = bySrc.get(code) ?? 0;
    const b = byTgt.get(code) ?? 0;
    if (a !== b) add({ area: "receivables", code: "customer_outstanding_total", ids: { customer: code }, field: "outstanding receivable (control total)", source: P(a), target: P(b), diff: b - a, unit: "p", severity: "BLOCKER", reason: `Control total: what this customer owes differs between SliQ and Tolra, over the invoices both sides can state${out.sourceExcluded || out.targetExcluded ? ` (${out.sourceExcluded} SliQ and ${out.targetExcluded} Tolra invoice(s) with an unconfirmed payment state are left out of both)` : ""}.` });
  }
  if (out.source !== out.target) add({ area: "receivables", code: "total_outstanding", ids: { total: "all customers" }, field: "outstanding receivables (control total)", source: P(out.source), target: P(out.target), diff: out.target - out.source, unit: "p", severity: "BLOCKER", reason: "Control total: the amount owed by customers differs between SliQ and Tolra." });
}
