/**
 * 084 review fixes (Wed 21 Oct). A refused Connect never removes a Xero connection another Tolra company relies on, or one that existed
 * before this consent (Xero keeps one connection per user per organisation; a repeat consent updates it); only a connection this consent
 * newly made for an unused organisation is cleaned up. A Xero 401 (after one fresh token) or 403 pauses the company (needs_reconnect) and
 * leaves the document waiting, never failed. Every manual send is admin only; the automatic send after an issue sends only that document's
 * first attempt. Xero and the database are faked: nothing reaches the network.
 */
import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const roles: string[][] = [];
vi.mock("@/lib/server/auth", () => ({
  sameOrigin: () => true,
  forbiddenOrigin: () => NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  isErrorResponse: (v: unknown) => v instanceof NextResponse,
  jsonError: (m: string, s: number) => NextResponse.json({ error: m }, { status: s }),
  readJson: async (r: Request) => ({ ok: true, data: await r.json() }),
  requireProfile: vi.fn(async (r: string[]) => {
    roles.push(r);
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }),
}));

import { encryptSecret } from "@/lib/integrations/crypto";
import { type ClaimedSend, type EngineDb, runSends } from "@/lib/integrations/engine";
import { finishConnect } from "@/lib/integrations/server";
import type { AccountingProvider, ProviderDocument } from "@/lib/integrations/types";
import { ProviderError } from "@/lib/integrations/types";
import { type XeroConnection, removableConnections } from "@/lib/integrations/xero/oauth";
import { AUTOMATIC_SEND_ROLES, MANUAL_SEND_ROLES } from "@/lib/integrations/xero/policy";

const ORG = "22222222-2222-2222-2222-222222222222"; // Marpet, in these tests
const NOW = Date.parse("2026-10-21T10:00:00Z");
const key = randomBytes(32);
const ready = { config: { clientId: "id", clientSecret: "secret", redirectUri: "https://app.example.test/api/integrations/xero/callback" }, key };
const conn = (over: Partial<XeroConnection>): XeroConnection => ({ id: "c", tenantId: "t", tenantName: "Org", tenantType: "ORGANISATION", authEventId: "evt-1", createdDateUtc: null, ...over });
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("removableConnections", () => {
  it("only a connection this consent newly made, for an organisation no Tolra company uses", () => {
    const jnr = conn({ id: "jnr", tenantId: "t-jnr", createdDateUtc: ago(90 * 86_400_000) });
    const jnrUpdatedJustNow = conn({ id: "jnr", tenantId: "t-jnr", createdDateUtc: ago(60_000) });
    const fresh = conn({ id: "new", tenantId: "t-new", createdDateUtc: ago(60_000) });
    const old = conn({ id: "old", tenantId: "t-old", createdDateUtc: ago(86_400_000) });
    const undated = conn({ id: "u", tenantId: "t-u", createdDateUtc: null });
    expect(removableConnections([jnr, jnrUpdatedJustNow, fresh, old, undated], new Set(["t-jnr"]), NOW).map((c) => c.id)).toEqual(["new"]);
  });
});

/** A fake service client: rpc results by name, the linked tenants' table, and every rpc call. */
function fakeService(storeError: { message: string; code: string; hint: string } | null, linked: string[] | string[][]) {
  const calls: string[] = [];
  // One list for every read, or one list per read in order (the last repeats): to replay an interleaving.
  const reads = (Array.isArray(linked[0]) ? linked : [linked]) as string[][];
  let read = 0;
  return {
    calls,
    client: {
      rpc: async (fn: string) => {
        calls.push(fn);
        if (fn === "integration_oauth_consume") return { data: { verifier_enc: encryptSecret("verifier", { organizationId: ORG, provider: "xero", purpose: "pkce" }, key) }, error: null };
        if (fn === "integration_store_connection") return { data: null, error: storeError };
        return { data: null, error: null };
      },
      from: () => ({ select: () => ({ eq: () => ({ neq: async () => ({ data: reads[Math.min(read++, reads.length - 1)].map((tenant_id) => ({ tenant_id })), error: null }) }) }) }),
    } as never,
  };
}

