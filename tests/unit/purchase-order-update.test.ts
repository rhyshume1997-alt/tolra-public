// Tests purchase-order update acknowledgements without changing database permissions or transitions.
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { updatePurchaseOrders } from "@/lib/purchase-order-update";

const requested = ["updated", "filtered"];
const columns = { status: "received" };

function responseClient(rows: { id: string }[]) {
  return createClient("https://purchasing.example.test", "local-test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (url, init) => {
        const request = new Request(url, init);
        expect(request.method).toBe("PATCH");
        expect(new URL(request.url).searchParams.get("id")).toBe("in.(updated,filtered)");
        expect(new URL(request.url).searchParams.get("select")).toBe("id");
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
