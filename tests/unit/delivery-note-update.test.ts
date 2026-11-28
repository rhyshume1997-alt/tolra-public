// Covers full, partial and absent database acknowledgements for Delivery Notes.
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { updateDeliveryNotes } from "@/lib/delivery-note-update";

const ids = ["visible", "filtered"];
const columns = { status: "signed" };

function clientWith(rows: { id: string }[]) {
  return createClient("https://delivery.example.test", "local-test-key", {
    global: {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect(request.method).toBe("PATCH");
        expect(await request.json()).toEqual(columns);
        const query = new URL(request.url).searchParams;
        expect(query.get("id")).toBe("in.(visible,filtered)");
        expect(query.get("select")).toBe("id");
        expect(request.headers.get("prefer")).toContain("return=representation");
        return Response.json(rows);
      },
    },
  });
}

describe("delivery note update acknowledgement", () => {
  it("returns only the acknowledged notes after a partial update", async () => {
    await expect(updateDeliveryNotes(clientWith([{ id: "visible" }]), ids, columns)).resolves.toEqual(["visible"]);
  });

  it("refuses a zero-row result", async () => {
    await expect(updateDeliveryNotes(clientWith([]), ids, columns)).rejects.toThrow("No delivery notes were updated");
  });

  it("preserves the full success path", async () => {
    await expect(updateDeliveryNotes(clientWith([{ id: "filtered" }, { id: "visible" }]), ids, columns)).resolves.toEqual(ids);
  });
});
