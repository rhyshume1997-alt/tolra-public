import { describe, expect, it } from "vitest";

import { invoiceDetailStatusLabel, invoiceLifecycle } from "@/lib/receivables";

// The invoice page derives status "closed" for any draft, void, cancelled or credited invoice (derive() in invoices/page.tsx).
const row = (rawStatus: string, partPaid = false) => {
  const lifecycle = invoiceLifecycle(rawStatus);
  return { rawStatus, partPaid, status: lifecycle === "closed" ? "closed" : lifecycle === "paid" ? "paid" : "outstanding" };
};

describe("invoice details: the Status badge", () => {
  it("a draft invoice shows DRAFT, not CLOSED (the same as the list)", () => {
    expect(invoiceDetailStatusLabel(row("draft"))).toBe("DRAFT");
  });

  it("void, cancelled and credited invoices show their own status", () => {
    expect(invoiceDetailStatusLabel(row("void"))).toBe("VOID");
    expect(invoiceDetailStatusLabel(row("cancelled"))).toBe("CANCELLED");
  });

  it("paid, part paid and collectible invoices are unchanged", () => {
    expect(invoiceDetailStatusLabel(row("paid"))).toBe("PAID");
    expect(invoiceDetailStatusLabel(row("sent", true))).toBe("PART PAID");
    expect(invoiceDetailStatusLabel({ rawStatus: "sent", partPaid: false, status: "overdue" })).toBe("OVERDUE");
    expect(invoiceDetailStatusLabel({ rawStatus: "sent", partPaid: false, status: "outstanding" })).toBe("OUTSTANDING");
  });
});
