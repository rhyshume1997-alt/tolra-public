/**
 * One column spec per data type for spreadsheet export. A future importer reads the same headers, so the header
 * labels are a contract: change one only together with the importer (tests/unit/import-columns.test.ts pins them).
 *
 * Types: text; number; money (pounds, 2 dp, "12.50"); date (YYYY-MM-DD). The row shapes are the fields each page
 * already loads, written as small structural types so a page's own row type fits without a conversion. Every value is
 * a stored field or the page's own derived status; nothing is calculated here that the page doesn't already show.
 */
import { exportedInvoiceRef } from "@/lib/invoice-ref";
import { calendarDate } from "@/lib/dates";
import { type InvoicePayment, reversedIds } from "@/lib/payments";
import type { SheetColumn, SheetColumnType } from "@/lib/spreadsheet";

export type ImportColumn<R> = SheetColumn<R> & {
  /** Stable machine name, for the importer. */
  key: string;
  type: SheetColumnType;
};

const col = <R>(key: string, header: string, type: SheetColumnType, value: ImportColumn<R>["value"]): ImportColumn<R> => ({ key, header, type, value });

/** A date column: a DATE ("2026-10-11") as it is, a timestamp as its calendar date in UK time; anything else is empty. */
const day = (value: unknown) => calendarDate(value);

// ---------------------------------------------------------------------------------------------------------------------
// Invoices (app/(dashboard)/invoices/page.tsx, table `invoices`)

export type InvoiceExportRow = {
  /** invoice_ref; a draft has none, so the page shows "Draft, no number yet" (lib/invoice-ref) and `reference` is only a key. */
  reference: string;
  /** A draft with no invoice number: its Invoice No cell is exported blank. */
  unnumbered?: boolean;
  customer: string;
  /** invoice_date (or the day it was created). */
  date?: string;
  dueDate?: string;
  /** tax_point: date of supply, when one was set. */
  taxPoint?: string;
  terms?: string;
  quoteRef?: string;
  /** customer_po. */
  customerPo?: string;
  /** Stored subtotal (net, as issued); absent on demo data. */
  subtotal?: number;
  /** Stored VAT; absent on demo data. */
  vatAmount?: number;
  /** Stored total, including carriage and VAT. */
  amount: number;
  /** Everything received (sum of its payments). */
  amountPaid: number;
  /** Credit notes / customer credit applied. */
  credited: number;
  /** Still to collect (0 when paid or closed). */
  balance: number;
  /** The page's status: overdue, outstanding, paid, closed (draft/void/credited) or unverified (imported, payment to confirm). */
  status: string;
  /** The stored status. */
  rawStatus: string;
};

export const INVOICE_COLUMNS: ImportColumn<InvoiceExportRow>[] = [
  col("reference", "Invoice No", "text", (r) => exportedInvoiceRef(r)),
  col("customer", "Customer", "text", (r) => r.customer),
  col("invoice_date", "Invoice Date", "date", (r) => day(r.date)),
  col("due_date", "Due Date", "date", (r) => day(r.dueDate)),
  col("tax_point", "Tax Point", "date", (r) => day(r.taxPoint)),
  col("terms", "Terms", "text", (r) => r.terms),
  col("quote_ref", "Quote Ref", "text", (r) => r.quoteRef),
  col("customer_po", "Customer PO", "text", (r) => r.customerPo),
  col("net", "Net", "money", (r) => r.subtotal),
  col("vat", "VAT", "money", (r) => r.vatAmount),
  col("total", "Total", "money", (r) => r.amount),
  col("paid", "Paid", "money", (r) => r.amountPaid),
  col("credited", "Credited", "money", (r) => r.credited),
  col("balance", "Balance Due", "money", (r) => r.balance),
  col("status", "Status", "text", (r) => r.status),
  col("stored_status", "Stored Status", "text", (r) => r.rawStatus),
];

// ---------------------------------------------------------------------------------------------------------------------
// Quotes (app/(dashboard)/quotes/page.tsx, table `quotes`)

