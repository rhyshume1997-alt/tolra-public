/**
 * The send engine, the Xero client and the token lease (G22, migration 084), with Xero and the database faked: nothing reaches the
 * network. Each document is sent once: an unknown outcome is read back before anything is sent again; a repeat attempt reads back first;
 * totals must match; a 429 stops the run until its Retry-After; contact problems never guess; voids are sent as voids (Q11); the refresh
 * token is stored before the new access token is used and a refused one pauses the company.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { decryptSecret, encryptSecret } from "@/lib/integrations/crypto";
import { type ClaimedSend, type EngineDb, MAX_ATTEMPTS, retryDelayMs, runSends } from "@/lib/integrations/engine";
import { overviewSummary, connectOutcomeMessage, vatKeyLabel } from "@/lib/integrations/overview";
import { runIntegrationSweep } from "@/lib/integrations/sweep";
import { createTokenSource } from "@/lib/integrations/tokens";
import type { AccountingProvider, ContactCandidate, IntegrationDocument, Mappings, ProviderDocument } from "@/lib/integrations/types";
import { ProviderError } from "@/lib/integrations/types";
import { createXeroClient, xeroString } from "@/lib/integrations/xero/client";
import { XeroAuthError } from "@/lib/integrations/xero/oauth";

const ORG = "11111111-1111-1111-1111-111111111111";
const NOW = Date.parse("2026-10-21T10:00:00Z");
const mappings: Mappings = { salesAccount: "200", creditAccount: "260", taxRates: { "20": "OUTPUT2" } };
const doc = (over: Partial<IntegrationDocument> = {}): IntegrationDocument => ({
  doc_type: "invoice", id: "doc-1", number: "INV-0042", date: "2026-10-21", due_date: "2026-11-20", reference: null, customer: "Acme Ltd",
  status: "issued", voided: false, subtotal: 100, carriage: 0, vat: 20, total: 120,
  lines: [{ description: "Bush", quantity: 2, unit_price: 50, net: 100, vat: 20, vat_key: "20", text_only: false }], ...over,
});
const inXero = (over: Partial<ProviderDocument> = {}): ProviderDocument => ({ externalId: "x-inv-1", externalNumber: "INV-0042", status: "AUTHORISED", totals: { subTotal: 100, totalTax: 20, total: 120 }, ...over });

type Recorded = { p_status: string; p_external_id: string | null; p_error: string | null; p_retry_at: string | null };

/** A fake database: a queue of claims, the document, the stored contact; records every rpc. */
function fakeDb(opts: { claims: Array<{ blocked: string | null; unmapped?: string[]; send: Partial<ClaimedSend> | null }>; document?: IntegrationDocument | null; contact?: { state: "ok" | "problem"; external_contact_id: string | null; problem: string | null } | null }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const claims = [...opts.claims];
  const db: EngineDb = {
    async rpc<T>(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      if (fn === "integration_claim_next") {
        const next = claims.shift() ?? { blocked: null, send: null };
        return (next.send ? { ...next, send: { id: "s-1", claim: "k-1", doc_type: "invoice", doc_id: "doc-1", doc_ref: "INV-0042", action: "create", attempts: 1, external_id: null, tenant_id: "t-1", ...next.send } } : next) as T;
      }
      if (fn === "integration_document") return (opts.document === undefined ? doc() : opts.document) as T;
      if (fn === "integration_contact_record") return (args.p_problem ? { state: "problem", external_contact_id: null, problem: args.p_problem } : { state: "ok", external_contact_id: args.p_external_contact_id, problem: null }) as T;
      return { recorded: true } as T;
    },
    mappings: async () => mappings,
    contact: async () => opts.contact ?? null,
  };
  const recorded = () => calls.filter((c) => c.fn === "integration_record_result").map((c) => c.args as unknown as Recorded);
  return { db, calls, recorded };
}

