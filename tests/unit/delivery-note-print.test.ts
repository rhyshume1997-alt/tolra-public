import { describe, expect, it } from "vitest";

import { deliveryNoteReceivedLine } from "@/lib/delivery-note-print";

const fmt = (iso: string) => iso.slice(0, 10);

describe("deliveryNoteReceivedLine (printed delivery note)", () => {
  it("a signed note prints who signed for it and when", () => {
    expect(deliveryNoteReceivedLine({ status: "signed", signedByName: " A Customer ", signedAt: "2026-10-26T09:30:00Z" }, fmt))
      .toBe("Received by: A Customer   Date: 2026-10-26   Signature: __________________");
  });
  it("a signed note without a time still names the signer", () => {
    expect(deliveryNoteReceivedLine({ status: "Signed", signedByName: "A Customer", signedAt: null }, fmt)).toContain("Received by: A Customer   Date: __________");
  });
  it("any other note, or a signed one with no name, prints the blank lines", () => {
    const blank = "Received by: __________________ Signature: __________________ Date: __________";
    expect(deliveryNoteReceivedLine({ status: "despatched", signedByName: "A Customer" }, fmt)).toBe(blank);
    expect(deliveryNoteReceivedLine({ status: "signed", signedByName: "  " }, fmt)).toBe(blank);
    expect(deliveryNoteReceivedLine({}, fmt)).toBe(blank);
  });
});
