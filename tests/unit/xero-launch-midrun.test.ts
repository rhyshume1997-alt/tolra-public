/**
 * Switched OFF in the middle of a send (release 149), with the REAL engine and a fake database: the next provider call is not made, the row is
 * put back to pending (never left in 'sending'), the run stops with launch_hold and nothing throws; a call already in flight cannot be recalled
 * and its real result is recorded.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { type ClaimedSend, type EngineDb, runSends as realRunSends } from "@/lib/integrations/engine";
import { type AccountingProvider, type IntegrationDocument, type Mappings, TransfersHeldError } from "@/lib/integrations/types";
import { heldXeroProvider } from "@/lib/integrations/xero/launch-hold";

const state = { enabled: false };

describe("switched OFF in the middle of a send (the real engine, a fake database)", () => {
  const NOW = Date.parse("2026-10-21T10:00:00Z");
  const mappings: Mappings = { salesAccount: "200", creditAccount: "260", taxRates: { "20": "OUTPUT2" } };
  const document: IntegrationDocument = {
    doc_type: "invoice", id: "doc-1", number: "INV-0042", date: "2026-10-21", due_date: "2026-11-20", reference: null, customer: "Acme Ltd", status: "issued", voided: false,
    subtotal: 100, carriage: 0, vat: 20, total: 120, lines: [{ description: "Bush", quantity: 2, unit_price: 50, net: 100, vat: 20, vat_key: "20", text_only: false }],
  };
  function setup(attempts = 1) {
    const recorded: Array<Record<string, unknown>> = [];
    const send: ClaimedSend = { id: "s-1", claim: "k-1", doc_type: "invoice", doc_id: "doc-1", doc_ref: "INV-0042", action: "create", attempts, external_id: null, tenant_id: "t-1" };
    const claims = [{ blocked: null, send }];
    const db: EngineDb = {
      async rpc<T>(fn: string, args: Record<string, unknown>) {
        if (fn === "integration_claim_next") return (claims.shift() ?? { blocked: null, send: null }) as T;
        if (fn === "integration_document") return document as T;
        if (fn === "integration_record_result") { recorded.push(args); return { recorded: true } as T; }
        return { state: "ok", external_contact_id: "c-1", problem: null } as T;
      },
      mappings: async () => mappings,
      contact: async () => null,
    };
    const raw = {
      id: "xero" as const, listAccounts: vi.fn(async () => []), listTaxRates: vi.fn(async () => []), findContacts: vi.fn(async () => []),
      createContact: vi.fn(async (name: string) => ({ id: "c-new", name, archived: false })),
      pushInvoice: vi.fn(async () => ({ externalId: "x1", externalNumber: "INV-0042", status: "AUTHORISED", totals: { subTotal: 100, totalTax: 20, total: 120 } })),
      pushCreditNote: vi.fn(), voidInvoice: vi.fn(), readBack: vi.fn(async () => null),
    };
    return { db, recorded, raw };
  }
  const run = (db: EngineDb, provider: AccountingProvider, enabled: () => Promise<boolean>, token?: () => Promise<string | null>) =>
    realRunSends("org", "xero", { db, accessToken: token ?? (async () => { if (!(await enabled())) throw new TransfersHeldError("off"); return "tok"; }), provider: () => heldXeroProvider(provider, enabled), now: () => NOW }) as Promise<{ sent: number; retryLater: number; blocked: string | null }>;

  it("off after the claim and before the contact lookup: no Xero call, the row is put back to pending, the run stops with launch_hold, nothing throws", async () => {
    const { db, recorded, raw } = setup();
    state.enabled = false;
    const summary = await run(db, raw as never, async () => state.enabled, async () => "tok");
    expect(summary).toMatchObject({ sent: 0, retryLater: 1, blocked: "launch_hold" });
    expect(raw.findContacts).not.toHaveBeenCalled();
    expect(raw.createContact).not.toHaveBeenCalled();
    expect(raw.pushInvoice).not.toHaveBeenCalled();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ p_status: "pending" });
    expect(recorded[0].p_retry_at).toBeTruthy();
  });
  it("off after the contact lookup and before the push: the invoice is not pushed, the row goes back to pending", async () => {
    const { db, recorded, raw } = setup();
    state.enabled = true;
    raw.findContacts.mockImplementation(async () => { state.enabled = false; return []; });
    const summary = await run(db, raw as never, async () => state.enabled);
    expect(summary).toMatchObject({ sent: 0, blocked: "launch_hold" });
    expect(raw.pushInvoice).not.toHaveBeenCalled();
    expect(raw.createContact).not.toHaveBeenCalled();
    expect(recorded.map((r) => r.p_status)).toEqual(["pending"]);
  });
  it("off while the push is in flight: that call cannot be recalled; its real result is recorded (sent), never lost", async () => {
    const { db, recorded, raw } = setup();
    state.enabled = true;
    raw.pushInvoice.mockImplementation(async () => { state.enabled = false; return { externalId: "x1", externalNumber: "INV-0042", status: "AUTHORISED", totals: { subTotal: 100, totalTax: 20, total: 120 } }; });
    const summary = await run(db, raw as never, async () => state.enabled);
    expect(summary).toMatchObject({ sent: 1, blocked: null });
    expect(recorded.map((r) => r.p_status)).toEqual(["sent"]);
  });
  it("off at the read-back of a repeat attempt: pending, and nothing is sent without reading Xero first", async () => {
    const { db, recorded, raw } = setup(2);
    state.enabled = false;
    const summary = await run(db, raw as never, async () => state.enabled, async () => "tok");
    expect(summary).toMatchObject({ sent: 0, blocked: "launch_hold" });
    expect(raw.pushInvoice).not.toHaveBeenCalled();
    expect(recorded.map((r) => r.p_status)).toEqual(["pending"]);
  });
});

