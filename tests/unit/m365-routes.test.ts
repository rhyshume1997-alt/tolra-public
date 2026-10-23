/**
 * /api/mail routes, with the real auth guard (fake Supabase client) and fetch mocked: the mailbox belongs to one company
 * and only its admins reach Microsoft; everyone else, and an unconfigured deployment, get a refusal with zero calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }), headers: async () => new Headers() }));

type Who = { role: string; org: string };
let who: Who;
let rpcResults: Record<string, { data?: unknown; error?: { code: string; message: string } | null }>;
const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
let tables: Record<string, unknown>;

const chain = (result: unknown) => {
  const c: unknown = new Proxy(() => undefined, { get: (_, prop) => (prop === "maybeSingle" || prop === "single" ? () => Promise.resolve({ data: result, error: null }) : () => c) });
  return c;
};

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    from: (table: string) => (table === "user_profiles"
      ? chain({ id: "user-1", email: "a@example.test", full_name: "A", role: who.role, secondary_role: null, organization_id: who.org, active: true, must_change_password: false })
      : chain(tables[table] ?? null)),
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "current_user_organization_id") return { data: who.org, error: null };
      if (name === "has_org_role") return { data: (args.allowed_roles as string[]).includes(who.role), error: null };
      return { error: null, data: null, ...rpcResults[name] };
    },
  }),
}));

import { POST as forward } from "@/app/api/mail/forward/route";
import { POST as poll } from "@/app/api/mail/poll/route";
import { POST as reply } from "@/app/api/mail/reply/route";
import { POST as resolve } from "@/app/api/mail/resolve/route";
import { GET as status } from "@/app/api/mail/status/route";
import { POST as send } from "@/app/api/mail/send/route";
import { resetTokenCache } from "@/lib/m365/graph";

const MAPPED = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const OTHER = "99999999-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const INBOUND = "7b0f4a3c-1d2e-4c5b-8f6a-123456789abc";
const ENV_KEYS = ["MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_MAILBOX", "MS_ORGANIZATION_ID", "MS_MAILBOX_DENY_DOMAINS", "EMAIL_RECIPIENT_DOMAINS", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const saved: Record<string, string | undefined> = {};
let fetchCalls: Array<{ url: string; method: string; body?: string }>;
let messageReplyTo: string[];

const post = (url: string, body: unknown, headers: Record<string, string> = {}) => new Request(`https://app.test${url}`, { method: "POST", body: JSON.stringify(body), headers });
const routes: Array<[string, (r: Request) => Promise<Response>, unknown]> = [
  ["/api/mail/poll", poll, {}],
  ["/api/mail/send", send, { to: "a@example.test", subject: "S", body: "B" }],
  ["/api/mail/reply", reply, { inboundEmailId: INBOUND, comment: "C" }],
  ["/api/mail/forward", forward, { inboundEmailId: INBOUND, to: "a@example.test", comment: "C" }],
];
const configure = (extra: Record<string, string> = {}) => Object.assign(process.env, { MS_TENANT_ID: "t", MS_CLIENT_ID: "c", MS_CLIENT_SECRET: "s", MS_MAILBOX: "mail@fixture-tolra.onmicrosoft.com", MS_ORGANIZATION_ID: MAPPED, EMAIL_RECIPIENT_DOMAINS: "example.test", ...extra });
const microsoftCalls = () => fetchCalls.filter((c) => c.url.includes("login.microsoftonline.com") || c.url.includes("graph.microsoft.com"));

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:1";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  who = { role: "admin", org: MAPPED };
  rpcResults = { reserve_mail_send: { data: { send_id: "s1", history_id: "h1" } } };
  rpcCalls.length = 0;
  tables = { inbound_emails: { received_at: null, graph_message_id: "AAA", subject: "RFQ", rfq_id: null } };
  messageReplyTo = [];
  fetchCalls = [];
  resetTokenCache();
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), method: init?.method ?? "GET", body: init?.body ? String(init.body) : undefined };
    fetchCalls.push(call);
    if (call.url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    if (call.method === "POST") return new Response(null, { status: 202 });
    if (call.url.includes("/inbox/messages")) return new Response(JSON.stringify({ value: [] }), { status: 200 });
    return new Response(JSON.stringify({ from: { emailAddress: { address: "buyer@example.test" } }, replyTo: messageReplyTo.map((address) => ({ emailAddress: { address } })) }), { status: 200 });
  });
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
});

describe("Microsoft 365 mail not configured", () => {
  it.each(routes)("%s answers 503 and calls neither Microsoft nor the mail database functions", async (url, handler, body) => {
    const res = await handler(post(url, body));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "Microsoft 365 mail is not configured" });
    expect(fetchCalls).toHaveLength(0);
    expect(rpcCalls.filter((c) => /mail|inbound/.test(c.name))).toHaveLength(0);
  });

  it.each(routes)("%s: no mapped company (MS_ORGANIZATION_ID missing or not a uuid) is off too", async (url, handler, body) => {
    for (const value of [undefined, "", "jnr"]) {
      configure();
      if (value === undefined) delete process.env.MS_ORGANIZATION_ID;
      else process.env.MS_ORGANIZATION_ID = value;
      expect((await handler(post(url, body))).status).toBe(503);
    }
    expect(fetchCalls).toHaveLength(0);
  });

  it.each(routes)("%s refuses (503) a denied mailbox domain and calls nothing", async (url, handler, body) => {
    configure({ MS_MAILBOX: "boss@jnr.example", MS_MAILBOX_DENY_DOMAINS: "jnr.example" });
    const res = await handler(post(url, body));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not allowed/);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("/api/mail/status (drives the RFQ Check inbox button)", () => {
  it("says not configured when Microsoft 365 is off, and calls nothing", async () => {
    const res = await status();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ configured: false });
    expect(fetchCalls).toHaveLength(0);
  });

  it("says configured for the mapped company's admin, without returning any setting", async () => {
    configure();
    const res = await status();
    expect(await res.json()).toEqual({ configured: true });
    expect(fetchCalls).toHaveLength(0);
  });

  it("says not configured for another company's admin, a denied mailbox, and refuses non-admins", async () => {
    configure();
    who = { role: "admin", org: OTHER };
    expect(await (await status()).json()).toEqual({ configured: false });
    who = { role: "admin", org: MAPPED };
    configure({ MS_MAILBOX: "boss@jnr.example", MS_MAILBOX_DENY_DOMAINS: "jnr.example" });
    expect(await (await status()).json()).toEqual({ configured: false });
    who = { role: "office", org: MAPPED };
    expect((await status()).status).toBe(403);
  });
});

describe("who may use the mailbox", () => {
  it.each(routes)("%s: the mapped company's admin gets through to Microsoft", async (url, handler, body) => {
    configure();
    const res = await handler(post(url, body));
    expect(res.status).toBe(200);
    expect(microsoftCalls().length).toBeGreaterThan(0);
  });

  it.each(routes)("%s: another company's admin gets 403 and nothing is sent to Microsoft", async (url, handler, body) => {
    configure();
    who = { role: "admin", org: OTHER };
    const res = await handler(post(url, body));
    expect(res.status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
    expect(rpcCalls.filter((c) => /mail|inbound/.test(c.name))).toHaveLength(0);
  });

  it.each(["office", "workshop", "viewer"])("%s of the mapped company gets 403 on every endpoint with zero calls", async (role) => {
    configure();
    who = { role, org: MAPPED };
    for (const [url, handler, body] of routes) {
      expect((await handler(post(url, body))).status, url).toBe(403);
    }
    expect(fetchCalls).toHaveLength(0);
    expect(rpcCalls.filter((c) => /mail|inbound/.test(c.name))).toHaveLength(0);
  });

  it.each(routes)("%s refuses a cross-site request before anything else", async (url, handler, body) => {
    configure();
    expect((await handler(post(url, body, { origin: "https://evil.test" }))).status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("input and recipients", () => {
  it("validates input before any mail is sent", async () => {
    configure();
    expect((await send(post("/api/mail/send", { to: "not-an-address", subject: "S", body: "B" }))).status).toBe(400);
    expect((await reply(post("/api/mail/reply", { inboundEmailId: "nope", comment: "C" }))).status).toBe(400);
    expect((await forward(post("/api/mail/forward", { inboundEmailId: INBOUND, to: "x", comment: "" }))).status).toBe(400);
    expect(fetchCalls).toHaveLength(0);
  });

  it("send respects EMAIL_RECIPIENT_DOMAINS as a strict list", async () => {
    configure();
    expect((await send(post("/api/mail/send", { to: "someone@real-customer.com", subject: "S", body: "B" }))).status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
  });

  it("forward checks the address it forwards to", async () => {
    configure();
    expect((await forward(post("/api/mail/forward", { inboundEmailId: INBOUND, to: "someone@real-customer.com", comment: "" }))).status).toBe(403);
    expect(fetchCalls).toHaveLength(0);
  });

  it("reply goes to the sender when there is no Reply-To, and logs who", async () => {
    configure();
    const res = await reply(post("/api/mail/reply", { inboundEmailId: INBOUND, comment: "C" }));
    expect(res.status).toBe(200);
    expect(fetchCalls.filter((c) => c.method === "POST" && c.url.endsWith("/reply"))).toHaveLength(1);
    expect(rpcCalls.find((c) => c.name === "reserve_mail_send")?.args).toMatchObject({ p_kind: "reply", p_recipients: ["buyer@example.test"] });
  });

  it("reply posts exactly the validated recipients, so Microsoft can't pick others", async () => {
    configure();
    messageReplyTo = ["ok@example.test", "also@example.test"];
    await reply(post("/api/mail/reply", { inboundEmailId: INBOUND, comment: "C" }));
    const posted = fetchCalls.find((c) => c.method === "POST" && c.url.endsWith("/reply"))!;
    expect(JSON.parse(posted.body!)).toEqual({ message: { toRecipients: [{ emailAddress: { address: "ok@example.test" } }, { emailAddress: { address: "also@example.test" } }] }, comment: "C" });
  });

  it("reply with a Reply-To outside the allowed set is refused and nothing is posted", async () => {
    configure();
    messageReplyTo = ["attacker@elsewhere.example"];
    const res = await reply(post("/api/mail/reply", { inboundEmailId: INBOUND, comment: "C" }));
    expect(res.status).toBe(403);
    expect(fetchCalls.filter((c) => c.method === "POST" && c.url.includes("graph.microsoft.com"))).toHaveLength(0);
    expect(rpcCalls.find((c) => c.name === "reserve_mail_send")).toBeUndefined();
  });

  it("reply is refused when ANY effective recipient is outside the set, and logs all of them when all pass", async () => {
    configure();
    messageReplyTo = ["ok@example.test", "attacker@elsewhere.example"];
    expect((await reply(post("/api/mail/reply", { inboundEmailId: INBOUND, comment: "C" }))).status).toBe(403);
    messageReplyTo = ["ok@example.test", "also@example.test"];
    expect((await reply(post("/api/mail/reply", { inboundEmailId: INBOUND, comment: "C" }))).status).toBe(200);
    expect(rpcCalls.find((c) => c.name === "reserve_mail_send")?.args.p_recipients).toEqual(["ok@example.test", "also@example.test"]);
  });
});

describe("poll state", () => {
  it("a stored paging link that isn't Microsoft Graph's is discarded and never followed", async () => {
    configure();
    tables.mail_poll_state = { next_link: "https://evil.example/v1.0/users/x/messages?skiptoken=1", checkpoint: null };
    const res = await poll(post("/api/mail/poll", {}));
    expect(res.status).toBe(200);
    expect(fetchCalls.some((c) => c.url.includes("evil.example"))).toBe(false);
    expect(fetchCalls.some((c) => c.url.includes("/inbox/messages?"))).toBe(true);
    expect(rpcCalls.filter((c) => c.name === "save_mail_poll_state")[0].args).toEqual({ p_next_link: null, p_checkpoint: null });
  });

  it("a valid stored link is resumed from", async () => {
    configure();
    const link = "https://graph.microsoft.com/v1.0/users/mail%40fixture-tolra.onmicrosoft.com/mailFolders/inbox/messages?skiptoken=1";
    tables.mail_poll_state = { next_link: link, checkpoint: null };
    expect((await poll(post("/api/mail/poll", {}))).status).toBe(200);
    expect(fetchCalls.filter((c) => c.url.includes("/inbox/messages")).map((c) => c.url)).toEqual([link]);
  });
});

describe("send accounting", () => {
  it("reserves before sending, and records the key the server computed (same e-mail, same key)", async () => {
    configure();
    await send(post("/api/mail/send", { to: "a@example.test", subject: "S", body: "B" }));
    await send(post("/api/mail/send", { to: "a@example.test", subject: "S", body: "B" }));
    await send(post("/api/mail/send", { to: "a@example.test", subject: "S", body: "B2" }));
    const keys = rpcCalls.filter((c) => c.name === "reserve_mail_send").map((c) => c.args.p_key as string);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    const order = rpcCalls.map((c) => c.name).filter((n) => /mail_send/.test(n));
    expect(order.slice(0, 2)).toEqual(["reserve_mail_send", "complete_mail_send"]);
    expect(rpcCalls.find((c) => c.name === "complete_mail_send")?.args).toEqual({ p_id: "s1", p_outcome: "accepted" });
  });

  it("202 is recorded as accepted, not delivered", async () => {
    configure();
    const res = await send(post("/api/mail/send", { to: "a@example.test", subject: "S", body: "B" }));
    expect(await res.json()).toMatchObject({ status: "accepted" });
  });

  it("a key already sending / accepted / unknown answers 409 and sends nothing", async () => {
    configure();
    rpcResults.reserve_mail_send = { data: null, error: { code: "PT409", message: "Already sent or outcome unknown - check Sent Items before retrying" } };
    const res = await send(post("/api/mail/send", { to: "a@example.test", subject: "S", body: "B" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Already sent or outcome unknown — check Sent Items before retrying");
    expect(fetchCalls.filter((c) => c.url.includes("/sendMail"))).toHaveLength(0);
  });

  it("over the hourly limit answers 429 and sends nothing", async () => {
    configure();
    rpcResults.reserve_mail_send = { data: null, error: { code: "PT429", message: "Rate limit exceeded. Max 20 emails per hour." } };
    expect((await send(post("/api/mail/send", { to: "a@example.test", subject: "S", body: "B" }))).status).toBe(429);
    expect(fetchCalls.filter((c) => c.url.includes("/sendMail"))).toHaveLength(0);
  });

  it("if the outcome can't be written the caller is told it is unknown", async () => {
    configure();
    rpcResults.complete_mail_send = { data: null, error: { code: "XX000", message: "db down" } };
    const res = await send(post("/api/mail/send", { to: "a@example.test", subject: "S", body: "B" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ status: "unknown", send_id: "s1" });
    expect(rpcCalls.find((c) => c.name === "write_audit")).toBeUndefined();
  });

  it("a definite refusal (400) is recorded failed", async () => {
    configure();
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => (String(url).includes("/sendMail") ? new Response(JSON.stringify({ error: { code: "ErrorInvalidRecipients" } }), { status: 400 }) : original(url, init)));
    const res = await send(post("/api/mail/send", { to: "a@example.test", subject: "S", body: "B" }));
    expect(res.status).toBe(502);
    expect(rpcCalls.find((c) => c.name === "complete_mail_send")?.args).toEqual({ p_id: "s1", p_outcome: "failed" });
  });

  it.each([["timeout", () => Promise.reject(new DOMException("timed out", "TimeoutError"))], ["server error", async () => new Response("bad gateway", { status: 502 })]])("a %s after the request went out is recorded unknown, and says so", async (_name, outcome) => {
    configure();
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => (String(url).includes("/sendMail") ? outcome() : original(url, init)));
    const res = await send(post("/api/mail/send", { to: "a@example.test", subject: "S", body: "B" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ status: "unknown", send_id: "s1" });
    expect(rpcCalls.find((c) => c.name === "complete_mail_send")?.args).toEqual({ p_id: "s1", p_outcome: "unknown" });
  });
});

describe("resolve", () => {
  it("is admin of the mapped company only, and audited", async () => {
    configure();
    const body = { sendId: INBOUND, as: "sent" };
    who = { role: "office", org: MAPPED };
    expect((await resolve(post("/api/mail/resolve", body))).status).toBe(403);
    who = { role: "admin", org: OTHER };
    expect((await resolve(post("/api/mail/resolve", body))).status).toBe(403);
    expect(rpcCalls.find((c) => c.name === "resolve_mail_send")).toBeUndefined();
    who = { role: "admin", org: MAPPED };
    rpcResults.resolve_mail_send = { data: "history-9" };
    const res = await resolve(post("/api/mail/resolve", body));
    expect(res.status).toBe(200);
    expect(rpcCalls.find((c) => c.name === "resolve_mail_send")?.args).toEqual({ p_id: INBOUND, p_as: "sent" });
    // The audit entry names the e-mail history row, with the ledger id kept in the metadata.
    expect(rpcCalls.find((c) => c.name === "write_audit")?.args).toMatchObject({ p_action: "UPDATE", p_entity_table: "email_history", p_entity_id: "history-9", p_metadata: { ledger_id: INBOUND } });
    expect(fetchCalls).toHaveLength(0);
  });
});
