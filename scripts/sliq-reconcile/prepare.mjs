// Derives, from the loaded SliQ records, everything the comparisons need on the source side: document keys, duplicates, which
// payments/credits/refunds belong to which invoice, and each invoice's payment state. Nothing is invented: a figure that the
// export does not settle is null and the reasons are kept in `unverified`.
import { normNumber, paymentIdentity } from "../sliq-import/ids.mjs";

import { P } from "./rows.mjs";
import { safeRef } from "./safe.mjs";
import { sum } from "./util.mjs";

const REVERSE_CHARGE = /reverse[\s-]*charge|\bd\.?r\.?c\.?\b|\bCIS\b/i;

const keyed = (rows) => rows.map((r) => ({ ...r, key: normNumber(r.number), ref: safeRef(r.number) }));

export function prepareSource(src) {
  const invoices = keyed(src.invoices);
  const credits = keyed(src.creditNotes);
  const quotes = keyed(src.quotes);
  const pos = keyed(src.purchaseOrders);
  const salesOrders = keyed(src.salesOrders);
  const jobs = keyed(src.jobs);
  const bills = keyed(src.supplierBills);

  const count = (rows) => {
    const m = new Map();
    for (const r of rows) m.set(r.key, (m.get(r.key) ?? 0) + 1);
    return m;
  };
  const invCredit = count([...invoices, ...credits]);
  const dup = {
    invoices: new Set(invoices.filter((r) => invCredit.get(r.key) > 1).map((r) => r.key)),
    credits: new Set(credits.filter((r) => invCredit.get(r.key) > 1).map((r) => r.key)),
    quotes: new Set(quotes.filter((r) => count(quotes).get(r.key) > 1).map((r) => r.key)),
    pos: new Set(pos.filter((r) => count(pos).get(r.key) > 1).map((r) => r.key)),
    salesOrders: new Set(salesOrders.filter((r) => count(salesOrders).get(r.key) > 1).map((r) => r.key)),
    jobs: new Set(jobs.filter((r) => count(jobs).get(r.key) > 1).map((r) => r.key)),
    bills: new Set(bills.filter((r) => count(bills).get(r.key) > 1).map((r) => r.key)),
  };

  const invByKey = new Map(invoices.map((r) => [r.key, r]));
  const creditByKey = new Map(credits.map((r) => [r.key, r]));

  const payByInv = new Map();
  src.payments.forEach((p) => {
    const k = normNumber(p.invoiceNumber);
    if (!payByInv.has(k)) payByInv.set(k, []);
    payByInv.get(k).push(p);
  });
  for (const list of payByInv.values()) list.forEach((p, i) => (p.ordinal = i));
  const allocByInv = new Map();
  const allocByCredit = new Map();
  for (const a of src.allocations) {
    const ik = normNumber(a.invoiceNumber);
    const ck = normNumber(a.creditNoteNumber);
    a.ok = invByKey.has(ik) && creditByKey.has(ck);
    if (!allocByInv.has(ik)) allocByInv.set(ik, []);
    allocByInv.get(ik).push(a);
    if (!allocByCredit.has(ck)) allocByCredit.set(ck, []);
    allocByCredit.get(ck).push(a);
  }
  const refundByInv = new Map();
  for (const r of src.refunds) {
    const k = normNumber(r.invoiceNumber);
    if (!refundByInv.has(k)) refundByInv.set(k, []);
    refundByInv.get(k).push(r);
  }

  const wordSays = (raw) => (/part/i.test(raw) ? "part" : /unpaid|overdue|outstanding/i.test(raw) ? "unpaid" : /\bpaid\b/i.test(raw) ? "paid" : null);

  for (const s of invoices) {
    const issued = s.status === "sent";
    const st = { issued, unverified: [], payUnv: [], credUnv: [], refUnv: [], paid: null, credited: 0, refunded: 0, balance: null };
    s.state = st;
    const pays = payByInv.get(s.key) ?? [];
    st.payments = pays;
    s.rc = REVERSE_CHARGE.test(`${s.notes ?? ""} ${s.vatCode ?? ""}`) || (src.profile.reverseChargeCodes ?? []).some((c) => s.vatCode && c.toLowerCase() === s.vatCode.trim().toLowerCase());
    if (!issued) continue;
    if (!src.supplied.payments) st.payUnv.push("the SliQ export has no payments file");
    else {
      st.paid = sum(pays.map((p) => p.amount));
      const seen = new Map();
      for (const p of pays) {
        const id = `${p.date ?? ""}|${p.amount}|${(p.reference ?? "").trim()}`;
        seen.set(id, (seen.get(id) ?? 0) + 1);
      }
      if ([...seen.values()].some((n) => n > 1)) st.payUnv.push("the same receipt (date, amount, reference) is listed more than once: two real payments or one entered twice cannot be told apart");
      if (s.amountPaid !== null && s.amountPaid !== st.paid) st.payUnv.push(`the invoice list says ${P(s.amountPaid)} paid but the payment records add up to ${P(st.paid)}`);
    }
    const allocs = allocByInv.get(s.key) ?? [];
    if (allocs.some((a) => !a.ok)) st.credUnv.push("a credit allocation points at a credit note or invoice that is not in the export");
    st.credited = sum(allocs.filter((a) => a.ok).map((a) => a.amount));
    st.refunded = sum((refundByInv.get(s.key) ?? []).map((r) => r.amount));
    if (st.paid !== null && st.payUnv.length === 0 && s.gross !== null) {
      const words = wordSays(s.statusRaw ?? "");
      const provisional = s.gross - st.paid - st.credited + st.refunded;
      if (words === "paid" && provisional > 0) st.payUnv.push(`the status word "${s.statusRaw}" says paid but the payments, credits and refunds leave ${P(provisional)} owed`);
      if (words === "part" && st.paid === 0) st.payUnv.push(`the status word "${s.statusRaw}" says part paid but no payment is recorded`);
    }
    st.unverified = [...st.payUnv, ...st.credUnv, ...st.refUnv];
    if (st.unverified.length === 0 && st.paid !== null && s.gross !== null) st.balance = s.gross - st.paid - st.credited + st.refunded;
  }

  // Credit notes: how much of each is allocated.
  for (const c of credits) {
    c.allocated = sum((allocByCredit.get(c.key) ?? []).filter((a) => a.ok).map((a) => a.amount));
    c.absGross = c.gross === null ? null : Math.abs(c.gross);
    c.absNet = c.net === null ? null : Math.abs(c.net);
    c.absVat = c.vat === null ? null : Math.abs(c.vat);
  }

  const customerOf = (ref) => src.customers.resolve(ref);
  const supplierOf = (ref) => src.suppliers.resolve(ref);
  const openQuote = (q) => q.status === "sent";
  const jobOpen = (j) => j.status !== "finished" && j.status !== "cancelled";
  const OPEN_SO = new Set(["open", "confirmed", "in_production", "converted"]);
  const OPEN_PO = new Set(["sent", "confirmed", "partial_received"]);
  return {
    invoices, credits, quotes, pos, salesOrders, jobs, bills, dup, invByKey, creditByKey, payByInv, allocByInv, allocByCredit, refundByInv,
    customerOf, supplierOf, openQuote, jobOpen, OPEN_SO, OPEN_PO, paymentIdentity, wordSays,
  };
}