export type QuoteExportRow = {
  /** quote_ref, with its version suffix ("QUO-0123 v2"). */
  ref: string;
  customer: string;
  description: string;
  /** Stored total_value (the quote total). The page loads no separate net or VAT for a quote. */
  value: number;
  /** The status shown (a sent quote past its valid-until date reads expired). */
  status: string;
  /** The stored status. */
  rawStatus: string;
  /** When the quote was created (timestamp). */
  date?: string;
  validUntil: string;
  /** When it was last sent (timestamp). */
  sentAt?: string;
  version: number;
  vatEnabled: boolean;
};

export const QUOTE_COLUMNS: ImportColumn<QuoteExportRow>[] = [
  col("quote_ref", "Quote Ref", "text", (r) => r.ref),
  col("version", "Version", "number", (r) => r.version),
  col("customer", "Customer", "text", (r) => r.customer),
  col("description", "Description", "text", (r) => r.description),
  col("quote_date", "Quote Date", "date", (r) => day(r.date)),
  col("valid_until", "Valid Until", "date", (r) => day(r.validUntil)),
  col("sent_date", "Sent Date", "date", (r) => day(r.sentAt)),
  col("vat_enabled", "VAT Added", "text", (r) => (r.vatEnabled ? "Yes" : "No")),
  col("total", "Total", "money", (r) => r.value),
  col("status", "Status", "text", (r) => r.status),
  col("stored_status", "Stored Status", "text", (r) => r.rawStatus),
];

// ---------------------------------------------------------------------------------------------------------------------
// Jobs (app/(dashboard)/jobs/page.tsx, table `jobs`). No prices: job values are admin/office-only (job_values) and are
// never loaded with the job, so a workshop or viewer export can't leak them.

export type JobExportRow = {
  /** job_no. */
  job_no: string;
  customer: string;
  description: string;
  customer_po?: string;
  quote_ref?: string;
  drawing_no?: string;
  quantity_required?: number | string;
  stage: string;
  /** The page's status: on_track, at_risk, overdue or rework. */
  status: string;
  /** date_received / date_required (DATE); due_date is the required date the board shows. */
  date_received?: string;
  due_date?: string;
  /** Timestamps; empty until it happens. */
  started_at?: string;
  finished_at?: string;
  inspected_at?: string;
  is_internal?: boolean;
};

export const JOB_COLUMNS: ImportColumn<JobExportRow>[] = [
  col("job_no", "Job No", "text", (r) => r.job_no),
  col("customer", "Customer", "text", (r) => r.customer),
  col("description", "Description", "text", (r) => r.description),
  col("customer_po", "Customer PO", "text", (r) => r.customer_po),
  col("quote_ref", "Quote Ref", "text", (r) => r.quote_ref),
  col("drawing_no", "Drawing No", "text", (r) => r.drawing_no),
  col("quantity_required", "Quantity", "number", (r) => (r.quantity_required === "" ? undefined : r.quantity_required)),
  col("date_received", "Date Received", "date", (r) => day(r.date_received)),
  col("date_required", "Date Required", "date", (r) => day(r.due_date)),
  col("started", "Started", "date", (r) => day(r.started_at)),
  col("finished", "Finished", "date", (r) => day(r.finished_at)),
  col("inspected", "Inspected", "date", (r) => day(r.inspected_at)),
  col("stage", "Stage", "text", (r) => r.stage),
  col("status", "Status", "text", (r) => r.status),
  col("internal", "Internal", "text", (r) => (r.is_internal ? "Yes" : "No")),
];

// ---------------------------------------------------------------------------------------------------------------------
// Purchase orders (app/(dashboard)/purchase-orders/page.tsx, table `purchase_orders`)

export type PurchaseOrderExportRow = {
  /** po_ref (or po_number). */
  ref: string;
  supplier: string;
  /** order_date (DATE). */
  date: string;
  /** expected_delivery (DATE) or "". */
  delivery: string;
  /** total_value: stored NET of VAT (the page loads no VAT or gross for a PO). */
  value: number;
  vatEnabled?: boolean;
  status: string;
  /** Timestamps, when someone confirmed it was sent / the goods arrived. */
  sentAt?: string;
  receivedAt?: string;
  notes?: string;
};