/** Xero faked: the token call, the connections list (as given), and a record of every DELETE. */
function fakeXero(connections: Array<Record<string, unknown>>) {
  const deleted: string[] = [];
  const at = `h.${Buffer.from(JSON.stringify({ authentication_event_id: "evt-1" })).toString("base64url")}.s`;
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/connect/token")) return new Response(JSON.stringify({ access_token: at, refresh_token: "r", expires_in: 1800 }), { status: 200 });
    if (init?.method === "DELETE") {
      deleted.push(url.split("/").pop()!);
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify(connections), { status: 200 });
  });
  return { deleted, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("a refused Connect (must-fix: never cut another company off)", () => {
  it("tenant_in_use: Marpet consenting to JNR's organisation (same Xero login) leaves JNR's connection untouched: no delete at all", async () => {
    // Xero updated JNR's existing connection (made months ago) with this consent's event id.
    const xero = fakeXero([{ id: "conn-jnr", tenantId: "t-jnr", tenantName: "JNR Ltd", tenantType: "ORGANISATION", authEventId: "evt-1", createdDateUtc: ago(90 * 86_400_000) }]);
    const svc = fakeService({ message: "in use", code: "23505", hint: "tenant_in_use" }, ["t-jnr"]);
    expect(await finishConnect(svc.client, ORG, "user-1", "state", "code", ready, { fetchImpl: xero.fetchImpl, now: () => NOW })).toEqual({ ok: false, reason: "tenant_in_use" });
    expect(xero.deleted).toEqual([]);
  });

  it("even a connection made just now is kept when its organisation is linked to another company", async () => {
    const xero = fakeXero([{ id: "conn-jnr", tenantId: "t-jnr", tenantName: "JNR Ltd", tenantType: "ORGANISATION", authEventId: "evt-1", createdDateUtc: ago(30_000) }]);
    const svc = fakeService({ message: "in use", code: "23505", hint: "tenant_in_use" }, ["t-jnr"]);
    await finishConnect(svc.client, ORG, "user-1", "state", "code", ready, { fetchImpl: xero.fetchImpl, now: () => NOW });
    expect(xero.deleted).toEqual([]);
  });

  it("a connection this consent newly made for an organisation nobody uses is cleaned up (disconnect_first, several ticked)", async () => {
    let xero = fakeXero([{ id: "conn-new", tenantId: "t-new", tenantName: "Spare Ltd", tenantType: "ORGANISATION", authEventId: "evt-1", createdDateUtc: ago(30_000) }]);
    let svc = fakeService({ message: "other", code: "22023", hint: "disconnect_first" }, ["t-jnr", "t-marpet"]);
    expect(await finishConnect(svc.client, ORG, "user-1", "state", "code", ready, { fetchImpl: xero.fetchImpl, now: () => NOW })).toEqual({ ok: false, reason: "disconnect_first" });
    expect(xero.deleted).toEqual(["conn-new"]);
    // Several ticked: the new unused one goes, JNR's (linked) and an older unused one stay.
    xero = fakeXero([
      { id: "conn-jnr", tenantId: "t-jnr", tenantType: "ORGANISATION", authEventId: "evt-1", createdDateUtc: ago(90 * 86_400_000) },
      { id: "conn-new", tenantId: "t-new", tenantType: "ORGANISATION", authEventId: "evt-1", createdDateUtc: ago(30_000) },
      { id: "conn-old", tenantId: "t-old", tenantType: "ORGANISATION", authEventId: "evt-1", createdDateUtc: ago(86_400_000) },
    ]);
    svc = fakeService(null, ["t-jnr"]);
    expect(await finishConnect(svc.client, ORG, "user-1", "state", "code", ready, { fetchImpl: xero.fetchImpl, now: () => NOW })).toEqual({ ok: false, reason: "choose_one" });
    expect(xero.deleted).toEqual(["conn-new"]);
    expect(svc.calls).not.toContain("integration_store_connection");
  });
});

const inXero = (): ProviderDocument => ({ externalId: "x-1", externalNumber: "INV-1", status: "AUTHORISED", totals: { subTotal: 100, totalTax: 20, total: 120 } });
function engineDb(claims: number) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let left = claims;
  const db: EngineDb = {
    async rpc<T>(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      if (fn === "integration_claim_next") {
        if (left-- <= 0) return { blocked: null, send: null } as T;
        const send: ClaimedSend = { id: `s-${left}`, claim: "k", doc_type: "invoice", doc_id: "d", doc_ref: "INV-1", action: "create", attempts: 1, external_id: null, tenant_id: "t" };
        return { blocked: null, send } as T;
      }
      if (fn === "integration_document") {
        return { doc_type: "invoice", id: "d", number: "INV-1", date: "2026-10-21", due_date: null, reference: null, customer: "Acme", status: "issued", voided: false,
          subtotal: 100, carriage: 0, vat: 20, total: 120, lines: [{ description: "x", quantity: 1, unit_price: 100, net: 100, vat: 20, vat_key: "20", text_only: false }] } as T;
      }
      return { recorded: true } as T;
    },
    mappings: async () => ({ salesAccount: "200", creditAccount: "260", taxRates: { "20": "OUTPUT2" } }),
    contact: async () => ({ state: "ok", external_contact_id: "c-1", problem: null }),
  };
  return { db, calls };
}
const provider = (push: AccountingProvider["pushInvoice"]) => ({ id: "xero", pushInvoice: push, readBack: async () => null } as unknown as AccountingProvider);

