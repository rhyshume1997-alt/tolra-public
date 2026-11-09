import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { pollMailbox, recordForCompany, saveResultFor } from "@/lib/integrations/microsoft/inbox";

const ORG = "11111111-1111-4111-8111-111111111111";
describe("inbound customer payment wording is evidence, never a payment", () => {
  it.each(["We have paid invoice DEMO-INV-1.", "Remittance attached for DEMO-INV-1.", "Payment sent for DEMO-INV-1."])("records %s without changing invoice money or status", async (text) => {
    const invoice = Object.freeze({ id: "invoice-1", organization_id: ORG, invoice_ref: "DEMO-INV-1", status: "sent", total: 120, amount_paid: 0, credited_amount: 0, refunded_amount: 0, paid_at: null, payment_unverified: false, payment_claimed_at: null });
    const before = structuredClone(invoice);
    const payments = Object.freeze([]);
    const evidence: Array<Record<string, unknown>> = [];
    const calls: string[] = [];
    const service = {
      // No table write methods: any new invoice/payment write in the inbound path must fail this test.
      from: () => { throw new Error("Inbound customer email must not write invoice/payment tables"); },
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push(name);
        expect(args.p_org).toBe(ORG);
        if (name === "mailbox_record_inbound") {
          evidence.push(structuredClone(args));
          return { data: { inserted: true, inbound_email_id: "evidence-1" }, error: null };
        }
        if (name === "mailbox_sync_result") return { data: null, error: null };
        throw new Error(`Forbidden inbound write: ${name}`);
      },
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ value: [{
      id: "fake-reply-1", internetMessageId: "<fake-reply@example.test>", receivedDateTime: "2026-11-03T10:00:00Z",
      subject: "Re: DEMO-INV-1 reminder", from: { emailAddress: { address: "customer@example.test", name: "Example Customer A" } },
      bodyPreview: text, body: { contentType: "text", content: text },
    }] }));
    const result = await pollMailbox({ cursor: { checkpoint: null, nextLink: null }, accessToken: async () => "synthetic-token",
      record: recordForCompany(service as never, ORG), saveResult: saveResultFor(service as never, ORG), fetchImpl,
      now: () => Date.parse("2026-11-03T11:00:00Z") });
    expect(result).toMatchObject({ read: 1, inserted: 1, duplicates: 0, error: null });
    expect(result.stored).toHaveLength(1);
    expect(calls).toEqual(["mailbox_record_inbound", "mailbox_sync_result"]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ p_org: ORG, p_from_address: "customer@example.test", p_subject: "Re: DEMO-INV-1 reminder", p_body_text: text });
    expect(invoice).toEqual(before);
    expect(invoice.status).toBe("sent"); expect(invoice.amount_paid).toBe(0); expect(invoice.paid_at).toBeNull();
    expect(payments).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1]?.method).toBe("GET");
  });
});

it("the actual delegated intake SQL has no invoice/payment mutation hidden inside its evidence RPC", () => {
  const sql = readFileSync(new URL("../../supabase/migrations/127_mailbox_read.sql", import.meta.url), "utf8");
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.mailbox_record_inbound(");
  expect(start).toBeGreaterThan(0);
  const body = sql.slice(start).match(/AS \$\$([\s\S]*?)\$\$;/)?.[1];
  expect(body).toBeDefined();
  const writes = [...body!.matchAll(/(?:INSERT INTO|UPDATE|DELETE FROM) public\.([a-z_]+)/g)].map(match => match[1]);
  expect(writes).toEqual(["inbound_emails", "rfqs", "inbound_emails"]);
  expect(body).not.toMatch(/public\.(invoices|invoice_payments|mark_payment_claimed|record_invoice_payment)\b/);
});