function fakeProvider(over: Partial<AccountingProvider> = {}) {
  const p = {
    id: "xero" as const,
    listAccounts: vi.fn(async () => []),
    listTaxRates: vi.fn(async () => []),
    findContacts: vi.fn(async (): Promise<ContactCandidate[]> => []),
    createContact: vi.fn(async (name: string) => ({ id: "contact-new", name, archived: false })),
    pushInvoice: vi.fn(async () => inXero()),
    pushCreditNote: vi.fn(async () => inXero({ externalId: "x-crd-1" })),
    voidInvoice: vi.fn(async () => inXero({ status: "VOIDED" })),
    readBack: vi.fn(async (): Promise<ProviderDocument | null> => null),
    ...over,
  };
  return p;
}

const run = (db: EngineDb, provider: AccountingProvider, token: (force?: boolean) => Promise<string | null> = async () => "access-token") =>
  runSends(ORG, "xero", { db, accessToken: (_o, _p, opts) => token(opts?.force), provider: () => provider, now: () => NOW });

describe("one document, once", () => {
  it("issued, not yet in Xero: the contact is created (none matched), the invoice pushed with the send's id as Idempotency-Key, recorded sent", async () => {
    const { db, recorded } = fakeDb({ claims: [{ blocked: null, send: {} }] });
    const provider = fakeProvider();
    const summary = await run(db, provider);
    expect(summary).toMatchObject({ sent: 1, failed: 0, blocked: null });
    expect(provider.findContacts).toHaveBeenCalledWith("Acme Ltd");
    expect(provider.pushInvoice).toHaveBeenCalledWith(expect.objectContaining({ number: "INV-0042" }), mappings, "contact-new", "tolra-s-1");
    expect(provider.readBack).not.toHaveBeenCalled();
    expect(recorded()).toEqual([expect.objectContaining({ p_status: "sent", p_external_id: "x-inv-1" })]);
  });

  it("the database's gate stops the run: not connected, or something unmapped (nothing is claimed or sent)", async () => {
    const { db } = fakeDb({ claims: [{ blocked: "unmapped", unmapped: ["vat:5"], send: null }] });
    const provider = fakeProvider();
    expect(await run(db, provider)).toMatchObject({ blocked: "unmapped", unmapped: ["vat:5"], sent: 0 });
    expect(provider.pushInvoice).not.toHaveBeenCalled();
  });

  it("an unknown outcome is read back: found = sent (no second push); not found = later, with backoff; can't tell = needs_check", async () => {
    const unknown = () => { throw new ProviderError("No answer from Xero (timeout or network error)", "unknown", 0); };
    let f = fakeDb({ claims: [{ blocked: null, send: {} }] });
    let provider = fakeProvider({ pushInvoice: vi.fn(unknown), readBack: vi.fn(async () => inXero()) });
    await run(f.db, provider);
    expect(provider.pushInvoice).toHaveBeenCalledTimes(1);
    expect(f.recorded()).toEqual([expect.objectContaining({ p_status: "sent", p_external_id: "x-inv-1" })]);

    f = fakeDb({ claims: [{ blocked: null, send: { attempts: 2 } }] });
    provider = fakeProvider({ pushInvoice: vi.fn(unknown), readBack: vi.fn(async () => null) });
    await run(f.db, provider);
    expect(f.recorded()[0]).toMatchObject({ p_status: "pending", p_retry_at: new Date(NOW + retryDelayMs(2)).toISOString() });

    f = fakeDb({ claims: [{ blocked: null, send: {} }] });
    provider = fakeProvider({ pushInvoice: vi.fn(unknown), readBack: vi.fn(async () => { throw new ProviderError("down", "unknown", 503); }) });
    await run(f.db, provider);
    expect(f.recorded()[0]).toMatchObject({ p_status: "needs_check", p_error: expect.stringMatching(/look for it in Xero/) });
  });

  it("a repeat attempt reads Xero back first: already there = sent, nothing pushed again", async () => {
    const f = fakeDb({ claims: [{ blocked: null, send: { attempts: 2 } }] });
    const provider = fakeProvider({ readBack: vi.fn(async () => inXero()) });
    await run(f.db, provider);
    expect(provider.readBack).toHaveBeenCalledWith("invoice", "INV-0042");
    expect(provider.pushInvoice).not.toHaveBeenCalled();
    expect(f.recorded()[0]).toMatchObject({ p_status: "sent" });
  });

  it("totals that differ fail the send with the difference (the document is in Xero: its id is kept)", async () => {
    const f = fakeDb({ claims: [{ blocked: null, send: {} }] });
    await run(f.db, fakeProvider({ pushInvoice: vi.fn(async () => inXero({ totals: { subTotal: 100, totalTax: 20.01, total: 120.01 } })) }));
    expect(f.recorded()[0]).toMatchObject({ p_status: "failed", p_external_id: "x-inv-1", p_error: expect.stringMatching(/^Totals differ: VAT Tolra 20.00, Xero 20.01/) });
  });

  it("a refusal fails with Xero's reason; after MAX_ATTEMPTS unknown outcomes it gives up", async () => {
    let f = fakeDb({ claims: [{ blocked: null, send: {} }] });
    await run(f.db, fakeProvider({ pushInvoice: vi.fn(async () => { throw new ProviderError("Xero refused it: Account code '999' is not a valid code", "failed", 400); }) }));
    expect(f.recorded()[0]).toMatchObject({ p_status: "failed", p_error: "Xero refused it: Account code '999' is not a valid code" });
    f = fakeDb({ claims: [{ blocked: null, send: { attempts: MAX_ATTEMPTS } }] });
    await run(f.db, fakeProvider({ pushInvoice: vi.fn(async () => { throw new ProviderError("timeout", "unknown", 0); }) }));
    expect(f.recorded()[0]).toMatchObject({ p_status: "failed", p_error: expect.stringMatching(/^Gave up after 6 attempts/) });
  });

  it("a 429 puts the document back until Retry-After and stops the run (Xero's limits respected)", async () => {
    const f = fakeDb({ claims: [{ blocked: null, send: {} }, { blocked: null, send: { id: "s-2" } }] });
    const provider = fakeProvider({ pushInvoice: vi.fn(async () => { throw new ProviderError("Xero's rate limit was reached", "rate_limited", 429, 30_000); }) });
    const summary = await run(f.db, provider);
    expect(summary.blocked).toBe("rate_limited");
    expect(provider.pushInvoice).toHaveBeenCalledTimes(1);
    expect(f.recorded()).toEqual([expect.objectContaining({ p_status: "pending", p_retry_at: new Date(NOW + 30_000).toISOString() })]);
  });

  it("a refused access token is refreshed once (forced) and the run goes on", async () => {
    const f = fakeDb({ claims: [{ blocked: null, send: {} }, { blocked: null, send: { id: "s-2" } }] });
    let n = 0;
    const provider = fakeProvider({ pushInvoice: vi.fn(async () => { n += 1; if (n === 1) throw new ProviderError("Xero refused the access token", "unauthorized", 401); return inXero(); }) });
    const token = vi.fn(async (force?: boolean) => (force ? "fresh" : "stale"));
    await run(f.db, provider, token);
    expect(token).toHaveBeenCalledWith(true);
    expect(f.recorded().map((r) => r.p_status)).toEqual(["pending", "sent"]);
  });
});