describe("the race: two companies, one Xero login, the same new organisation a second apart", () => {
  it("unused on the first read, linked by the other company's Connect by the re-read just before the delete: kept (no delete)", async () => {
    const xero = fakeXero([{ id: "conn-new", tenantId: "t-new", tenantName: "New Ltd", tenantType: "ORGANISATION", authEventId: "evt-1", createdDateUtc: ago(5_000) }]);
    const svc = fakeService({ message: "in use", code: "23505", hint: "tenant_in_use" }, [[], ["t-new"]]);
    expect(await finishConnect(svc.client, ORG, "user-1", "state", "code", ready, { fetchImpl: xero.fetchImpl, now: () => NOW })).toEqual({ ok: false, reason: "tenant_in_use" });
    expect(xero.deleted).toEqual([]);
  });
});

describe("Xero refuses this company's access (must-fix: needs_reconnect, not failed)", () => {
  it("a 403 on the read-back after an unknown answer: needs_reconnect (document pending), not needs_check", async () => {
    const { db, calls } = engineDb(1);
    const p = { id: "xero", pushInvoice: vi.fn(async () => { throw new ProviderError("timeout", "unknown", 0); }),
      readBack: vi.fn(async () => { throw new ProviderError("Xero refused access to this organisation", "forbidden", 403); }) } as unknown as AccountingProvider;
    const summary = await runSends(ORG, "xero", { db, accessToken: async () => "t", provider: () => p, now: () => NOW });
    expect(summary.blocked).toBe("needs_reconnect");
    expect(calls.filter((c) => c.fn === "integration_record_result").map((c) => c.args.p_status)).toEqual(["pending"]);
    expect(calls.find((c) => c.fn === "integration_mark_needs_reconnect")).toBeTruthy();
  });

  it("403: the document waits (pending) and the company is marked needs_reconnect; the run stops", async () => {
    const { db, calls } = engineDb(2);
    const push = vi.fn(async () => { throw new ProviderError("Xero refused access to this organisation", "forbidden", 403); });
    const summary = await runSends(ORG, "xero", { db, accessToken: async () => "t", provider: () => provider(push), now: () => NOW });
    expect(summary.blocked).toBe("needs_reconnect");
    expect(push).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.fn === "integration_record_result").map((c) => c.args.p_status)).toEqual(["pending"]);
    expect(calls.find((c) => c.fn === "integration_mark_needs_reconnect")).toBeTruthy();
  });

  it("401 again after one fresh token: needs_reconnect, the documents pending, never failed", async () => {
    const { db, calls } = engineDb(3);
    const push = vi.fn(async () => { throw new ProviderError("Xero refused the access token", "unauthorized", 401); });
    const token = vi.fn(async () => "t");
    const summary = await runSends(ORG, "xero", { db, accessToken: token, provider: () => provider(push), now: () => NOW });
    expect(summary).toMatchObject({ blocked: "needs_reconnect", failed: 0 });
    expect(token).toHaveBeenCalledTimes(2);
    expect(calls.filter((c) => c.fn === "integration_record_result").map((c) => c.args.p_status)).toEqual(["pending", "pending"]);
    expect(calls.filter((c) => c.fn === "integration_mark_needs_reconnect")).toHaveLength(1);
  });

  it("the automatic send after an issue asks the database for that document only", async () => {
    const { db, calls } = engineDb(1);
    await runSends(ORG, "xero", { db, accessToken: async () => "t", provider: () => provider(vi.fn(async () => inXero())), now: () => NOW },
      { only: { docType: "invoice", docId: "d" } });
    expect(calls[0]).toMatchObject({ fn: "integration_claim_next", args: { p_doc_type: "invoice", p_doc_id: "d" } });
  });
});

describe("who may send (Rhys, Wed 21 Oct): every manual send is an admin's", () => {
  beforeEach(() => { roles.length = 0; });
  const post = (body: unknown = {}) => new Request("https://app.example.test/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  it("Send now (the whole queue, retries included) asks for admin only; the automatic send after an issue for admin or office", async () => {
    expect([...MANUAL_SEND_ROLES]).toEqual(["admin"]);
    expect([...AUTOMATIC_SEND_ROLES]).toEqual(["admin", "office"]);
    const send = await import("@/app/api/integrations/xero/send/route");
    expect((await send.POST(post())).status).toBe(403);
    expect(roles.at(-1)).toEqual(["admin"]);
    const after = await import("@/app/api/integrations/xero/after-issue/route");
    expect((await after.POST(post({ doc_type: "invoice", doc_id: "11111111-1111-1111-1111-111111111111" }))).status).toBe(403);
    expect(roles.at(-1)).toEqual(["admin", "office"]);
    const connect = await import("@/app/api/integrations/xero/connect/route");
    await connect.POST(post());
    expect(roles.at(-1)).toEqual(["admin"]);
  });
});
