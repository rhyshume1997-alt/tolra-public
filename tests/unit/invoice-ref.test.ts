import { describe, expect, it } from "vitest";

import { DRAFT_NO_NUMBER_LABEL, draftKey, exportedInvoiceRef, shownInvoiceRef } from "@/lib/invoice-ref";
import { INVOICE_COLUMNS, type InvoiceExportRow } from "@/lib/import-columns";
import { toCsv } from "@/lib/spreadsheet";

const draft = { reference: draftKey("3f2a9c1e-aaaa-bbbb-cccc-000000000000"), unnumbered: true };
const issued = { reference: "INV-0001" };

describe("draft invoice reference", () => {
  it("keeps the key built from the id, in the old DRAFT-xxxxxxxx form", () => {
    expect(draft.reference).toBe("DRAFT-3F2A9C1E");
  });

  it("shows plain words for a draft, and the number for an issued invoice", () => {
    expect(DRAFT_NO_NUMBER_LABEL).toBe("Draft, no number yet");
    expect(shownInvoiceRef(draft)).toBe("Draft, no number yet");
    expect(shownInvoiceRef(issued)).toBe("INV-0001");
  });

  it("never shows the DRAFT- key", () => {
    expect(shownInvoiceRef(draft)).not.toContain("DRAFT-");
  });

  it("exports a blank Invoice No for a draft and the number for an issued invoice", () => {
    expect(exportedInvoiceRef(draft)).toBe("");
    expect(exportedInvoiceRef(issued)).toBe("INV-0001");
  });

  it("the invoice CSV leaves a draft's Invoice No blank and keeps every column", () => {
    const row: InvoiceExportRow = { ...draft, customer: "Arc Co", amount: 120, amountPaid: 0, credited: 0, balance: 120, status: "closed", rawStatus: "draft" };
    const [, line] = toCsv(INVOICE_COLUMNS, [row]).slice(1).split("\r\n");
    expect(line.startsWith(",Arc Co,")).toBe(true);
    expect(line).not.toContain("DRAFT-");
    expect(line.split(",")).toHaveLength(INVOICE_COLUMNS.length);
  });
});
