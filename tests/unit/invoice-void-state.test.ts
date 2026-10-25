import { describe, expect, it } from "vitest";

import { isVoid, voidOffered } from "@/lib/invoice-void";

const row = (rawStatus: string) => ({ rawStatus, amountPaid: 0, credited: 0, refunded: 0, paymentUnverified: false });

describe("an invoice after it is voided", () => {
  it("is offered Void while issued, and not once void", () => {
    expect(voidOffered(row("sent"))).toBe(true);
    expect(isVoid("sent")).toBe(false);
    expect(voidOffered(row("void"))).toBe(false);
    expect(isVoid("void")).toBe(true);
  });
});
