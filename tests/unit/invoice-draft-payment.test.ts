import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DRAFT_PAYMENT_REASON, paymentBlockedReason } from "@/lib/receivables";

describe("paymentBlockedReason: a draft invoice (no number yet) takes no payment", () => {
  it("gives the plain reason for a draft", () => {
    expect(paymentBlockedReason("draft")).toBe("Issue the invoice before recording a payment");
    expect(DRAFT_PAYMENT_REASON).toBe("Issue the invoice before recording a payment");
  });

  it("a missing or blank status is a draft, as the database reads it", () => {
    expect(paymentBlockedReason(null)).toBe(DRAFT_PAYMENT_REASON);
    expect(paymentBlockedReason(undefined)).toBe(DRAFT_PAYMENT_REASON);
    expect(paymentBlockedReason("  ")).toBe(DRAFT_PAYMENT_REASON);
    expect(paymentBlockedReason("DRAFT")).toBe(DRAFT_PAYMENT_REASON);
  });

  it.each(["issued", "sent", "partial", "paid", "void"])("%s is not blocked by this rule", (status) => {
    expect(paymentBlockedReason(status)).toBeNull();
  });
});

describe("the Invoices page uses that rule", () => {
  const page = readFileSync("app/(dashboard)/invoices/page.tsx", "utf8");

  it("the list does not render a Record payment button on a draft at all", () => {
    expect(page).toContain("{paymentBlockedReason(invoice.rawStatus) ? null : <Button variant=\"outline\" size=\"sm\" disabled={invoice.status === \"paid\" || invoice.status === \"closed\" || saving} onClick={() => openPayment(invoice)}>Record payment</Button>}");
    expect(page).not.toContain("title={paymentBlockedReason(invoice.rawStatus) ?? undefined} onClick={() => openPayment(invoice)}>Record payment");
  });

  it("opening the payment form refuses a draft, whichever button asked", () => {
    expect(page).toMatch(/function openPayment\(invoice: InvoiceRow\) \{\s+const blocked = paymentBlockedReason\(invoice\.rawStatus\);\s+if \(blocked\) \{\s+toast\.error\(blocked\);\s+return;/);
  });

  it("Pay Selected in Full leaves drafts out and says why", () => {
    expect(page).toContain("selectedInvoices.includes(invoice.reference) && !paymentBlockedReason(invoice.rawStatus)");
    expect(page).toContain("None of the selected invoices is waiting for payment. ${DRAFT_PAYMENT_REASON}.");
  });
});
