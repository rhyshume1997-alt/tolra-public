/**
 * Regression tests for CR-014 (Module 3 — Quotes & Sales Orders):
 * Uncertain creation failures (5xx, timeouts, network drops, post-write errors) must tell the user
 * to refresh and check rather than falsely claiming "Nothing was saved."
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { salesCreateErrorMessage, uncertainCreateMessage } from "@/lib/sales-create-error";
import { ValidationError } from "@/lib/validation/schemas";

describe("CR-014 (Module 3): salesCreateErrorMessage", () => {
  it("never claims nothing was saved on 5xx, timeout, network, or unknown errors", () => {
    const cases: unknown[] = [
      { status: 504, message: "Gateway Timeout" },
      { status: 500, message: "Internal Server Error" },
      new TypeError("Failed to fetch"),
      new Error("connection reset after commit"),
      null,
    ];
    for (const err of cases) {
      const quoteMsg = salesCreateErrorMessage(err, "quote");
      const orderMsg = salesCreateErrorMessage(err, "sales order");
      expect(quoteMsg).toBe(uncertainCreateMessage("quote"));
      expect(orderMsg).toBe(uncertainCreateMessage("sales order"));
      expect(quoteMsg.toLowerCase()).not.toContain("nothing was saved");
      expect(orderMsg.toLowerCase()).not.toContain("nothing was saved");
    }
  });

  it("preserves definite client validation and database refusal messages", () => {
    expect(salesCreateErrorMessage(new ValidationError("Enter a customer name."), "quote")).toBe("Enter a customer name.");
    expect(salesCreateErrorMessage({ code: "42501", message: "permission denied for table quotes" }, "quote")).toBe("You don't have permission to do that.");
    expect(salesCreateErrorMessage({ code: "22023", message: "Customer name is required." }, "sales order")).toBe("Customer name is required.");
    expect(salesCreateErrorMessage({ code: "23505", message: "duplicate key" }, "quote")).toContain("already in use");
  });

  it("wires salesCreateErrorMessage into quotes and sales-orders pages with no 'Nothing was saved' create fallback", () => {
    const quotesPage = readFileSync("app/(dashboard)/quotes/page.tsx", "utf8");
    const ordersPage = readFileSync("app/(dashboard)/sales-orders/page.tsx", "utf8");
    expect(quotesPage).toContain('salesCreateErrorMessage(err, "quote")');
    expect(quotesPage).not.toContain("Could not save the quote. Nothing was saved.");
    expect(ordersPage).toContain('salesCreateErrorMessage(err, "sales order")');
    expect(ordersPage).not.toContain("Could not create the sales order. Nothing was saved.");
  });
});