export const PURCHASE_ORDER_COLUMNS: ImportColumn<PurchaseOrderExportRow>[] = [
  col("po_ref", "PO No", "text", (r) => r.ref),
  col("supplier", "Supplier", "text", (r) => r.supplier),
  col("order_date", "Order Date", "date", (r) => day(r.date)),
  col("expected_delivery", "Expected Delivery", "date", (r) => day(r.delivery)),
  col("net", "Net", "money", (r) => r.value),
  col("vat_enabled", "VAT Added", "text", (r) => (r.vatEnabled ? "Yes" : "No")),
  col("status", "Status", "text", (r) => r.status),
  col("sent_date", "Sent Date", "date", (r) => day(r.sentAt)),
  col("received_date", "Received Date", "date", (r) => day(r.receivedAt)),
  col("notes", "Notes", "text", (r) => r.notes),
];

// ---------------------------------------------------------------------------------------------------------------------
// Sales orders (app/(dashboard)/sales-orders/page.tsx, table `sales_orders`)

export type SalesOrderExportRow = {
  /** What the page shows as the reference: the customer's PO, else the SO number (provisional until the PO arrives). */
  ref: string;
  customer: string;
  /** The customer's PO ("" until it arrives). */
  customerPo?: string;
  quoteRef?: string;
  /** order_date (DATE). */
  date: string;
  /** delivery_date (DATE) or "". */
  delivery: string;
  /** total_value: the order value ex VAT. */
  value: number;
  vatEnabled: boolean;
  /** The order's VAT rate choice: "20", "5", "0" or "exempt". */
  vat: string;
  status: string;
  /** The job number it was converted to, or "". */
  convertedJob: string;
};

export const SALES_ORDER_COLUMNS: ImportColumn<SalesOrderExportRow>[] = [
  col("ref", "Order Ref", "text", (r) => r.ref),
  col("customer", "Customer", "text", (r) => r.customer),
  col("customer_po", "Customer PO", "text", (r) => r.customerPo),
  col("quote_ref", "Quote Ref", "text", (r) => r.quoteRef),
  col("order_date", "Order Date", "date", (r) => day(r.date)),
  col("delivery_date", "Delivery Date", "date", (r) => day(r.delivery)),
  col("net", "Net", "money", (r) => r.value),
  col("vat_enabled", "VAT Added", "text", (r) => (r.vatEnabled ? "Yes" : "No")),
  col("vat_rate", "VAT Rate", "text", (r) => (r.vatEnabled ? r.vat : "")),
  col("status", "Status", "text", (r) => r.status),
  col("job_no", "Job No", "text", (r) => r.convertedJob),
];

// ---------------------------------------------------------------------------------------------------------------------
// Customers (app/(dashboard)/customers/page.tsx, table `customers`)

export type CustomerExportRow = {
  name: string;
  contactName: string;
  email: string;
  phone: string;
  /** Mobile (migration 073); absent when the database has no such column yet. */
  mobile?: string;
  address: string;
  notes: string;
};

export const CUSTOMER_COLUMNS: ImportColumn<CustomerExportRow>[] = [
  col("name", "Name", "text", (r) => r.name),
  col("contact_name", "Contact", "text", (r) => r.contactName),
  col("email", "Email", "text", (r) => r.email),
  col("phone", "Phone", "text", (r) => r.phone),
  col("mobile", "Mobile", "text", (r) => r.mobile),
  col("address", "Address", "text", (r) => r.address),
  col("notes", "Notes", "text", (r) => r.notes),
];

// ---------------------------------------------------------------------------------------------------------------------
// Suppliers (app/(dashboard)/suppliers/page.tsx, table `suppliers`)

export type SupplierExportRow = {
  name: string;
  email: string;
  contactName?: string;
  phone?: string;
  notes?: string;
  /** on_time_rate, a percentage. */
  onTimeRate?: number;
  /** reliability_status. */
  status?: string;
};

