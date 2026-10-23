import { describe, expect, it } from "vitest";

import { canDespatch, editBlockedReason, isConverted, ordersToConvert, ordersToDespatch } from "@/lib/sales-order-convert";

describe("isConverted", () => {
  it("is true when the order has a job", () => {
    expect(isConverted({ status: "open", convertedJob: "J-0101" })).toBe(true);
    expect(isConverted({ status: "despatched", convertedJob: "Linked" })).toBe(true);
  });

  it("is true when the status says converted, even with no job number to hand", () => {
    expect(isConverted({ status: "converted", convertedJob: "" })).toBe(true);
  });

  it("is false for an order with no job yet", () => {
    expect(isConverted({ status: "open", convertedJob: "" })).toBe(false);
    expect(isConverted({ status: "confirmed" })).toBe(false);
    expect(isConverted({ status: null, convertedJob: null })).toBe(false);
  });
});

describe("ordersToConvert", () => {
  it("leaves out orders that already have a job", () => {
    const orders = [
      { ref: "A", status: "open", convertedJob: "" },
      { ref: "B", status: "converted", convertedJob: "J-0001" },
      { ref: "C", status: "confirmed", convertedJob: "" },
    ];
    expect(ordersToConvert(orders).map((o) => o.ref)).toEqual(["A", "C"]);
  });
});

describe("Despatch is offered only where valid", () => {
  const cases: Array<[string, { status: string; convertedJob?: string }, boolean]> = [
    ["open, no job", { status: "open" }, true],
    ["confirmed, no job", { status: "confirmed" }, true],
    ["in production, no job", { status: "in_production" }, true],
    ["open but already has a job", { status: "open", convertedJob: "J-0101" }, false],
    ["confirmed but already has a job", { status: "confirmed", convertedJob: "J-0101" }, false],
    ["in production but already has a job", { status: "in_production", convertedJob: "J-0101" }, false],
    ["converted (status)", { status: "converted" }, false],
    ["despatched", { status: "despatched" }, false],
    ["closed", { status: "closed" }, false],
  ];

  it.each(cases)("%s", (_name, order, offered) => {
    expect(canDespatch(order)).toBe(offered);
  });

  it("treats a missing status as open", () => {
    expect(canDespatch({ status: null })).toBe(true);
    expect(canDespatch({})).toBe(true);
  });

  it("Despatch Selected acts only on the eligible selected orders, and none when none qualify", () => {
    const orders = [
      { ref: "A", status: "open" },
      { ref: "B", status: "converted", convertedJob: "J-1" },
      { ref: "C", status: "despatched" },
      { ref: "D", status: "confirmed" },
      { ref: "E", status: "closed" },
    ];
    expect(ordersToDespatch(orders).map((o) => o.ref)).toEqual(["A", "D"]);
    expect(ordersToDespatch([orders[1], orders[2], orders[4]])).toEqual([]);
  });
});

describe("editBlockedReason: a converted order is not edited (088)", () => {
  it("names the job when the order has one", () => {
    expect(editBlockedReason({ status: "converted", convertedJob: "J-0042" })).toBe("Converted to J-0042: change the job, not the order.");
    // Linked but with its status moved on (despatched, closed): still the job's.
    expect(editBlockedReason({ status: "despatched", convertedJob: "J-0101" })).toBe("Converted to J-0101: change the job, not the order.");
  });

  it("says 'a job' when the job number isn't to hand (the status says converted, or the page only knows it is linked)", () => {
    expect(editBlockedReason({ status: "converted", convertedJob: "" })).toBe("Converted to a job: change the job, not the order.");
    expect(editBlockedReason({ status: "open", convertedJob: "Linked" })).toBe("Converted to a job: change the job, not the order.");
  });

  it("is null for an order with no job yet, whatever its status", () => {
    for (const status of ["open", "confirmed", "in_production", "despatched", "closed", null]) expect(editBlockedReason({ status, convertedJob: "" })).toBeNull();
    expect(editBlockedReason({})).toBeNull();
  });
});
