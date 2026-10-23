/**
 * Demo data: entirely synthetic companies, parts, references and prices (audit SEC12). This file can end up as a
 * publicly downloadable chunk in the build, so it must never contain real customer or commercial details.
 * Pages load it lazily (import()) ONLY in demo mode (NEXT_PUBLIC_DEMO_MODE=true). Test-only fixtures live in
 * tests/fixtures and supabase/fixtures, which are never bundled; scripts/check-bundle.mjs checks the built output.
 *
 * Money is ex-VAT unit prices with 20% VAT added per line (rounded to the penny per line); the stated totals are
 * what the app computes for these lines (checked in tests/unit/money.test.ts).
 */

export type TestLine = { description: string; quantity: number; unitPrice: number; vatPct: number };

export type TestCustomer = { name: string; contactName: string; email: string; phone: string; address: string; notes: string };

export type TestQuote = {
  ref: string;
  customer: string;
  /** ISO date the quote was issued. */
  date: string;
  /** ISO date the quote stops being valid. */
  validUntil: string;
  status: "accepted";
  total: number;
  lines: TestLine[];
};

export type TestSalesOrder = {
  /** The customer's own purchase order number. */
  ref: string;
  customer: string;
  quoteRef: string;
  orderDate: string;
  dueDate: string;
  /** Ex VAT, as printed on the customer PO. */
  value: number;
  status: "despatched" | "closed";
  jobNo: string;
};

export type TestInvoice = {
  ref: string;
  customer: string;
  date: string;
  dueDate: string;
  terms: string;
  quoteRef: string;
  customerPo: string;
  subtotal: number;
  vat: number;
  total: number;
  status: "paid";
  lines: TestLine[];
};

export type TestDeliveryNote = {
  ref: string;
  invoiceRef: string;
  customer: string;
  email: string;
  jobNo: string;
  taxDate: string;
  shipDate: string;
  shipVia: string;
  status: "delivered";
  items: Array<{ description: string; quantity: number }>;
};

export type TestJob = {
  id: string;
  jobNo: string;
  customer: string;
  description: string;
  stage: string;
  dueDate: string;
  value: number;
  status: "on_track";
  specification: string;
  drawingNo: string;
  customerPo: string;
  dateReceived: string;
  dateRequired: string;
  quoteRef: string;
  quantityRequired: number;
};

export const CUSTOMER_A = "Example Pumps Ltd";
export const CUSTOMER_B = "Sample Fabrications Ltd";

export const JNR_TEST_CUSTOMERS: TestCustomer[] = [
  {
    name: CUSTOMER_A,
    contactName: "Accounts Payable",
    email: "accounts@examplepumps.example",
    phone: "0100 000 0001",
    address: "1 Example Road\nExample Business Park\nExampletown\nEX1 1AA",
    notes: "Invoices to be emailed to accounts@examplepumps.example. Quote the PO number on all paperwork.",
  },
  {
    name: CUSTOMER_B,
    contactName: "",
    email: "orders@samplefab.example",
    phone: "0100 000 0002",
    address: "Unit 2, Sample Trading Estate\nSampleton\nSA2 2BB",
    notes: "Customer collects from the works.",
  },
];

const CUSTOMER_A_LINES: TestLine[] = [
  { description: "DEMO-SH-101 Shaft sleeve", quantity: 2, unitPrice: 96.4, vatPct: 20 },
  { description: "DEMO-SH-102 Shaft sleeve, long", quantity: 2, unitPrice: 112.15, vatPct: 20 },
  { description: "DEMO-RG-201 Retaining ring", quantity: 4, unitPrice: 38.6, vatPct: 20 },
  { description: "DEMO-RG-202 Split collar", quantity: 4, unitPrice: 44.9, vatPct: 20 },
  { description: "DEMO-HB-301 Bearing housing", quantity: 1, unitPrice: 865, vatPct: 20 },
  { description: "DEMO-BS-401 Bush, bronze (finish bore to suit)", quantity: 12, unitPrice: 27.35, vatPct: 20 },
  { description: "DEMO-PL-501 Mounting plate", quantity: 3, unitPrice: 142.8, vatPct: 20 },
];

const CUSTOMER_B_LINES: TestLine[] = [
  { description: "DEMO-SP-25 Spacer, 25 mm", quantity: 20, unitPrice: 6.45, vatPct: 20 },
  { description: "DEMO-SP-40 Spacer, 40 mm", quantity: 20, unitPrice: 7.9, vatPct: 20 },
  { description: "DEMO-AD-60 Adaptor flange, 60 mm", quantity: 8, unitPrice: 58.25, vatPct: 20 },
  { description: "DEMO-AD-90 Adaptor flange, 90 mm", quantity: 6, unitPrice: 74.6, vatPct: 20 },
  { description: "DEMO-PN-12 Locating pin", quantity: 50, unitPrice: 2.15, vatPct: 20 },
];

