import { describe, expect, it } from "vitest";

import { DELIVERY_NOTE_GOODS_OUT_WORDING, deliveryNoteGoodsOutWording, deliveryNoteReceivedLine, deliveryNoteSignOffLines } from "@/lib/delivery-note-print";

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

describe("goods-out wording (one place, every delivery note output)", () => {
  it("has a clear default constant", () => {
    expect(DELIVERY_NOTE_GOODS_OUT_WORDING).toBe("Goods out: the items listed above were despatched.");
  });
  it("uses the default unless a company wording is given, and a blank one falls back to the default", () => {
    expect(deliveryNoteGoodsOutWording()).toBe(DELIVERY_NOTE_GOODS_OUT_WORDING);
    expect(deliveryNoteGoodsOutWording("   ")).toBe(DELIVERY_NOTE_GOODS_OUT_WORDING);
    expect(deliveryNoteGoodsOutWording(null)).toBe(DELIVERY_NOTE_GOODS_OUT_WORDING);
    expect(deliveryNoteGoodsOutWording(" Goods out in good order ")).toBe("Goods out in good order");
  });
  it("the sign-off block is the goods-out wording then the received line", () => {
    expect(deliveryNoteSignOffLines({ status: "despatched" }, fmt)).toEqual([
      DELIVERY_NOTE_GOODS_OUT_WORDING,
      "Received by: __________________ Signature: __________________ Date: __________",
    ]);
    expect(deliveryNoteSignOffLines({ status: "signed", signedByName: "A Customer", signedAt: "2026-10-26T09:30:00Z" }, fmt, "Custom wording")).toEqual([
      "Custom wording",
      "Received by: A Customer   Date: 2026-10-26   Signature: __________________",
    ]);
  });
});
