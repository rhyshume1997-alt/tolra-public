/**
 * Admin > Data: the words a spreadsheet's headers and sheet names use, in one data file (tests/unit/import-detect.test.ts keeps it honest).
 * A header is compared after lib/import-detect.ts normaliseHeader: lower case, "&" as "and", everything but letters and digits dropped
 * ("Inv No." and "inv no" and "INV-NO" are the same word). Add a synonym here and nowhere else.
 *
 * Order of trust when a header is looked up: the company's saved mapping, then the export column specs (lib/import-columns.ts), then this list.
 */
import type { ImportKind } from "@/lib/import-targets";

/** "address 1" ... "address 9": the numbered lines of one address, all filling the same (joined) field. */
const numbered = (word: string) => Array.from({ length: 9 }, (_, i) => `${word} ${i + 1}`);

/** Words shared by a customer and a supplier. */
const PARTY_COMMON: Record<string, string[]> = {
  contact_name: ["contact", "contact name", "contact person", "main contact", "attention", "fao", "buyer"],
  email: ["email", "e-mail", "email address", "contact email", "e mail"],
  phone: ["phone", "telephone", "tel", "phone number", "telephone number", "office phone", "tel no"],
  mobile: ["mobile", "mobile number", "mobile phone", "cell", "mob"],
  address: ["address", "full address", "postal address", "invoice address", "billing address", ...numbered("address")],
  notes: ["notes", "note", "comments", "comment", "remarks"],
  // No column of their own in Tolra yet: written into the notes (lib/import-targets.ts into_notes).
  delivery_address: ["delivery address", "deliver to", "ship to", "shipping address", ...numbered("delivery"), ...numbered("delivery address")],
  credit_limit_used: ["use credit limit", "credit limit used", "credit limit on"],
  credit_limit: ["credit limit", "credit limit amount"],
  vat_number: ["vat", "vat number", "vat no", "vat reg", "vat reg no", "vat registration", "vat registration number"],
  website: ["website", "web site", "web address", "url", "www"],
  terms_days: ["terms (days)", "terms days", "payment terms days", "payment days", "credit days"],
  terms_message: ["terms (message)", "terms message", "payment terms", "terms"],
};