/** Newest first, matching the order the pages list them in. */
export const JNR_TEST_QUOTES: TestQuote[] = [
  { ref: "QUO-9102", customer: CUSTOMER_B, date: "2026-08-10", validUntil: "2026-09-09", status: "accepted", total: 1569.72, lines: CUSTOMER_B_LINES },
  { ref: "QUO-9101", customer: CUSTOMER_A, date: "2026-03-02", validUntil: "2026-04-01", status: "accepted", total: 2847.24, lines: CUSTOMER_A_LINES },
];

export const JNR_TEST_SALES_ORDERS: TestSalesOrder[] = [
  { ref: "DEMO-PO-302", customer: CUSTOMER_B, quoteRef: "QUO-9102", orderDate: "2026-08-12", dueDate: "2026-08-26", value: 1308.1, status: "despatched", jobNo: "J-9102" },
  { ref: "DEMO-PO-301", customer: CUSTOMER_A, quoteRef: "QUO-9101", orderDate: "2026-03-03", dueDate: "2026-03-24", value: 2372.7, status: "closed", jobNo: "J-9101" },
];

export const JNR_TEST_INVOICES: TestInvoice[] = [
  { ref: "INV-9202", customer: CUSTOMER_B, date: "2026-08-26", dueDate: "2026-09-25", terms: "30 days", quoteRef: "QUO-9102", customerPo: "DEMO-PO-302", subtotal: 1308.1, vat: 261.62, total: 1569.72, status: "paid", lines: CUSTOMER_B_LINES },
  { ref: "INV-9201", customer: CUSTOMER_A, date: "2026-03-24", dueDate: "2026-04-23", terms: "30 days", quoteRef: "QUO-9101", customerPo: "DEMO-PO-301", subtotal: 2372.7, vat: 474.54, total: 2847.24, status: "paid", lines: CUSTOMER_A_LINES },
];

const toItems = (lines: TestLine[]) => lines.map((line) => ({ description: line.description, quantity: line.quantity }));

export const JNR_TEST_DELIVERY_NOTES: TestDeliveryNote[] = [
  { ref: "DLN-9202", invoiceRef: "INV-9202", customer: CUSTOMER_B, email: "orders@samplefab.example", jobNo: "J-9102", taxDate: "2026-08-26", shipDate: "2026-08-25", shipVia: "", status: "delivered", items: toItems(CUSTOMER_B_LINES) },
  { ref: "DLN-9201", invoiceRef: "INV-9201", customer: CUSTOMER_A, email: "accounts@examplepumps.example", jobNo: "J-9101", taxDate: "2026-03-24", shipDate: "2026-03-23", shipVia: "", status: "delivered", items: toItems(CUSTOMER_A_LINES) },
];

export const JNR_TEST_JOBS: TestJob[] = [
  {
    id: "demo-j-9102",
    jobNo: "J-9102",
    customer: CUSTOMER_B,
    description: "Spacers, adaptor flanges and locating pins",
    stage: "inspection",
    dueDate: "2026-08-26",
    value: 1308.1,
    status: "on_track",
    specification: "Customer PO DEMO-PO-302. Spacers 25 mm and 40 mm, adaptor flanges 60 mm and 90 mm, locating pins. Customer collects.",
    drawingNo: "DEMO-SP-25 / DEMO-SP-40 / DEMO-AD-60 / DEMO-AD-90 / DEMO-PN-12",
    customerPo: "DEMO-PO-302",
    dateReceived: "2026-08-12",
    dateRequired: "2026-08-26",
    quoteRef: "QUO-9102",
    quantityRequired: 104,
  },
  {
    id: "demo-j-9101",
    jobNo: "J-9101",
    customer: CUSTOMER_A,
    description: "Pump parts: sleeves, rings, housing, bushes, plates",
    stage: "inspection",
    dueDate: "2026-03-24",
    value: 2372.7,
    status: "on_track",
    specification: "Customer PO DEMO-PO-301. Material certificate and certificate of conformity with the parts. Bushes left with bore to finish.",
    drawingNo: "DEMO-SH-101 / DEMO-SH-102 / DEMO-RG-201 / DEMO-RG-202 / DEMO-HB-301 / DEMO-BS-401 / DEMO-PL-501",
    customerPo: "DEMO-PO-301",
    dateReceived: "2026-03-03",
    dateRequired: "2026-03-24",
    quoteRef: "QUO-9101",
    quantityRequired: 28,
  },
];

/** "2026-08-24" -> "24/08/2026" (UK date format). */
export function ukDate(iso: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : iso;
}

export function findTestCustomer(name: string) {
  return JNR_TEST_CUSTOMERS.find((customer) => customer.name.toLowerCase() === name.trim().toLowerCase());
}
