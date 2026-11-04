#!/usr/bin/env node
// BB: deterministic fake SliQ exports for two isolated rehearsal companies. No database or network access.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const profile = JSON.parse(readFileSync(new URL("../sliq-import/mappings/synthetic.json", import.meta.url), "utf8"));
const money = pence => `${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, "0")}`;
const csv = value => `"${String(value ?? "").replaceAll('"', '""')}"`;

/** Creates a NEW folder only; never overwrites an export or connects to a database. */
export function generateMockProduction(outDir, count = 300) {
  if (!Number.isSafeInteger(count) || count < 3 || count > 2000) throw new Error("Count must be a whole number from 3 to 2000 per company.");
  if (typeof outDir !== "string" || !outDir.trim()) throw new Error("Choose a new output folder.");
  mkdirSync(outDir, { recursive: false, mode: 0o700 });
  const companies = [];
  for (const [index, tag] of ["alpha", "beta"].entries()) {
    const folder = path.join(outDir, tag);
    mkdirSync(folder, { mode: 0o700 });
    const files = { ...profile.files, ...profile.jobsImport.files };
    const records = Object.fromEntries(Object.keys(files).map(k => [k, []]));
    const totals = { netPence: 0, vatPence: 0, grossPence: 0, paymentsPence: 0, outstandingPence: 0, purchaseOrdersPence: 0 };
    for (let i = 1; i <= count; i++) {
      const n = String(i).padStart(4, "0"), account = `C${n}`, invoice = `INV-${n}`, job = `J-${n}`;
      // Deliberately share account/document numbers across companies to exercise scoped legacy IDs.
      const net = 10000 + i * 5 + index * 500, vat = net / 5, gross = net + vat;
      const paid = i % 3 === 0 ? gross : i % 3 === 1 ? gross / 2 : 0;
      const po = 5000 + i * 5;
      records.customers.push({ key: account, name: `Example ${tag} Customer ${n}`, contact: `Example Person ${n}`, address: ["1 Example Road", "Fake Estate", "Exampletown"], postcode: "TE1 1ST", email: `customer.${n}.${tag}@example.test` });
      records.suppliers.push({ key: `S${n}`, name: `Example ${tag} Supplier ${n}`, email: `supplier.${n}.${tag}@example.test` });
      records.invoices.push({ number: invoice, docType: "Invoice", date: "01/11/2026", dueDate: i % 2 ? "10/11/2026" : "30/11/2026", customer: account, net: money(net), vat: money(vat), gross: money(gross), status: paid === gross ? "Paid" : "Issued", amountPaid: money(paid) });
      records.invoiceLines.push({ documentNumber: invoice, description: `Example part ${n}, fake only`, quantity: "1", unitPrice: money(net), net: money(net), vatRate: "20", vatAmount: money(vat) });
      if (paid) records.payments.push({ invoiceNumber: invoice, date: "03/11/2026", amount: money(paid), method: "BACS", reference: `FAKE-${tag}-${n}` });
      records.jobs.push({ number: job, customer: account, description: `Example job ${n}`, status: "Open", stage: "Machining", dueDate: "20/11/2026", specification: "Synthetic practice part only", value: money(net) });
      records.purchaseOrders.push({ number: `PO-${n}`, supplier: `S${n}`, orderDate: "01/11/2026", deliveryDate: "15/11/2026", total: money(po), status: "Open", jobRef: job });
      totals.netPence += net; totals.vatPence += vat; totals.grossPence += gross;
      totals.paymentsPence += paid; totals.outstandingPence += gross - paid; totals.purchaseOrdersPence += po;
    }
    for (const [kind, spec] of Object.entries(files)) {
      const entries = Object.entries(spec.columns);
      const headers = entries.flatMap(([, header]) => Array.isArray(header) ? header : [header]);
      const lines = [headers.map(csv).join(","), ...records[kind].map(row => entries.flatMap(([field, header]) => Array.isArray(header) ? header.map((_, i) => row[field]?.[i] ?? "") : [row[field] ?? ""]).map(csv).join(","))];
      writeFileSync(path.join(folder, spec.file), lines.join("\r\n") + "\r\n", { flag: "wx", mode: 0o600 });
    }
    companies.push({ label: `Example ${tag} Engineering`, folder: tag, counts: { customers: count, suppliers: count, jobs: count, purchaseOrders: count, invoices: count, payments: records.payments.length }, totals });
  }
  const expected = { format: "tolra-fake-transfer-v1", fakeOnly: true, databaseWrites: 0, asOf: "2026-11-12", companies };
  writeFileSync(path.join(outDir, "expected-reconciliation.json"), JSON.stringify(expected, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return expected;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    let out, count = 300;
    const seen = new Set();
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i], value = args[i + 1];
      if (!["--out", "--count"].includes(flag) || seen.has(flag) || !value || value.startsWith("--")) throw new Error("Use --out NEW_FOLDER [--count 300]. Database, input and write flags are not supported.");
      seen.add(flag);
      if (flag === "--out") out = value;
      else { if (!/^\d+$/.test(value)) throw new Error("Count must be a whole number."); count = Number(value); }
    }
    const result = generateMockProduction(out, count);
    console.log(`Created ${result.companies.length} fake-company export folders. No database connection or writes. Expected totals: expected-reconciliation.json`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
