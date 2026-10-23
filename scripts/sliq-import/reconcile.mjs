// Turns the loaded records into (1) the reconciliation report and (2) the write plan. Pure: no database, no clock except
// generatedAt. "Unknown stays unknown": nothing here invents a payment, price, date or VAT figure; what the source does not
// say is left blank and listed. Payment state comes ONLY from the payments file, never from a status word.
import { createHash } from "node:crypto";

import { legacyId, normNumber, normaliseName, paymentIdentity } from "./ids.mjs";
import { poundsString } from "./parse.mjs";
import { resolveCreditNotes } from "./resolutions.mjs";

export const REPORT_FORMAT = "sliq-reconciliation/3";

const REVERSE_CHARGE_WORDS = /reverse[\s-]*charge|\bd\.?r\.?c\.?\b|\bCIS\b/i;
const DISCOUNT_WORDS = /discount|settlement|\bdisc\b|rebate/i;
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const where = (r) => ({ file: r._file, row: r._row });

export const NOT_IN_EXPORT = [
  "PDFs of invoices and quotes, attachments, document templates, logos and e-mail history do not export from SliQ. They are not imported; keep SliQ's own backup as the record of them.",
  "Only the figures and text in the CSV or Excel files are imported. Anything the files do not say is left blank and listed under 'Not in the source'.",
];

function lineNet(l) {
  const computed = l.quantity !== null && l.unitPrice !== null && (l.quantity * l.unitPrice) % 1000 === 0 ? (l.quantity * l.unitPrice) / 1000 : null;
  return { net: l.net ?? computed, computed, issue: l.net !== null && computed !== null && l.net !== computed ? "stated line net differs from quantity x unit price" : null };
}

function lineVat(l, net) {
  const rate = l.vatRate;
  const amt = l.vatAmount;
  if (rate !== null) {
    if (net === null) return amt !== null ? { ok: true, pct: rate, amount: amt, basis: "stated" } : { ok: true, pct: rate, amount: null, basis: "rate only; line net unknown" };
    const exactTimes = net * rate;
    if (amt !== null) {
      if (Math.abs(amt * 10000 - exactTimes) > 5000) return { ok: false, reason: `stated VAT ${poundsString(amt)} does not match ${rate / 100}% of ${poundsString(net)}` };
      return { ok: true, pct: rate, amount: amt, basis: "stated" };
    }
    return { ok: true, pct: rate, amount: Math.round(exactTimes / 10000), basis: "computed at the rate (comparison only)" };
  }
  if (amt !== null) {
    if (net !== null && net > 0 && (amt * 10000) % net === 0) return { ok: true, pct: (amt * 10000) / net, amount: amt, basis: "stated" };
    return { ok: false, reason: "VAT amount given but the rate cannot be worked out exactly from it" };
  }
  return { ok: false, reason: "no VAT rate or amount in the source" };
}

/** Customers and suppliers: the same shape. Duplicates by normalised name are listed and all kept as separate records. */
function parties(rows) {
  const list = [];
  const byName = new Map();
  const byKey = new Map();
  const seen = new Map();
  for (const c of rows.filter((r) => !r._bad)) {
    const nn = normaliseName(c.name);
    let identity = c.key ? `key:${c.key.trim().toLowerCase()}` : `name:${nn}`;
    const n = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, n);
    if (n > 1) identity = `${identity}#${n}`;
    const entry = { ...c, nn, identity };
    list.push(entry);
    if (!byName.has(nn)) byName.set(nn, []);
    byName.get(nn).push(entry);
    if (c.key) {
      const k = c.key.trim().toLowerCase();
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(entry);
    }
  }
  const resolve = (ref) => {
    if (!ref) return null;
    const k = byKey.get(ref.trim().toLowerCase());
    if (k) return k[0];
    const n = byName.get(normaliseName(ref));
    return n ? n[0] : null;
  };
  const dupNames = [...byName.entries()].filter(([, v]) => v.length > 1).map(([nn, v]) => ({ normalisedName: nn, records: v.map((c) => ({ name: c.name, key: c.key, ...where(c) })) }));
  const dupKeys = [...byKey.entries()].filter(([, v]) => v.length > 1).map(([key, v]) => ({ key, records: v.map((c) => ({ name: c.name, ...where(c) })) }));
  return { list, resolve, dupNames, dupKeys };
}

/**
 * @param loaded    result of loadFolder
 * @param opts      { organizationId?, target?, excludeNumbers? }
 *   target = result of readTarget (rehearsal read) or null/undefined (not checked)
 */