describe("contacts, credit notes and voids", () => {
  it("two contacts with the name: a problem is recorded, the send fails, nothing is pushed; a stored match is used without asking Xero", async () => {
    let f = fakeDb({ claims: [{ blocked: null, send: {} }] });
    let provider = fakeProvider({ findContacts: vi.fn(async () => [{ id: "a", name: "Acme Ltd", archived: false }, { id: "b", name: "Acme Ltd", archived: false }]) });
    await run(f.db, provider);
    expect(provider.pushInvoice).not.toHaveBeenCalled();
    expect(f.calls.find((c) => c.fn === "integration_contact_record")!.args).toMatchObject({ p_external_contact_id: null, p_problem: expect.stringMatching(/^2 contacts/) });
    expect(f.recorded()[0]).toMatchObject({ p_status: "failed", p_error: expect.stringMatching(/^Contact: 2 contacts/) });

    f = fakeDb({ claims: [{ blocked: null, send: {} }], contact: { state: "ok", external_contact_id: "chosen-1", problem: null } });
    provider = fakeProvider();
    await run(f.db, provider);
    expect(provider.findContacts).not.toHaveBeenCalled();
    expect(provider.pushInvoice).toHaveBeenCalledWith(expect.anything(), mappings, "chosen-1", "tolra-s-1");
  });

  it("a credit note goes as a credit note (Q7)", async () => {
    const f = fakeDb({ claims: [{ blocked: null, send: { doc_type: "credit_note" } }], document: doc({ doc_type: "credit_note", number: "CRD-2167", reference: "INV-0042" }),
      contact: { state: "ok", external_contact_id: "c-1", problem: null } });
    const provider = fakeProvider();
    await run(f.db, provider);
    expect(provider.pushCreditNote).toHaveBeenCalledTimes(1);
    expect(provider.pushInvoice).not.toHaveBeenCalled();
    expect(f.recorded()[0]).toMatchObject({ p_status: "sent", p_external_id: "x-crd-1" });
  });

  it("a void is sent as a void (Q11); Xero's refusal (a payment there) fails it with the by-hand instruction; unknown is read back", async () => {
    let f = fakeDb({ claims: [{ blocked: null, send: { action: "void", external_id: "x-inv-1" } }], document: doc({ voided: true, status: "void" }) });
    let provider = fakeProvider();
    await run(f.db, provider);
    expect(provider.voidInvoice).toHaveBeenCalledWith("x-inv-1", "tolra-s-1");
    expect(f.recorded()[0]).toMatchObject({ p_status: "sent" });

    f = fakeDb({ claims: [{ blocked: null, send: { action: "void", external_id: "x-inv-1" } }] });
    provider = fakeProvider({ voidInvoice: vi.fn(async () => { throw new ProviderError("Xero refused it: This document cannot be edited as it has a payment allocated to it", "failed", 400); }) });
    await run(f.db, provider);
    expect(f.recorded()[0]).toMatchObject({ p_status: "failed", p_error: expect.stringMatching(/raise a credit note in Xero by hand/) });

    f = fakeDb({ claims: [{ blocked: null, send: { action: "void", external_id: "x-inv-1" } }] });
    provider = fakeProvider({ voidInvoice: vi.fn(async () => { throw new ProviderError("timeout", "unknown", 0); }), readBack: vi.fn(async () => inXero({ status: "VOIDED" })) });
    await run(f.db, provider);
    expect(f.recorded()[0]).toMatchObject({ p_status: "sent" });
  });

  it("a document Tolra can't find fails; nothing is pushed", async () => {
    const f = fakeDb({ claims: [{ blocked: null, send: {} }], document: null });
    const provider = fakeProvider();
    await run(f.db, provider);
    expect(provider.pushInvoice).not.toHaveBeenCalled();
    expect(f.recorded()[0]).toMatchObject({ p_status: "failed" });
  });
});