export const FIELD_SYNONYMS: Record<ImportKind, Record<string, string[]>> = {
  customers: {
    name: ["name", "customer", "customer name", "client", "client name", "company", "company name", "account name", "account", "business", "business name"],
    external_ref: ["account ref", "account reference", "account no", "account number", "account code", "customer ref", "customer code", "customer no", "client ref", "client code", "external ref"],
    ...PARTY_COMMON,
  },
  suppliers: {
    name: ["name", "supplier", "supplier name", "vendor", "vendor name", "company", "company name", "account name", "business", "business name"],
    external_ref: ["account ref", "account reference", "account no", "account number", "account code", "supplier ref", "supplier code", "supplier no", "vendor ref", "vendor code", "external ref"],
    ...PARTY_COMMON,
  },
  stock: {
    sku: ["sku", "code", "stock code", "part code", "item code", "product code", "part no", "part number", "stock no"],
    material: ["material", "description", "item", "item description", "stock description", "product", "name", "stock item"],
    current_stock: ["stock", "current stock", "quantity in stock", "qty in stock", "on hand", "qty on hand", "in stock", "stock level", "quantity on hand"],
    min_level: ["min level", "minimum", "minimum level", "min stock", "reorder level", "re-order level", "min"],
    reorder_quantity: ["reorder quantity", "reorder qty", "re-order qty", "re-order quantity", "order qty", "order quantity"],
    unit_price: ["unit price", "price", "cost", "unit cost", "cost price", "price each", "buy price"],
    preferred_supplier: ["supplier", "preferred supplier", "main supplier", "vendor"],
    lead_time_days: ["lead time", "lead time days", "lead days", "lead time (days)"],
    auto_purchase: ["auto purchase", "auto order", "auto reorder", "automatic purchase"],
  },
  quotes: {
    quote_ref: ["quote ref", "quote no", "quote number", "quote #", "quotation no", "quotation number", "quote reference", "quote id", "qu no", "quote", "quotation"],
    customer: ["customer", "client", "customer name", "client name", "company", "account"],
    quote_date: ["quote date", "date", "date created", "created", "created on", "date issued", "quote created"],
    valid_until: ["valid until", "valid to", "expiry", "expiry date", "expires", "valid till"],
    status: ["status", "quote status", "stored status"],
    description: ["description", "quote description", "title", "subject", "details", "summary"],
    terms: ["terms", "payment terms", "quote terms", "terms and conditions"],
    customer_notes: ["customer notes", "notes", "comments", "notes to customer"],
    internal_notes: ["internal notes", "private notes", "office notes"],
    total_value: ["total", "quote total", "value", "quote value", "net total", "net", "total value", "total ex vat", "net value", "amount"],
    vat_enabled: ["vat added", "vat enabled", "charge vat", "add vat", "vatable"],
    "lines.description": ["line description", "line item", "item description", "line desc", "item", "product"],
    "lines.quantity": ["qty", "quantity", "line qty", "line quantity", "no off", "qty required"],
    "lines.unit_price": ["unit price", "price", "price each", "each", "rate", "line price", "unit cost"],
    "lines.vat_pct": ["vat %", "vat pct", "vat rate", "line vat", "vat percent", "vat percentage"],
    "lines.vat_exempt": ["vat exempt", "exempt", "zero rated"],
    "lines.part_number": ["part number", "part no", "part", "part ref"],
    "lines.drawing_number": ["drawing number", "drawing no", "drawing", "dwg", "dwg no"],
    "lines.drawing_revision": ["revision", "drawing revision", "drawing rev", "rev"],
  },
  sales_orders: {
    so_number: ["so number", "so no", "so ref", "sales order", "sales order no", "sales order number", "order no", "order number", "order ref", "order", "so", "order id", "so #"],
    customer: ["customer", "client", "customer name", "client name", "company", "account"],
    customer_po: ["customer po", "po", "po number", "po no", "po ref", "customer order no", "customer order number", "your order no", "your ref", "customer ref"],
    quote_ref: ["quote ref", "quote no", "quote number", "our quote", "quote", "quotation no"],
    status: ["status", "order status", "stored status"],
    order_date: ["order date", "date", "date ordered", "date received", "created"],
    delivery_date: ["delivery date", "due date", "required date", "date required", "delivery required", "due", "required by"],
    total_value: ["total", "net", "order value", "value", "order total", "net value", "total value", "net total"],
    notes: ["notes", "note", "comments", "remarks"],
  },
  jobs: {
    job_no: ["job no", "job number", "job ref", "job", "j no", "job #", "work order", "wo no", "job id", "job reference"],
    customer: ["customer", "client", "customer name", "client name", "company", "account"],
    description: ["description", "job description", "details", "part description", "title"],
    quote_ref: ["quote ref", "quote no", "quote number", "our quote", "quote"],
    so_number: ["so number", "so no", "so ref", "sales order", "sales order no", "sales order number", "order no", "order number"],
    customer_po: ["customer po", "po", "po number", "po no", "po ref", "customer order no", "your order no", "your ref"],
    stage: ["stage", "job stage", "progress", "phase"],
    status: ["status", "job status", "stored status"],
    due_date: ["due date", "due", "date required", "required date", "delivery date", "promise date", "required by", "date due"],
    date_received: ["date received", "received", "received date", "date in", "order date", "start date", "date started"],
    drawing_no: ["drawing no", "drawing number", "drawing", "dwg", "dwg no"],
    quantity_required: ["quantity", "qty", "qty required", "quantity required", "no off", "batch size"],
    material_required: ["material", "material required", "material spec"],
    specification: ["specification", "spec", "instructions", "work instructions"],
    value: ["value", "job value", "price", "sell price", "net value", "sale value"],
  },
  purchase_orders: {
    po_ref: ["po number", "po no", "po ref", "po", "purchase order", "purchase order no", "purchase order number", "po #", "po reference", "order no"],
    supplier: ["supplier", "vendor", "supplier name", "vendor name"],
    order_date: ["order date", "date", "date ordered", "po date", "created"],
    expected_delivery: ["expected delivery", "delivery date", "due date", "expected", "date expected", "required date", "delivery due", "due"],
    total_value: ["total", "net", "value", "po value", "net total", "order value", "net value", "total value"],
    status: ["status", "po status", "stored status"],
    notes: ["notes", "note", "comments", "remarks"],
    vat_enabled: ["vat added", "vat enabled", "charge vat", "add vat"],
    sent_by: ["po sent by", "purchase order sent by", "po sent by name", "po raised by", "po issued by", "po sent by user", "sent by", "raised by"],
  },
  invoices: {
    invoice_ref: ["invoice no", "invoice number", "invoice ref", "invoice #", "inv no", "inv number", "inv ref", "inv #", "invoice", "invoice id", "sales invoice no", "invoice reference", "inv"],
    customer: ["customer", "client", "customer name", "client name", "company", "account"],
    invoice_date: ["invoice date", "date", "inv date", "date issued", "date invoiced", "issued", "invoiced on"],
    due_date: ["due date", "due", "payment due", "due on", "date due"],
    status: ["status", "invoice status", "stored status"],
    subtotal: ["net", "subtotal", "sub total", "net total", "net amount", "total ex vat", "goods", "total net", "net value"],
    vat: ["vat", "vat amount", "tax", "vat total", "tax amount"],
    total: ["total", "invoice total", "gross", "gross total", "total inc vat", "total gross", "invoice value", "total value"],
    vat_enabled: ["vat added", "vat enabled", "charge vat", "add vat"],
    terms: ["terms", "payment terms"],
    customer_po: ["customer po", "po", "po number", "po no", "po ref", "customer order no", "customer order number", "your order no", "your ref", "order no"],
    quote_ref: ["quote ref", "quote no", "quote number", "our quote", "quote"],
    job_no: ["job no", "job number", "job ref", "job", "job #", "job reference"],
    description: ["description", "invoice description", "details", "summary"],
    sent_by: ["invoice sent by", "inv sent by", "invoice sent by name", "invoice issued by", "invoiced by", "sent by"],
    "lines.description": ["line description", "line item", "item description", "line desc", "item", "product"],
    "lines.quantity": ["qty", "quantity", "line qty", "line quantity"],
    "lines.unit_price": ["unit price", "price", "price each", "each", "rate", "line price", "unit cost"],
    "lines.vat_pct": ["vat %", "vat pct", "vat rate", "line vat", "vat percent", "vat percentage"],
    "lines.vat_exempt": ["vat exempt", "exempt", "zero rated"],
  },
  payments: {
    invoice_ref: ["invoice no", "invoice number", "invoice ref", "invoice #", "inv no", "inv number", "inv ref", "inv #", "invoice", "invoice id", "invoice reference", "inv"],
    paid_on: ["paid on", "date paid", "payment date", "date received", "received on", "date", "paid date", "received date"],
    amount: ["amount", "payment", "payment amount", "amount paid", "paid", "received", "payment received", "value"],
    method: ["method", "payment method", "payment type", "paid by", "paid via"],
    reference: ["reference", "payment reference", "ref", "bank ref", "bank reference", "cheque no", "remittance"],
  },
  // 085. Specific on purpose: the invoice export's "Credited" column is not a credit note number.
  credit_notes: {
    credit_ref: ["credit note", "credit note no", "credit note number", "credit note ref", "crd no", "crd number", "crd ref", "cn no", "cn number", "credit no",
      "credit number", "credit ref", "credit note reference", "crn", "crn no"],
    invoice_ref: ["invoice no", "invoice number", "invoice ref", "invoice #", "inv no", "inv number", "inv ref", "inv #", "invoice", "invoice reference",
      "original invoice", "invoice credited", "against invoice", "credited invoice"],
    customer: ["customer", "client", "customer name", "client name", "company", "account"],
    credit_date: ["credit date", "credit note date", "date", "date issued", "issued", "cn date", "crd date"],
    status: ["status", "credit status", "stored status"],
    reason: ["reason", "credit reason", "reason for credit", "notes", "note", "comments"],
    subtotal: ["net", "subtotal", "sub total", "net total", "net amount", "total ex vat", "net value"],
    vat: ["vat", "vat amount", "tax", "vat total", "tax amount"],
    total: ["total", "credit total", "gross", "gross total", "total inc vat", "credit value", "total value", "amount"],
    vat_enabled: ["vat added", "vat enabled", "charge vat", "add vat"],
    "lines.description": ["line description", "line item", "item description", "line desc", "item", "product"],
    "lines.quantity": ["qty", "quantity", "line qty", "line quantity"],
    "lines.unit_price": ["unit price", "price", "price each", "each", "rate", "line price"],
    "lines.vat_pct": ["vat %", "vat pct", "vat rate", "line vat", "vat percent", "vat percentage"],
    "lines.vat_exempt": ["vat exempt", "exempt", "zero rated"],
  },
  delivery_notes: {
    dn_number: ["delivery note", "delivery note no", "delivery note number", "delivery note ref", "dln no", "dln number", "dln ref", "dn no", "dn number", "dn ref",
      "despatch note no", "dispatch note no", "despatch note number", "delivery no", "delivery number", "dn"],
    customer: ["customer", "client", "customer name", "client name", "company", "account", "deliver to"],
    job_no: ["job no", "job number", "job ref", "job", "job #", "job reference"],
    so_number: ["so number", "so no", "so ref", "sales order", "sales order no", "sales order number", "order no", "order number"],
    invoice_ref: ["invoice no", "invoice number", "invoice ref", "inv no", "invoice", "invoiced on invoice"],
    delivery_date: ["delivery date", "date", "date delivered", "delivered", "despatch date", "dispatch date", "date despatched", "date sent"],
    ship_date: ["ship date", "shipped", "date shipped", "shipped on"],
    ship_via: ["ship via", "shipped via", "via", "carrier", "courier", "delivery method", "despatch method"],
    status: ["status", "delivery status", "dn status", "stored status"],
    notes: ["notes", "note", "comments", "remarks", "delivery notes"],
    signed_by: ["signed by", "delivery note signed by", "dn signed by", "dln signed by", "delivery signed by", "signed for by", "received by", "signatory"],
    signed_at: ["date signed", "signed on", "signed date", "signed at", "signature date"],
    signature_notes: ["signature notes", "signature note", "signing notes"],
    "lines.description": ["description", "line description", "item", "item description", "line item", "product", "part", "details"],
    "lines.quantity": ["qty", "quantity", "qty delivered", "quantity delivered", "qty despatched", "quantity despatched", "line qty"],
  },
};