export const SUPPLIER_COLUMNS: ImportColumn<SupplierExportRow>[] = [
  col("name", "Name", "text", (r) => r.name),
  col("contact_name", "Contact", "text", (r) => r.contactName),
  col("email", "Email", "text", (r) => r.email),
  col("phone", "Phone", "text", (r) => r.phone),
  col("notes", "Notes", "text", (r) => r.notes),
  col("on_time_rate", "On-time Rate %", "number", (r) => r.onTimeRate),
  col("reliability_status", "Reliability", "text", (r) => r.status),
];

// ---------------------------------------------------------------------------------------------------------------------
// Invoice payments (table `invoice_payments`, migration 032; exported from the invoices page)
//
// An importer matches a payment on invoice_ref + paid_on + amount. Rows are append-only: a mistaken payment is undone
// by a second NEGATIVE row (Type "Reversal") that points at it, and the original is marked Reversed "Yes". Both rows are
// exported, signed as stored, so they net to nothing; an importer should skip a Reversal and the payment it reverses.

export type PaymentExportRow = {
  /** The invoice's invoice_ref. */
  invoiceRef: string;
  /** paid_on (DATE); "" only on a legacy row whose invoice had no paid date. */
  paidOn: string;
  /** Positive for a payment, negative for a reversal. */
  amount: number;
  method: string;
  reference: string;
  /** "recorded" in the app, or "legacy": carried over from the single amount_paid an invoice had before part payments. */
  source: string;
  isReversal: boolean;
  /** A payment that has since been reversed. */
  reversed: boolean;
  voidReason: string;
  /** created_at: when it was recorded (timestamp). */
  createdAt: string;
};

export const PAYMENT_COLUMNS: ImportColumn<PaymentExportRow>[] = [
  col("invoice_ref", "Invoice No", "text", (r) => r.invoiceRef),
  col("paid_on", "Paid On", "date", (r) => day(r.paidOn)),
  col("amount", "Amount", "money", (r) => r.amount),
  col("method", "Method", "text", (r) => r.method),
  col("reference", "Reference", "text", (r) => r.reference),
  col("source", "Source", "text", (r) => r.source),
  col("type", "Type", "text", (r) => (r.isReversal ? "Reversal" : "Payment")),
  col("reversed", "Reversed", "text", (r) => (r.isReversal ? "" : r.reversed ? "Yes" : "No")),
  col("void_reason", "Reversal Reason", "text", (r) => r.voidReason),
  col("recorded_on", "Recorded On", "date", (r) => day(r.createdAt)),
];

/** The payment rows for these invoices (matched by id), by invoice then the order they were recorded. */
export function paymentExportRows(invoices: { id?: string; reference: string }[], payments: InvoicePayment[]): PaymentExportRow[] {
  const refs = new Map(invoices.flatMap((invoice) => (invoice.id ? [[invoice.id, invoice.reference] as const] : [])));
  const mine = payments.filter((p) => refs.has(p.invoiceId));
  const reversed = reversedIds(mine);
  return mine
    .slice()
    .sort((a, b) => (refs.get(a.invoiceId) as string).localeCompare(refs.get(b.invoiceId) as string) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .map((p) => ({
      invoiceRef: refs.get(p.invoiceId) as string, paidOn: p.paidOn, amount: p.amount, method: p.method, reference: p.reference, source: p.source,
      isReversal: p.reversesPaymentId !== null, reversed: reversed.has(p.id), voidReason: p.voidReason, createdAt: p.createdAt,
    }));
}

/** The column specs by data type. */
export const IMPORT_COLUMNS = {
  invoices: INVOICE_COLUMNS, quotes: QUOTE_COLUMNS, jobs: JOB_COLUMNS,
  payments: PAYMENT_COLUMNS, purchase_orders: PURCHASE_ORDER_COLUMNS, sales_orders: SALES_ORDER_COLUMNS, customers: CUSTOMER_COLUMNS, suppliers: SUPPLIER_COLUMNS,
} as const;
