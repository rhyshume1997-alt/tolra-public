import { describe, expect, it } from "vitest";
import { auditActionLabel, describeEntry, recordTypeLabel, type ActivityEntry } from "@/lib/activity";

// Every table with a security_audit.log_row_change() trigger (migrations 000, 009, 013, 034, 037, 042-045, 050-052, 059, 067, 074-076, 081, 083, 084).
const LABELS: Record<string, string> = {
  customers: "Customer", rfqs: "RFQ", quotes: "Quote", jobs: "Job", invoices: "Invoice", stock: "Stock item", suppliers: "Supplier",
  machines: "Machine", sales_orders: "Sales order", purchase_orders: "Purchase order", delivery_notes: "Delivery note", user_profiles: "User profile",
  quote_line_items: "Line", quote_attachments: "Attachment", invoice_line_items: "Line", delivery_note_items: "Line", machine_bookings: "Machine booking",
  job_values: "Job value", job_files: "File", credit_notes: "Credit note", credit_note_lines: "Credit note line", document_attachments: "File",
  job_machines: "Job machine", sales_order_line_machines: "Order line machine", machine_runs: "Machine run", job_signoffs: "Sign-off",
  job_rework: "Rework", job_rework_entries: "Rework entry", operator_sessions: "Operator session", time_settings: "Time setting",
  attendance_events: "Clock action", attendance_event_networks: "Clock action network", time_week_approvals: "Week approval", time_day_flags: "Day flag",
  time_sync_rejections: "Rejected clock sync", job_flow_events: "Job flow", job_inspections: "Inspection", invoice_queue_events: "Invoice queue event",
  inspector_authorisations: "Inspector authorisation", integration_connections: "Integration connection", integration_mappings: "Integration mapping",
  integration_contacts: "Integration contact", integration_sends: "Integration send", site_network_settings: "Site network setting",
  site_networks: "Site network", site_network_members: "Site network member", site_network_names: "Site network name", import_mappings: "Import mapping", import_batches: "Import batch",
  import_runs: "Import run",
};

const entry = (entity_table: string, action: string): ActivityEntry => ({
  id: "1", created_at: "2026-10-19T10:00:00Z", actor_name: null, action, entity_table, entity_id: null, changes: null, snapshot: {}, metadata: null,
});

describe("audited table labels", () => {
  it.each(Object.entries(LABELS))("%s is labelled %s", (table, label) => {
    expect(recordTypeLabel(table)).toBe(label);
    expect(recordTypeLabel(table)).not.toMatch(/_/);
  });

  it("titles a new clock action once, with no raw table name", () => {
    expect(describeEntry(entry("attendance_events", "INSERT"), {}).title).toBe("Clock action created");
    expect(describeEntry(entry("rfqs", "INSERT"), {}).title).toBe("RFQ created");
    expect(describeEntry(entry("user_profiles", "INSERT"), {}).title).toBe("User profile created");
  });

  it("words the raw audit actions plainly", () => {
    expect(auditActionLabel("INSERT")).toBe("Created");
    expect(auditActionLabel("UPDATE")).toBe("Changed");
    expect(auditActionLabel("DELETE")).toBe("Removed");
  });
});
