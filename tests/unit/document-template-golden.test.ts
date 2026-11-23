/**
 * Module J golden check: the DEFAULT design (classic, and also "feature off" / "nothing chosen") prints exactly what the app printed
 * before document templates existed. The golden files in tests/fixtures/document-templates were recorded from the original
 * components/pdf/BaseDocumentPDF.tsx output BEFORE this module changed any PDF code (text of every page, in drawing order).
 * To re-record (only when a protected layout change is approved): UPDATE_GOLDEN=1 npx vitest run tests/unit/document-template-golden.test.ts
 */
import { createElement } from "react";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import { DeliveryNotePDF } from "@/components/pdf/DeliveryNotePDF";
import { InvoicePDF } from "@/components/pdf/InvoicePDF";
import { PurchaseOrderPDF } from "@/components/pdf/PurchaseOrderPDF";
import { QuotePDF } from "@/components/pdf/QuotePDF";
import { FIXTURE_DELIVERY_NOTE, FIXTURE_INVOICE, FIXTURE_INVOICE_PAID, FIXTURE_PURCHASE_ORDER, FIXTURE_QUOTE } from "../support/document-template-fixtures";
import { pdfText } from "../support/pdf-text";

const DIR = join(__dirname, "..", "fixtures", "document-templates");
const CASES = [
  { name: "quote", make: () => createElement(QuotePDF, { data: FIXTURE_QUOTE }) },
  { name: "invoice", make: () => createElement(InvoicePDF, { data: FIXTURE_INVOICE }) },
  { name: "invoice-paid", make: () => createElement(InvoicePDF, { data: FIXTURE_INVOICE_PAID }) },
  { name: "purchase-order", make: () => createElement(PurchaseOrderPDF, { data: FIXTURE_PURCHASE_ORDER }) },
  { name: "delivery-note", make: () => createElement(DeliveryNotePDF, { data: FIXTURE_DELIVERY_NOTE }) },
];

describe("default design output is today's", () => {
  for (const { name, make } of CASES) {
    it(`${name} matches the recorded golden text`, async () => {
      const text = pdfText(await renderToBuffer(make() as never));
      const file = join(DIR, `${name}.golden.txt`);
      if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) { writeFileSync(file, text); return; }
      expect(text).toBe(readFileSync(file, "utf8"));
    });
  }
});
