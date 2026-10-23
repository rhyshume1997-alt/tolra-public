import { describe, expect, it } from "vitest";

import type { CustomerRecord } from "@/lib/customers";
import { planRfqEmailCarry, rfqQuoteLine } from "@/lib/rfq-quote";

const customer = (over: Partial<CustomerRecord> = {}): CustomerRecord => ({ id: "c1", name: "Acme Ltd", contactName: "Sam", email: "", phone: "", address: "1 High St", notes: "", ...over });

describe("RFQ to Quote: the e-mail reaches the customer record Send reads", () => {
  it("fills a blank e-mail on the existing customer, keeping the rest of the record", () => {
    const plan = planRfqEmailCarry([customer()], "acme ltd", " buyer@acme.example ");
    expect(plan).toEqual({ action: "update", customer: customer({ email: "buyer@acme.example" }) });
  });

  it("never overwrites an existing customer's e-mail", () => {
    expect(planRfqEmailCarry([customer({ email: "accounts@acme.example" })], "Acme Ltd", "buyer@acme.example")).toEqual({ action: "none" });
  });

  it("starts a customer record (name and e-mail) when there is none", () => {
    const plan = planRfqEmailCarry([customer({ name: "Other" })], "Acme Ltd", "buyer@acme.example");
    expect(plan).toEqual({ action: "create", customer: { name: "Acme Ltd", contactName: "", email: "buyer@acme.example", phone: "", address: "", notes: "" } });
  });

  it("does nothing when the RFQ has no e-mail", () => {
    expect(planRfqEmailCarry([customer()], "Acme Ltd", "  ")).toEqual({ action: "none" });
  });
});

describe("RFQ to Quote: quantity and value open as the first line", () => {
  it("the RFQ value is its total: qty 5, value 100 -> 5 x 20.00", () => {
    expect(rfqQuoteLine(5, 100)).toEqual({ qty: 5, unit: 20 });
  });

  it("rounds the unit price to the penny, half away from zero, like the rest of the app", () => {
    expect(rfqQuoteLine(3, 100)).toEqual({ qty: 3, unit: 33.33 });
    expect(rfqQuoteLine(3, 100.01)).toEqual({ qty: 3, unit: 33.34 });
    expect(rfqQuoteLine("5", "100.00")).toEqual({ qty: 5, unit: 20 });
  });

  it("with no quantity the line is 1 at the whole value; with no value the quantity alone is kept", () => {
    expect(rfqQuoteLine(null, 100)).toEqual({ qty: 1, unit: 100 });
    expect(rfqQuoteLine(0, 100)).toEqual({ qty: 1, unit: 100 });
    expect(rfqQuoteLine(5, null)).toEqual({ qty: 5, unit: 0 });
  });

  it("an RFQ with neither leaves the builder's ordinary blank line", () => {
    expect(rfqQuoteLine(null, null)).toBeNull();
    expect(rfqQuoteLine(0, 0)).toBeNull();
  });
});
