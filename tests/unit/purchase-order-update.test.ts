// Tests purchase-order update acknowledgements and cancelled-PO receipt/send guards (Module 4).
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { boughtIn } from "@/lib/purchase-order-link";
import {
  NON_RECEIVABLE_PO_STATUSES,
  canEmailPurchaseOrder,
  canReceivePurchaseOrder,
  canRecordPurchaseOrderSent,
  filterReceivablePurchaseOrders,
  isCancelledPurchaseOrder,
  isOpenPurchaseOrder,
  updatePurchaseOrders,
} from "@/lib/purchase-order-update";

const requested = ["updated", "filtered"];
const columns = { status: "received" };

function responseClient(rows: { id: string }[], expectedStatusFilter: string | null = null) {
  return createClient("https://purchasing.example.test", "local-test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (url, init) => {
        const request = new Request(url, init);
        expect(request.method).toBe("PATCH");
        expect(new URL(request.url).searchParams.get("id")).toBe("in.(updated,filtered)");
        expect(new URL(request.url).searchParams.get("select")).toBe("id");
        expect(new URL(request.url).searchParams.get("status")).toBe(expectedStatusFilter);
        expect(request.headers.get("prefer")).toContain("return=representation");
        return Response.json(rows);
      },
    },
  });
}

describe("purchase-order update acknowledgements", () => {
  it("returns only the committed IDs when part of a batch was updated", async () => {
    await expect(updatePurchaseOrders(responseClient([{ id: "updated" }]), requested, columns)).resolves.toEqual(["updated"]);
  });

  it("rejects an apparently successful request that updated no rows", async () => {
    await expect(updatePurchaseOrders(responseClient([]), requested, columns)).rejects.toThrow("No purchase orders were updated");
  });

  it("preserves a fully acknowledged update", async () => {
    await expect(updatePurchaseOrders(responseClient([{ id: "filtered" }, { id: "updated" }]), requested, columns)).resolves.toEqual(requested);
  });
});

describe("CR-008: cancelled purchase orders cannot be received, sent, emailed, or counted open", () => {
  it("excludes cancelled, draft, and received purchase orders from receivable targets", () => {
    const orders = [
      { id: "po-draft", status: "draft" },
      { id: "po-issued", status: "issued" },
      { id: "po-sent", status: "sent" },
      { id: "po-confirmed", status: "confirmed" },
      { id: "po-partial", status: "partial_received" },
      { id: "po-received", status: "received" },
      { id: "po-cancelled", status: "cancelled" },
      { id: "po-cancelled-upper", status: "Cancelled" },
    ];
    const eligible = filterReceivablePurchaseOrders(
      orders,
      orders.map((po) => po.id),
    );
    expect(eligible.map((po) => po.id)).toEqual(["po-issued", "po-sent", "po-confirmed", "po-partial"]);
    expect(isCancelledPurchaseOrder("cancelled")).toBe(true);
    expect(isCancelledPurchaseOrder("Cancelled")).toBe(true);
    expect(canReceivePurchaseOrder("cancelled")).toBe(false);
    expect(canRecordPurchaseOrderSent("cancelled")).toBe(false);
    expect(canEmailPurchaseOrder("cancelled")).toBe(false);
    expect(isOpenPurchaseOrder("cancelled")).toBe(false);
    expect(isOpenPurchaseOrder("issued")).toBe(true);
    // Cancelled PO remains excluded from bought-in job/quote cost because it cannot be received.
    expect(boughtIn([{ id: "po-cancelled", status: "cancelled", total_value: 250 }])).toEqual({ pence: 0, count: 0 });
  });

  it("sends a PostgREST status exclusion filter so stale-UI receipts cannot mutate a cancelled PO", async () => {
    const client = responseClient([{ id: "updated" }], "not.in.(draft,received,cancelled)");
    await expect(
      updatePurchaseOrders(client, requested, { status: "received", received_at: "2026-11-27T12:00:00Z" }, { excludeStatuses: NON_RECEIVABLE_PO_STATUSES }),
    ).resolves.toEqual(["updated"]);

    const emptyClient = responseClient([], "not.in.(draft,received,cancelled)");
    await expect(
      updatePurchaseOrders(emptyClient, requested, { status: "received", received_at: "2026-11-27T12:00:00Z" }, { excludeStatuses: NON_RECEIVABLE_PO_STATUSES }),
    ).rejects.toThrow("No purchase orders were updated");
  });

  it("wires cancelled-PO guards into app/(dashboard)/purchase-orders/page.tsx", () => {
    const page = readFileSync("app/(dashboard)/purchase-orders/page.tsx", "utf8");
    expect(page).toContain("filterReceivablePurchaseOrders(purchaseOrders, ids)");
    expect(page).toContain("excludeStatuses: NON_RECEIVABLE_PO_STATUSES");
    expect(page).toContain("!canReceivePurchaseOrder(po.status)");
    expect(page).toContain("canRecordPurchaseOrderSent(po.status)");
    expect(page).toContain("canEmailPurchaseOrder(viewing.status)");
    expect(page).toContain("isOpenPurchaseOrder(po.status)");
  });
});
