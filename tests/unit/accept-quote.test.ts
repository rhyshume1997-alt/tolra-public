import { describe, expect, it, vi } from "vitest";

import { type AcceptQuoteResult, acceptOutcome, awaitsCustomerPo, customerPoInput, deliveryDateInput, manualOrderIdentity } from "@/lib/accept-quote";
import { salesOrderSaveSchema } from "@/lib/validation/schemas";

const base: AcceptQuoteResult = {
  quote_id: "q1", quote_ref: "QUO-0101", accepted: true, so_id: "s1", so_number: "SO-0007", so_created: true, provisional: true,
  job_id: "j1", job_no: "J-0101", job_created: true, auto_convert: true, needs: null, reason: null, job_reason: null,
};

describe("customerPoInput", () => {
  it("trims, and empty means no PO yet", () => {
    expect(customerPoInput("  PO-1 ")).toBe("PO-1");
    expect(customerPoInput("   ")).toBeNull();
    expect(customerPoInput("")).toBeNull();
  });
});

describe("deliveryDateInput", () => {
  it("passes a real date, and everything else means no due date", () => {
    expect(deliveryDateInput("2026-11-30")).toBe("2026-11-30");
    expect(deliveryDateInput(" 2026-11-30 ")).toBe("2026-11-30");
    expect(deliveryDateInput("")).toBeNull();
    expect(deliveryDateInput("30/11/2026")).toBeNull();
    expect(deliveryDateInput("2026-02-30")).toBeNull();
  });
});

describe("acceptOutcome", () => {
  it("order and job made: says both, the job is not started, links to the job", () => {
    const told = acceptOutcome(base);
    expect(told.tone).toBe("success");
    expect(told.message).toBe("QUO-0101 accepted. Sales order SO-0007 created (a provisional number: add the customer's PO on Sales Orders when it arrives) and job J-0101 made, not started.");
    expect(told.link).toEqual({ label: "Open job J-0101", href: "/jobs?job=j1" });
  });

  it("a job number with no id still links to the job, by number", () => {
    expect(acceptOutcome({ ...base, job_id: null }).link).toEqual({ label: "Open job J-0101", href: "/jobs?created=J-0101" });
  });

  it("with the customer's PO: no provisional note", () => {
    expect(acceptOutcome({ ...base, so_number: "PO-88", provisional: false }).message).toBe("QUO-0101 accepted. Sales order PO-88 created and job J-0101 made, not started.");
  });

  it("setting manual: the order waits for Convert to Job", () => {
    const told = acceptOutcome({ ...base, job_id: null, job_no: null, job_created: false, auto_convert: false, provisional: false, so_number: "PO-9" });
    expect(told).toEqual({ tone: "success", message: "QUO-0101 accepted. Sales order PO-9 created. Convert it to a job on Sales Orders when you're ready.", link: { label: "Open Sales Orders", href: "/sales-orders" } });
  });

  it("the job couldn't be made: a warning with the database's reason", () => {
    const told = acceptOutcome({ ...base, job_id: null, job_no: null, job_created: false, provisional: false, so_number: "PO-9", job_reason: "Use Convert to Job on the order." });
    expect(told.tone).toBe("warning");
    expect(told.message).toBe("QUO-0101 accepted. Sales order PO-9 created. Use Convert to Job on the order.");
  });

  it("terms refused: accepted, needs a sales order by hand, with the reason and the manual path", () => {
    const reason = "That quote has lines at different VAT rates. A sales order holds one VAT rate, so it can't be linked without changing the VAT. Choose \"No linked quote\" and enter the order by hand.";
    const told = acceptOutcome({ ...base, so_id: null, so_number: null, so_created: false, provisional: false, job_id: null, job_no: null, job_created: false, needs: "sales_order_by_hand", reason });
    expect(told).toEqual({ tone: "warning", message: `QUO-0101 accepted, but it needs a sales order by hand. ${reason}`, link: { label: "Open Sales Orders", href: "/sales-orders" } });
  });

  it("already accepted: nothing changed, points to what it has", () => {
    const told = acceptOutcome({ ...base, accepted: false, so_created: false, job_created: false });
    expect(told).toEqual({ tone: "info", message: "QUO-0101 was already accepted: it has sales order SO-0007 and job J-0101. Nothing was changed.", link: { label: "Open job J-0101", href: "/jobs?job=j1" } });
    expect(acceptOutcome({ ...base, accepted: false, so_id: null, so_number: null, so_created: false, job_id: null, job_no: null, job_created: false, reason: "No lines." }, "QUO-1").message)
      .toBe("QUO-1 is accepted, but it needs a sales order by hand. No lines.");
  });
});

describe("awaitsCustomerPo", () => {
  it("is an order with a provisional SO number and no customer PO", () => {
    expect(awaitsCustomerPo({ ref: "SO-0001", customerPo: "" })).toBe(true);
    expect(awaitsCustomerPo({ ref: "SO-12345", customerPo: null })).toBe(true);
    expect(awaitsCustomerPo({ ref: "SO-0001", customerPo: "  " })).toBe(true);
  });
  it("is not an order with its PO, or an older hand-entered order that never stored one", () => {
    expect(awaitsCustomerPo({ ref: "PO-77", customerPo: "PO-77" })).toBe(false);
    expect(awaitsCustomerPo({ ref: "SO-0001", customerPo: "PO-77" })).toBe(false);
    expect(awaitsCustomerPo({ ref: "ACME-4411", customerPo: "" })).toBe(false);
    expect(awaitsCustomerPo({ ref: "SO-1", customerPo: undefined })).toBe(false);
  });
});

describe("a manual sales order's customer PO is optional (customer_po is nullable, as on Mark accepted)", () => {
  it("the save schema accepts an empty PO and still trims and caps it", () => {
    const base = { customer: "Acme", quoteRef: "", orderDate: "2026-10-19", deliveryDate: "", totalValue: 50 };
    expect(salesOrderSaveSchema.safeParse({ ...base, customerPo: "" }).success).toBe(true);
    expect(salesOrderSaveSchema.safeParse({ ...base, customerPo: "   " }).success).toBe(true);
    expect(salesOrderSaveSchema.safeParse({ ...base, customerPo: "x".repeat(101) }).success).toBe(false);
  });

  it("with a PO the order is referenced by it; the number is not allocated", async () => {
    const next = vi.fn(async () => "SO-0007");
    expect(await manualOrderIdentity("  PO-123 ", next)).toEqual({ soNumber: "PO-123", customerPo: "PO-123" });
    expect(next).not.toHaveBeenCalled();
  });

  it("with no PO it takes a provisional SO-#### number and leaves customer_po empty", async () => {
    const next = vi.fn(async () => "SO-0007");
    expect(await manualOrderIdentity("   ", next)).toEqual({ soNumber: "SO-0007", customerPo: null });
    expect(next).toHaveBeenCalledTimes(1);
    expect(awaitsCustomerPo({ customerPo: null, ref: "SO-0007" })).toBe(true);
  });
});
