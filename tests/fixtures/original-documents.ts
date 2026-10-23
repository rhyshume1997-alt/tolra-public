/**
 * Line items of two invented documents (INV-0101, INV-0102), designed from scratch for the golden totals test in
 * tests/unit/money.test.ts: the app must reproduce the pinned totals exactly. INV-0101 is the per-line rounding case
 * (VAT rounded to the penny on each line, then summed, is 1p more than 20% of the subtotal); INV-0102 is not.
 * Test-only; never imported by app code, so it never reaches a browser bundle (audit SEC12, checked by
 * scripts/check-bundle.mjs). supabase/fixtures/demo_documents.sql holds the same lines.
 */
import type { TestLine } from "@/lib/jnr-test-data";

export const SAMPLE_INVOICE_0101_LINES: TestLine[] = [
  { description: "Turned bush, EN8, PN-100", quantity: 25, unitPrice: 6.5, vatPct: 20 },
  { description: "Milled bracket, 6082-T6, PN-101", quantity: 12, unitPrice: 42.49, vatPct: 20 },
  { description: "Weld fabrication, mild steel frame, PN-102", quantity: 2, unitPrice: 1250, vatPct: 20 },
  { description: "Laser-cut plate set", quantity: 7, unitPrice: 9.99, vatPct: 20 },
  { description: "Inspection and CMM report", quantity: 1, unitPrice: 310.4, vatPct: 20 },
  { description: "Delivery", quantity: 1, unitPrice: 65, vatPct: 20 },
];

export const SAMPLE_INVOICE_0102_LINES: TestLine[] = [
  { description: "Turned spacer, 303 stainless, PN-103", quantity: 40, unitPrice: 2.85, vatPct: 20 },
  { description: "Milled housing, 6082-T6, PN-104", quantity: 3, unitPrice: 186, vatPct: 20 },
  { description: "Threaded stud, A4-80, PN-105", quantity: 16, unitPrice: 3.35, vatPct: 20 },
  { description: "Drilled base plate, S275, PN-106", quantity: 9, unitPrice: 27.5, vatPct: 20 },
  { description: "Weld fabrication, mild steel bracket", quantity: 2, unitPrice: 412, vatPct: 20 },
  { description: "Bead blast and anodise", quantity: 5, unitPrice: 14.75, vatPct: 20 },
  { description: "Packing and crating", quantity: 3, unitPrice: 7.99, vatPct: 20 },
  { description: "Inspection and CMM report", quantity: 1, unitPrice: 95, vatPct: 20 },
];
