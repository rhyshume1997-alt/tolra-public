/**
 * Decision 16 / migration 123: the customer's PO on the quote, labelled "Customer PO" on the quote, job, delivery note and invoice;
 * a supplier purchase order keeps "Purchase Order" / "PO No." and never shows a Customer PO. Plus the migration's files: the release
 * text is release-sql.mjs's, the rollback is one transaction that puts back 068's and 076's bodies, and set_quote_customer_po only
 * ever writes DRAFT invoices.
 */
import { createElement } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToBuffer } from "@react-pdf/renderer";
import { describe, expect, it } from "vitest";

import { DeliveryNotePDF, type DeliveryNotePdfData } from "@/components/pdf/DeliveryNotePDF";
import { InvoicePDF, type InvoicePdfData } from "@/components/pdf/InvoicePDF";
import { PurchaseOrderPDF } from "@/components/pdf/PurchaseOrderPDF";
import { QuotePDF, type QuotePdfData, quoteKeyValues } from "@/components/pdf/QuotePDF";
import { acceptOutcome, type AcceptQuoteResult } from "@/lib/accept-quote";
import { JNR_PROFILE } from "@/lib/company";
import { CUSTOMER_PO_LABEL, customerPoBeside, customerPoKeyValue, customerPoText } from "@/lib/customer-po";
import { quoteSaveSchema } from "@/lib/validation/schemas";
import { releaseSql } from "../../scripts/release-sql.mjs";
import { pdfText } from "../support/pdf-text";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const company = { ...JNR_PROFILE, name: "Example Engineering Ltd", documentName: "Example Engineering Ltd", logoSrc: undefined };
const pdf = (element: ReturnType<typeof createElement>) => renderToBuffer(element as Parameters<typeof renderToBuffer>[0]).then(pdfText);

describe("the Customer PO helpers", () => {
  it("trim, treat blank as none, and label the PO 'Customer PO'", () => {
    expect(CUSTOMER_PO_LABEL).toBe("Customer PO");
    expect(customerPoText("  4471 ")).toBe("4471");
    expect(customerPoText("   ")).toBeNull();
    expect(customerPoText(undefined)).toBeNull();
    expect(customerPoBeside(" 4471 ")).toBe("Customer PO 4471");
    expect(customerPoBeside("")).toBe("");
    expect(customerPoKeyValue("4471")).toEqual([{ label: "Customer PO", value: "4471" }]);
    expect(customerPoKeyValue(null)).toEqual([]);
  });

  it("the quote form's PO is optional, trimmed, at most 100 characters", () => {
    const base = { customer: "Acme", description: "", customerNotes: "", internalNotes: "", terms: "", validUntil: "", lines: [{ description: "Bush", quantity: 1, unitPrice: 10 }] };
    expect(quoteSaveSchema.parse(base).customerPo).toBe("");
    expect(quoteSaveSchema.parse({ ...base, customerPo: "  4471 " }).customerPo).toBe("4471");
    expect(quoteSaveSchema.safeParse({ ...base, customerPo: "x".repeat(101) }).success).toBe(false);
  });

  it("an order accepted with no PO tells staff to add it on the quote, not on Sales Orders", () => {
    const result = { quote_id: "q", quote_ref: "QUO-0012", accepted: true, so_id: "s", so_number: "SO-0003", so_created: true, provisional: true,
      job_id: "j", job_no: "J-0012", job_created: true, auto_convert: true, needs: null, reason: null, job_reason: null } as AcceptQuoteResult;
    expect(acceptOutcome(result).message).toContain("no customer PO yet: add it on the quote when it arrives");
    expect(acceptOutcome(result).message).not.toMatch(/on Sales Orders when/);
  });
});

