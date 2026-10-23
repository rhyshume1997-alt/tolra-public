import { describe, expect, it } from "vitest";

import { CUSTOMER_COLUMNS, IMPORT_COLUMNS, PAYMENT_COLUMNS, paymentExportRows, INVOICE_COLUMNS, JOB_COLUMNS, PURCHASE_ORDER_COLUMNS, QUOTE_COLUMNS, SALES_ORDER_COLUMNS, SUPPLIER_COLUMNS, type InvoiceExportRow, type JobExportRow, type QuoteExportRow } from "@/lib/import-columns";
import type { InvoicePayment } from "@/lib/payments";
import { toCsv } from "@/lib/spreadsheet";

const invoice: InvoiceExportRow = {
  reference: "INV-0001", customer: "Arc Co", date: "2026-10-01", dueDate: "2026-10-31", terms: "30 days", customerPo: "PO-77",
  subtotal: 100, vatAmount: 20, amount: 120, amountPaid: 50.5, credited: 0, balance: 69.5, status: "outstanding", rawStatus: "issued",
};
const quote: QuoteExportRow = {
  ref: "QUO-0001 v2", customer: "Arc Co", description: "Plates", value: 1234.5, status: "sent", rawStatus: "sent",
  date: "2026-07-01T23:30:00+00:00", validUntil: "2026-08-01", version: 2, vatEnabled: true,
};
const job: JobExportRow = {
  job_no: "JOB-1", customer: "Arc Co", description: "Shaft", stage: "machining", status: "on_track", due_date: "2026-11-02",
  started_at: "2026-10-10T08:00:00+00:00", quantity_required: 4,
};

