import { describe, expect, it } from "vitest";

import { REASON_LABEL, customerKey, isMissingFunction, toUninvoiced } from "@/lib/uninvoiced";

describe("sent but not invoiced (migration 059)", () => {
  it("reads a row of uninvoiced_delivery_notes()", () => {
    expect(toUninvoiced({
      delivery_note_id: "n1", dn_number: "DLN-0007", customer: "Acme Ltd", status: "despatched", sent_at: "2026-10-15T09:00:00Z", delivery_date: "2026-10-15",
      reason: "queued-failed", detail: "The automatic draft failed: x", invoiceable: true, voided_invoice_ref: null,
    })).toEqual({ id: "n1", ref: "DLN-0007", customer: "Acme Ltd", status: "despatched", sentAt: "2026-10-15T09:00:00Z", reason: "queued-failed", detail: "The automatic draft failed: x", invoiceable: true, voidedInvoiceRef: null });
  });

  it("falls back to the delivery date, and shows an unknown reason as not drafted rather than dropping it", () => {
    const row = toUninvoiced({ delivery_note_id: "n2", dn_number: "DLN-0008", sent_at: null, delivery_date: "2026-10-01", reason: "something-new", invoiceable: false, voided_invoice_ref: "INV-0003" });
    expect(row).toMatchObject({ sentAt: "2026-10-01", reason: "not-drafted", invoiceable: false, voidedInvoiceRef: "INV-0003", customer: "" });
  });

  it("has a label for every reason the database gives", () => {
    expect(Object.keys(REASON_LABEL).sort()).toEqual(["customer-mismatch", "internal-job", "manual-items", "not-drafted", "queued-failed"]);
  });

  it("compares customers as the database does: case and repeated spaces ignored", () => {
    expect(customerKey("  ACME   Ltd ")).toBe(customerKey("acme ltd"));
    expect(customerKey("Acme Ltd")).not.toBe(customerKey("Acme Limited"));
    expect(customerKey(null)).toBe("");
  });

  it("knows the answer for a database older than 059", () => {
    expect(isMissingFunction({ code: "PGRST202" })).toBe(true);
    expect(isMissingFunction({ code: "42501" })).toBe(false);
    expect(isMissingFunction(null)).toBe(false);
  });
});