/** Sheet names (or a "Kind" cell's text) that name a kind. Plural and singular both. */
export const KIND_WORDS: Record<ImportKind, string[]> = {
  customers: ["customers", "customer", "clients", "client", "customer list", "customer accounts", "sales ledger accounts"],
  suppliers: ["suppliers", "supplier", "vendors", "vendor", "supplier list", "purchase ledger accounts"],
  stock: ["stock", "stock items", "stock list", "inventory", "parts", "items", "stock levels", "materials"],
  quotes: ["quotes", "quote", "quotations", "quotation", "estimates", "quote list"],
  sales_orders: ["sales orders", "sales order", "so", "sos", "sales order list"],
  jobs: ["jobs", "job", "work orders", "work order", "job list", "job board"],
  purchase_orders: ["purchase orders", "purchase order", "po", "pos", "po list", "purchase order list"],
  invoices: ["invoices", "invoice", "sales invoices", "sales invoice", "invoice list", "invoice headers"],
  payments: ["payments", "payment", "receipts", "receipt", "invoice payments", "payments received", "cash receipts"],
  credit_notes: ["credit notes", "credit note", "credits", "credit", "sales credit notes", "crn", "cn"],
  delivery_notes: ["delivery notes", "delivery note", "deliveries", "dn", "dns", "despatch notes", "despatch note", "dispatch notes"],
};

