/**
 * Synthetic SliQ-shaped export for the release 152 proofs (tests/db/sliq-import-route-152.test.ts, tests/local/sliq-import-152-clones.test.ts):
 * 12 customers, 3 suppliers, 60 invoices INV-1001..1060, 60 payments (full, part, same-day splits, none), 5 credit notes.
 */
const enc = new TextEncoder();
export const MAPPING = {
  version: 1, confirmed: true, dateFormat: "DD/MM/YYYY",
  entities: {
    customers: { file: "customers.csv", columns: { key: "Account", name: "Name" } },
    suppliers: { file: "suppliers.csv", columns: { key: "Account", name: "Name" } },
    invoices: { file: "invoices.csv", columns: { ref: "Invoice No", customerKey: "Account", date: "Date", gross: "Gross", net: "Net", vat: "VAT" } },
    payments: { file: "payments.csv", columns: { key: "Receipt", invoiceRef: "Invoice No", date: "Date", amount: "Amount" } },
    creditNotes: { file: "credits.csv", columns: { ref: "Credit No", invoiceRef: "Invoice No", date: "Date", gross: "Gross", reason: "Reason" } },
  },
};
export const N_CRD = 5;
export const N_INV = 60;
/** Synthetic SliQ export: 12 customers, 3 suppliers, 60 invoices INV-1001..1060, payments: full, part, two-part, none. */
export function syntheticFiles() {
  const cust = ["Account,Name", ...Array.from({ length: 12 }, (_, i) => `ACC${String(i + 1).padStart(3, "0")},Synthetic Customer ${i + 1} Ltd`)].join("\r\n");
  const supp = ["Account,Name", "SUP001,Synthetic Steel Ltd", "SUP002,Synthetic Tools Ltd", "SUP003,Synthetic Carriers Ltd"].join("\r\n");
  const inv: string[] = ["Invoice No,Account,Date,Net,VAT,Gross"];
  const pay: string[] = ["Receipt,Invoice No,Date,Amount"];
  let receipt = 0;
  for (let i = 0; i < N_INV; i += 1) {
    const ref = `INV-${1001 + i}`;
    const net = 100 * (i + 1) + 0.5;
    const vat = Math.round(net * 20) / 100;
    const gross = Math.round((net + vat) * 100) / 100;
    inv.push(`${ref},ACC${String((i % 12) + 1).padStart(3, "0")},${String((i % 28) + 1).padStart(2, "0")}/0${(i % 9) + 1}/2026,${net.toFixed(2)},${vat.toFixed(2)},${gross.toFixed(2)}`);
    const date = `${String((i % 28) + 1).padStart(2, "0")}/10/2026`;
    if (i % 4 === 0) pay.push(`R${++receipt},${ref},${date},${gross.toFixed(2)}`);
    else if (i % 4 === 1) pay.push(`R${++receipt},${ref},${date},${(Math.round(gross * 50) / 100).toFixed(2)}`);
    else if (i % 4 === 2) {
      const half = Math.round(gross * 50) / 100;
      // Two receipts the same day; for an even total the two halves are the same amount: a legitimate split (different receipt keys).
      pay.push(`R${++receipt},${ref},${date},${half.toFixed(2)}`, `R${++receipt},${ref},${date},${(Math.round((gross - half) * 100) / 100).toFixed(2)}`);
    }
  }
  // Credit notes against five unpaid invoices (i % 4 === 3), 10.00 each, after the invoice.
  const crd = ["Credit No,Invoice No,Date,Gross,Reason", ...Array.from({ length: N_CRD }, (_, k) => `CRD-${2001 + k},INV-${1001 + 3 + 4 * k},20/10/2026,10.00,Synthetic credit ${k + 1}`)];
  const f = (name: string, text: string) => ({ name, bytes: enc.encode(text + "\r\n") });
  return { customers: f("customers.csv", cust), suppliers: f("suppliers.csv", supp), invoices: f("invoices.csv", inv.join("\r\n")), payments: f("payments.csv", pay.join("\r\n")),
    creditNotes: f("credits.csv", crd.join("\r\n")) };
}
