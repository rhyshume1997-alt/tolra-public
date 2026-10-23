/**
 * A synthetic export in the OLD single-tenant format (supabase/import/export_legacy.sql), used by the legacy import
 * test and the upgrade rehearsal (audit B10). Made-up companies and refs only.
 */
import type { SyntheticWorld } from "./fixtures";

// The importer's id map (public.legacy_import_map) is keyed by (table, old id) only, so every run gets its own old ids
// and uuids: nothing is shared with other runs or test files, and afterAll removes the run's map and archive rows.
/** Run-scoped id helpers: legacy uuids start with the run id, legacy bigint ids are offset per run. */
export function legacyIds(runId: string) {
  const off = (parseInt(runId, 16) % 1_000_000) * 1000;
  return { off, uid: (n: number) => `${runId}-0000-4000-8000-${String(n).padStart(12, "0")}`, I: (n: number) => off + n };
}
const ts = (day: number) => `2026-03-${String(day).padStart(2, "0")}T09:00:00+00:00`;

export function buildLegacyExport(w: SyntheticWorld) {
  const { uid, I } = legacyIds(w.runId);
  const users = w.tenants.alpha.users;
  const legacyOrg = uid(900);
  const profile = (n: number, email: string, role: string, name: string) => ({
    id: uid(n), email, full_name: name, role, secondary_role: null, organization_id: legacyOrg, organization: "Legacy Example Ltd",
    workshop_email: null, active: true, mfa_required: false, last_login_at: ts(2), created_at: ts(1), updated_at: ts(1),
  });
  const who = uid(2); // the office user, as created_by
  const base = { organization_id: legacyOrg, created_by: who, updated_by: who, created_at: ts(3), updated_at: ts(3) };
  // Money: 20% VAT, 2 dp. A legacy quote's total_value is the face value (gross) sent to the customer; its single line
  // is qty x unit_price (net), which the importer turns into one line at the default 20% VAT.
  const quote = (id: number, ref: string, status: string, qty: number, price: number, extra: object = {}) => ({
    ...base, id, quote_ref: ref, customer: "Legacy Example Ltd", description: `Legacy part ${ref}`, material: "Mild steel", quantity: qty, unit_price: price,
    total_value: Math.round((qty * price + Math.round(qty * price * 20) / 100) * 100) / 100, status, valid_until: "2026-12-31", sent_date: null, rfq_id: null, ...extra,
  });
  const invoice = (id: number, ref: string, status: string, qty: number, price: number, extra: object = {}) => {
    const subtotal = Math.round(qty * price * 100) / 100;
    const vat = Math.round(subtotal * 20) / 100;
    return { ...base, id, invoice_ref: ref, job_id: null, customer: "Legacy Example Ltd", description: `Legacy invoice ${ref}`, quantity: qty, unit_price: price,
      subtotal, vat, total: subtotal + vat, status, sent_date: ts(10), due_date: "2026-04-10", paid_date: null, ...extra };
  };
  return {
    format: "quoteflow-legacy-export/1",
    exported_at: "2026-03-31T00:00:00+00:00",
    counts: { organizations: 1, user_profiles: 3, customers: 2, suppliers: 2, stock: 1, rfqs: 1, quotes: 3, invoices: 3, jobs: 3, sales_orders: 2, purchase_orders: 1, delivery_notes: 1, email_history: 2, audit_log: 2 },
    organizations: [{ id: legacyOrg, name: "Legacy Example Ltd", slug: "legacy-example", created_at: ts(1) }],
    user_profiles: [
      profile(1, users.admin.email, "admin", "Legacy Admin"),
      profile(2, users.office.email, "office", "Legacy Office"),
      profile(3, `nobody.${w.runId}@example.test`, "workshop", "Legacy Leaver"),
    ],
    customers: [
      { ...base, id: I(11), name: "Legacy Example Ltd", email: "buyer@example.test", phone: "01000 111111", address: "1 Old Road", notes: null, status: "active" },
      { ...base, id: I(12), name: "Second Legacy Ltd", email: "second@example.test", phone: null, address: null, notes: "n/a", status: "active" },
    ],
    suppliers: [
      { ...base, id: I(21), name: "Steel Supplier Ltd", email: "steel@example.test", phone: null, on_time_rate: 95, reliability_status: "good" },
      { ...base, id: I(22), name: "Tooling Supplier Ltd", email: "tools@example.test", phone: null, on_time_rate: 80, reliability_status: "fair" },
    ],
    stock: [{ ...base, id: I(31), sku: "SKU-7001", material: "Mild steel bar 25mm", current_stock: 40, min_level: 10, reorder_quantity: 20, preferred_supplier: "Steel Supplier Ltd", unit_price: 12.5, lead_time_days: "5", auto_purchase: false }],
    rfqs: [{ ...base, id: I(41), customer: "Legacy Example Ltd", email: "buyer@example.test", phone: null, description: "Bracket enquiry", quantity: 50, material: "Mild steel", estimated_value: 900, status: "quoted", notes: null }],
    quotes: [
      quote(I(51), "QUO-7001", "sent", 10, 25, { sent_date: ts(5), rfq_id: I(41) }),
      quote(I(52), "QUO-7002", "accepted", 4, 100, { sent_date: ts(6) }),
      quote(I(53), "QUO-7003", "draft", 2, 49.99),
    ],
    jobs: [
      { ...base, id: I(61), job_ref: "J-7001", quote_id: I(52), customer: "Legacy Example Ltd", description: "Linked to QUO-7002", stage: "material", due_date: "2026-05-01", value: 480, status: "on_track", specification: "Per drawing", drawings: [], started_at: ts(8), finished_at: null, converted_from_sales_order_id: I(71), converted_at: ts(8) },
      { ...base, id: I(62), job_ref: "J-7002", quote_id: null, customer: "Second Legacy Ltd", description: "Finished job", stage: "dispatched", due_date: "2026-03-20", value: null, status: "on_track", specification: null, drawings: null, started_at: ts(4), finished_at: ts(18), converted_from_sales_order_id: null, converted_at: null },
      { ...base, id: I(63), job_ref: "J-7003", quote_id: null, customer: "Legacy Example Ltd", description: "Valued job", stage: "material", due_date: "2026-06-01", value: 1234.56, status: "on_track", specification: null, drawings: [], started_at: null, finished_at: null, converted_from_sales_order_id: null, converted_at: null },
    ],
    sales_orders: [
      { ...base, id: I(71), order_ref: "SO-7001", customer: "Legacy Example Ltd", quote_id: String(I(52)), status: "converted", order_date: "2026-03-07", expected_delivery: "2026-05-01", total_value: 480, notes: null, converted_to_job_id: I(61), converted_at: ts(8) },
      { ...base, id: I(72), order_ref: "SO-7002", customer: "Second Legacy Ltd", quote_id: "QUO-7001", status: "open", order_date: "2026-03-09", expected_delivery: "2026-05-15", total_value: 250, notes: null, converted_to_job_id: null, converted_at: null },
    ],
    invoices: [
      invoice(I(81), "INV-7001", "paid", 5, 100, { job_id: I(61), paid_date: ts(20) }),
      invoice(I(82), "INV-7002", "part_paid", 2, 250.5),
      invoice(I(83), "INV-7003", "sent", 3, 33.33),
    ],
    purchase_orders: [{ ...base, id: I(91), po_ref: "PO-7001", supplier: "Steel Supplier Ltd", order_date: "2026-03-04", expected_delivery: "2026-03-14", items: [{ description: "Bar 25mm", quantity: 20, unit_price: 12.5 }], total_value: 250, status: "sent", notes: null }],
    delivery_notes: [{ ...base, id: I(101), dn_ref: "DLN-7001", customer: "Legacy Example Ltd", job_id: String(I(61)), delivery_date: "2026-04-02", status: "despatched", notes: null, signed_by: "A. Receiver", signed_at: ts(25), signature_notes: null, emailed_at: null,
      items: [{ description: "Bracket", quantity: 10 }, { name: "Spacer", qty: 4 }, "Loose fixings"] }],
    email_history: [
      { id: uid(201), organization_id: legacyOrg, to_email: "buyer@example.test", to_name: "Buyer", subject: "Quote QUO-7001", body: "Please find attached.", status: "sent_manually", related_to_type: "quote", related_to_id: String(I(51)), drafted_by: uid(2), drafted_at: ts(5), sent_at: ts(5) },
      { id: uid(202), organization_id: legacyOrg, to_email: "buyer@example.test", to_name: "Buyer", subject: "Invoice INV-7001", body: "Thanks.", status: "drafted", related_to_type: "invoice", related_to_id: String(I(81)), drafted_by: uid(2), drafted_at: ts(10), sent_at: null },
    ],
    audit_log: [
      { id: uid(301), organization_id: legacyOrg, actor_user_id: uid(2), actor_email: users.office.email, action: "INSERT", entity_table: "quotes", entity_id: "51", old_data: null, new_data: { quote_ref: "QUO-7001" }, metadata: {}, ip_address: null, user_agent: null, request_id: null, previous_hash: null, hash: "legacy-hash-1", created_at: ts(5) },
      { id: uid(302), organization_id: null, actor_user_id: null, actor_email: null, action: "LOGIN", entity_table: "auth", entity_id: null, old_data: null, new_data: null, metadata: {}, ip_address: null, user_agent: null, request_id: null, previous_hash: "legacy-hash-1", hash: "legacy-hash-2", created_at: ts(6) },
    ],
  };
}

