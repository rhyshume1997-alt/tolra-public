import { describe, expect, it } from "vitest";

import { draftedInvoiceId, invoiceHref, linkedInvoiceId } from "@/lib/invoice-link";

describe("invoice links (/invoices?invoice=<id>)", () => {
  it("builds the link from the invoice id, encoded", () => {
    expect(invoiceHref("3f1c0a52-9a4e-4a39-8d41-1c2b7a9e5d10")).toBe("/invoices?invoice=3f1c0a52-9a4e-4a39-8d41-1c2b7a9e5d10");
    expect(invoiceHref("a b&c")).toBe("/invoices?invoice=a%20b%26c");
  });

  it("reads the id back from the query string", () => {
    expect(linkedInvoiceId("?invoice=abc-123")).toBe("abc-123");
    expect(linkedInvoiceId("?x=1&invoice=abc-123")).toBe("abc-123");
    expect(linkedInvoiceId(`?${invoiceHref("a b&c").split("?")[1]}`)).toBe("a b&c");
  });

  it("returns null when there is no id", () => {
    expect(linkedInvoiceId("")).toBeNull();
    expect(linkedInvoiceId("?invoice=")).toBeNull();
    expect(linkedInvoiceId("?invoice=%20")).toBeNull();
    expect(linkedInvoiceId("?job=abc")).toBeNull();
  });
});

describe("draftedInvoiceId (the draft that Mark Despatched made, migration 059)", () => {
  it("is the invoice of the latest drafted row", () => {
    expect(draftedInvoiceId([{ outcome: "drafted", invoice_id: "inv-2" }, { outcome: "drafted", invoice_id: "inv-1" }])).toBe("inv-2");
  });
  it("skips a failed attempt and a row with no invoice", () => {
    expect(draftedInvoiceId([{ outcome: "failed", invoice_id: null }, { outcome: "drafted", invoice_id: null }, { outcome: "drafted", invoice_id: "inv-1" }])).toBe("inv-1");
  });
  it("is null when nothing was drafted or the rows are unreadable", () => {
    expect(draftedInvoiceId([])).toBeNull();
    expect(draftedInvoiceId([{ outcome: "failed", invoice_id: null }])).toBeNull();
    expect(draftedInvoiceId(null)).toBeNull();
    expect(draftedInvoiceId(undefined)).toBeNull();
    expect(draftedInvoiceId([null])).toBeNull();
  });
});
