import { describe, expect, it } from "vitest";

import { deliveryNoteNumberForInvoice, jobNumberForQuote, nextNumber, quoteNumberForJob } from "@/lib/numbering";

describe("numbering", () => {
  it("nextNumber is highest + 1, zero padded", () => {
    expect(nextNumber("QUO", ["QUO-0102", "QUO-0101", null, "junk"])).toBe("QUO-0103");
    expect(nextNumber("INV", [])).toBe("INV-0001");
    expect(nextNumber("INV-", ["INV-0009"])).toBe("INV-0010");
  });

  it("ignores other prefixes", () => {
    expect(nextNumber("QUO", ["INV-5000", "QUO-0007"])).toBe("QUO-0008");
  });

  it("delivery note number mirrors the invoice", () => {
    expect(deliveryNoteNumberForInvoice("INV-0102")).toBe("DLN-0102");
    expect(() => deliveryNoteNumberForInvoice("QUO-1")).toThrow();
  });

  it("job number carries the quote number", () => {
    expect(jobNumberForQuote("QUO-0102")).toBe("J-0102");
    expect(quoteNumberForJob("J-0102")).toBe("QUO-0102");
    expect(quoteNumberForJob("X-1")).toBeNull();
    expect(() => jobNumberForQuote("INV-1")).toThrow();
  });
});
