/**
 * Regression tests for CR-037 (Module 5 — Customers):
 * Failed customer_credit RPC reads must surface an unavailable warning rather than silently showing £0 credit.
 */
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/use-user", () => ({
  useUser: () => ({
    profile: { organization_id: "alpha" },
    user: { id: "user" },
    activeRole: "admin",
    loading: false,
    hasAnyRole: () => true,
    hasRole: () => true,
  }),
}));

import { CustomersRedesign } from "@/components/customers/customers-redesign";
import { CUSTOMER_CREDITS_UNAVAILABLE, loadCustomerCredits } from "@/lib/customer-credits";

describe("CR-037 (Customers): loadCustomerCredits fails closed instead of returning empty/zero credits", () => {
  it("returns loaded credit balances when customer_credit succeeds", async () => {
    const result = await loadCustomerCredits({
      rpc: async () => ({
        data: [
          { customer: "Acme Ltd", credit: 125.5 },
          { customer: "Beta Engineering", credit: "40.00" },
        ],
        error: null,
      }),
    });
    expect(result.status).toBe("loaded");
    if (result.status === "loaded") {
      expect(result.credits.get("Acme Ltd")).toBe(125.5);
      expect(result.credits.get("Beta Engineering")).toBe(40);
    }
  });

  it("returns loaded with empty map when customer_credit succeeds with no credits held", async () => {
    const result = await loadCustomerCredits({ rpc: async () => ({ data: [], error: null }) });
    expect(result).toEqual({ status: "loaded", credits: new Map() });
  });

  it("returns unavailable when customer_credit returns an RPC error", async () => {
    const result = await loadCustomerCredits({
      rpc: async () => ({ data: null, error: { code: "503", message: "service unavailable" } }),
    });
    expect(result).toEqual({ status: "unavailable" });
  });

  it("returns unavailable when customer_credit throws or returns non-array / invalid credit figures", async () => {
    expect(await loadCustomerCredits({ rpc: async () => { throw new Error("Failed to fetch"); } })).toEqual({ status: "unavailable" });
    expect(await loadCustomerCredits({ rpc: async () => ({ data: null, error: null }) })).toEqual({ status: "unavailable" });
    expect(await loadCustomerCredits({ rpc: async () => ({ data: [{ customer: "Acme", credit: "not-a-number" }], error: null }) })).toEqual({ status: "unavailable" });
  });

  it("renders an explicit unavailable warning callout on CustomersRedesign when creditNotice is present", () => {
    const html = renderToStaticMarkup(
      createElement(CustomersRedesign, {
        customers: [],
        isVisible: () => true,
        view: "table",
        setView: () => undefined,
        loading: false,
        error: null,
        load: async () => undefined,
        emptyTitle: "No customers yet.",
        creditNotice: CUSTOMER_CREDITS_UNAVAILABLE,
        add: () => undefined,
        toolbar: null,
        phaseFilter: null,
        dialog: null,
        details: () => null,
        actions: () => null,
      }),
    );
    expect(html).toContain('data-testid="customer-credits-unavailable"');
    expect(html).toContain("Customer credit balances");
  });

  it("wires loadCustomerCredits and unavailable notice into app/(dashboard)/customers/page.tsx", () => {
    const page = readFileSync("app/(dashboard)/customers/page.tsx", "utf8");
    expect(page).toContain("loadCustomerCredits(supabase)");
    expect(page).toContain("CUSTOMER_CREDITS_UNAVAILABLE");
    expect(page).toContain('data-testid="customer-credits-unavailable"');
  });
});
