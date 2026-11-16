import { describe, expect, it } from "vitest";
import { detectPaidClaim } from "@/lib/chase/paid-claim";
const refs = ["INV-12", "INV-123", "INV-124"];
const positive = [
  "We sent the BACS this morning for INV-123.",
  "Sent the BACS this morning, ref INV-123.",
  "We paid INV-123 on Friday.",
  "Ref INV-123 settled.",
  "Payment was made yesterday for INV-123.",
  "BACS has been sent for INV-123.",
  "We have settled invoice INV-123.",
  "Funds transferred today, INV-123.",
  "The balance has been settled for INV-123.",
  "Remittance advice attached for INV-123.",
  "Our accounts team sent payment for INV-123.",
  "We have transferred the funds for INV-123.",
  "Invoice INV-123 is now paid.",
  "Paid in full yesterday — INV-123.",
  "The bank transfer was completed for INV-123.",
  "We paid INV 123 this afternoon.",
  "We have paid inv/123. Cheers.",
  "I have settled INV-123 by bank transfer.",
] as const;
const negative = [
  "Can you send a copy of INV-123?",
  "We will pay INV-123 next week.",
  "INV-123 is not paid yet.",
  "BACS will be sent for INV-123 tomorrow.",
  "We haven't paid INV-123.",
  "Has INV-123 been paid?",
  "Please mark INV-123 paid when the money arrives.",
  "Payment made tomorrow for INV-123, once approved.",
  "We expect the bank transfer to be completed tomorrow for INV-123.",
  "Could you confirm whether payment was made for INV-123?",
  "Not transferred the funds for INV-123 yet.",
  "If payment was made for INV-123, please send the receipt.",
] as const;
describe("30 extra UK payment emails", () => {
  it.each(positive)("recognises the completed claim: %s", (body) => {
    const result = detectPaidClaim({ subject: "Account update", body }, refs);
    expect(result.claimsPaid).toBe(true);
    expect(result.invoiceRefs).toEqual(["INV-123"]);
  });
  it.each(negative)("does not turn this into a claim: %s", (body) => {
    const result = detectPaidClaim({ subject: "Invoice query", body }, refs);
    expect(result.claimsPaid).toBe(false); expect(result.invoiceRefs).toEqual([]);
  });
});
