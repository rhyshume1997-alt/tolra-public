/**
 * The inbox check's PO step (lib/po-capture-load, migration 125) and its hook in /api/mail/poll, with fakes: suggestions only (p_how
 * 'suggested', never a link), only for NEW messages (a message stored before is not matched again), never failing or blocking the
 * check, nothing done without 125, customer POs matched without 123 too, and the mailbox only read (GET).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }), headers: async () => new Headers() }));

type Result = { data: unknown; error: { code: string; message: string } | null };
let tableData: Record<string, unknown[]>;
let tableErrors: Record<string, (columns: string) => Result["error"]>;
let rpcResults: Record<string, (args: Record<string, unknown>) => Result>;
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
const reads: string[] = [];
let throwOn: string | null = null;

/** A PostgREST-like builder: every filter returns itself; awaiting it (or maybeSingle) gives the table's rows. */
function builder(table: string) {
  let columns = "";
  let single = false;
  const result = (): Result => {
    if (throwOn === table) throw new Error("network down");
    const error = tableErrors[table]?.(columns) ?? null;
    if (error) return { data: null, error };
    const rows = tableData[table] ?? [];
    return { data: single ? (rows[0] ?? null) : rows, error: null };
  };
  const b: Record<string, unknown> = {};
  for (const m of ["eq", "neq", "in", "not", "order", "limit", "like", "is", "ilike"]) b[m] = () => b;
  b.select = (c: string) => { columns = c; reads.push(`${table}:${c}`); return b; };
  // fetchAll pages: one page of rows, then an empty one.
  b.range = (from: number) => ({ then: (ok: (r: Result) => unknown, bad: (e: unknown) => unknown) => { try { const r = result(); return Promise.resolve(from > 0 && !r.error ? { data: [], error: null } : r).then(ok, bad); } catch (e) { return Promise.reject(e).then(ok, bad); } } });
  b.maybeSingle = () => { single = true; return Promise.resolve().then(result); };
  b.single = b.maybeSingle;
  b.then = (ok: (r: Result) => unknown, bad: (e: unknown) => unknown) => Promise.resolve().then(result).then(ok, bad);
  return b;
}

const fakeDb = {
  from: (table: string) => builder(table),
  rpc: async (name: string, args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    return rpcResults[name]?.(args) ?? { data: null, error: null };
  },
};

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (table: string) => (table === "user_profiles"
      ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: "user-1", email: "a@example.test", full_name: "A", role: "admin", secondary_role: null, organization_id: MAPPED, active: true, must_change_password: false }, error: null }), single: async () => ({ data: { id: "user-1", email: "a@example.test", full_name: "A", role: "admin", secondary_role: null, organization_id: MAPPED, active: true, must_change_password: false }, error: null }) }) }) }
      : fakeDb.from(table)),
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === "current_user_organization_id") return { data: MAPPED, error: null };
      if (name === "has_org_role") return { data: (args.allowed_roles as string[]).includes("admin"), error: null };
      return fakeDb.rpc(name, args);
    },
  }),
}));

const MAPPED = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
import type { SupabaseClient } from "@supabase/supabase-js";

import { POST as poll } from "@/app/api/mail/poll/route";
import { resetTokenCache } from "@/lib/m365/graph";
import { suggestPoLinks } from "@/lib/po-capture-load";

const db = fakeDb as unknown as SupabaseClient;
const acme = { id: "q1", quote_ref: "QUO-0012", customer: "Acme Ltd", status: "sent", rfq_id: null, customer_po: null };
const poEmail = (id = "e1", subject = "PO 4471 for QUO-0012", from = "buyer@acme.example") => ({ inboundEmailId: id, email: { fromAddress: from, subject, bodyText: "Please find our PO attached." } });

beforeEach(() => {
  tableData = { inbound_emails: [], quotes: [acme], customers: [{ id: "c1", name: "Acme Ltd", email: "buyer@acme.example" }], rfqs: [], purchase_orders: [], suppliers: [] };
  tableErrors = {};
  rpcResults = {};
  rpcCalls.length = 0;
  reads.length = 0;
  throwOn = null;
});

