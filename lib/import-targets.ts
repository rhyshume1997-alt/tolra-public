/**
 * Admin > Data: what a file can fill. One list of target fields per kind of sheet, exactly the fields the import reads (migration 076's
 * import_company_data, section 5; credit notes, delivery notes and the "sent by" / "signed by" people: migration 085). Nothing here
 * decides a match or a link: the database does (document number first, then the normalised name).
 *
 * Field types say how a cell is written into the payload (lib/import-build.ts): date -> YYYY-MM-DD, money and number -> a plain decimal,
 * bool -> yes/no, text -> as it is.
 */

/** In the import's order: a credit note comes after its invoice, a delivery note after its job, order and invoice (085). */
export const IMPORT_KINDS = ["customers", "suppliers", "stock", "quotes", "sales_orders", "jobs", "purchase_orders", "invoices", "payments",
  "credit_notes", "delivery_notes"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const KIND_LABEL: Record<ImportKind, string> = {
  customers: "Customers", suppliers: "Suppliers", stock: "Stock", quotes: "Quotes", sales_orders: "Sales orders", jobs: "Jobs",
  purchase_orders: "Purchase orders", invoices: "Invoices", payments: "Payments", credit_notes: "Credit notes", delivery_notes: "Delivery notes",
};

/** The singular, for messages ("Customer").  */
export const KIND_ONE: Record<ImportKind, string> = {
  customers: "customer", suppliers: "supplier", stock: "stock item", quotes: "quote", sales_orders: "sales order", jobs: "job",
  purchase_orders: "purchase order", invoices: "invoice", payments: "payment", credit_notes: "credit note", delivery_notes: "delivery note",
};

export type FieldType = "text" | "date" | "number" | "money" | "bool";
export type TargetField = {
  /** The payload key; `lines.x` is a line of the quote, invoice, credit note or delivery note. */
  key: string;
  label: string;
  type: FieldType;
  /** The kind's match key (a row without it is a problem row in 076). */
  key_field?: boolean;
  /** Several columns may fill it ("Address1" ... "Address6"): their cells are joined in column order (lib/import-build.ts). */
  joined?: boolean;
  /** Tolra has no column for it yet: written into the record's notes with a label (lib/import-build.ts partyNotes), never sent as its own field. */
  into_notes?: boolean;
};

type Extra = Pick<TargetField, "joined" | "into_notes">;
const f = (key: string, label: string, type: FieldType = "text", key_field = false, extra: Extra = {}): TargetField => ({ key, label, type, ...(key_field ? { key_field } : {}), ...extra });

const PARTY: TargetField[] = [
  f("name", "Name", "text", true), f("external_ref", "Account reference"),
  f("contact_name", "Contact person (free text, not a Tolra user)"), f("email", "E-mail"), f("phone", "Phone"), f("mobile", "Mobile"),
  f("address", "Address", "text", false, { joined: true }), f("notes", "Notes"),
  f("delivery_address", "Delivery address (into the notes)", "text", false, { joined: true, into_notes: true }),
  f("credit_limit_used", "Use credit limit (into the notes)", "bool", false, { into_notes: true }),
  f("credit_limit", "Credit limit (into the notes)", "money", false, { into_notes: true }),
  f("vat_number", "VAT number (into the notes)", "text", false, { into_notes: true }),
  f("website", "Website (into the notes)", "text", false, { into_notes: true }),
  f("terms_days", "Payment terms, days (into the notes)", "number", false, { into_notes: true }),
  f("terms_message", "Payment terms (into the notes)", "text", false, { into_notes: true }),
];

const QUOTE_LINES: TargetField[] = [
  f("lines.description", "Line: description"), f("lines.quantity", "Line: quantity", "number"), f("lines.unit_price", "Line: unit price", "money"),
  f("lines.vat_pct", "Line: VAT %", "number"), f("lines.vat_exempt", "Line: VAT exempt", "bool"),
  f("lines.part_number", "Line: part number"), f("lines.drawing_number", "Line: drawing number"), f("lines.drawing_revision", "Line: drawing revision"),
];
const INVOICE_LINES: TargetField[] = QUOTE_LINES.filter((t) => !["lines.part_number", "lines.drawing_number", "lines.drawing_revision"].includes(t.key));

/**
 * A person named on a document (085): kept as written, marked "not a Tolra user", and linked to a user only when exactly one person in
 * the company has that full name. Never a new user, never a guess.
 */
const PERSON = "(free text: not a Tolra user unless exactly one person in Tolra has that name)";

export const TARGETS: Record<ImportKind, TargetField[]> = {
  customers: PARTY,
  suppliers: PARTY,
  stock: [
    f("sku", "Code (SKU)", "text", true), f("material", "Description"), f("current_stock", "Stock", "number"), f("min_level", "Minimum level", "number"),
    f("reorder_quantity", "Reorder quantity", "number"), f("unit_price", "Unit price", "money"), f("preferred_supplier", "Supplier"),
    f("lead_time_days", "Lead time"), f("auto_purchase", "Auto purchase", "bool"),
  ],
  quotes: [
    f("quote_ref", "Quote number", "text", true), f("customer", "Customer"), f("quote_date", "Quote date", "date"), f("valid_until", "Valid until", "date"),
    f("status", "Status"), f("description", "Description"), f("terms", "Terms"), f("customer_notes", "Customer notes"), f("internal_notes", "Internal notes"),
    f("total_value", "Total (net)", "money"), f("vat_enabled", "VAT added", "bool"), ...QUOTE_LINES,
  ],
  sales_orders: [
    f("so_number", "Order number", "text", true), f("customer", "Customer"), f("customer_po", "Customer PO"), f("quote_ref", "Quote number"), f("status", "Status"),
    f("order_date", "Order date", "date"), f("delivery_date", "Delivery date", "date"), f("total_value", "Total (net)", "money"), f("notes", "Notes"),
  ],
  jobs: [
    f("job_no", "Job number", "text", true), f("customer", "Customer"), f("description", "Description"), f("quote_ref", "Quote number"), f("so_number", "Order number"),
    f("customer_po", "Customer PO"), f("stage", "Stage"), f("status", "Status"), f("due_date", "Due date", "date"), f("date_received", "Date received", "date"),
    f("drawing_no", "Drawing number"), f("quantity_required", "Quantity", "number"), f("material_required", "Material"), f("specification", "Specification"),
    f("value", "Value", "money"),
  ],
  purchase_orders: [
    f("po_ref", "PO number", "text", true), f("supplier", "Supplier"), f("order_date", "Order date", "date"), f("expected_delivery", "Expected delivery", "date"),
    f("total_value", "Total (net)", "money"), f("status", "Status"), f("notes", "Notes"), f("vat_enabled", "VAT added", "bool"),
    f("sent_by", `Sent by ${PERSON}`),
  ],
  invoices: [
    f("invoice_ref", "Invoice number", "text", true), f("customer", "Customer"), f("invoice_date", "Invoice date", "date"), f("due_date", "Due date", "date"),
    f("status", "Status"), f("subtotal", "Net", "money"), f("vat", "VAT", "money"), f("total", "Total", "money"), f("vat_enabled", "VAT added", "bool"),
    f("terms", "Terms"), f("customer_po", "Customer PO"), f("quote_ref", "Quote number"), f("job_no", "Job number"), f("description", "Description"),
    f("sent_by", `Sent by ${PERSON}`), ...INVOICE_LINES,
  ],
  payments: [
    f("invoice_ref", "Invoice number", "text", true), f("paid_on", "Date paid", "date"), f("amount", "Amount", "money"), f("method", "Method"), f("reference", "Reference"),
  ],
  // 085: issued credit notes, each with the invoice it credits (in the same file); its number is kept as written.
  credit_notes: [
    f("credit_ref", "Credit note number", "text", true), f("invoice_ref", "Invoice number (the invoice it credits)"), f("customer", "Customer"),
    f("credit_date", "Credit note date", "date"), f("status", "Status"), f("reason", "Reason"), f("subtotal", "Net", "money"), f("vat", "VAT", "money"),
    f("total", "Total", "money"), f("vat_enabled", "VAT added", "bool"), ...INVOICE_LINES,
  ],
  // 085: delivery notes as they went (sent out, delivered or signed), with their items.
  delivery_notes: [
    f("dn_number", "Delivery note number", "text", true), f("customer", "Customer"), f("job_no", "Job number"), f("so_number", "Order number"),
    f("invoice_ref", "Invoice number"), f("delivery_date", "Delivery date", "date"), f("ship_date", "Ship date", "date"), f("ship_via", "Ship via"),
    f("status", "Status"), f("notes", "Notes"), f("signed_by", `Signed by ${PERSON}`), f("signed_at", "Date signed", "date"),
    f("signature_notes", "Signature notes"), f("lines.description", "Line: description"), f("lines.quantity", "Line: quantity", "number"),
  ],
};

/**
 * Columns of our own payments export that decide whether a row is imported: "Type" (a Reversal row is skipped) and "Reversed" (a payment
 * that was reversed is skipped), as lib/import-columns.ts says an importer should. Never sent to the database.
 */
export const PAYMENT_FLAGS: TargetField[] = [f("_type", "Type (a Reversal is skipped)"), f("_reversed", "Reversed (Yes is skipped)")];

/** What a dropdown offers for a kind: its fields (payments also take the two skip flags). */
export function targetsFor(kind: ImportKind): TargetField[] {
  return kind === "payments" ? [...TARGETS[kind], ...PAYMENT_FLAGS] : TARGETS[kind];
}

export function targetOf(kind: ImportKind, key: string): TargetField | undefined {
  return targetsFor(kind).find((t) => t.key === key);
}

export const hasLines = (kind: ImportKind) => kind === "quotes" || kind === "invoices" || kind === "credit_notes" || kind === "delivery_notes";
export const isLineField = (key: string) => key.startsWith("lines.");