export function analyse(loaded, opts = {}) {
  const { organizationId = null, target = null, excludeNumbers = [], resolutions = null } = opts;
  const docFigures = [];
  const rec = loaded.records;
  const excluded = new Set(excludeNumbers.map(normNumber));
  const hasFile = (k) => loaded.inputs.some((i) => i.kind === k);
  const goodRows = (rows) => rows.filter((r) => !r._bad);

  const cust = parties(rec.customers);
  const supp = parties(rec.suppliers);
  const resolveCustomer = cust.resolve;
  const customers = cust.list;
  const suppliers = supp.list;

  // ---- documents ----
  const invoiceRows = [];
  const creditRows = [];
  const suspected = [];
  for (const r of goodRows(rec.invoices)) {
    if (r.docType === "credit_note") creditRows.push({ ...r, source: "invoice file (type column)" });
    else if (r.gross !== null && r.gross < 0) {
      creditRows.push({ ...r, source: "negative total in the invoice file (possible credit note, no type column says so)" });
      suspected.push(r);
    } else invoiceRows.push(r);
  }
  for (const r of goodRows(rec.creditNotes)) creditRows.push({ ...r, source: "credit-notes file", status: null });
  const quoteRows = goodRows(rec.quotes);

  const group = (rows, key) => {
    const m = new Map();
    for (const r of rows) {
      const k = normNumber(r[key]);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const invByNo = group(invoiceRows, "number");
  const creditByNo = group(creditRows, "number");
  const quoteByNo = group(quoteRows, "number");
  const allInvNos = group([...invoiceRows, ...creditRows], "number");
  const dupList = (m, kind) => [...m.entries()].filter(([, v]) => v.length > 1).map(([, v]) => ({ kind, number: v[0].number, rows: v.map(where) }));
  const duplicateDocs = [...dupList(allInvNos, "invoice/credit note"), ...dupList(quoteByNo, "quote")];
  const dupNos = new Set([...allInvNos].filter(([, v]) => v.length > 1).map(([k]) => `i:${k}`).concat([...quoteByNo].filter(([, v]) => v.length > 1).map(([k]) => `q:${k}`)));

  // ---- lines (one lines file serves invoices, credit notes and quotes; a number in two document types is ambiguous) ----
  const linesByDoc = group(goodRows(rec.invoiceLines).map((l) => ({ ...l, number: l.documentNumber })), "number");
  const orphanLines = [];
  const ambiguousLines = [];
  for (const [k, ls] of linesByDoc) {
    if (allInvNos.has(k) && quoteByNo.has(k)) ambiguousLines.push({ number: ls[0].documentNumber, lines: ls.length, reason: "the number is used by both an invoice/credit note and a quote: the lines file cannot say which" });
    else if (!allInvNos.has(k) && !quoteByNo.has(k)) for (const l of ls) orphanLines.push({ documentNumber: l.documentNumber, ...where(l) });
  }
  const linesOf = (k) => (allInvNos.has(k) && quoteByNo.has(k) ? [] : linesByDoc.get(k) ?? []);

  // ---- payments (cash) and allocations (credit notes: never cash) ----
  const paymentsByInv = group(goodRows(rec.payments).map((p) => ({ ...p, number: p.invoiceNumber })), "number");
  const paymentsForUnknownInvoice = [];
  for (const [k, ps] of paymentsByInv) {
    if (invByNo.has(k)) continue;
    for (const p of ps) paymentsForUnknownInvoice.push({ invoiceNumber: p.invoiceNumber, amount: p.amount, date: p.date, reason: creditByNo.has(k) ? "points at a credit note, not an invoice" : "no such invoice in the invoice file", ...where(p) });
  }
  // The same receipt listed twice (same invoice, date, amount and reference) is never summed: the invoice is left to confirm.
  const duplicatePayments = [];
  const dupPayInvoices = new Set();
  for (const [k, ps] of paymentsByInv) {
    const seenKey = new Map();
    for (const p of ps) {
      const id = `${p.date ?? ""}|${p.amount}|${(p.reference ?? "").trim()}`;
      if (!seenKey.has(id)) seenKey.set(id, []);
      seenKey.get(id).push(p);
    }
    for (const [, same] of seenKey) {
      if (same.length > 1) {
        dupPayInvoices.add(k);
        duplicatePayments.push({ invoiceNumber: same[0].invoiceNumber, date: same[0].date, amount: same[0].amount, reference: same[0].reference, times: same.length, rows: same.map(where) });
      }
    }
  }
  const allocRows = goodRows(rec.allocations);
  const allocatedByInv = new Map();
  const allocatedByCredit = new Map();
  const allocations = allocRows.map((a) => {
    const ck = normNumber(a.creditNoteNumber);
    const ik = normNumber(a.invoiceNumber);
    let status = "ok";
    if (!creditByNo.has(ck)) status = "credit note not found";
    else if (!invByNo.has(ik)) status = "invoice not found";
    if (status === "ok") {
      allocatedByInv.set(ik, (allocatedByInv.get(ik) ?? 0) + a.amount);
      allocatedByCredit.set(ck, (allocatedByCredit.get(ck) ?? 0) + a.amount);
    }
    return { creditNote: a.creditNoteNumber, invoice: a.invoiceNumber, amount: a.amount, date: a.date, status, note: "an allocation settles an invoice with a credit note; it is not cash and is never written as a payment", ...where(a) };
  });

  // ---- per-document analysis ----
  const mismatches = [];
  const unresolvedVat = [];
  const needsReview = [];
  const reviewFor = (kind, number, reasons) => {
    if (reasons.length) needsReview.push({ documentKind: kind, number, blocksWrite: kind !== "credit_note", excluded: excluded.has(normNumber(number)), reasons });
  };
  const dedupeReasons = (rs) => rs.filter((r, i) => rs.findIndex((x) => x.detail === r.detail) === i);
  const isRcCode = (c) => c && (loaded.profile.reverseChargeCodes ?? []).some((x) => x.toLowerCase() === c.trim().toLowerCase());

  function analyseDoc(kind, header) {
    const key = normNumber(header.number);
    const lines = linesOf(key);
    const reasons = [];
    const textHit = [header.notes, header.vatCode, header.reason].filter(Boolean);
    if (textHit.some((t) => REVERSE_CHARGE_WORDS.test(t))) reasons.push({ code: "reverse_charge", detail: "reverse-charge wording on the header" });
    if (textHit.some((t) => DISCOUNT_WORDS.test(t))) reasons.push({ code: "discount", detail: "discount wording on the header" });
    if (isRcCode(header.vatCode)) reasons.push({ code: "reverse_charge", detail: `VAT code ${header.vatCode} is a reverse-charge code` });
    if (header.discount) reasons.push({ code: "discount", detail: `discount on the header ("${header.discount}": a percentage or an amount, never applied here)` });
    const lineInfo = lines.map((l) => {
      const n = lineNet(l);
      const v = lineVat(l, n.net);
      if (REVERSE_CHARGE_WORDS.test(l.description ?? "") || isRcCode(l.vatCode) || (l.vatCode && REVERSE_CHARGE_WORDS.test(l.vatCode))) {
        reasons.push({ code: "reverse_charge", detail: `line ${l._row}: reverse-charge wording or code` });
      }
      if (l.discount) reasons.push({ code: "discount", detail: `line ${l._row}: discount "${l.discount}" (a percentage or an amount, never applied here)` });
      if (DISCOUNT_WORDS.test(l.description ?? "")) reasons.push({ code: "discount", detail: `line ${l._row}: description reads as a discount ("${l.description}")` });
      if (n.net !== null && n.net < 0) reasons.push({ code: "discount", detail: `line ${l._row}: negative line (possible discount)` });
      if (n.issue) mismatches.push({ documentKind: kind, number: header.number, field: "line net", row: l._row, stated: l.net, fromLines: n.computed, difference: l.net - n.computed, withinRounding: false, note: n.issue });
      if (!v.ok) unresolvedVat.push({ kind: "line", documentKind: kind, number: header.number, row: l._row, description: l.description, reason: v.reason });
      return { l, net: n.net, vat: v };
    });
    let sumNet = null;
    let sumVat = null;
    let tol = 0;
    if (lineInfo.length > 0) {
      const allNet = lineInfo.every((x) => x.net !== null);
      const allVat = lineInfo.every((x) => x.vat.ok && x.vat.amount !== null);
      sumNet = allNet ? sum(lineInfo.map((x) => x.net)) : null;
      sumVat = allVat ? sum(lineInfo.map((x) => x.vat.amount)) : null;
      tol = lineInfo.some((x) => x.vat.basis !== "stated") ? lineInfo.length : 0;
      const cmp = (field, stated, fromLines, tolerance) => {
        if (stated === null || stated === undefined || fromLines === null) return;
        if (stated !== fromLines) mismatches.push({ documentKind: kind, number: header.number, field, stated, fromLines, difference: stated - fromLines, withinRounding: Math.abs(stated - fromLines) <= tolerance });
      };
      cmp("net", header.net, sumNet, 0);
      cmp("vat", header.vat, sumVat, tol);
      cmp("gross", header.gross, sumNet !== null && sumVat !== null ? sumNet + sumVat : null, tol);
      const vatMis = mismatches.find((m) => m.number === header.number && m.documentKind === kind && m.field === "vat" && !m.withinRounding);
      if (vatMis) unresolvedVat.push({ kind: "document", documentKind: kind, number: header.number, reason: `lines carry VAT ${poundsString(vatMis.fromLines)} but the header says ${poundsString(vatMis.stated)}` });
      if (sumNet !== null && header.net !== null && header.net !== undefined && header.net < sumNet) reasons.push({ code: "discount", detail: `header net ${poundsString(header.net)} is lower than the lines' ${poundsString(sumNet)} (possible discount)` });
    }
    if (header.net !== null && header.net !== undefined && header.vat !== null && header.vat !== undefined && header.gross !== null && header.net + header.vat !== header.gross) {
      mismatches.push({ documentKind: kind, number: header.number, field: "header net + VAT vs gross", stated: header.gross, fromLines: header.net + header.vat, difference: header.gross - (header.net + header.vat), withinRounding: false });
    }
    reviewFor(kind, header.number, dedupeReasons(reasons));
    // Every document's source figures beside the lines' figures, not only the ones that disagree.
    const sGross = sumNet !== null && sumVat !== null ? sumNet + sumVat : null;
    const d = (stated, fromLines) => (stated === null || stated === undefined || fromLines === null ? null : stated - fromLines);
    const diffs = [d(header.net, sumNet), d(header.vat, sumVat), d(header.gross, sGross)];
    let result;
    if (lineInfo.length === 0) result = "no lines";
    else if (diffs.some((x) => x === null)) result = "not comparable";
    else if (diffs.every((x) => x === 0)) result = "match";
    else if (diffs[0] === 0 && diffs.slice(1).every((x) => Math.abs(x) <= tol)) result = "within rounding";
    else result = "MISMATCH";
    docFigures.push({
      kind, number: header.number, ...where(header), statedNet: header.net ?? null, statedVat: header.vat ?? null, statedGross: header.gross ?? null,
      lines: lineInfo.length, linesNet: sumNet, linesVat: sumVat, linesGross: sGross, differenceNet: diffs[0], differenceVat: diffs[1], differenceGross: diffs[2],
      vatBasis: lineInfo.length === 0 ? null : lineInfo.every((x) => x.vat.basis === "stated") ? "stated on the lines" : "computed from the rates (rounded per line, comparison only)", result,
    });
    return { lines: lineInfo };
  }

  const quotesA = quoteRows.map((h) => ({ h, a: analyseDoc("quote", h) }));
  const invA = invoiceRows.map((h) => ({ h, a: analyseDoc("invoice", h) }));
  const creditA = creditRows.map((h) => ({ h, a: analyseDoc("credit_note", h) }));

  const noLines = [];
  const linesSupplied = hasFile("invoiceLines");
  for (const { h, a } of invA) if (a.lines.length === 0) noLines.push({ number: h.number, gross: h.gross, note: linesSupplied ? "no lines in the lines file" : "no lines file supplied", ...where(h) });

  // ---- collisions and targets ----
  const collisions = { checked: !!target, status: target ? "checked against the target organisation" : "not checked", invoices: [], quotes: [], purchaseOrders: [], stock: [], customerReview: [], supplierReview: [] };
  const targetOwn = (kind, number, oldId) => {
    if (!target) return false;
    const existing = target[kind].get(number);
    return existing !== undefined && target.mapped[kind].get(String(oldId)) === existing;
  };
  const collide = (kind, listKey, number, oldId, row, held, label) => {
    if (target && target[kind].has(number) && !targetOwn(kind, number, oldId)) {
      held.push(`${label} already used by a different Tolra record`);
      collisions[listKey].push({ number, ...where(row) });
    }
  };
  const reviewHeld = (kind, key, held) => {
    if (excluded.has(key)) held.push("excluded by number (operator decision)");
    else if (needsReview.some((n) => n.documentKind === kind && normNumber(n.number) === key)) held.push("needs review (reverse charge or discount): not yet excluded or resolved");
  };

  // ---- balances: payment state comes only from the payments file ----
  const balances = [];
  const exceptions = [];
  const paymentsSupplied = hasFile("payments");
  const statusWordConflicts = [];
  const customerMissing = (ref) => ref && !resolveCustomer(ref);

  const invoicePlans = invA.map(({ h, a }) => {
    const key = normNumber(h.number);
    const held = [];
    if (dupNos.has(`i:${key}`)) held.push("duplicate document number in the source");
    if (!h.customer || !resolveCustomer(h.customer)) held.push("customer not found in the customers file");
    const oldId = organizationId ? legacyId(organizationId, "invoices", key) : null;
    collide("invoices", "invoices", h.number, oldId, h, held, "number");
    reviewHeld("invoice", key, held);

    const ps = (paymentsByInv.get(key) ?? []).map((p, i) => ({ ...p, ordinal: i }));
    const distinct = ps.filter((p, i) => ps.findIndex((o) => o.date === p.date && o.amount === p.amount && (o.reference ?? "").trim() === (p.reference ?? "").trim()) === i);
    const paid = sum((dupPayInvoices.has(key) ? distinct : ps).map((p) => p.amount));
    const bad = ps.filter((p) => p.amount <= 0);
    const undated = ps.filter((p) => !p.date);
    const allocated = allocatedByInv.get(key) ?? 0;
    const issued = h.status === "sent";
    let state;
    let reason = null;
    let toConfirm = false;
    let writePayments = false;
    if (!issued) {
      state = h.status === "void" ? "void" : "draft";
      if (ps.length) {
        reason = "payments recorded against a draft or cancelled invoice";
        exceptions.push({ number: h.number, reason, payments: ps.length });
      }
    } else if (dupPayInvoices.has(key)) {
      state = "exception";
      reason = "the same payment (date, amount, reference) is listed more than once: duplicates are never summed, so no payment is imported";
      toConfirm = true;
      exceptions.push({ number: h.number, reason });
    } else if (!paymentsSupplied) {
      state = "unknown";
      reason = "no payments file supplied";
      toConfirm = true;
    } else if (bad.length) {
      state = "exception";
      reason = "a payment of zero or less (refund or error): not imported";
      toConfirm = true;
      exceptions.push({ number: h.number, reason });
    } else if (paid > h.gross) {
      state = "overpaid";
      reason = `payments ${poundsString(paid)} exceed the invoice ${poundsString(h.gross)}: not imported`;
      toConfirm = true;
      exceptions.push({ number: h.number, reason });
    } else if (ps.length === 0) {
      state = "unpaid";
      toConfirm = true;
      reason = h.amountPaid ? `the invoice list says ${poundsString(h.amountPaid)} paid but there are no payment records` : "no payment records: still owed, to be confirmed by JNR";
      if (h.amountPaid) exceptions.push({ number: h.number, reason });
    } else if (h.amountPaid !== null && h.amountPaid !== undefined && h.amountPaid !== paid) {
      state = "exception";
      reason = `the invoice list says ${poundsString(h.amountPaid)} paid but the payment records add up to ${poundsString(paid)}: not imported`;
      toConfirm = true;
      exceptions.push({ number: h.number, reason });
    } else if (undated.length) {
      state = paid === h.gross ? "paid" : "PARTIAL";
      toConfirm = true;
      reason = `${undated.length} payment(s) have no date: not imported, to be confirmed`;
    } else {
      state = paid === h.gross ? "paid" : "PARTIAL";
      writePayments = true;
    }
    if (issued && allocated > 0) {
      writePayments = false;
      toConfirm = true;
      reason = `credit note allocation(s) of ${poundsString(allocated)} touch this invoice; an allocation is not cash and is not modelled, so its payments are not imported (cash on file: ${poundsString(paid)})`;
      exceptions.push({ number: h.number, reason });
    }
    // The status word is never trusted for payment; a disagreement with the payments file is only listed.
    const raw = h.statusRaw ?? "";
    const says = /part/i.test(raw) ? "part paid" : /unpaid|overdue|outstanding/i.test(raw) ? "unpaid" : /\bpaid\b/i.test(raw) ? "paid" : null;
    const cash = state === "paid" ? "paid" : state === "PARTIAL" ? "part paid" : state === "unpaid" ? "unpaid" : null;
    if (issued && says && cash && says !== cash) statusWordConflicts.push({ number: h.number, statusWord: raw, fromPayments: state, note: "payment state comes from the payments file only", ...where(h) });
    balances.push({
      number: h.number, documentKind: "invoice", gross: h.gross, paid: ps.length ? paid : null, allocated: allocated || null, balance: ps.length || paymentsSupplied ? h.gross - paid : null,
      state, payments: ps.length, paymentToConfirm: toConfirm, held: held.length > 0, reason, statusWord: raw || null, ...where(h),
    });
    return { h, a, key, oldId, held, ps, writePayments, state, paid, toConfirm };
  });

  const missing = {
    invoicesWithoutCustomer: invA.filter(({ h }) => !h.customer || customerMissing(h.customer)).map(({ h }) => ({ number: h.number, customer: h.customer, ...where(h) })),
    quotesWithoutCustomer: quotesA.filter(({ h }) => !h.customer || customerMissing(h.customer)).map(({ h }) => ({ number: h.number, customer: h.customer, ...where(h) })),
    creditNotesWithoutCustomer: creditA.filter(({ h }) => !h.customer || customerMissing(h.customer)).map(({ h }) => ({ number: h.number, customer: h.customer, ...where(h) })),
    orphanLines,
    ambiguousLines,
    paymentsForUnknownInvoice,
    allocationsWithoutDocument: allocations.filter((a) => a.status !== "ok"),
  };

  const quotePlans = quotesA.map(({ h: q, a }) => {
    const key = normNumber(q.number);
    const held = [];
    if (dupNos.has(`q:${key}`)) held.push("duplicate document number in the source");
    if (!q.customer || !resolveCustomer(q.customer)) held.push("customer not found in the customers file");
    const oldId = organizationId ? legacyId(organizationId, "quotes", key) : null;
    collide("quotes", "quotes", q.number, oldId, q, held, "number");
    reviewHeld("quote", key, held);
    return { q, a, key, oldId, held };
  });
  if (target) {
    for (const c of customers) {
      const hit = target.customerNames.get(c.nn);
      if (hit) collisions.customerReview.push({ sliqName: c.name, tolraNames: hit, ...where(c), note: "same normalised name as an existing Tolra customer: added as a separate record, review before merging" });
    }
    for (const c of suppliers) {
      const hit = target.supplierNames.get(c.nn);
      if (hit) collisions.supplierReview.push({ sliqName: c.name, tolraNames: hit, ...where(c), note: "same normalised name as an existing Tolra supplier: added as a separate record, review before merging" });
    }
  }

  // ---- credit notes ----
  const creditNotes = creditA.map(({ h, a }) => {
    const ref = h.relatedInvoice;
    const linked = ref ? invByNo.has(normNumber(ref)) : false;
    const gross = h.gross;
    const ck = normNumber(h.number);
    return {
      number: h.number, source: h.source, customer: h.customer, date: h.date, statedGross: gross, proposedGross: gross === null ? null : -Math.abs(gross),
      linkedInvoice: linked ? invByNo.get(normNumber(ref))[0].number : null,
      link: !ref ? "no invoice reference in the source: listed unlinked" : linked ? "linked" : `reference ${ref} not found in the invoice file: listed unlinked`,
      lines: a.lines.length, written: false,
      allocated: allocatedByCredit.get(ck) ?? null,
      allocations: allocations.filter((x) => normNumber(x.creditNote) === ck).map((x) => ({ invoice: x.invoice, amount: x.amount, status: x.status })),
      representation: linked ? `would be a negative document (${poundsString(gross === null ? null : -Math.abs(gross))}) linked to ${ref}` : `would be a negative document (${poundsString(gross === null ? null : -Math.abs(gross))}), unlinked`,
      ...where(h),
    };
  });

  const creditResolution = resolveCreditNotes({ creditNotes, allocations, invoiceNumbers: new Set(invByNo.keys()), resolutions });

  // ---- products (stock items only), suppliers, purchase orders ----
  const productRows = goodRows(rec.products);
  const prodByCode = group(productRows.map((p) => ({ ...p, number: p.code })), "number");
  const dupProducts = [...prodByCode.entries()].filter(([, v]) => v.length > 1).map(([, v]) => ({ code: v[0].code, rows: v.map(where) }));
  const stockPlans = [];
  const productsNotWritten = [];
  for (const p of productRows) {
    const key = normNumber(p.code);
    const held = [];
    if (p.stock === null) {
      productsNotWritten.push({ code: p.code, reason: "no Stock figure: a price-list item, not a stock item", ...where(p) });
      continue;
    }
    if (prodByCode.get(key).length > 1) held.push("duplicate item code in the source");
    if (p.stock < 0) held.push("negative stock figure");
    const oldId = organizationId ? legacyId(organizationId, "stock", key) : null;
    collide("stock", "stock", p.code, oldId, p, held, "item code");
    stockPlans.push({ p, key, oldId, held });
  }
  for (const s of stockPlans) if (s.held.length) productsNotWritten.push({ code: s.p.code, reason: s.held.join("; "), ...where(s.p) });

  const poRows = goodRows(rec.purchaseOrders);
  const poByNo = group(poRows, "number");
  const poPlans = poRows.map((po) => {
    const key = normNumber(po.number);
    const held = [];
    if (poByNo.get(key).length > 1) held.push("duplicate document number in the source");
    if (!supp.resolve(po.supplier)) held.push("supplier not found in the suppliers file");
    if (!po.status) held.push("status not in the source: a purchase order cannot be written without one (none is invented)");
    const oldId = organizationId ? legacyId(organizationId, "purchase_orders", key) : null;
    collide("purchaseOrders", "purchaseOrders", po.number, oldId, po, held, "number");
    return { po, key, oldId, held };
  });

  // ---- blanks (not in the source) ----
  const blanks = [];
  const blankScan = (kind, rows, label) => {
    const spec = loaded.profile.files[kind]?.columns ?? {};
    for (const field of ["email", "phone", "address", "postcode", "vatNumber", "contact", "dueDate", "method", "reference", "validUntil", "date", "relatedInvoice", "amountPaid", "net", "vat", "unitPrice", "stock", "orderDate", "deliveryDate", "total"]) {
      if (!rows.length || !(field in rows[0])) continue;
      const bl = rows.filter((r) => r[field] === null || r[field] === "");
      if (bl.length > 0) blanks.push({ entity: label, field, mapped: Boolean(spec[field]), blank: bl.length, of: rows.length, firstRows: bl.slice(0, 10).map((r) => r._row) });
    }
  };
  blankScan("customers", goodRows(rec.customers), "customers");
  blankScan("suppliers", goodRows(rec.suppliers), "suppliers");
  blankScan("invoices", goodRows(rec.invoices), "invoices");
  blankScan("quotes", quoteRows, "quotes");
  blankScan("payments", goodRows(rec.payments), "payments");
  blankScan("products", productRows, "products");
  blankScan("purchaseOrders", poRows, "purchase orders");

  // ---- the write plan ----
  const linesFor = (p) => {
    const reasonWithheld = p.a.lines.length === 0 ? "no lines in the source" : p.a.lines.some((x) => !x.vat.ok) ? "a line's VAT could not be resolved" : p.a.lines.some((x) => x.net === null || x.l.quantity === null) ? "a line's net could not be worked out exactly" : p.a.lines.some((x) => x.l.quantity <= 0 || x.l.unitPrice < 0) ? "a line has a zero or negative quantity or a negative price" : null;
    return reasonWithheld ? { withheld: reasonWithheld, lines: [] } : { withheld: null, lines: p.a.lines.map((x, i) => ({ position: i, description: x.l.description, quantityMilli: x.l.quantity, unitPence: x.l.unitPrice, vatCenti: x.vat.pct })) };
  };
  const methodFor = (raw) => {
    if (!raw) return null;
    const hit = Object.entries(loaded.profile.paymentMethodWords ?? {}).find(([k]) => k.toLowerCase() === raw.trim().toLowerCase());
    return hit ? hit[1] : null;
  };
  const oid = (kind, identity) => (organizationId ? legacyId(organizationId, kind, identity) : null);
  const plan = {
    organizationId,
    customers: customers.map((c) => ({ ...c, oldId: oid("customers", c.identity) })),
    suppliers: suppliers.map((c) => ({ ...c, oldId: oid("suppliers", c.identity) })),
    stock: stockPlans.filter((s) => s.held.length === 0).map((s) => ({ ...s.p, oldId: s.oldId })),
    purchaseOrders: poPlans.filter((p) => p.held.length === 0).map((p) => ({ ...p.po, oldId: p.oldId, supplierName: supp.resolve(p.po.supplier).name })),
    quotes: quotePlans.filter((p) => p.held.length === 0).map((p) => {
      const wl = linesFor(p);
      return { ...p.q, oldId: p.oldId, customerName: resolveCustomer(p.q.customer).name, lines: wl.lines, linesWithheld: wl.withheld };
    }),
    invoices: invoicePlans.filter((p) => p.held.length === 0).map((p) => {
      const wl = linesFor(p);
      const latest = p.ps.map((x) => x.date).filter(Boolean).sort().at(-1) ?? null;
      let final;
      if (p.h.status !== "sent") final = { status: p.h.status, amountPaid: 0, paidAt: null, unverified: false };
      else if (p.writePayments) final = { status: p.state === "paid" ? "paid" : "partial", amountPaid: p.paid, paidAt: p.state === "paid" ? latest : null, unverified: false };
      else final = { status: "sent", amountPaid: 0, paidAt: null, unverified: true };
      const pays = p.writePayments
        ? p.ps.map((x) => ({ oldId: oid("payments", paymentIdentity(normNumber(p.h.number), x.date, x.amount, x.ordinal)), amountPence: x.amount, date: x.date, method: methodFor(x.method), reference: x.reference, rawMethod: x.method }))
        : [];
      return { ...p.h, oldId: p.oldId, customerName: resolveCustomer(p.h.customer).name, lines: wl.lines, linesWithheld: wl.withheld, payments: pays, final };
    }),
  };
  const unmappedMethods = [...new Set(plan.invoices.flatMap((i) => i.payments).filter((p) => p.rawMethod && !p.method).map((p) => p.rawMethod))];

  const held = [
    ...invoicePlans.filter((p) => p.held.length).map((p) => ({ documentKind: "invoice", number: p.h.number, reasons: p.held, ...where(p.h) })),
    ...quotePlans.filter((p) => p.held.length).map((p) => ({ documentKind: "quote", number: p.q.number, reasons: p.held, ...where(p.q) })),
    ...poPlans.filter((p) => p.held.length).map((p) => ({ documentKind: "purchase_order", number: p.po.number, reasons: p.held, ...where(p.po) })),
    ...stockPlans.filter((p) => p.held.length).map((p) => ({ documentKind: "stock_item", number: p.p.code, reasons: p.held, ...where(p.p) })),
    ...creditNotes.map((c) => ({ documentKind: "credit_note", number: c.number, reasons: ["Tolra has no credit-note type: listed for a decision, never netted into an invoice"], file: c.file, row: c.row })),
  ];
  const unresolvedReview = needsReview.filter((n) => n.blocksWrite && !n.excluded);
  const state = (s) => balances.filter((b) => b.state === s);
  const allKnown = new Set([...allInvNos.keys(), ...quoteByNo.keys()]);
  const unknownExcluded = [...excluded].filter((n) => !allKnown.has(n));
  const mp = loaded.profile;
  const optionsApproved = {
    encoding: loaded.formats.encoding.confirmed ?? null,
    dateFormat: loaded.formats.dateFormat.confirmed ?? null,
    sheets: Object.fromEntries(Object.entries(loaded.options?.sheets ?? {}).sort()),
    exclusions: [...excluded].sort(),
    resolutionsSha256: resolutions?.sha256 ?? null,
  };
  const approval = { mappingId: mp.id, mappingFile: mp.fileName ?? null, mappingSha256: mp.fileSha256 ?? null, options: optionsApproved };
  approval.sha256 = createHash("sha256").update(JSON.stringify(approval)).digest("hex");

  const report = {
    format: REPORT_FORMAT,
    generatedAt: new Date().toISOString(),
    mapping: { id: mp.id, label: mp.label, status: mp.status, confirmed: mp.confirmed, isStub: mp.isStub, isProvisional: mp.isProvisional },
    provisionalNotice: mp.isProvisional ? "Provisional mapping, confirm against the real headers." : null,
    organizationId,
    approval,
    rehearsal: { checked: !!target, id: target?.rehearsalId ?? null },
    formats: loaded.formats,
    inputs: loaded.inputs,
    filesNotSupplied: loaded.missingFiles,
    unmatchedSheets: loaded.unmatchedSheets,
    errors: loaded.errors,
    warnings: loaded.warnings,
    notInExport: NOT_IN_EXPORT,
    counts: {
      customers: rec.customers.length, suppliers: rec.suppliers.length, products: rec.products.length, quotes: rec.quotes.length, invoices: invoiceRows.length, creditNotes: creditRows.length,
      invoiceLines: rec.invoiceLines.length, payments: rec.payments.length, allocations: rec.allocations.length, purchaseOrders: rec.purchaseOrders.length,
    },
    products: { read: rec.products.length, stockItems: stockPlans.length, notWritten: productsNotWritten, duplicates: dupProducts },
    duplicates: { documents: duplicateDocs, customers: cust.dupNames, customerKeys: cust.dupKeys, suppliers: supp.dupNames },
    missingRelationships: missing,
    documentAmounts: { documentsChecked: invA.length + creditA.length + quotesA.length, withLines: [...invA, ...creditA, ...quotesA].filter((x) => x.a.lines.length).length, mismatches, documents: docFigures },
    balances: {
      note: "Payment state comes only from the payments file. A status word such as Unpaid or Paid is never trusted for payment.",
      summary: Object.fromEntries(["paid", "PARTIAL", "unpaid", "overpaid", "exception", "unknown", "draft", "void"].map((s) => [s, state(s).length])),
      partial: balances.filter((b) => b.state === "PARTIAL"),
      paymentToConfirm: balances.filter((b) => b.paymentToConfirm && !b.held),
      exceptions,
      statusWordConflicts,
      items: balances,
    },
    creditNotes,
    allocations,
    creditNoteResolution: creditResolution,
    unresolvedCreditNoteCount: creditResolution.unresolved.length,
    duplicatePayments,
    suspectedCreditNotes: suspected.map((s) => ({ number: s.number, gross: s.gross, ...where(s) })),
    invoicesMissingLines: noLines,
    unresolvedVat,
    needsReview,
    excludeNumbers: [...excluded].sort(),
    unknownExcludedNumbers: unknownExcluded,
    blanks,
    collisions,
    purchaseOrders: { read: poRows.length, written: poPlans.filter((p) => !p.held.length).length, notWritten: poPlans.filter((p) => p.held.length).map((p) => ({ number: p.po.number, total: p.po.total, reasons: p.held, ...where(p.po) })) },
    held,
    writePlan: {
      customers: customers.length, suppliers: suppliers.length, stockItems: plan.stock.length, purchaseOrders: plan.purchaseOrders.length,
      quotes: plan.quotes.length, invoices: plan.invoices.length,
      invoiceLines: plan.invoices.reduce((n, i) => n + i.lines.length, 0), quoteLines: plan.quotes.reduce((n, i) => n + i.lines.length, 0),
      payments: plan.invoices.reduce((n, i) => n + i.payments.length, 0),
      invoicesPaymentToConfirm: plan.invoices.filter((i) => i.final.unverified).length,
      invoicesWithoutLines: plan.invoices.filter((i) => i.linesWithheld).length,
      creditNotesHeld: creditNotes.length, unmappedPaymentMethods: unmappedMethods,
    },
    unresolvedReviewCount: unresolvedReview.length,
    writable: loaded.errors.length === 0 && !mp.isStub && unknownExcluded.length === 0 && creditResolution.problems.length === 0,
  };
  return { report, plan };
}

// ---- Markdown ----
export function renderMarkdown(r) {
  const L = [];
  const money = poundsString;
  const table = (head, rows) => (rows.length ? [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((x) => `| ${x.map((c) => String(c ?? "").replaceAll("|", "/")).join(" | ")} |`), ""] : ["None.", ""]);
  L.push("# SliQ import: reconciliation report", "");
  L.push(`Generated ${r.generatedAt}. Mapping: ${r.mapping.label} (${r.mapping.status}${r.mapping.confirmed ? "" : ", not confirmed"}). Organisation: ${r.organizationId ?? "none given (dry run without a target)"}.`);
  if (r.provisionalNotice) L.push("", `**${r.provisionalNotice}** A write is refused until the mapping file is marked confirmed.`);
  L.push("", `Writable: **${r.writable ? "yes, once the stop conditions are met" : "NO"}**. Nothing in this report was written to a database.`, "");
  L.push("## 1. Source files", "");
  L.push(...table(["File", "Sheet", "Kind", "Rows", "Bytes", "SHA-256", "Columns not mapped"], r.inputs.map((i) => [i.file, i.sheet ?? "", i.kind, i.rows, i.bytes, i.sha256, i.unmappedColumns.join(", ")])));
  if (r.filesNotSupplied.length) L.push(`Not supplied: ${r.filesNotSupplied.map((f) => f.file).join(", ")}.`, "");
  if (r.unmatchedSheets.length) L.push("Worksheets matched to nothing (ignored):", "", ...table(["Workbook", "Sheet", "Headers"], r.unmatchedSheets.map((s) => [s.file, s.sheet, s.headers.join(", ")])));
  L.push("### Detected (a write needs these confirmed explicitly and equal to the detection)", "");
  const f = r.formats;
  L.push(`* Encoding: detected ${f.encoding.detected.join(", ") || "n/a"}; confirmed ${f.encoding.confirmed ?? "NOT CONFIRMED"}. ${f.encoding.perFile.map((e) => `${e.file}: ${e.detected}`).join("; ")}`);
  L.push(`* Date format: detected ${f.dateFormat.detected ?? "none"}${f.dateFormat.ambiguous ? " (AMBIGUOUS: every day is 12 or less)" : ""}; confirmed ${f.dateFormat.confirmed ?? "NOT CONFIRMED"}; used ${f.dateFormat.used}. Examples: ${f.dateFormat.examples.join(", ")}`, "");
  if (r.errors.length) L.push("### Rows that could not be read (these stop a write)", "", ...table(["File", "Row", "Column", "Value", "Problem"], r.errors.map((e) => [e.file, e.row, e.column, e.value, e.message])));
  if (r.warnings.length) L.push("### Warnings", "", ...table(["File", "Row", "Column", "Value", "Note"], r.warnings.map((e) => [e.file, e.row, e.column, e.value, e.message])));
  L.push("### Not in the export", "", ...r.notInExport.map((n) => `* ${n}`), "");
  L.push("## 2. Duplicates", "");
  L.push("Same document number more than once (none of these documents is written):", "", ...table(["Kind", "Number", "Rows"], r.duplicates.documents.map((d) => [d.kind, d.number, d.rows.map((x) => `${x.file}:${x.row}`).join(", ")])));
  L.push("Same customer twice by normalised name (all are written as separate records; review before any merge):", "", ...table(["Normalised name", "Records"], r.duplicates.customers.map((d) => [d.normalisedName, d.records.map((x) => `${x.name} (row ${x.row})`).join("; ")])));
  L.push("Same supplier twice by normalised name:", "", ...table(["Normalised name", "Records"], r.duplicates.suppliers.map((d) => [d.normalisedName, d.records.map((x) => `${x.name} (row ${x.row})`).join("; ")])));
  L.push("## 3. Missing relationships", "");
  const m = r.missingRelationships;
  L.push("Invoices whose customer is missing:", "", ...table(["Invoice", "Customer as written", "Row"], m.invoicesWithoutCustomer.map((x) => [x.number, x.customer, x.row])));
  L.push("Quotes whose customer is missing:", "", ...table(["Quote", "Customer as written", "Row"], m.quotesWithoutCustomer.map((x) => [x.number, x.customer, x.row])));
  L.push("Credit notes whose customer is missing:", "", ...table(["Credit note", "Customer as written", "Row"], m.creditNotesWithoutCustomer.map((x) => [x.number, x.customer, x.row])));
  L.push("Lines without a header:", "", ...table(["Document number", "Row"], m.orphanLines.map((x) => [x.documentNumber, x.row])));
  L.push("Lines whose number belongs to both an invoice/credit note and a quote:", "", ...table(["Number", "Lines", "Why"], m.ambiguousLines.map((x) => [x.number, x.lines, x.reason])));
  L.push("Payments for unknown invoices (not imported):", "", ...table(["Invoice", "Amount", "Date", "Why", "Row"], m.paymentsForUnknownInvoice.map((x) => [x.invoiceNumber, money(x.amount), x.date, x.reason, x.row])));
  L.push("## 4. Document amounts: lines against the stated header", "");
  L.push(`${r.documentAmounts.documentsChecked} invoices, credit notes and quotes; ${r.documentAmounts.withLines} have lines to compare. Header totals are kept as stated; nothing is adjusted.`, "");
  L.push("### Every document: source figures beside the lines", "", ...table(["Kind", "Number", "Net", "VAT", "Gross", "Lines", "Lines net", "Lines VAT", "Lines gross", "Result"], r.documentAmounts.documents.map((x) => [x.kind, x.number, money(x.statedNet), money(x.statedVat), money(x.statedGross), x.lines, x.lines ? money(x.linesNet) : "", x.lines ? money(x.linesVat) : "", x.lines ? money(x.linesGross) : "", x.result])));
  L.push("### Differences", "");
  L.push(...table(["Document", "Field", "Header (stated)", "From lines", "Difference", "Within rounding"], r.documentAmounts.mismatches.map((x) => [x.number, x.field, money(x.stated), money(x.fromLines), money(x.difference), x.withinRounding ? "yes" : "NO"])));
  L.push("## 5. Balances", "");
  L.push(r.balances.note, "", `Counts: ${Object.entries(r.balances.summary).map(([k, v]) => `${k} ${v}`).join(", ")}.`, "");
  L.push("### PARTIAL (payments are written as legacy payment rows; the invoice shows part paid)", "", ...table(["Invoice", "Total", "Paid", "Balance", "Payments", "Status word", "Payment to confirm"], r.balances.partial.map((x) => [x.number, money(x.gross), money(x.paid), money(x.balance), x.payments, x.statusWord, x.paymentToConfirm ? x.reason : "no"])));
  L.push("### Payment to confirm (paid status or amount not evidenced; kept out of money owed and chasers until a person decides)", "", ...table(["Invoice", "Total", "State", "Why"], r.balances.paymentToConfirm.map((x) => [x.number, money(x.gross), x.state, x.reason])));
  L.push("### Duplicate payment rows (never summed; the invoice is left to confirm)", "", ...table(["Invoice", "Date", "Amount", "Reference", "Times", "Rows"], r.duplicatePayments.map((x) => [x.invoiceNumber, x.date, money(x.amount), x.reference, x.times, x.rows.map((y) => y.row).join(", ")])));
  L.push("### Payment exceptions (not imported)", "", ...table(["Invoice", "Why"], r.balances.exceptions.map((x) => [x.number, x.reason])));
  L.push("### Status word disagrees with the payments file (listed only)", "", ...table(["Invoice", "Status word", "From payments"], r.balances.statusWordConflicts.map((x) => [x.number, x.statusWord, x.fromPayments])));
  L.push("## 6. Credit notes and allocations (never netted into invoices; not written)", "");
  L.push(...table(["Credit note", "Source", "Stated", "Link", "Would be represented as"], r.creditNotes.map((c) => [c.number, c.source, money(c.statedGross), c.link, c.representation])));
  L.push(`Credit-note resolution file: ${r.creditNoteResolution.file ?? "none"}${r.creditNoteResolution.sha256 ? ` (sha256 ${r.creditNoteResolution.sha256})` : ""}. **A write is refused while any credit note or allocation below is unresolved.**`, "");
  L.push("Unresolved:", "", ...table(["Credit note", "Why"], r.creditNoteResolution.unresolved.map((x) => [x.number, x.reason])));
  L.push("Covered by the resolution file:", "", ...table(["Credit note", "Decision", "Allocation"], r.creditNoteResolution.covered.map((x) => [x.number, x.decision, x.allocation ? `${x.allocation.invoice} ${money(x.allocation.amount)}` : "none"])));
  L.push("Allocations (a credit note settling an invoice; never cash, never a payment row):", "", ...table(["Credit note", "Invoice", "Amount", "Date", "Check"], r.allocations.map((a) => [a.creditNote, a.invoice, money(a.amount), a.date, a.status])));
  L.push("## 7. Invoices missing lines (header total kept as stated, flagged, no lines invented)", "");
  L.push(...table(["Invoice", "Total", "Why"], r.invoicesMissingLines.map((x) => [x.number, money(x.gross), x.note])));
  L.push("## 8. Unresolved VAT", "");
  L.push(...table(["Document", "Level", "Row", "Why"], r.unresolvedVat.map((x) => [x.number, x.kind, x.row ?? "", x.reason])));
  L.push("## 9. Needs review: reverse charge or discounts (not modelled in Tolra)", "");
  L.push("A write is refused while any of these (invoices, quotes) is neither resolved in the source nor excluded by number. Discounts (percentage or amount, on a line, a header or as a separate item) are never applied here. Nothing is treated as exempt or zero-rated and no adjustment line is invented.", "");
  L.push(...table(["Document", "Kind", "Excluded", "Why"], r.needsReview.map((x) => [x.number, x.documentKind, x.excluded ? "yes" : x.blocksWrite ? "NO" : "n/a (held anyway)", x.reasons.map((y) => y.detail).join("; ")])));
  L.push("## 10. Number collisions with existing Tolra documents", "");
  L.push(`Status: **${r.collisions.status}**.`, "");
  if (r.collisions.checked) {
    L.push(...table(["Kind", "Number"], [...r.collisions.invoices.map((x) => ["invoice", x.number]), ...r.collisions.quotes.map((x) => ["quote", x.number]), ...r.collisions.purchaseOrders.map((x) => ["purchase order", x.number]), ...r.collisions.stock.map((x) => ["stock item", x.number])]));
    L.push("Customers and suppliers sharing a name with an existing Tolra record (review list):", "", ...table(["SliQ", "Tolra"], [...r.collisions.customerReview, ...r.collisions.supplierReview].map((x) => [x.sliqName, x.tolraNames.join("; ")])));
  }
  L.push("## 11. Not in the source (left blank)", "");
  L.push(...table(["Entity", "Field", "Column mapped", "Blank", "Of", "First rows"], r.blanks.map((b) => [b.entity, b.field, b.mapped ? "yes" : "no", b.blank, b.of, b.firstRows.join(", ")])));
  L.push("## 12. Products, suppliers and purchase orders", "");
  L.push(`Products read ${r.products.read}; stock items ${r.products.stockItems}. Not written:`, "", ...table(["Item code", "Why"], r.products.notWritten.map((p) => [p.code, p.reason])));
  L.push(`Purchase orders read ${r.purchaseOrders.read}; written ${r.purchaseOrders.written}. Not written (header only is ever written):`, "", ...table(["PO", "Total", "Why"], r.purchaseOrders.notWritten.map((p) => [p.number, money(p.total), p.reasons.join("; ")])));
  L.push("## 13. Approval and rehearsal identity", "");
  L.push(`Approval checksum ${r.approval.sha256}: mapping file ${r.approval.mappingFile ?? "n/a"} (${r.approval.mappingSha256 ?? "n/a"}), encoding ${r.approval.options.encoding ?? "not confirmed"}, date format ${r.approval.options.dateFormat ?? "not confirmed"}, sheets ${JSON.stringify(r.approval.options.sheets)}, exclusions ${r.approval.options.exclusions.join(", ") || "none"}, resolutions ${r.approval.options.resolutionsSha256 ?? "none"}. A write is refused if any of these differs.`);
  L.push(`Rehearsal identity of the target: ${r.rehearsal.checked ? r.rehearsal.id ?? "NONE (the target is not a prepared rehearsal copy)" : "not checked"}.`, "");
  L.push("## 14. What a write would do", "");
  L.push(...table(["Item", "Count"], Object.entries(r.writePlan).filter(([, v]) => !Array.isArray(v)).map(([k, v]) => [k, v])));
  L.push("Held (not written):", "", ...table(["Kind", "Number", "Why"], r.held.map((h) => [h.documentKind, h.number, h.reasons.join("; ")])));
  if (r.writePlan.unmappedPaymentMethods.length) L.push(`Payment methods not in the mapping (stored as blank): ${r.writePlan.unmappedPaymentMethods.join(", ")}.`, "");
  return L.join("\n");
}
