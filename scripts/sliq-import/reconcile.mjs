// Turns the loaded records into (1) the reconciliation report and (2) the write plan. Pure: no database, no clock except
// generatedAt. "Unknown stays unknown": nothing here invents a payment, price, date or VAT figure; what the source does not
// say is left blank and listed. Payment state comes ONLY from the payments file, never from a status word.
import { createHash } from "node:crypto";

import { legacyId, normNumber, normaliseName, paymentIdentity } from "./ids.mjs";
import { poundsString } from "./parse.mjs";
import { resolveCreditNotes } from "./resolutions.mjs";

export const REPORT_FORMAT = "sliq-reconciliation/4";

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

/** A name as a person reads it exactly: Unicode composed, surrounding and repeated spaces dropped, case ignored. Nothing else. */
export const exactName = (s) => String(s ?? "").normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Customers and suppliers: the same shape. Duplicates by normalised name are listed and all kept as separate records.
 * `names` gives some records their own Tolra name (resolutions file, customerNames), keyed by account in lower case.
 *
 * match(ref) (decision 3, Mon 2 Nov): a document's customer is matched on a stable identifier only, never on a guess:
 *   1. the account (SliQ's account number) of exactly one record;
 *   2. otherwise the name EXACTLY as one record has it (case and spacing aside), when no other record has that name or a name
 *      that normalises to it (Ltd/Limited, &/and, punctuation): SliQ's invoice reports print the business name, so a name that
 *      only one record can have is an identifier;
 *   anything else (an account used twice, a name two records share, a match only after normalising, nothing at all) is
 *   ambiguous or unmatched, with the candidates, and stops the write until the resolutions file names the account.
 */
function parties(rows, names = new Map()) {
  const list = [];
  const byName = new Map();
  const byKey = new Map();
  const byExact = new Map();
  const seen = new Map();
  const push = (m, k, v) => {
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(v);
  };
  for (const c of rows.filter((r) => !r._bad)) {
    const nn = normaliseName(c.name);
    let identity = c.key ? `key:${c.key.trim().toLowerCase()}` : `name:${nn}`;
    const n = (seen.get(identity) ?? 0) + 1;
    seen.set(identity, n);
    if (n > 1) identity = `${identity}#${n}`;
    const override = c.key ? names.get(c.key.trim().toLowerCase()) : undefined;
    const entry = { ...c, nn, identity, tolraName: override ?? c.name, renamedFrom: override ? c.name : null };
    list.push(entry);
    push(byName, nn, entry);
    push(byExact, exactName(c.name), entry);
    if (c.key) push(byKey, c.key.trim().toLowerCase(), entry);
  }
  const cand = (xs) => xs.map((c) => ({ account: c.key ?? null, name: c.name, ...where(c) }));
  const match = (ref) => {
    if (!ref || !String(ref).trim()) return { status: "unmatched", reason: "no customer on the document", candidates: [] };
    const k = byKey.get(String(ref).trim().toLowerCase());
    if (k) return k.length === 1 ? { status: "ok", entry: k[0], via: "account" } : { status: "ambiguous", reason: `account ${ref} belongs to ${k.length} records`, candidates: cand(k) };
    const ex = byExact.get(exactName(ref)) ?? [];
    const nn = byName.get(normaliseName(ref)) ?? [];
    if (ex.length === 1 && nn.length === 1) return { status: "ok", entry: ex[0], via: "name (the only record with this name)" };
    if (ex.length === 1) return { status: "ok", entry: ex[0], via: "name exactly as written (another record's name differs only by Ltd/Limited, & or punctuation)" };
    if (ex.length > 1) return { status: "ambiguous", reason: `${ex.length} records have exactly this name`, candidates: cand(ex) };
    if (nn.length > 0) return { status: "ambiguous", reason: "matches only after normalising (case, punctuation, Ltd/Limited, &/and): not an identifier", candidates: cand(nn) };
    return { status: "unmatched", reason: "no record has this account or name", candidates: [] };
  };
  const byAccount = (account) => byKey.get(String(account ?? "").trim().toLowerCase()) ?? [];
  const dupNames = [...byName.entries()].filter(([, v]) => v.length > 1).map(([nn, v]) => ({ normalisedName: nn, records: v.map((c) => ({ name: c.name, key: c.key, ...where(c) })) }));
  const dupKeys = [...byKey.entries()].filter(([, v]) => v.length > 1).map(([key, v]) => ({ key, records: v.map((c) => ({ name: c.name, ...where(c) })) }));
  // Tolra links documents to a customer by its name: two records may not end up with the same Tolra name.
  const byTolra = new Map();
  for (const e of list) push(byTolra, exactName(e.tolraName), e);
  const sameTolraName = [...byTolra.values()].filter((v) => v.length > 1).map((v) => ({ name: v[0].tolraName, records: cand(v) }));
  return { list, match, byAccount, dupNames, dupKeys, sameTolraName };
}

/**
 * Numbers SliQ used more than once (decision 2, Mon 2 Nov): every copy is kept and gets its own Tolra number, the same every run.
 * The earliest (by date, then source row) keeps the number; the others get -B, -C ... (skipping a number already used). The
 * number SliQ printed is kept as sourceNumber (written to source_ref, migration 135). Returns the rows (renamed copies replaced)
 * and the log of every copy.
 */
export function numberCopies(rows, kind, dateField) {
  const groups = new Map();
  for (const r of rows) {
    const k = normNumber(r.number);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const used = new Set(groups.keys());
  const renamed = new Map();
  const log = [];
  const duplicated = new Set();
  for (const [k, copies] of groups) {
    if (copies.length < 2) continue;
    duplicated.add(k);
    const sorted = [...copies].sort((a, b) => String(a[dateField] ?? "").localeCompare(String(b[dateField] ?? "")) || a._row - b._row);
    let letter = 1;
    sorted.forEach((r, i) => {
      let number = normNumber(r.number);
      if (i > 0) {
        do number = `${k}-${String.fromCharCode(65 + letter++)}`; while (used.has(number));
        used.add(number);
        renamed.set(r, number);
      }
      log.push({ kind, sourceNumber: r.number, number, keeps: i === 0, date: r[dateField] ?? null, party: r.customer ?? r.supplier ?? null, ...where(r) });
    });
  }
  const out = rows.map((r) => ({ ...r, sourceNumber: r.number, ...(renamed.has(r) ? { number: renamed.get(r) } : {}) }));
  return { rows: out, log, duplicated };
}

/**
 * @param loaded    result of loadFolder
 * @param opts      { organizationId?, target?, excludeNumbers?, resolutions?, otherNumbers? }
 *   target = result of readTarget (rehearsal read) or null/undefined (not checked)
 *   otherNumbers = the job and sales-order numbers of the jobs files (jobs-plan.mjs), so --exclude may name them
 */
export function analyse(loaded, opts = {}) {
  const { organizationId = null, target = null, excludeNumbers = [], resolutions = null, otherNumbers = [] } = opts;
  const docFigures = [];
  const rec = loaded.records;
  const excluded = new Set(excludeNumbers.map(normNumber));
  // An exclusion names the Tolra number or the number SliQ printed (which excludes every copy of it).
  const isExcluded = (h) => excluded.has(normNumber(h.number)) || (h.sourceNumber !== undefined && excluded.has(normNumber(h.sourceNumber)));
  const hasFile = (k) => loaded.inputs.some((i) => i.kind === k);
  const goodRows = (rows) => rows.filter((r) => !r._bad);

  // ---- customer and supplier names for Tolra (resolutions file, customerNames) ----
  const matchProblems = [];
  const nameOverrides = { customer: new Map(), supplier: new Map() };
  for (const e of resolutions?.customerNames ?? []) {
    const party = e?.party ?? "customer";
    const account = String(e?.account ?? "").trim();
    const name = String(e?.name ?? "").trim().replace(/\s+/g, " ");
    const pool = party === "supplier" ? rec.suppliers : party === "customer" ? rec.customers : null;
    if (!pool) matchProblems.push(`customerNames: party must be "customer" or "supplier" (${account || "no account"})`);
    else if (!account || !name || name.length > 200) matchProblems.push(`customerNames: ${account || "an entry"} needs an account and a name of 1 to 200 characters`);
    else if (pool.filter((c) => !c._bad && (c.key ?? "").trim().toLowerCase() === account.toLowerCase()).length !== 1) matchProblems.push(`customerNames: ${party} account ${account} is not exactly one record in the ${party === "supplier" ? "suppliers" : "customers"} file`);
    else if (nameOverrides[party].has(account.toLowerCase())) matchProblems.push(`customerNames: ${party} account ${account} is named twice`);
    else nameOverrides[party].set(account.toLowerCase(), name);
  }
  const cust = parties(rec.customers, nameOverrides.customer);
  const supp = parties(rec.suppliers, nameOverrides.supplier);
  const customers = cust.list;
  const suppliers = supp.list;

  // ---- documents ----
  const creditRows = [];
  const suspected = [];
  const invoiceSource = [];
  for (const r of goodRows(rec.invoices)) {
    if (r.docType === "credit_note") creditRows.push({ ...r, source: "invoice file (type column)" });
    else if (r.gross !== null && r.gross < 0) {
      creditRows.push({ ...r, source: "negative total in the invoice file (possible credit note, no type column says so)" });
      suspected.push(r);
    } else invoiceSource.push(r);
  }
  for (const r of goodRows(rec.creditNotes)) creditRows.push({ ...r, source: "credit-notes file", status: null });
  // A number SliQ used twice: every copy is written under its own deterministic Tolra number; nothing is dropped (decision 2).
  const invCopies = numberCopies(invoiceSource, "invoice", "date");
  const quoteCopies = numberCopies(goodRows(rec.quotes), "quote", "date");
  const poCopies = numberCopies(goodRows(rec.purchaseOrders), "purchase_order", "orderDate");
  const invoiceRows = invCopies.rows;
  const quoteRows = quoteCopies.rows;
  // Lines and payments name the number SliQ printed; when several documents share it they cannot be told apart.
  const sharedInv = invCopies.duplicated;
  const sharedQuote = quoteCopies.duplicated;

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
  const invBySource = group(invoiceRows, "sourceNumber");
  const creditByNo = group(creditRows, "number");
  const quoteByNo = group(quoteRows, "number");
  const quoteBySource = group(quoteRows, "sourceNumber");
  const allInvNos = group([...invoiceRows, ...creditRows], "number");
  const allInvSource = group([...invoiceRows.map((r) => ({ ...r, number: r.sourceNumber })), ...creditRows], "number");
  const dupList = (m, kind) => [...m.entries()].filter(([, v]) => v.length > 1).map(([, v]) => ({ kind, number: v[0].number, rows: v.map(where) }));
  // After the renames only a credit note sharing a number with an invoice (or another credit note) is left here.
  const duplicateDocs = [...dupList(allInvNos, "invoice/credit note"), ...dupList(quoteByNo, "quote")];
  const dupNos = new Set([...allInvNos].filter(([, v]) => v.length > 1).map(([k]) => `i:${k}`).concat([...quoteByNo].filter(([, v]) => v.length > 1).map(([k]) => `q:${k}`)));
  const renames = [...invCopies.log, ...quoteCopies.log, ...poCopies.log];

  // ---- lines (one lines file serves invoices, credit notes and quotes; a number in two document types is ambiguous) ----
  const linesByDoc = group(goodRows(rec.invoiceLines).map((l) => ({ ...l, number: l.documentNumber })), "number");
  const orphanLines = [];
  const ambiguousLines = [];
  for (const [k, ls] of linesByDoc) {
    if (allInvSource.has(k) && quoteBySource.has(k)) ambiguousLines.push({ number: ls[0].documentNumber, lines: ls.length, reason: "the number is used by both an invoice/credit note and a quote: the lines file cannot say which" });
    else if (sharedInv.has(k) || sharedQuote.has(k)) ambiguousLines.push({ number: ls[0].documentNumber, lines: ls.length, reason: `SliQ used the number for ${(sharedInv.has(k) ? invBySource : quoteBySource).get(k).length} documents: the lines file cannot say whose lines these are, so each copy is written with its header only` });
    else if (!allInvSource.has(k) && !quoteBySource.has(k)) for (const l of ls) orphanLines.push({ documentNumber: l.documentNumber, ...where(l) });
  }
  const linesOf = (k) => (allInvSource.has(k) && quoteBySource.has(k) ? [] : sharedInv.has(k) || sharedQuote.has(k) ? [] : linesByDoc.get(k) ?? []);

  // ---- payments (cash) and allocations (credit notes: never cash) ----
  const paymentsByInv = group(goodRows(rec.payments).map((p) => ({ ...p, number: p.invoiceNumber })), "number");
  const paymentsForUnknownInvoice = [];
  for (const [k, ps] of paymentsByInv) {
    if (invBySource.has(k)) continue;
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
    else if (!invBySource.has(ik)) status = "invoice not found";
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
  const reviewFor = (kind, header, reasons) => {
    if (reasons.length) needsReview.push({ documentKind: kind, number: header.number, sourceNumber: header.sourceNumber ?? header.number, blocksWrite: kind !== "credit_note", excluded: isExcluded(header), reasons });
  };
  const dedupeReasons = (rs) => rs.filter((r, i) => rs.findIndex((x) => x.detail === r.detail) === i);
  const isRcCode = (c) => c && (loaded.profile.reverseChargeCodes ?? []).some((x) => x.toLowerCase() === c.trim().toLowerCase());

  function analyseDoc(kind, header) {
    const lines = linesOf(normNumber(header.sourceNumber ?? header.number));
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
    reviewFor(kind, header, dedupeReasons(reasons));
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
  for (const { h, a } of invA) {
    if (a.lines.length > 0) continue;
    const shared = sharedInv.has(normNumber(h.sourceNumber));
    noLines.push({ number: h.number, gross: h.gross, note: shared ? `lines are listed under SliQ number ${h.sourceNumber}, which ${invBySource.get(normNumber(h.sourceNumber)).length} invoices share: header only` : linesSupplied ? "no lines in the lines file" : "no lines file supplied", ...where(h) });
  }

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
  const reviewHeld = (kind, h, held) => {
    if (isExcluded(h)) held.push("excluded by number (operator decision)");
    else if (needsReview.some((n) => n.documentKind === kind && normNumber(n.number) === normNumber(h.number))) held.push("needs review (reverse charge or discount): not yet excluded or resolved");
  };

  // ---- customers and suppliers of each document: a stable identifier or a reviewed resolution, never a guess (decision 3) ----
  const ambiguities = [];
  const matchEntries = (resolutions?.customerMatches ?? []).map((e, i) => ({ e, i, used: 0 }));
  const KINDS = ["invoice", "quote", "purchase_order", "credit_note"];
  // A job or sales order is matched to its customer the same way, by jobs-plan.mjs (plan.matchCustomer below).
  const ALL_KINDS = [...KINDS, "job", "sales_order"];
  for (const m of matchEntries) {
    if (!ALL_KINDS.includes(m.e?.kind ?? "invoice")) matchProblems.push(`customerMatches entry ${m.i + 1}: kind must be one of ${ALL_KINDS.join(", ")}`);
    else if (!String(m.e?.number ?? "").trim() || !String(m.e?.account ?? "").trim()) matchProblems.push(`customerMatches entry ${m.i + 1}: "number" and "account" are needed`);
  }
  const resolvedParty = (kind, h, ref) => {
    const pool = kind === "purchase_order" ? supp : cust;
    const hits = matchEntries.filter((m) => (m.e?.kind ?? "invoice") === kind && normNumber(m.e?.number) === normNumber(h.sourceNumber ?? h.number)
      && (m.e.row === undefined || m.e.row === h._row) && (m.e.date === undefined || String(m.e.date).trim() === (h.date ?? h.orderDate ?? "")));
    if (hits.length > 1) return { status: "ambiguous", reason: "more than one customerMatches entry fits this document (add row or date)", candidates: [] };
    if (hits.length === 1) {
      hits[0].used++;
      const acc = pool.byAccount(hits[0].e.account);
      if (acc.length !== 1) return { status: "unmatched", reason: `the resolutions file names account ${hits[0].e.account}, which is ${acc.length ? "used by more than one record" : "not in the file"}`, candidates: [] };
      return { status: "ok", entry: acc[0], via: "resolutions file (customerMatches)" };
    }
    return pool.match(ref);
  };
  const partyFor = (kind, h, ref, held) => {
    const m = resolvedParty(kind, h, ref);
    if (m.status !== "ok") {
      const blocks = !isExcluded(h);
      held.push(`${kind === "purchase_order" ? "supplier" : "customer"} ${m.status}: ${m.reason} (see the ambiguity report)`);
      ambiguities.push({ kind, number: h.number, sourceNumber: h.sourceNumber ?? h.number, reference: ref ?? null, status: m.status, reason: m.reason, candidates: m.candidates, blocksWrite: blocks, ...where(h) });
      return null;
    }
    return m;
  };
  // Two customers (or suppliers) with the same Tolra name could not be told apart in Tolra: each needs its own name.
  for (const [label, pool] of [["customer", cust], ["supplier", supp]]) {
    for (const g of pool.sameTolraName) {
      for (const c of g.records) ambiguities.push({ kind: label, number: c.account ?? "(no account)", sourceNumber: c.account ?? null, reference: c.name, status: "ambiguous", reason: `${g.records.length} ${label}s would have the Tolra name "${g.name}": Tolra links documents by name, so give all but one a name of its own (resolutions file, customerNames)`, candidates: g.records, blocksWrite: true, file: c.file, row: c.row });
    }
  }

  // ---- balances: payment state comes only from the payments file ----
  // Decision 1 (Mon 2 Nov): an imported invoice gets its real status and balance, so Tolra's money owed equals SliQ's Aged
  // Debtors straight after the import. Unpaid (no payment record), part paid, paid and overpaid (the surplus is the customer's
  // credit) are written as they are; nothing is left "Payment to confirm". Evidence that disagrees is an exception that stops
  // the write until the source is fixed or the invoice is excluded by number.
  const balances = [];
  const exceptions = [];
  const paymentsSupplied = hasFile("payments");
  const statusWordConflicts = [];

  const invoicePlans = invA.map(({ h, a }) => {
    const key = normNumber(h.number);
    const sourceKey = normNumber(h.sourceNumber);
    const held = [];
    if (dupNos.has(`i:${key}`)) held.push("duplicate document number in the source (an invoice and a credit note)");
    const party = partyFor("invoice", h, h.customer, held);
    const oldId = organizationId ? legacyId(organizationId, "invoices", key) : null;
    collide("invoices", "invoices", h.number, oldId, h, held, "number");
    reviewHeld("invoice", h, held);

    const ps = (paymentsByInv.get(sourceKey) ?? []).map((p, i) => ({ ...p, ordinal: i }));
    const distinct = ps.filter((p, i) => ps.findIndex((o) => o.date === p.date && o.amount === p.amount && (o.reference ?? "").trim() === (p.reference ?? "").trim()) === i);
    const paid = sum((dupPayInvoices.has(sourceKey) ? distinct : ps).map((p) => p.amount));
    const bad = ps.filter((p) => p.amount <= 0);
    const undated = ps.filter((p) => !p.date);
    const allocated = allocatedByInv.get(sourceKey) ?? 0;
    const issued = h.status === "sent";
    const raw = h.statusRaw ?? "";
    const says = /part/i.test(raw) ? "part paid" : /unpaid|overdue|outstanding/i.test(raw) ? "unpaid" : /\bpaid\b/i.test(raw) ? "paid" : null;
    let state;
    let reason = null;
    let exception = false;
    let writePayments = false;
    const fail = (why) => {
      state = "exception";
      reason = why;
      exception = true;
    };
    if (!issued) {
      state = h.status === "void" ? "void" : "draft";
      if (ps.length) {
        reason = "payments recorded against a draft or cancelled invoice";
        exceptions.push({ number: h.number, reason, payments: ps.length, blocksWrite: false });
      }
    } else if (!paymentsSupplied) {
      state = "unknown";
      reason = "no payments file supplied: the balance cannot be known";
      exception = true;
    } else if (sharedInv.has(sourceKey) && ps.length) fail(`${ps.length} payment row(s) name SliQ number ${h.sourceNumber}, which ${invBySource.get(sourceKey).length} invoices share: they cannot be told apart`);
    else if (dupPayInvoices.has(sourceKey)) fail("the same payment (date, amount, reference) is listed more than once: duplicates are never summed");
    else if (bad.length) fail("a payment of zero or less (refund or error)");
    else if (undated.length) fail(`${undated.length} payment(s) have no date`);
    else if (h.amountPaid !== null && h.amountPaid !== undefined && h.amountPaid !== paid) {
      fail(ps.length ? `the invoice list says ${poundsString(h.amountPaid)} paid but the payment records add up to ${poundsString(paid)}` : `the invoice list says ${poundsString(h.amountPaid)} paid but there are no payment records`);
    } else if (allocated > 0) fail(`credit note allocation(s) of ${poundsString(allocated)} touch this invoice; an allocation is not cash and is not imported, so its balance would be wrong (cash on file: ${poundsString(paid)})`);
    else if (says === "paid" && paid < h.gross) fail(`the status word "${raw}" says paid but the payment records add up to ${poundsString(paid)} of ${poundsString(h.gross)}`);
    else {
      state = paid === 0 ? "unpaid" : paid < h.gross ? "PARTIAL" : paid === h.gross ? "paid" : "overpaid";
      if (state === "overpaid") reason = `paid ${poundsString(paid)} on ${poundsString(h.gross)}: the ${poundsString(paid - h.gross)} surplus is the customer's credit`;
      writePayments = true;
    }
    if (exception) exceptions.push({ number: h.number, reason, blocksWrite: held.length === 0 });
    // The status word is never trusted for payment; any other disagreement with the payments file is listed.
    const cash = state === "paid" || state === "overpaid" ? "paid" : state === "PARTIAL" ? "part paid" : state === "unpaid" ? "unpaid" : null;
    if (issued && says && cash && says !== cash) statusWordConflicts.push({ number: h.number, statusWord: raw, fromPayments: state, note: "payment state comes from the payments file only", ...where(h) });
    balances.push({
      number: h.number, sourceNumber: h.sourceNumber, documentKind: "invoice", gross: h.gross, paid: ps.length ? paid : null, allocated: allocated || null, balance: ps.length || paymentsSupplied ? h.gross - paid : null,
      state, payments: ps.length, exception, held: held.length > 0, reason, statusWord: raw || null, ...where(h),
    });
    return { h, a, key, oldId, held, ps, writePayments, state, paid, exception, party };
  });

  const missing = {
    invoicesWithoutCustomer: ambiguities.filter((x) => x.kind === "invoice" && x.status === "unmatched").map((x) => ({ number: x.number, customer: x.reference, file: x.file, row: x.row })),
    quotesWithoutCustomer: [],
    creditNotesWithoutCustomer: [],
    orphanLines,
    ambiguousLines,
    paymentsForUnknownInvoice,
    allocationsWithoutDocument: allocations.filter((a) => a.status !== "ok"),
  };

  const quotePlans = quotesA.map(({ h: q, a }) => {
    const key = normNumber(q.number);
    const held = [];
    if (dupNos.has(`q:${key}`)) held.push("duplicate document number in the source");
    const party = partyFor("quote", q, q.customer, held);
    const oldId = organizationId ? legacyId(organizationId, "quotes", key) : null;
    collide("quotes", "quotes", q.number, oldId, q, held, "number");
    reviewHeld("quote", q, held);
    return { q, a, key, oldId, held, party };
  });
  missing.quotesWithoutCustomer = ambiguities.filter((x) => x.kind === "quote" && x.status === "unmatched").map((x) => ({ number: x.number, customer: x.reference, file: x.file, row: x.row }));
  // Credit notes are never written: their customer is only listed (it decides nothing).
  missing.creditNotesWithoutCustomer = creditA.filter(({ h }) => cust.match(h.customer).status !== "ok").map(({ h }) => ({ number: h.number, customer: h.customer, ...where(h) }));
  if (target) {
    for (const c of customers) {
      const hit = target.customerNames.get(normaliseName(c.tolraName));
      if (hit) collisions.customerReview.push({ sliqName: c.name, tolraNames: hit, ...where(c), note: "same normalised name as an existing Tolra customer: added as a separate record, review before merging" });
    }
    for (const c of suppliers) {
      const hit = target.supplierNames.get(normaliseName(c.tolraName));
      if (hit) collisions.supplierReview.push({ sliqName: c.name, tolraNames: hit, ...where(c), note: "same normalised name as an existing Tolra supplier: added as a separate record, review before merging" });
    }
  }

  // ---- credit notes ----
  const creditNotes = creditA.map(({ h, a }) => {
    const ref = h.relatedInvoice;
    const linked = ref ? invBySource.has(normNumber(ref)) : false;
    const gross = h.gross;
    const ck = normNumber(h.number);
    return {
      number: h.number, source: h.source, customer: h.customer, date: h.date, statedGross: gross, proposedGross: gross === null ? null : -Math.abs(gross),
      linkedInvoice: linked ? invBySource.get(normNumber(ref))[0].sourceNumber : null,
      link: !ref ? "no invoice reference in the source: listed unlinked" : linked ? "linked" : `reference ${ref} not found in the invoice file: listed unlinked`,
      lines: a.lines.length, written: false,
      allocated: allocatedByCredit.get(ck) ?? null,
      allocations: allocations.filter((x) => normNumber(x.creditNote) === ck).map((x) => ({ invoice: x.invoice, amount: x.amount, status: x.status })),
      representation: linked ? `would be a negative document (${poundsString(gross === null ? null : -Math.abs(gross))}) linked to ${ref}` : `would be a negative document (${poundsString(gross === null ? null : -Math.abs(gross))}), unlinked`,
      ...where(h),
    };
  });

  const creditResolution = resolveCreditNotes({ creditNotes, allocations, invoiceNumbers: new Set(invBySource.keys()), resolutions });

  // ---- credit notes imported as customer credit (resolution "import-as-credit") ----
  // Tolra holds a credit note against an invoice, and a customer's credit as what is paid or credited beyond an invoice (the same
  // way as an overpayment). A credit note SliQ links to an invoice is applied to that invoice. One with no link is applied to an
  // imported invoice of the same customer that carries it: the latest one paid in full on or before the credit note's date (then
  // the earliest paid after it, then any invoice written), so money owed is unchanged and the customer's credit grows by it. Each
  // customer's balance (owed less credit) then equals Aged Debtors.
  const importAsCredit = new Set(creditResolution.covered.filter((c) => c.decision === "import-as-credit").map((c) => c.number));
  const creditPlans = creditA.filter(({ h }) => importAsCredit.has(h.number)).map(({ h }) => {
    const held = [];
    const gross = Math.abs(h.gross ?? 0);
    const party = partyFor("credit_note", h, h.customer, held);
    let carrier = null;
    let via = null;
    if (party) {
      const written = (p) => !p.held.length && !p.exception && p.h.status === "sent";
      if (h.relatedInvoice) {
        const hits = invoicePlans.filter((p) => normNumber(p.h.sourceNumber) === normNumber(h.relatedInvoice));
        if (hits.length !== 1) held.push(`SliQ links it to ${h.relatedInvoice}, which ${hits.length ? "more than one invoice shares" : "is not in the invoice file"}`);
        else if (!written(hits[0])) held.push(`SliQ links it to ${h.relatedInvoice}, which is not being written`);
        else if (hits[0].party?.entry !== party.entry) held.push(`SliQ links it to ${h.relatedInvoice}, which is another customer's`);
        else [carrier, via] = [hits[0], "linked in SliQ"];
      } else {
        const own = invoicePlans.filter((p) => written(p) && p.party?.entry === party.entry);
        const paid = own.filter((p) => p.state === "paid" || p.state === "overpaid");
        const byDate = (a, b) => String(a.h.date).localeCompare(String(b.h.date)) || a.h._row - b.h._row;
        const before = paid.filter((p) => String(p.h.date) <= String(h.date ?? "")).sort(byDate);
        const after = paid.filter((p) => String(p.h.date) > String(h.date ?? "")).sort(byDate);
        carrier = before.at(-1) ?? after[0] ?? [...own].sort(byDate).at(-1) ?? null;
        via = carrier ? (paid.includes(carrier) ? "no link in SliQ: carried as customer credit on a paid invoice of the customer" : "no link in SliQ and no paid invoice: applied to the customer's latest invoice") : null;
        if (!carrier) held.push("no imported invoice of this customer can carry the credit");
      }
    }
    if (!h.date) held.push("the credit note has no date");
    if (target?.creditNotes?.has(h.number) && target.mapped.creditNotes?.get(String(legacyId(organizationId, "credit_notes", normNumber(h.number)))) !== target.creditNotes.get(h.number)) {
      held.push("its number is already used by a different Tolra credit note");
      collisions.creditNotes = [...(collisions.creditNotes ?? []), { number: h.number, ...where(h) }];
    }
    if (held.length) exceptions.push({ number: h.number, reason: `credit note to import as customer credit: ${held.join("; ")}`, blocksWrite: !isExcluded(h) });
    return { h, held, party, carrier, via, gross };
  });
  const creditOn = new Map();
  for (const c of creditPlans.filter((x) => !x.held.length)) creditOn.set(c.carrier, [...(creditOn.get(c.carrier) ?? []), c]);
  for (const c of creditNotes) {
    const cp = creditPlans.find((x) => x.h.number === c.number);
    if (cp && !cp.held.length) Object.assign(c, { written: true, carriedOn: cp.carrier.h.number, carriedVia: cp.via, representation: `written as an issued Tolra credit note applied to ${cp.carrier.h.number} (${cp.via})` });
  }

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

  const poRows = poCopies.rows;
  const poPlans = poRows.map((po) => {
    const key = normNumber(po.number);
    const held = [];
    const party = partyFor("purchase_order", po, po.supplier, held);
    if (!po.status) held.push("status not in the source: a purchase order cannot be written without one (none is invented)");
    const oldId = organizationId ? legacyId(organizationId, "purchase_orders", key) : null;
    collide("purchaseOrders", "purchaseOrders", po.number, oldId, po, held, "number");
    if (isExcluded(po)) held.push("excluded by number (operator decision)");
    return { po, key, oldId, held, party };
  });
  for (const m of matchEntries) if (m.used === 0 && KINDS.includes(m.e?.kind ?? "invoice")) matchProblems.push(`customerMatches entry ${m.i + 1} (${m.e?.kind ?? "invoice"} ${m.e?.number}) fits no document in the source`);


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
    const src = normNumber((p.h ?? p.q).sourceNumber);
    const shared = sharedInv.has(src) || sharedQuote.has(src);
    const reasonWithheld = shared ? `SliQ number ${src} is used by more than one document: its lines cannot be told apart` : p.a.lines.length === 0 ? "no lines in the source" : p.a.lines.some((x) => !x.vat.ok) ? "a line's VAT could not be resolved" : p.a.lines.some((x) => x.net === null || x.l.quantity === null) ? "a line's net could not be worked out exactly" : p.a.lines.some((x) => x.l.quantity <= 0 || x.l.unitPrice < 0) ? "a line has a zero or negative quantity or a negative price" : null;
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
    purchaseOrders: poPlans.filter((p) => p.held.length === 0).map((p) => ({ ...p.po, oldId: p.oldId, sourceRef: p.po.sourceNumber, supplierName: p.party.entry.tolraName, matchedVia: p.party.via })),
    quotes: quotePlans.filter((p) => p.held.length === 0).map((p) => {
      const wl = linesFor(p);
      return { ...p.q, oldId: p.oldId, sourceRef: p.q.sourceNumber, customerName: p.party.entry.tolraName, customerAccount: p.party.entry.key ?? null, matchedVia: p.party.via, lines: wl.lines, linesWithheld: wl.withheld };
    }),
    invoices: invoicePlans.filter((p) => p.held.length === 0).map((p) => {
      const wl = linesFor(p);
      const latest = p.ps.map((x) => x.date).filter(Boolean).sort().at(-1) ?? null;
      let final;
      if (p.h.status !== "sent") final = { status: p.h.status, amountPaid: 0, paidAt: null, unverified: false };
      else if (p.writePayments) {
        // Unpaid stays issued ('sent') and is owed in full; overpaid is paid, its surplus the customer's credit (lib/receivables.ts).
        const status = p.state === "unpaid" ? "sent" : p.state === "PARTIAL" ? "partial" : "paid";
        final = { status, amountPaid: p.paid, paidAt: status === "paid" ? latest : null, unverified: false };
      } else final = { status: "sent", amountPaid: 0, paidAt: null, unverified: true }; // an exception: the write is refused while one is left
      const pays = p.writePayments
        ? p.ps.map((x) => ({ oldId: oid("payments", paymentIdentity(normNumber(p.h.number), x.date, x.amount, x.ordinal)), amountPence: x.amount, date: x.date, method: methodFor(x.method), reference: x.reference, rawMethod: x.method }))
        : [];
      // Credit notes applied to this invoice (import-as-credit): credited_amount, and the status they leave it in (034's rule).
      const credits = (creditOn.get(p) ?? []).map((c) => ({ number: c.h.number, amountPence: c.gross, date: c.h.date }));
      const credited = sum(credits.map((c) => c.amountPence));
      if (credited > 0 && !final.unverified && p.h.gross - final.amountPaid - credited <= 0 && final.status !== "paid") {
        final.status = final.amountPaid > 0 ? "paid" : "credited";
        final.paidAt = final.status === "paid" ? credits.map((c) => c.date).sort().at(-1) : null;
      }
      final.credited = credited;
      return { ...p.h, oldId: p.oldId, sourceRef: p.h.sourceNumber, customerName: p.party.entry.tolraName, customerAccount: p.party.entry.key ?? null, matchedVia: p.party.via, lines: wl.lines, linesWithheld: wl.withheld, payments: pays, credits, final };
    }),
  };
  plan.creditNotes = creditPlans.filter((c) => !c.held.length && !isExcluded(c.h)).map((c) => ({
    number: c.h.number, oldId: oid("credit_notes", normNumber(c.h.number)), customerName: c.party.entry.tolraName, customerAccount: c.party.entry.key ?? null, date: c.h.date,
    reason: [c.h.reason, `SliQ credit note ${c.h.number}${c.via === "linked in SliQ" ? ` against ${c.h.relatedInvoice}` : ", no invoice link in SliQ"}: applied to ${c.carrier.h.number} on import (${c.via}).`].filter(Boolean).join(" "),
    netPence: Math.abs(c.h.net ?? 0), vatPence: Math.abs(c.h.vat ?? 0), grossPence: c.gross, carrierNumber: c.carrier.h.number, carrierOldId: c.carrier.oldId, via: c.via,
  }));
  // Money owed and customer credit straight after the import, from what would be written (lib/receivables.ts owed / customerCredit).
  const collectible = (i) => !["paid", "draft", "void", "credited"].includes(i.final.status) && !i.final.unverified;
  const owedAfterImport = plan.invoices.filter(collectible).reduce((n, i) => n + Math.max(0, i.gross - i.final.amountPaid - i.final.credited), 0);
  const creditAfterImport = plan.invoices.filter((i) => !["draft", "void"].includes(i.final.status) && !i.final.unverified).reduce((n, i) => n + Math.max(0, i.final.amountPaid + i.final.credited - i.gross), 0);
  const unmappedMethods = [...new Set(plan.invoices.flatMap((i) => i.payments).filter((p) => p.rawMethod && !p.method).map((p) => p.rawMethod))];

  const held = [
    ...invoicePlans.filter((p) => p.held.length).map((p) => ({ documentKind: "invoice", number: p.h.number, reasons: p.held, ...where(p.h) })),
    ...quotePlans.filter((p) => p.held.length).map((p) => ({ documentKind: "quote", number: p.q.number, reasons: p.held, ...where(p.q) })),
    ...poPlans.filter((p) => p.held.length).map((p) => ({ documentKind: "purchase_order", number: p.po.number, reasons: p.held, ...where(p.po) })),
    ...stockPlans.filter((p) => p.held.length).map((p) => ({ documentKind: "stock_item", number: p.p.code, reasons: p.held, ...where(p.p) })),
    ...creditNotes.filter((c) => !plan.creditNotes.some((x) => x.number === c.number)).map((c) => ({ documentKind: "credit_note", number: c.number, reasons: [creditPlans.find((x) => x.h.number === c.number)?.held.join("; ") || (isExcluded(c) ? "excluded by number (operator decision)" : "not imported: the resolutions file records it outside Tolra (or it is not needed)")], file: c.file, row: c.row })),
  ];
  const unresolvedReview = needsReview.filter((n) => n.blocksWrite && !n.excluded);
  const state = (s) => balances.filter((b) => b.state === s);
  const allKnown = new Set([...allInvNos.keys(), ...allInvSource.keys(), ...quoteByNo.keys(), ...quoteBySource.keys(), ...poRows.flatMap((p) => [normNumber(p.number), normNumber(p.sourceNumber)]), ...otherNumbers.map(normNumber)]);
  const unresolvedMatches = ambiguities.filter((x) => x.blocksWrite);
  const unresolvedPayments = exceptions.filter((x) => x.blocksWrite);
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
    // Every copy of a number SliQ used more than once, with the Tolra number it gets (decision 2). Nothing is dropped.
    renames,
    customerMatching: {
      note: "Documents are matched to a customer (a purchase order to a supplier) by account, or by a name exactly one record has; anything else stops the write until the resolutions file names the account (customerMatches) or gives a customer its own Tolra name (customerNames).",
      ambiguities, problems: matchProblems,
      renamedParties: [...customers, ...suppliers].filter((c) => c.renamedFrom).map((c) => ({ account: c.key, sliqName: c.renamedFrom, tolraName: c.tolraName })),
      byVia: Object.entries([...invoicePlans, ...quotePlans, ...poPlans].filter((p) => p.party).reduce((m, p) => ({ ...m, [p.party.via]: (m[p.party.via] ?? 0) + 1 }), {})).map(([via, n]) => ({ via, documents: n })),
    },
    missingRelationships: missing,
    documentAmounts: { documentsChecked: invA.length + creditA.length + quotesA.length, withLines: [...invA, ...creditA, ...quotesA].filter((x) => x.a.lines.length).length, mismatches, documents: docFigures },
    balances: {
      note: "Payment state comes only from the payments file. A status word such as Unpaid or Paid is never trusted for payment.",
      summary: Object.fromEntries(["paid", "PARTIAL", "unpaid", "overpaid", "exception", "unknown", "draft", "void"].map((s) => [s, state(s).length])),
      partial: balances.filter((b) => b.state === "PARTIAL"),
      unpaid: balances.filter((b) => b.state === "unpaid"),
      customerCredit: balances.filter((b) => b.state === "overpaid").map((b) => ({ number: b.number, gross: b.gross, paid: b.paid, credit: b.paid - b.gross, file: b.file, row: b.row })),
      // Money owed straight after the import (unpaid and part-paid balances of the invoices written), and the customers' credit.
      owedAfterImport,
      creditAfterImport,
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
      invoicesUnpaid: plan.invoices.filter((i) => i.final.status === "sent" && !i.final.unverified).length,
      renamedDocuments: renames.filter((x) => !x.keeps).length,
      invoicesWithoutLines: plan.invoices.filter((i) => i.linesWithheld).length,
      creditNotes: plan.creditNotes.length, creditNotesHeld: creditNotes.length - plan.creditNotes.length, unmappedPaymentMethods: unmappedMethods,
    },
    unresolvedReviewCount: unresolvedReview.length,
    unresolvedMatchCount: unresolvedMatches.length,
    unresolvedPaymentCount: unresolvedPayments.length,
    writable: loaded.errors.length === 0 && !mp.isStub && unknownExcluded.length === 0 && creditResolution.problems.length === 0 && matchProblems.length === 0,
  };
  // For jobs-plan.mjs: the same customer match (customerMatches entries of kind job / sales_order included) and the same exclusions.
  // Not enumerable, so the plan still compares and serialises as plain data.
  Object.defineProperty(plan, "matchCustomer", { value: (kind, h, ref) => resolvedParty(kind, h, ref) });
  Object.defineProperty(plan, "isExcluded", { value: isExcluded });
  Object.defineProperty(plan, "unusedMatchEntries", { value: (kinds) => matchEntries.filter((m) => m.used === 0 && kinds.includes(m.e?.kind ?? "invoice")).map((m) => ({ entry: m.i + 1, kind: m.e.kind, number: m.e.number })) });
  return { report, plan };
}

/** The ambiguity report as CSV: one row per document (or customer) that stops the write until it is resolved or excluded. */
export function renderAmbiguityCsv(r) {
  const cell = (v) => {
    const t = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
  };
  const head = ["kind", "tolra_number", "sliq_number", "file", "row", "reference_as_written", "status", "reason", "candidates", "stops_write", "resolve_with"];
  const rows = r.customerMatching.ambiguities.map((x) => [
    x.kind, x.number, x.sourceNumber, x.file, x.row, x.reference, x.status, x.reason, x.candidates.map((c) => `${c.account ?? "no account"}=${c.name} (row ${c.row})`).join("; "),
    x.blocksWrite ? "yes" : "no", x.resolveWith ? x.resolveWith : ["customer", "supplier"].includes(x.kind) ? `customerNames: {"party":"${x.kind}","account":"${x.number}","name":"<a name of its own>"}` : `customerMatches: {"kind":"${x.kind}","number":"${x.sourceNumber}","row":${x.row},"account":"<account>"} or --exclude ${x.number}`,
  ]);
  return `${[head, ...rows].map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
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
  L.push("Numbers SliQ used more than once: every copy is written under its own Tolra number, the same every run (the earliest by date keeps the number, then -B, -C ...). The SliQ number is kept as the document's source reference. Lines and payments under a shared number cannot be told apart: each copy gets its header only, and a payment under it stops the write.", "", ...table(["Kind", "SliQ number", "Tolra number", "Keeps it", "Date", "Customer/supplier", "Row"], r.renames.map((d) => [d.kind, d.sourceNumber, d.number, d.keeps ? "yes" : "no", d.date, d.party, `${d.file}:${d.row}`])));
  L.push("An invoice and a credit note with the same number (the invoice is held):", "", ...table(["Kind", "Number", "Rows"], r.duplicates.documents.map((d) => [d.kind, d.number, d.rows.map((x) => `${x.file}:${x.row}`).join(", ")])));
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
  L.push(`Money owed in Tolra straight after the import: **${money(r.balances.owedAfterImport)}** (unpaid and part-paid balances); customers' credit (overpayments): **${money(r.balances.creditAfterImport)}**. Compare with SliQ's Aged Debtors. No imported invoice is left "Payment to confirm".`, "");
  L.push("### PARTIAL (payments are written as legacy payment rows; the invoice shows part paid)", "", ...table(["Invoice", "Total", "Paid", "Balance", "Payments", "Status word"], r.balances.partial.map((x) => [x.number, money(x.gross), money(x.paid), money(x.balance), x.payments, x.statusWord])));
  L.push("### Unpaid (no payment record: issued and owed in full)", "", ...table(["Invoice", "Total", "Status word"], r.balances.unpaid.map((x) => [x.number, money(x.gross), x.statusWord])));
  L.push("### Overpaid (every payment is written; the invoice is paid and the surplus is the customer's credit)", "", ...table(["Invoice", "Total", "Paid", "Credit"], r.balances.customerCredit.map((x) => [x.number, money(x.gross), money(x.paid), money(x.credit)])));
  L.push("### Duplicate payment rows (never summed; the invoice is left to confirm)", "", ...table(["Invoice", "Date", "Amount", "Reference", "Times", "Rows"], r.duplicatePayments.map((x) => [x.invoiceNumber, x.date, money(x.amount), x.reference, x.times, x.rows.map((y) => y.row).join(", ")])));
  L.push("### Payment exceptions (**a write is refused while any is left**: fix the source or exclude the invoice by number)", "", ...table(["Invoice", "Why", "Stops the write"], r.balances.exceptions.map((x) => [x.number, x.reason, x.blocksWrite ? "YES" : "no (held or not issued)"])));
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
  L.push("## 14. Customer matching (decision 3: never on a name alone)", "");
  L.push(r.customerMatching.note, "", ...table(["Matched by", "Documents"], r.customerMatching.byVia.map((x) => [x.via, x.documents])));
  L.push(`Ambiguous or unmatched (also in ambiguity.csv). **A write is refused while any row says YES.** Resolve each in the resolutions file (customerMatches: kind, number, row, account; customerNames: account, name) or exclude the document by number.`, "",
    ...table(["Kind", "Tolra number", "SliQ number", "Reference as written", "Status", "Why", "Candidates", "Row", "Stops the write"], r.customerMatching.ambiguities.map((x) => [x.kind, x.number, x.sourceNumber, x.reference, x.status, x.reason, x.candidates.map((c) => `${c.account ?? "no account"} ${c.name} (row ${c.row})`).join("; "), x.row, x.blocksWrite ? "YES" : "no (excluded)"])));
  if (r.customerMatching.problems.length) L.push("**Resolutions that could not be applied (these stop a write):**", "", ...r.customerMatching.problems.map((p) => `* ${p}`), "");
  L.push("Customers and suppliers given their own Tolra name (the SliQ name is kept in the notes):", "", ...table(["Account", "SliQ name", "Tolra name"], r.customerMatching.renamedParties.map((x) => [x.account, x.sliqName, x.tolraName])));
  L.push("## 15. What a write would do", "");
  L.push(...table(["Item", "Count"], Object.entries(r.writePlan).filter(([, v]) => !Array.isArray(v)).map(([k, v]) => [k, v])));
  L.push("Held (not written):", "", ...table(["Kind", "Number", "Why"], r.held.map((h) => [h.documentKind, h.number, h.reasons.join("; ")])));
  if (r.writePlan.unmappedPaymentMethods.length) L.push(`Payment methods not in the mapping (stored as blank): ${r.writePlan.unmappedPaymentMethods.join(", ")}.`, "");
  return L.join("\n");
}
