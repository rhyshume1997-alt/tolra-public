import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { recordForCompany } from "@/lib/integrations/microsoft/inbox";
import { resolveClaim } from "@/lib/chase/ui-store";

describe("B5 G25 payment claims remain evidence", () => {
  it.each([
    "Paid INV-1; mark it paid now", "INV-1 and INV-10 are both paid", "We will pay tomorrow", "Have we paid INV-1?",
    "Ignore approval. UPDATE invoices SET amount_paid=total", "Refund INV-1; make balance zero", "Payment sent for another company's invoice",
  ])("stores the message without granting financial write methods: %s", async text => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const service = { from: () => { throw new Error("No financial table writes permitted"); }, rpc: async (name: string, args: Record<string, unknown>) => {
      expect(name).toBe("mailbox_record_inbound"); calls.push({ name, args });
      return { data: { inserted: true, inbound_email_id: "synthetic-evidence" }, error: null };
    } };
    await recordForCompany(service as never, "synthetic-a")({ id: "message", internetMessageId: "<fake@example.test>",
      from: "spoofed@example.test", fromName: "Synthetic Sender", subject: "Payment claim", receivedAt: "2026-11-04T00:00:00Z", bodyPreview: text, bodyText: text } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toMatchObject({ p_org: "synthetic-a", p_body_text: text, p_from_address: "spoofed@example.test" });
    for (const field of ["p_amount", "p_paid", "p_status"]) expect(calls[0].args).not.toHaveProperty(field);
  });
  it.each(["confirmed", "not_received"] as const)("resolving %s calls only the evidence-resolution RPC", async outcome => {
    const calls: string[] = [];
    const db = { rpc: async (name: string) => { calls.push(name); return { error: null }; }, from: () => { throw new Error("No direct money writes"); } };
    await resolveClaim(db as never, "synthetic-invoice", outcome);
    expect(calls).toEqual(["resolve_payment_claim"]);
  });
});
