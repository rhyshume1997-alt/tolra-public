// Exercises receipt selection and the update acknowledgement without changing other Purchasing actions.
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { CANCELLED_RECEIPT_MESSAGE, planPurchaseOrderReceipt, receivePurchaseOrders } from "@/lib/purchase-order-receipt";

const orders = [
  { id: "cancelled", status: "cancelled" },
  { id: "issued", status: "issued" },
  { id: "sent", status: "sent" },
];
const at = "2026-11-26T12:00:00Z";

function clientFor(body: unknown, status = 200) {
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(url, init);
    expect(request.method).toBe("PATCH");
    expect(await request.json()).toEqual({ status: "received", received_at: at });
    expect(new URL(request.url).searchParams.get("select")).toBe("id");
    return Response.json(body, { status });
  });
  return { client: createClient("https://purchasing.example.test", "local-test-key", { global: { fetch } }), fetch };
}

describe("purchase order receipt", () => {
  it("refuses a cancelled-only selection without modifying it", () => {
    const selected = ["cancelled"];
    expect(planPurchaseOrderReceipt(orders, selected)).toEqual({ targets: [], cancelled: ["cancelled"] });
    expect(selected).toEqual(["cancelled"]);
  });

  it("receives an ordinary issued order", async () => {
    const { targets } = planPurchaseOrderReceipt(orders, ["issued"]);
    const { client } = clientFor([{ id: "issued" }]);
    await expect(receivePurchaseOrders(client, targets.map(({ id }) => id), at)).resolves.toEqual(["issued"]);
  });

  it("excludes cancelled orders and counts only confirmed IDs in a mixed batch", async () => {
    const { targets, cancelled } = planPurchaseOrderReceipt(orders, ["issued", "cancelled", "sent"]);
    const { client, fetch } = clientFor([{ id: "sent" }]);
    await expect(receivePurchaseOrders(client, targets.map(({ id }) => id), at)).resolves.toEqual(["sent"]);
    expect(cancelled).toEqual(["cancelled"]);
    expect(new URL(new Request(fetch.mock.calls[0][0]).url).searchParams.get("id")).toBe("in.(issued,sent)");
  });

  it("shows the same refusal when the order was cancelled after loading", async () => {
    const { client } = clientFor({ code: "23514", hint: "purchase_order_cancelled_terminal", message: "Cannot change status" }, 400);
    await expect(receivePurchaseOrders(client, ["issued"], at)).rejects.toThrow(CANCELLED_RECEIPT_MESSAGE);
  });
});