describe("suggestPoLinks", () => {
  it("a customer PO e-mail from the customer becomes a suggestion (p_how suggested), never a link", async () => {
    const out = await suggestPoLinks(db, [poEmail()]);
    expect(out).toMatchObject({ status: "ok", customerPo: true, checked: 1, suggested: 1, failed: 0 });
    expect(rpcCalls).toEqual([{ name: "link_inbound_email", args: { p_email: "e1", p_kind: "quote", p_target: "q1", p_po: "4471", p_how: "suggested" } }]);
    expect(rpcCalls.some((c) => c.args.p_how === "manual" || c.args.p_how === "auto")).toBe(false);
  });

  it("a quote that already has its customer PO (123): still only a suggestion; the inbox check never writes a PO or links", async () => {
    tableData.quotes = [{ ...acme, customer_po: "4471" }];
    const out = await suggestPoLinks(db, [poEmail("e1", "Our PO 4471")]);
    expect(out).toMatchObject({ status: "ok", customerPo: true, suggested: 1 });
    expect(rpcCalls.map((c) => c.name)).toEqual(["link_inbound_email"]);
    expect(rpcCalls.every((c) => c.args.p_how === "suggested")).toBe(true);
    expect(rpcCalls.some((c) => c.name === "set_quote_customer_po")).toBe(false);
  });

  it("messages without a PO number load nothing and call nothing", async () => {
    const out = await suggestPoLinks(db, [poEmail("e1", "RFQ: 50 brackets, drawing attached")]);
    expect(out.status).toBe("skipped");
    expect(reads).toEqual([]);
    expect(rpcCalls).toEqual([]);
  });

  it("without 125 (no link_status column) it does nothing", async () => {
    tableErrors.inbound_emails = () => ({ code: "42703", message: "column inbound_emails.link_status does not exist" });
    const out = await suggestPoLinks(db, [poEmail()]);
    expect(out.status).toBe("off");
    expect(rpcCalls).toEqual([]);
  });

  it("without 123 (no quotes.customer_po) it still matches by the quote's number and says customerPo false", async () => {
    tableErrors.quotes = (columns) => (columns.includes("customer_po") ? { code: "42703", message: "column quotes.customer_po does not exist" } : null);
    const out = await suggestPoLinks(db, [poEmail()]);
    expect(out).toMatchObject({ status: "ok", customerPo: false, suggested: 1 });
    expect([...new Set(reads.filter((r) => r.startsWith("quotes:")))]).toEqual(["quotes:id, quote_ref, customer, status, rfq_id, customer_po", "quotes:id, quote_ref, customer, status, rfq_id"]);
  });

  it("the PO number alone (a stranger) gives no suggestion", async () => {
    const out = await suggestPoLinks(db, [poEmail("e1", "PO 4471 for QUO-0012", "x@other.example")]);
    expect(out).toMatchObject({ status: "ok", suggested: 0 });
    expect(rpcCalls).toEqual([]);
  });

  it("a failure while loading never throws: status failed", async () => {
    throwOn = "customers";
    await expect(suggestPoLinks(db, [poEmail()])).resolves.toMatchObject({ status: "failed", suggested: 0 });
    tableErrors.customers = () => ({ code: "XX000", message: "boom" });
    throwOn = null;
    await expect(suggestPoLinks(db, [poEmail()])).resolves.toMatchObject({ status: "failed" });
  });

  it("a refused suggestion is counted and the rest carry on", async () => {
    tableData.quotes = [acme, { ...acme, id: "q2", quote_ref: "QUO-0013" }];
    rpcResults.link_inbound_email = (args) => (args.p_target === "q1" ? { data: null, error: { code: "P0002", message: "Quote not found" } } : { data: { changed: true }, error: null });
    const out = await suggestPoLinks(db, [poEmail()]);
    expect(out).toMatchObject({ status: "ok", suggested: 1, failed: 1 });
  });
});