describe("Customer PO on the PDFs", () => {
  it("the quote prints 'Customer PO 4471' right after its number, and nothing when it has none", async () => {
    expect(quoteKeyValues({ number: "QUO-0012", date: "01/11/2026", customerPo: "4471" }, company).slice(0, 2)).toEqual([
      { label: "Our Quote No.", value: "QUO-0012" }, { label: "Customer PO", value: "4471" }]);
    expect(quoteKeyValues({ number: "QUO-0012", date: "01/11/2026" }, company).map((row) => row.label)).not.toContain("Customer PO");
    const data: QuotePdfData = { number: "QUO-0012", date: "01/11/2026", validUntil: "01/12/2026", terms: "Valid for 30 days", customerPo: "4471", billTo: ["Acme"],
      lineItems: [{ description: "Bush", quantity: 1, unitPrice: 100, vatPct: 20 }], vatEnabled: false, company, storedTotals: { reference: "QUO-0012", issued: true, total: 100 } };
    expect(await pdf(createElement(QuotePDF, { data }))).toMatch(/Customer PO[\s\S]*4471/);
  });

  it("the invoice prints 'Customer PO' (not 'Your Order No.')", async () => {
    const data: InvoicePdfData = { number: "INV-0042", date: "01/11/2026", customerPo: "4471", billTo: ["Acme"], lineItems: [{ description: "Bush", quantity: 1, unitPrice: 100, vatPct: 20 }],
      vatEnabled: true, payments: 0, company, storedTotals: { reference: "INV-0042", issued: true, subtotal: 100, vat: 20, total: 120 } };
    const out = await pdf(createElement(InvoicePDF, { data }));
    expect(out).toMatch(/Customer PO[\s\S]*4471/);
    expect(out).not.toMatch(/Your Order No/);
  });

  it("the delivery note prints 'Customer PO' when its order has one, and is as before without", async () => {
    const data: DeliveryNotePdfData = { number: "DLN-0042", taxDate: "01/11/2026", shipDate: "01/11/2026", billTo: ["Acme"], items: [{ description: "Bush", quantity: 1 }], company };
    expect(await pdf(createElement(DeliveryNotePDF, { data: { ...data, customerPo: "4471" } }))).toMatch(/Customer PO[\s\S]*4471/);
    expect(await pdf(createElement(DeliveryNotePDF, { data }))).not.toMatch(/Customer PO/);
  });

  it("a supplier purchase order keeps 'Purchase Order' and 'PO No.' and never shows a Customer PO", async () => {
    const out = await pdf(createElement(PurchaseOrderPDF, { data: { number: "PO-0007", date: "01/11/2026", supplier: ["Steel Co"], lineItems: [{ description: "Bar", quantity: 1, unitPrice: 10 }], company } }));
    expect(out).toMatch(/PURCHASE ORDER/i);
    expect(out).toMatch(/PO No\./);
    expect(out).not.toMatch(/Customer PO/);
  });
});

describe("migration 123's files", () => {
  const migration = read("supabase/migrations/123_quote_customer_po.sql");
  const rollback = read("supabase/release/123_quote_customer_po.rollback.sql");

  it("the release text is exactly what release-sql.mjs produces", () => {
    expect(read("supabase/release/123_quote_customer_po.release.sql")).toBe(releaseSql(migration, "123_quote_customer_po.sql"));
  });

  it("the rollback is one transaction, stops while a quote holds a PO, and puts back 068's and 076's bodies verbatim", () => {
    expect(rollback.match(/^BEGIN;$/gm)).toHaveLength(1);
    expect(rollback.trimEnd().endsWith("COMMIT;")).toBe(true);
    expect(rollback).toMatch(/123 rollback stopped: % quote\(s\) hold a customer PO/);
    // The text between the dollar quotes of the function's (last) definition in the file.
    const body = (sql: string, name: string) => {
      const start = sql.lastIndexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
      const m = /\bAS (\$\w*\$)/.exec(sql.slice(start))!;
      const open = start + m.index + m[0].length;
      return sql.slice(open, sql.indexOf(m[1], open));
    };
    expect(body(rollback, "quote_lifecycle_guard")).toBe(body(read("supabase/migrations/076_data_import.sql"), "quote_lifecycle_guard"));
    expect(body(rollback, "revise_quote")).toBe(body(read("supabase/migrations/068_quote_versions.sql"), "revise_quote"));
    expect(body(rollback, "create_sales_order_from_quote")).toBe(body(read("supabase/migrations/068_quote_versions.sql"), "create_sales_order_from_quote"));
  });

  it("set_quote_customer_po writes draft invoices only, checks the second step first, and the guard opens only customer_po", () => {
    const fn = migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION public.set_quote_customer_po("));
    expect(fn).toMatch(/BEGIN\s+PERFORM public\.assert_privileged_aal\(\);/);
    expect(fn).toMatch(/UPDATE public\.invoices i SET customer_po = v_po\s+WHERE i\.organization_id = v_org AND i\.status = 'draft'/);
    expect(fn.match(/UPDATE public\.invoices/g)).toHaveLength(1);
    expect(migration).toMatch(/THEN v_open \|\| ARRAY\['customer_po'\] ELSE v_open END;/);
    expect(migration).toMatch(/v_from IN \('sent', 'accepted'\) AND v_to = v_from\s+AND current_setting\('quoteflow\.set_quote_customer_po', TRUE\) = OLD\.id::TEXT/);
  });

  it("the preflight has 123's marker, in numeric order (a later migration's marker goes after it)", () => {
    const markers = [...read("supabase/verify/release_preflight.sql").matchAll(/^\s+\('(\d{3}) [^']+',/gm)].map((m) => m[1]);
    expect(markers).toContain("123");
    expect(markers).toEqual([...markers].sort());
  });
});
