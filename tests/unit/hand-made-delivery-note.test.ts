/**
 * A delivery note made by hand (Delivery Notes page, "Without an order"): its number comes from the DLN counter in the database
 * (release 147's numbering guard), never from the invoice number it names. The header sent carries no number at all.
 */
import { describe, expect, it } from "vitest";

import { handMadeDeliveryNoteHeader } from "@/lib/hand-made-delivery-note";

const input = { customer: "Acme Ltd", invoiceRef: "INV-0456", job: "J-0042", shipDate: "2026-11-12", taxDate: "2026-11-12", notes: "" };

describe("handMadeDeliveryNoteHeader", () => {
  it("sends no dn_number, even with an invoice number (the old INV-0456 -> DLN-0456 mirror is gone)", () => {
    const header = handMadeDeliveryNoteHeader(input);
    expect(header).not.toHaveProperty("dn_number");
    expect(JSON.stringify(header)).not.toContain("DLN-0456");
  });
  it("keeps the invoice number as a reference, and the rest of the note", () => {
    expect(handMadeDeliveryNoteHeader(input)).toEqual({
      customer: "Acme Ltd", invoice_ref: "INV-0456", job_ref: "J-0042", delivery_date: "2026-11-12", ship_date: "2026-11-12",
      tax_date: "2026-11-12", status: "awaiting", notes: null,
    });
    expect(handMadeDeliveryNoteHeader({ ...input, invoiceRef: "", job: "", notes: "Fragile" })).toMatchObject({ invoice_ref: null, job_ref: null, notes: "Fragile" });
  });
});