const res = (json: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json", ...headers } });

describe("the Xero client (HTTP mocked)", () => {
  it("pushes with the tenant, the token and the Idempotency-Key; reads Xero's id, number and totals", async () => {
    const fetchImpl = vi.fn(async () => res({ Invoices: [{ InvoiceID: "x-1", InvoiceNumber: "INV-0042", Status: "AUTHORISED", SubTotal: 100, TotalTax: 20, Total: 120 }] }));
    const client = createXeroClient({ accessToken: "at", tenantId: "t-1", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.pushInvoice(doc(), mappings, "c-1", "tolra-s-1")).toEqual(inXero({ externalId: "x-1" }));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.xero.com/api.xro/2.0/Invoices");
    expect(init.method).toBe("PUT");
    expect(init.headers).toMatchObject({ authorization: "Bearer at", "xero-tenant-id": "t-1", "idempotency-key": "tolra-s-1" });
    expect(JSON.parse(String(init.body)).Invoices[0]).toMatchObject({ InvoiceNumber: "INV-0042", Contact: { ContactID: "c-1" } });
  });

  it("429 is rate_limited with Retry-After; 401 unauthorized; 5xx and no answer unknown; 400 failed with Xero's validation message", async () => {
    const with_ = (r: Response | Error) => createXeroClient({ accessToken: "at", tenantId: "t", fetchImpl: (async () => { if (r instanceof Error) throw r; return r; }) as unknown as typeof fetch });
    await expect(with_(res({}, 429, { "retry-after": "12" })).pushInvoice(doc(), mappings, "c", "k")).rejects.toMatchObject({ outcome: "rate_limited", retryAfterMs: 12_000 });
    await expect(with_(res({}, 401)).pushInvoice(doc(), mappings, "c", "k")).rejects.toMatchObject({ outcome: "unauthorized" });
    await expect(with_(res({ Message: "boom" }, 503)).pushInvoice(doc(), mappings, "c", "k")).rejects.toMatchObject({ outcome: "unknown" });
    await expect(with_(new Error("ECONNRESET")).pushInvoice(doc(), mappings, "c", "k")).rejects.toMatchObject({ outcome: "unknown" });
    await expect(with_(res({ Elements: [{ ValidationErrors: [{ Message: "Account code '999' is not a valid code" }] }] }, 400)).pushInvoice(doc(), mappings, "c", "k"))
      .rejects.toMatchObject({ outcome: "failed", message: "Xero refused it: Account code '999' is not a valid code" });
  });

  it("an unmapped document never reaches Xero", async () => {
    const fetchImpl = vi.fn();
    const client = createXeroClient({ accessToken: "at", tenantId: "t", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.pushInvoice(doc({ lines: [{ description: "x", quantity: 1, unit_price: 1, net: 1, vat: 0.05, vat_key: "5", text_only: false }] }), mappings, "c", "k")).rejects.toThrow(/vat:5/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("contacts are looked up by the whole name (quotes escaped, archived included); read-back matches the number exactly and skips deleted ones", async () => {
    expect(xeroString('O"Brien \\ Sons')).toBe('"O\\"Brien \\\\ Sons"');
    const fetchImpl = vi.fn(async (url: string) => (url.includes("/Contacts")
      ? res({ Contacts: [{ ContactID: "c1", Name: "Acme Ltd", ContactStatus: "ARCHIVED" }] })
      : res({ Invoices: [{ InvoiceID: "old", InvoiceNumber: "INV-0042", Type: "ACCREC", Status: "DELETED" }, { InvoiceID: "x-1", InvoiceNumber: "INV-0042", Type: "ACCREC", Status: "AUTHORISED", SubTotal: 1, TotalTax: 0, Total: 1 }] })));
    const client = createXeroClient({ accessToken: "at", tenantId: "t", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await client.findContacts(" Acme Ltd ")).toEqual([{ id: "c1", name: "Acme Ltd", archived: true }]);
    expect(decodeURIComponent(String(fetchImpl.mock.calls[0][0]))).toContain('where=Name=="Acme Ltd"&includeArchived=true');
    expect((await client.readBack("invoice", "INV-0042"))!.externalId).toBe("x-1");
  });
});

describe("the token lease (refresh tokens rotate: stored before use)", () => {
  const key = randomBytes(32);
  const enc = (v: string, purpose: "refresh" | "access") => encryptSecret(v, { organizationId: ORG, provider: "xero", purpose }, key);
  function leaseDb(lease: Record<string, unknown> | null, stored = true) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const db = { rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return fn === "integration_token_lease" ? lease : fn === "integration_token_store" ? stored : null; }) } as unknown as EngineDb;
    return { db, calls };
  }
  const source = (db: EngineDb, refresh = vi.fn(async () => ({ accessToken: "new-access", refreshToken: "new-refresh", expiresAt: new Date(NOW + 1_800_000), authEventId: null }))) =>
    ({ refresh, get: createTokenSource({ db, key, refresh, isRefused: (e) => e instanceof XeroAuthError, now: () => NOW, sleep: async () => undefined }) });

  it("a fresh access token is used as it is (no refresh); the lease is always released", async () => {
    const { db, calls } = leaseDb({ refresh_token_enc: enc("r", "refresh"), access_token_enc: enc("current-access", "access"), access_expires_at: new Date(NOW + 600_000).toISOString(), key_version: 1 });
    const s = source(db);
    expect(await s.get(ORG, "xero")).toBe("current-access");
    expect(s.refresh).not.toHaveBeenCalled();
    expect(calls.map((c) => c.fn)).toEqual(["integration_token_lease", "integration_token_release"]);
  });

  it("due (or forced): refreshed, and the new pair stored (encrypted, by the holder) BEFORE the new access token is returned", async () => {
    const { db, calls } = leaseDb({ refresh_token_enc: enc("old-refresh", "refresh"), access_token_enc: enc("a", "access"), access_expires_at: new Date(NOW + 60_000).toISOString(), key_version: 1 });
    const s = source(db);
    expect(await s.get(ORG, "xero")).toBe("new-access");
    // The company is passed too (C1: Microsoft 365 asks for the scopes that company consented to); Xero ignores it.
    expect(s.refresh).toHaveBeenCalledWith("old-refresh", ORG);
    expect(calls.map((c) => c.fn)).toEqual(["integration_token_lease", "integration_token_store", "integration_token_release"]);
    const store = calls[1].args;
    expect(store.p_holder).toBe(calls[0].args.p_holder);
    expect(decryptSecret(String(store.p_refresh_enc), { organizationId: ORG, provider: "xero", purpose: "refresh" }, key)).toBe("new-refresh");
    expect(JSON.stringify(store)).not.toContain("new-refresh");
  });

  it("a refused refresh token, or a lease lost while Xero answered, pauses the company (needs_reconnect); a busy lease gives nothing", async () => {
    let f = leaseDb({ refresh_token_enc: enc("r", "refresh"), access_token_enc: null, access_expires_at: null, key_version: 1 });
    expect(await source(f.db, vi.fn(async () => { throw new XeroAuthError("refused", "invalid_grant"); })).get(ORG, "xero")).toBeNull();
    expect(f.calls.map((c) => c.fn)).toContain("integration_mark_needs_reconnect");
    f = leaseDb({ refresh_token_enc: enc("r", "refresh"), access_token_enc: null, access_expires_at: null, key_version: 1 }, false);
    expect(await source(f.db).get(ORG, "xero")).toBeNull();
    expect(f.calls.map((c) => c.fn)).toContain("integration_mark_needs_reconnect");
    f = leaseDb(null);
    expect(await source(f.db).get(ORG, "xero")).toBeNull();
    expect(f.calls.filter((c) => c.fn === "integration_token_lease")).toHaveLength(4);
  });
});

describe("the daily sweep and the Integrations page's words", () => {
  it("renews each connected company and sends its queue; one company's failure never stops the others; counts only", async () => {
    const out = await runIntegrationSweep({
      connected: async () => [{ organizationId: "a", provider: "xero" }, { organizationId: "b", provider: "xero" }, { organizationId: "c", provider: "xero" }],
      renew: async (org) => (org === "b" ? null : "t"),
      send: async (org) => { if (org === "c") throw new Error("boom"); return { sent: 2, failed: 1, needsCheck: 0, retryLater: 0, skipped: 0, blocked: null, unmapped: [] }; },
    });
    expect(out).toEqual({ companies: 3, renewed: 2, needReconnect: 1, sent: 2, failed: 1, needsCheck: 0, errors: 1 });
  });

  it("says what is not mapped and what the log holds, plainly", () => {
    const s = overviewSummary({ provider: "xero", status: "connected", tenant_name: "JNR", connected_at: null, status_reason: null,
      unmapped: ["account:credit", "vat:5", "vat:no_vat"], counts: { sent: 3, pending: 1, failed: 1, needs_check: 1 }, contact_problems: 1 });
    expect(s.statusLabel).toBe("Connected");
    expect(s.unmappedLabel).toBe("Nothing is sent until these are mapped: the credit note account, VAT 5%, VAT No VAT.");
    expect(s.countsLabel).toBe("Send log: 3 sent, 1 waiting, 1 failed, 1 to check in Xero, 1 customer to match by hand.");
    expect(vatKeyLabel("exempt")).toBe("Exempt");
    expect(connectOutcomeMessage("tenant_in_use")).toMatch(/another company/);
    expect(connectOutcomeMessage("anything else")).toMatch(/didn't work/);
  });
});