describe("import column specs", () => {
  it("keep their headers stable (a future importer reads them)", () => {
    expect(INVOICE_COLUMNS.map((c) => c.header)).toEqual(["Invoice No", "Customer", "Invoice Date", "Due Date", "Tax Point", "Terms", "Quote Ref", "Customer PO", "Net", "VAT", "Total", "Paid", "Credited", "Balance Due", "Status", "Stored Status"]);
    expect(QUOTE_COLUMNS.map((c) => c.header)).toEqual(["Quote Ref", "Version", "Customer", "Description", "Quote Date", "Valid Until", "Sent Date", "VAT Added", "Total", "Status", "Stored Status"]);
    expect(JOB_COLUMNS.map((c) => c.header)).toEqual(["Job No", "Customer", "Description", "Customer PO", "Quote Ref", "Drawing No", "Quantity", "Date Received", "Date Required", "Started", "Finished", "Inspected", "Stage", "Status", "Internal"]);
    expect(Object.keys(IMPORT_COLUMNS)).toEqual(["invoices", "quotes", "jobs", "payments", "purchase_orders", "sales_orders", "customers", "suppliers"]);
    for (const spec of Object.values(IMPORT_COLUMNS) as { key: string; header: string }[][]) {
      expect(new Set(spec.map((c) => c.key)).size).toBe(spec.length);
      expect(new Set(spec.map((c) => c.header)).size).toBe(spec.length);
    }
  });

  it("has no price column on jobs (job values are admin/office only)", () => {
    expect(JOB_COLUMNS.some((c) => c.type === "money")).toBe(false);
  });

  it("writes invoice money in pounds to 2 dp and dates as YYYY-MM-DD", () => {
    const [header, line] = toCsv(INVOICE_COLUMNS, [invoice]).slice(1).split("\r\n");
    expect(header.split(",")).toHaveLength(INVOICE_COLUMNS.length);
    expect(line).toBe("INV-0001,Arc Co,2026-10-01,2026-10-31,,30 days,,PO-77,100.00,20.00,120.00,50.50,0.00,69.50,outstanding,issued");
  });

  it("leaves an unknown net / VAT empty rather than writing 0.00", () => {
    const line = toCsv(INVOICE_COLUMNS, [{ ...invoice, subtotal: undefined, vatAmount: undefined }]).split("\r\n")[1];
    expect(line).toContain(",PO-77,,,120.00,");
  });

  it("writes a quote total as pounds and a UTC timestamp as the UK calendar date", () => {
    const line = toCsv(QUOTE_COLUMNS, [quote]).split("\r\n")[1];
    // 23:30 UTC on 1 July is already 2 July in London.
    expect(line).toBe("QUO-0001 v2,2,Arc Co,Plates,2026-07-02,2026-08-01,,Yes,1234.50,sent,sent");
  });

  it("writes job dates, a numeric quantity and blanks for what hasn't happened", () => {
    const line = toCsv(JOB_COLUMNS, [job]).split("\r\n")[1];
    expect(line).toBe("JOB-1,Arc Co,Shaft,,,,4,,2026-11-02,2026-10-10,,,machining,on_track,No");
  });

  it("keeps the purchase order, sales order, customer and supplier headers stable", () => {
    expect(PURCHASE_ORDER_COLUMNS.map((c) => c.header)).toEqual(["PO No", "Supplier", "Order Date", "Expected Delivery", "Net", "VAT Added", "Status", "Sent Date", "Received Date", "Notes"]);
    expect(SALES_ORDER_COLUMNS.map((c) => c.header)).toEqual(["Order Ref", "Customer", "Customer PO", "Quote Ref", "Order Date", "Delivery Date", "Net", "VAT Added", "VAT Rate", "Status", "Job No"]);
    expect(CUSTOMER_COLUMNS.map((c) => c.header)).toEqual(["Name", "Contact", "Email", "Phone", "Mobile", "Address", "Notes"]);
    expect(SUPPLIER_COLUMNS.map((c) => c.header)).toEqual(["Name", "Contact", "Email", "Phone", "Notes", "On-time Rate %", "Reliability"]);
  });

  it("writes a purchase order's net in pounds and its dates", () => {
    const line = toCsv(PURCHASE_ORDER_COLUMNS, [{ ref: "PO-0001", supplier: "Steel Ltd", date: "2026-10-02", delivery: "", value: 250.5, vatEnabled: true, status: "sent", receivedAt: "2026-10-09T10:00:00.000Z", notes: "Urgent, call first" }]).split("\r\n")[1];
    expect(line).toBe('PO-0001,Steel Ltd,2026-10-02,,250.50,Yes,sent,,2026-10-09,"Urgent, call first"');
  });

  it("writes a sales order with its rate only when VAT is added", () => {
    const row = { ref: "CPO-1", customer: "Arc Co", customerPo: "CPO-1", quoteRef: "QUO-0001", date: "2026-10-03", delivery: "2026-10-20", value: 300, vatEnabled: true, vat: "20", status: "open", convertedJob: "J-0001" };
    expect(toCsv(SALES_ORDER_COLUMNS, [row]).split("\r\n")[1]).toBe("CPO-1,Arc Co,CPO-1,QUO-0001,2026-10-03,2026-10-20,300.00,Yes,20,open,J-0001");
    expect(toCsv(SALES_ORDER_COLUMNS, [{ ...row, vatEnabled: false }]).split("\r\n")[1]).toBe("CPO-1,Arc Co,CPO-1,QUO-0001,2026-10-03,2026-10-20,300.00,No,,open,J-0001");
  });

  it("writes customers (mobile blank when not read) and suppliers (on-time rate as a number)", () => {
    expect(toCsv(CUSTOMER_COLUMNS, [{ name: "Arc Co", contactName: "Pat", email: "a@x.test", phone: "01", address: "1 High St\nLeeds", notes: "" }]).split("\r\n").slice(1, 3).join("|")).toBe('Arc Co,Pat,a@x.test,01,,"1 High St\nLeeds",|');
    expect(toCsv(SUPPLIER_COLUMNS, [{ name: "Steel Ltd", email: "s@x.test", onTimeRate: 92.5, status: "Reliable" }]).split("\r\n")[1]).toBe("Steel Ltd,,s@x.test,,,92.5,Reliable");
  });

  describe("payments", () => {
    const pay = (over: Partial<InvoicePayment>): InvoicePayment => ({ id: "p1", invoiceId: "i1", amount: 40, paidOn: "2026-09-01", method: "BACS", reference: "Ref 1", source: "recorded", reversesPaymentId: null, voidReason: "", createdBy: null, createdAt: "2026-09-01T09:00:00+00:00", ...over });
    const invoices = [{ id: "i1", reference: "INV-0001" }, { id: "i2", reference: "INV-0002" }];

    it("keeps the match columns (invoice_ref, paid_on, amount) first and stable", () => {
      expect(PAYMENT_COLUMNS.map((c) => c.header)).toEqual(["Invoice No", "Paid On", "Amount", "Method", "Reference", "Source", "Type", "Reversed", "Reversal Reason", "Recorded On"]);
      expect(PAYMENT_COLUMNS.slice(0, 3).map((c) => c.key)).toEqual(["invoice_ref", "paid_on", "amount"]);
    });

    it("writes each payment with the invoice ref, ISO paid date and amount to 2 dp", () => {
      const rows = paymentExportRows(invoices, [pay({})]);
      expect(toCsv(PAYMENT_COLUMNS, rows).split("\r\n")[1]).toBe("INV-0001,2026-09-01,40.00,BACS,Ref 1,recorded,Payment,No,,2026-09-01");
    });

    it("exports a reversal as a negative row and marks the payment it undoes", () => {
      const rows = paymentExportRows(invoices, [pay({}), pay({ id: "p2", amount: -40, reversesPaymentId: "p1", voidReason: "Entered twice", createdAt: "2026-09-02T09:00:00+00:00", paidOn: "2026-09-01" })]);
      const lines = toCsv(PAYMENT_COLUMNS, rows).split("\r\n");
      expect(lines[1]).toBe("INV-0001,2026-09-01,40.00,BACS,Ref 1,recorded,Payment,Yes,,2026-09-01");
      expect(lines[2]).toBe("INV-0001,2026-09-01,-40.00,BACS,Ref 1,recorded,Reversal,,Entered twice,2026-09-02");
    });

    it("keeps only the given invoices' payments, ordered by invoice then time, and leaves a legacy row's missing date empty", () => {
      const rows = paymentExportRows(invoices, [pay({ id: "p3", invoiceId: "i2", createdAt: "2026-09-03T09:00:00+00:00" }), pay({ id: "p4", invoiceId: "other" }), pay({ id: "p5", paidOn: "", source: "legacy" })]);
      expect(rows.map((r) => r.invoiceRef)).toEqual(["INV-0001", "INV-0002"]);
      expect(toCsv(PAYMENT_COLUMNS, rows).split("\r\n")[1].startsWith("INV-0001,,40.00,")).toBe(true);
    });
  });
});
