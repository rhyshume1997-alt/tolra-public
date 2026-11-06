import { describe, expect, it } from "vitest";

import { isFinalInvoice } from "@/lib/invoice-phase-filters";
import { invoiceLifecycle } from "@/lib/receivables";
import { phaseOf } from "@/lib/archive";

// invoices/page.tsx derive(): lifecycle "closed" => derived status "closed"; lifecycle "paid" => "paid"; otherwise overdue/outstanding.
const derivedStatus = (raw: string | null) => { const l = invoiceLifecycle(raw); return l === "paid" ? "paid" : l === "closed" ? "closed" : "outstanding"; };
// The page's placement test before the fix (it tested the DERIVED status).
const oldFinal = (raw: string | null) => ["paid", "void", "cancelled"].includes(derivedStatus(raw));

const OLD = new Date("2020-01-01");
const NOW = new Date("2026-11-06");
const place = (final: boolean) => phaseOf({ final, finalDate: OLD.toISOString() }, undefined, 12, NOW);

describe("sm-c: void invoices and archive placement", () => {
  it("REPRODUCES the old defect: a 5-year-old void invoice was never final, so it stayed Open forever", () => {
    for (const raw of ["void", "voided", "cancelled", "canceled"]) {
      expect(derivedStatus(raw)).toBe("closed");
      expect(oldFinal(raw)).toBe(false);
      expect(place(oldFinal(raw))).toBe("open");
    }
    expect(oldFinal("paid")).toBe(true);
  });
  it("fixed: void, cancelled, credited, written-off and paid are final (aged out to Archived), drafts and live ones are not", () => {
    for (const raw of ["void", "voided", "cancelled", "canceled", "credited", "written_off", "paid"]) { expect(isFinalInvoice(raw)).toBe(true); expect(place(isFinalInvoice(raw))).toBe("archived"); }
    for (const raw of ["draft", null, "", "issued", "sent", "partial", "mystery"]) { expect(isFinalInvoice(raw)).toBe(false); expect(place(isFinalInvoice(raw))).toBe("open"); }
  });
});