/** Headers that carry a record's kind on a mixed sheet. */
export const KIND_COLUMN_HEADERS = ["kind", "type", "record type", "record kind", "document type", "doc type", "record"];

/**
 * A document number's prefix says what it is: a sheet whose first filled column is all CRD- (or DLN-) numbers looks like credit notes (or
 * delivery notes). Only a suggestion: the admin still chooses.
 */
export const NUMBER_PREFIXES: Partial<Record<ImportKind, RegExp>> = {
  credit_notes: /^(crd|cn)[-\s]?\d/i,
  delivery_notes: /^(dln|dn)[-\s]?\d/i,
};

/**
 * Columns that name a person on one kind of document (085 imports them on that kind: a PO's or an invoice's "sent by", a delivery
 * note's "signed by"). On a sheet of another kind such a column is reported as not a field of that kind, never dropped silently. The
 * contact person is NOT here: it is a column of the customer and the supplier (contact_name), free text and not a Tolra user.
 */
export const PEOPLE_COLUMNS: { label: string; headers: string[] }[] = [
  { label: "PO sent by", headers: ["po sent by", "purchase order sent by", "po sent by name", "po raised by", "po issued by", "po sent by user"] },
  { label: "Invoice sent by", headers: ["invoice sent by", "inv sent by", "invoice sent by name", "invoice issued by", "invoiced by"] },
  { label: "Delivery note signed by", headers: ["delivery note signed by", "dn signed by", "signed by", "dln signed by", "delivery signed by", "signed for by"] },
  { label: "Sent by", headers: ["sent by"] },
];
