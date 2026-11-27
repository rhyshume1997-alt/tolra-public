// Exercises invoice sent-date acknowledgement through the installed Supabase client.
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { recordInvoiceSent } from "@/lib/invoice-sent";

const sentAt = "2026-11-27T09:00:00Z";
const invoiceId = "invoice-12";

function clientWith(body: unknown, status = 200) {
  return createClient("https://invoicing.example.test", "local-test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect(request.method).toBe("PATCH");
        expect(await request.json()).toEqual({ sent_date: sentAt });
        const query = new URL(request.url).searchParams;
        expect(query.get("id")).toBe(`eq.${invoiceId}`);
        expect(query.get("select")).toBe("id");
        expect(request.headers.get("prefer")).toContain("return=representation");
        return Response.json(body, { status });
      },
    },
  });
}

describe("record invoice sent", () => {
  it("accepts an acknowledged write for the requested invoice", async () => {
    await expect(recordInvoiceSent(clientWith([{ id: invoiceId }]), invoiceId, sentAt)).resolves.toBeUndefined();
  });

  it.each([{ rows: [] }, { rows: [{ id: "unrelated" }] }])("does not report success without the requested invoice ID (%j)", async ({ rows }) => {
    await expect(recordInvoiceSent(clientWith(rows), invoiceId, sentAt)).rejects.toThrow("check whether the email was sent");
  });

  it("preserves a database refusal", async () => {
    const refusal = { code: "42501", message: "write refused" };
    await expect(recordInvoiceSent(clientWith(refusal, 403), invoiceId, sentAt)).rejects.toMatchObject(refusal);
  });
});