describe("/api/mail/poll with the PO step", () => {
  const ENV = { MS_TENANT_ID: "t", MS_CLIENT_ID: "c", MS_CLIENT_SECRET: "s", MS_MAILBOX: "mail@fixture-tolra.onmicrosoft.com", MS_ORGANIZATION_ID: MAPPED, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" };
  const saved: Record<string, string | undefined> = {};
  let fetchCalls: Array<{ url: string; method: string }>;
  let inbox: unknown[];

  beforeEach(() => {
    for (const [k, v] of Object.entries(ENV)) { saved[k] = process.env[k]; process.env[k] = v; }
    fetchCalls = [];
    inbox = [
      { id: "AAA", internetMessageId: "<a@x>", subject: "PO 4471 for QUO-0012", from: { emailAddress: { address: "buyer@acme.example", name: "Buyer" } }, receivedDateTime: "2026-11-01T09:00:00Z", bodyPreview: "PO", body: { content: "Our PO attached." }, hasAttachments: true },
      { id: "BBB", internetMessageId: "<b@x>", subject: "RFQ 50 brackets", from: { emailAddress: { address: "new@customer.example", name: "New" } }, receivedDateTime: "2026-11-01T09:01:00Z", bodyPreview: "RFQ", body: { content: "Drawing attached." }, hasAttachments: true },
    ];
    resetTokenCache();
    rpcResults.record_inbound_email = (args) => ({ data: { inserted: true, inbound_email_id: `id-${args.p_graph_message_id}`, rfq_id: `rfq-${args.p_graph_message_id}` }, error: null });
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), method: init?.method ?? "GET" });
      if (String(url).includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      return new Response(JSON.stringify({ value: inbox }), { status: 200 });
    });
  });
  afterEach(() => {
    for (const k of Object.keys(ENV)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    vi.unstubAllGlobals();
  });

  const run = async () => {
    const res = await poll(new Request("https://app.test/api/mail/poll", { method: "POST", body: "{}" }));
    return { status: res.status, body: await res.json() };
  };

  it("every message is stored (each still makes its RFQ in record_inbound_email); the PO one gets a suggestion; Graph only read", async () => {
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toMatchObject({ read: 2, inserted: 2, duplicates: 0, poCapture: { status: "ok", suggested: 1 } });
    expect(rpcCalls.filter((c) => c.name === "record_inbound_email").map((c) => c.args.p_graph_message_id)).toEqual(["AAA", "BBB"]);
    expect(rpcCalls.filter((c) => c.name === "link_inbound_email").map((c) => c.args)).toEqual([{ p_email: "id-AAA", p_kind: "quote", p_target: "q1", p_po: "4471", p_how: "suggested" }]);
    // The suggestions come after the paging state is saved.
    const names = rpcCalls.map((c) => c.name);
    expect(names.indexOf("save_mail_poll_state")).toBeLessThan(names.indexOf("link_inbound_email"));
    const graph = fetchCalls.filter((c) => c.url.includes("graph.microsoft.com"));
    expect(graph.length).toBeGreaterThan(0);
    expect(graph.every((c) => c.method === "GET")).toBe(true);
  });

  it("a message stored before (Microsoft message id already kept) is not matched again", async () => {
    rpcResults.record_inbound_email = () => ({ data: { inserted: false, inbound_email_id: null, rfq_id: null }, error: null });
    const { body } = await run();
    expect(body).toMatchObject({ inserted: 0, duplicates: 2, poCapture: { status: "skipped" } });
    expect(rpcCalls.filter((c) => c.name === "link_inbound_email")).toEqual([]);
  });

  it("the matcher's data failing never fails the check", async () => {
    throwOn = "quotes";
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toMatchObject({ read: 2, inserted: 2, poCapture: { status: "failed" } });
  });

  it("without 125 the check works exactly as before", async () => {
    tableErrors.inbound_emails = (columns) => (columns.includes("link_status") ? { code: "42703", message: "column does not exist" } : null);
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toMatchObject({ read: 2, inserted: 2, poCapture: { status: "off" } });
    expect(rpcCalls.filter((c) => c.name === "link_inbound_email")).toEqual([]);
  });
});
