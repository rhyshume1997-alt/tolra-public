/**
 * LIVE Microsoft 365 suite. Runs the app's real /api/mail route handlers, as signed-in synthetic users on the local
 * disposable Supabase, against the real TEST tenant mailbox. Only for the test tenant (tests/live/guards.ts refuses
 * anything else); run by .github/workflows/m365-live-test.yml or `npm run test:live` with the MS_TEST_* settings.
 *
 * What it proves:
 *   a) the app registration reads and sends for MS_TEST_MAILBOX and is DENIED (403) for MS_TEST_DENIED_MAILBOX, tried
 *      with real GET and POST calls rather than inferred from the Exchange configuration;
 *   b) the mapped company's admin gets through, and another company's admin, office, workshop and viewer make no call
 *      to Microsoft;
 *   c) with a small page size and more messages than one page, polling twice in a row and twice at once leaves exactly
 *      one RFQ per message;
 *   d) send, reply and forward reach the intended recipients and show in Sent Items, and a reply whose original has a
 *      disallowed Reply-To is refused;
 *   e) polled messages stay unread and in the Inbox;
 *   f) the hourly limit holds under concurrency, an uncertain send blocks a repeat, and a switched-off configuration
 *      sends nothing (these use a faked Microsoft: no mail is sent for them).
 * It never prints secrets or message bodies, and deletes nothing in the mailbox: its messages carry TOLRA-LIVE-TEST.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }), headers: async () => new Headers() }));
vi.mock("@supabase/ssr", async () => {
  const { session } = await import("../support/mail-session");
  return { createServerClient: () => session.client };
});

import { POST as forward } from "@/app/api/mail/forward/route";
import { POST as poll } from "@/app/api/mail/poll/route";
import { POST as reply } from "@/app/api/mail/reply/route";
import { POST as resolve } from "@/app/api/mail/resolve/route";
import { POST as send } from "@/app/api/mail/send/route";
import { mailConfig, resetTokenCache, sendMail } from "@/lib/m365/graph";

import { type SyntheticUser, type SyntheticWorld, adminClient, createSyntheticWorld, destroySyntheticWorld, signedInClient, verifyBackendIdentity, withDb } from "../support/fixtures";
import { isolatedBackend } from "../support/isolation";
import { isMicrosoft, post, session } from "../support/mail-session";
import { liveConfig } from "./guards";

const guard = liveConfig(process.env);
if (!guard.ok) throw new Error(guard.problem);
const cfg = guard.config;

const realFetch = globalThis.fetch;
const GRAPH = "https://graph.microsoft.com/v1.0";
const stamp = new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15) + "Z";
const PAGE_SIZE = 2;
const N = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- fetch seen by the app code: counted, and faked in the tests that must not send real mail ----
type Call = { method: string; url: string };
const msCalls: Call[] = [];
let fake: null | "ok" | "timeout" = null;

async function appFetch(input: string | URL | Request, init?: RequestInit) {
  const url = String(input instanceof Request ? input.url : input);
  if (!isMicrosoft(url)) return realFetch(input, init);
  const method = init?.method ?? "GET";
  msCalls.push({ method, url });
  if (!fake) return realFetch(input, init);
  if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
  if (method === "POST" && url.endsWith("/sendMail")) {
    if (fake === "timeout") throw new DOMException("timed out", "TimeoutError");
    return new Response(null, { status: 202 });
  }
  throw new Error("unexpected call to Microsoft while it is faked");
}

function setFake(mode: typeof fake) {
  fake = mode;
  resetTokenCache(); // a faked token must never be reused for real calls, nor the other way round
}

// ---- direct Graph calls for checking things, with the app registration but outside the app ----
let directToken: string | null = null;
async function direct(method: "GET" | "POST", path: string, body?: unknown) {
  if (!directToken) {
    const res = await realFetch(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.clientId, client_secret: cfg.clientSecret, scope: "https://graph.microsoft.com/.default" }),
    });
    const json = (await res.json().catch(() => null)) as { access_token?: string; error?: string } | null;
    if (!res.ok || !json?.access_token) throw new Error(`token request failed (${res.status} ${json?.error ?? "no error code"})`);
    directToken = json.access_token;
  }
  const res = await realFetch(`${GRAPH}${path}`, {
    method,
    headers: { authorization: `Bearer ${directToken}`, Prefer: 'IdType="ImmutableId"', ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  return { status: res.status, code: (json?.error?.code as string | undefined) ?? null, json };
}

const user = (mb: string) => `/users/${encodeURIComponent(mb)}`;
const inboxWithStamp = async () => (await direct("GET", `${user(cfg.mailbox)}/mailFolders/inbox/messages?$filter=${encodeURIComponent(`contains(subject,'${stamp}')`)}&$select=id,subject,isRead,parentFolderId&$top=50`)).json?.value as Array<{ id: string; subject: string; isRead: boolean; parentFolderId: string }>;
const sentWithStamp = async () => (await direct("GET", `${user(cfg.mailbox)}/mailFolders/sentitems/messages?$filter=${encodeURIComponent(`contains(subject,'${stamp}')`)}&$select=id,subject,toRecipients&$top=50`)).json?.value as Array<{ id: string; subject: string; toRecipients: Array<{ emailAddress: { address: string } }> }>;

async function waitFor<T>(what: string, check: () => Promise<T | null | false>, ms = 120_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`${what}: not there after ${ms / 1000} seconds`);
    await sleep(5_000);
  }
}

// ---- the app, called as a user ----
let worldA: SyntheticWorld; // its "alpha" company owns the mailbox
let worldB: SyntheticWorld; // another company's admin, also used for the faked tests
let mappedOrg: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_MAILBOX", "MS_ORGANIZATION_ID", "MS_PAGE_SIZE", "EMAIL_RECIPIENT_DOMAINS", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];

type Handler = (r: Request) => Promise<Response>;
async function call(who: SyntheticUser, org: string, handler: Handler, url: string, body: unknown = {}) {
  session.client = await signedInClient(who);
  process.env.MS_ORGANIZATION_ID = org;
  const res = await handler(post(url, body));
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const asAdmin = (handler: Handler, url: string, body?: unknown) => call(worldA.tenants.alpha.users.admin, mappedOrg, handler, url, body);
const pollAll = async () => {
  const bodies: Array<Record<string, any>> = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let i = 0; i < 30; i += 1) {
    const r = await asAdmin(poll, "/api/mail/poll");
    expect(r.status).toBe(200);
    bodies.push(r.body);
    if (!r.body.more) return bodies;
  }
  throw new Error("polling never caught up");
};

const ledgerCount = (userId: string) => withDb(async (db) => (await db.query("select count(*)::int as n from security_audit.mail_send_ledger where user_id = $1", [userId])).rows[0].n as number);

beforeAll(async () => {
  for (const key of ENV) saved[key] = process.env[key];
  const backend = isolatedBackend();
  await verifyBackendIdentity();
  worldA = await createSyntheticWorld();
  worldB = await createSyntheticWorld();
  mappedOrg = worldA.tenants.alpha.id;
  Object.assign(process.env, {
    NEXT_PUBLIC_SUPABASE_URL: backend.apiUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: backend.anonKey,
    MS_TENANT_ID: cfg.tenantId,
    MS_CLIENT_ID: cfg.clientId,
    MS_CLIENT_SECRET: cfg.clientSecret,
    MS_MAILBOX: cfg.mailbox,
    MS_ORGANIZATION_ID: mappedOrg,
    MS_PAGE_SIZE: String(PAGE_SIZE),
    // Exact addresses: the app may write to the test mailbox and the external test address, nobody else.
    EMAIL_RECIPIENT_DOMAINS: `${cfg.mailbox},${cfg.externalTo}`,
  });
  vi.stubGlobal("fetch", appFetch);
  resetTokenCache();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  if (worldA) await destroySyntheticWorld(worldA.runId);
  if (worldB) await destroySyntheticWorld(worldB.runId);
});

describe("a. the app registration is scoped to the test mailbox", () => {
  it("reads the test mailbox", async () => {
    const r = await direct("GET", `${user(cfg.mailbox)}/mailFolders/inbox/messages?$top=1&$select=id`);
    expect(r.status, `read ${cfg.mailbox}: ${r.code}`).toBe(200);
  });

  it("is DENIED reading the denied mailbox (tenant admin)", async () => {
    const r = await direct("GET", `${user(cfg.deniedMailbox)}/mailFolders/inbox/messages?$top=1&$select=id`);
    expect(r.status, `read ${cfg.deniedMailbox}: ${r.code}`).toBe(403);
    expect(r.code).toBe("ErrorAccessDenied");
  });

  it("is DENIED sending as the denied mailbox", async () => {
    const r = await direct("POST", `${user(cfg.deniedMailbox)}/sendMail`, {
      message: { subject: `TOLRA-LIVE-TEST ${stamp} denied-probe`, body: { contentType: "Text", content: "Tolra live test. This must not be sent." }, toRecipients: [{ emailAddress: { address: cfg.mailbox } }] },
      saveToSentItems: false,
    });
    expect(r.status, `send as ${cfg.deniedMailbox}: ${r.code}`).toBe(403);
    expect(r.code).toBe("ErrorAccessDenied");
  });
});

describe("b. who may use the mailbox through the app", () => {
  it("another company's admin, and the mapped company's office, workshop and viewer, make no call to Microsoft", async () => {
    const before = msCalls.length;
    const callers: Array<[string, SyntheticUser, string]> = [
      ["other company admin", worldB.tenants.alpha.users.admin, worldB.tenants.alpha.id],
      ["office", worldA.tenants.alpha.users.office, mappedOrg],
      ["workshop", worldA.tenants.alpha.users.workshop, mappedOrg],
      ["viewer", worldA.tenants.alpha.users.viewer, mappedOrg],
    ];
    const some = "7b0f4a3c-1d2e-4c5b-8f6a-123456789abc";
    for (const [name, who] of callers) {
      for (const [handler, url, body] of [
        [poll, "/api/mail/poll", {}],
        [send, "/api/mail/send", { to: cfg.externalTo, subject: "S", body: "B" }],
        [reply, "/api/mail/reply", { inboundEmailId: some, comment: "C" }],
        [forward, "/api/mail/forward", { inboundEmailId: some, to: cfg.externalTo, comment: "C" }],
      ] as Array<[Handler, string, unknown]>) {
        const r = await call(who, mappedOrg, handler, url, body);
        expect(r.status, `${name} ${url}`).toBe(403);
      }
    }
    expect(msCalls.length - before, "calls to Microsoft").toBe(0);
  });

  it("the mapped company's admin is let through", async () => {
    const before = msCalls.length;
    expect((await asAdmin(poll, "/api/mail/poll")).status).toBe(200);
    expect(msCalls.length).toBeGreaterThan(before);
  });
});

describe("c + e. polling many messages, and leaving the mailbox alone", () => {
  let beforeState: Map<string, { isRead: boolean; parentFolderId: string }>;

  it(`sends ${N} dummy messages to the mailbox itself through the app`, async () => {
    for (let i = 1; i <= N; i += 1) {
      const r = await asAdmin(send, "/api/mail/send", { to: cfg.mailbox, subject: `TOLRA-LIVE-TEST ${stamp} #${i}`, body: `Tolra live test message ${i}. Safe to delete.` });
      expect(r.status, `send #${i}`).toBe(200);
      expect(r.body.status).toBe("accepted");
    }
  });

  it("they arrive in the Inbox unread", async () => {
    const found = await waitFor("messages in Inbox", async () => {
      const list = await inboxWithStamp();
      return list.filter((m) => /#\d$/.test(m.subject)).length >= N ? list.filter((m) => /#\d$/.test(m.subject)) : null;
    });
    beforeState = new Map(found.map((m) => [m.id, { isRead: m.isRead, parentFolderId: m.parentFolderId }]));
    expect(found).toHaveLength(N);
    for (const m of found) expect(m.isRead, "arrives unread").toBe(false);
  });

  it(`a poll with page size ${PAGE_SIZE} pages through all of them`, async () => {
    // Graph's @odata.nextLink names the folder its own way (mailFolders('inbox'), or by id), not mailFolders/inbox, so
    // count every message-list read the app makes (during a poll it makes no other GET to Graph).
    const inboxReads = () => msCalls.filter((c) => c.method === "GET" && /^https:\/\/graph\.microsoft\.com\/.*\/messages(\?|$)/.test(c.url)).length;
    const before = inboxReads();
    const bodies = await pollAll();
    const pages = inboxReads() - before;
    expect(pages, "inbox pages fetched").toBeGreaterThanOrEqual(Math.ceil(N / PAGE_SIZE));
    expect(bodies.at(-1)!.more).toBe(false);
    const stored = await adminClient().from("inbound_emails").select("graph_message_id, rfq_id").eq("organization_id", mappedOrg).in("graph_message_id", [...beforeState.keys()]);
    expect(stored.data).toHaveLength(N);
    expect(new Set(stored.data!.map((r) => r.rfq_id)).size).toBe(N);
  });

  it("polling twice in a row and twice at once makes no second RFQ for any message", async () => {
    const ids = [...beforeState.keys()];
    const rfqIds = async () => (await adminClient().from("inbound_emails").select("rfq_id").eq("organization_id", mappedOrg).in("graph_message_id", ids)).data!.map((r) => r.rfq_id as string);
    const first = await rfqIds();
    await pollAll();
    await pollAll();
    session.client = await signedInClient(worldA.tenants.alpha.users.admin);
    process.env.MS_ORGANIZATION_ID = mappedOrg;
    const both = await Promise.all([poll(post("/api/mail/poll", {})), poll(post("/api/mail/poll", {}))]);
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    await pollAll();
    expect((await rfqIds()).sort()).toEqual(first.sort());
    const rfqs = await adminClient().from("rfqs").select("id").eq("organization_id", mappedOrg).in("id", first);
    expect(rfqs.data).toHaveLength(N);
    const rows = await adminClient().from("inbound_emails").select("id").eq("organization_id", mappedOrg).in("graph_message_id", ids);
    expect(rows.data).toHaveLength(N);
  });

  it("the messages are still in the Inbox, still unread, in the same folder", async () => {
    const after = new Map((await inboxWithStamp()).filter((m) => /#\d$/.test(m.subject)).map((m) => [m.id, m]));
    expect(after.size).toBe(N);
    for (const [id, was] of beforeState) {
      const now = after.get(id);
      expect(now, `message ${id} still in the Inbox`).toBeDefined();
      expect(now!.isRead).toBe(was.isRead);
      expect(now!.parentFolderId).toBe(was.parentFolderId);
    }
    expect(msCalls.filter((c) => c.method !== "GET" && c.method !== "POST")).toEqual([]);
    expect(msCalls.filter((c) => c.method === "POST" && !/login\.microsoftonline\.com|\/sendMail$|\/reply$|\/forward$/.test(c.url))).toEqual([]);
  });
});

describe("d. send, reply and forward", () => {
  it("reply, forward and a new message reach the intended recipients and appear in Sent Items", async () => {
    const mailRow = await adminClient().from("inbound_emails").select("id, subject").eq("organization_id", mappedOrg).like("subject", `%${stamp} #1`).single();
    expect(mailRow.error).toBeNull();
    const inboundEmailId = mailRow.data!.id as string;
    const r1 = await asAdmin(reply, "/api/mail/reply", { inboundEmailId, comment: "Tolra live test reply." });
    expect(r1.status, "reply").toBe(200);
    const r2 = await asAdmin(forward, "/api/mail/forward", { inboundEmailId, to: cfg.externalTo, comment: "Tolra live test forward." });
    expect(r2.status, "forward").toBe(200);
    const r3 = await asAdmin(send, "/api/mail/send", { to: cfg.externalTo, subject: `TOLRA-LIVE-TEST ${stamp} send`, body: "Tolra live test send." });
    expect(r3.status, "send").toBe(200);

    const sent = await waitFor("reply, forward and send in Sent Items", async () => {
      const list = await sentWithStamp();
      const to = (m: (typeof list)[number]) => m.toRecipients.map((x) => x.emailAddress.address.toLowerCase());
      const found = {
        reply: list.find((m) => /^re:/i.test(m.subject) && m.subject.endsWith("#1") && to(m).includes(cfg.mailbox)),
        forward: list.find((m) => /^(fw|fwd):/i.test(m.subject) && m.subject.endsWith("#1") && to(m).includes(cfg.externalTo)),
        send: list.find((m) => m.subject === `TOLRA-LIVE-TEST ${stamp} send` && to(m).includes(cfg.externalTo)),
      };
      return found.reply && found.forward && found.send ? found : null;
    }, 90_000);
    expect([sent.reply!.id, sent.forward!.id, sent.send!.id].every(Boolean)).toBe(true);
    // The reply went to exactly the address the app checked (the original's sender), nobody else.
    expect(sent.reply!.toRecipients.map((x) => x.emailAddress.address.toLowerCase())).toEqual([cfg.mailbox]);
    expect(sent.forward!.toRecipients.map((x) => x.emailAddress.address.toLowerCase())).toEqual([cfg.externalTo]);

    // The history says who it went to.
    const history = await adminClient().from("email_history").select("to_email, status").in("id", [r1.body.history_id, r2.body.history_id, r3.body.history_id]);
    expect(history.data!.map((h) => h.status)).toEqual(["sent_via_system", "sent_via_system", "sent_via_system"]);
    expect(history.data!.map((h) => h.to_email).sort()).toEqual([cfg.externalTo, cfg.externalTo, cfg.mailbox].sort());
  });

  it("a reply whose original has a Reply-To outside the allowed set is refused and nothing is sent", async () => {
    const subject = `TOLRA-LIVE-TEST ${stamp} replyto`;
    // A message with a Reply-To pointing elsewhere, sent to the mailbox itself (outside the app's send route, which has no such option).
    await sendMail({ to: cfg.mailbox, subject, body: "Tolra live test: Reply-To points outside.", replyTo: "attacker@not-allowed.example" }, mailConfig());
    await waitFor("Reply-To message in Inbox", async () => {
      const list = await inboxWithStamp();
      return list.some((m) => m.subject === subject);
    });
    await pollAll();
    const row = await adminClient().from("inbound_emails").select("id").eq("organization_id", mappedOrg).eq("subject", subject).single();
    expect(row.error).toBeNull();

    const before = msCalls.filter((c) => c.method === "POST").length;
    const r = await asAdmin(reply, "/api/mail/reply", { inboundEmailId: row.data!.id, comment: "Tolra live test: must not be sent." });
    expect(r.status).toBe(403);
    expect(msCalls.filter((c) => c.method === "POST").length - before, "POST calls to Microsoft").toBe(0);
    await sleep(10_000);
    expect((await sentWithStamp()).filter((m) => /^re:/i.test(m.subject) && m.subject.endsWith("replyto"))).toEqual([]);
  });
});

describe("d2. a reply goes to the validated Reply-To, and only to it", () => {
  it("an allowed Reply-To is the only recipient of the reply in Sent Items", async () => {
    const subject = `TOLRA-LIVE-TEST ${stamp} replyto-allowed`;
    // Reply-To is the external test address, which the app is allowed to write to.
    await sendMail({ to: cfg.mailbox, subject, body: "Tolra live test: Reply-To points at the external test address.", replyTo: cfg.externalTo }, mailConfig());
    await waitFor("Reply-To message in Inbox", async () => (await inboxWithStamp()).some((m) => m.subject === subject));
    await pollAll();
    const row = await adminClient().from("inbound_emails").select("id").eq("organization_id", mappedOrg).eq("subject", subject).single();
    expect(row.error).toBeNull();

    const r = await asAdmin(reply, "/api/mail/reply", { inboundEmailId: row.data!.id, comment: "Tolra live test reply to Reply-To." });
    expect(r.status).toBe(200);
    const sent = await waitFor("reply in Sent Items", async () => (await sentWithStamp()).find((m) => /^re:/i.test(m.subject) && m.subject.endsWith("replyto-allowed")) ?? null, 90_000);
    expect(sent.toRecipients.map((x) => x.emailAddress.address.toLowerCase())).toEqual([cfg.externalTo]);
    const history = await adminClient().from("email_history").select("to_email").eq("id", r.body.history_id).single();
    expect(history.data!.to_email).toBe(cfg.externalTo);
  });
});

describe("f. limits, uncertain sends and switched-off configuration (Microsoft faked: no mail is sent)", () => {
  const admin = () => worldB.tenants.alpha.users.admin;
  const org = () => worldB.tenants.alpha.id;
  const mail = (n: string) => ({ to: cfg.mailbox, subject: `TOLRA-LIVE-TEST ${stamp} f-${n}`, body: `Tolra live test faked ${n}.` });
  let before = 0;

  it("switched-off configuration answers 503 and calls nothing", async () => {
    setFake("ok");
    before = msCalls.length;
    for (const key of ["MS_TENANT_ID", "MS_MAILBOX"]) {
      const value = process.env[key];
      delete process.env[key];
      expect((await call(admin(), org(), send, "/api/mail/send", mail("off"))).status, key).toBe(503);
      process.env[key] = value;
    }
    const calls = msCalls.length - before;
    expect(calls, "calls to Microsoft while switched off").toBe(0);
    const r = await call(admin(), org(), send, "/api/mail/send", mail("on"));
    expect(r.status).toBe(200); // configured again
    expect(msCalls.length).toBeGreaterThan(before);
  });

  it("an uncertain send (timeout) is reported unknown, blocks a repeat, and can be settled by an admin", async () => {
    setFake("timeout");
    const first = await call(admin(), org(), send, "/api/mail/send", mail("uncertain"));
    expect(first.status).toBe(502);
    expect(first.body.status).toBe("unknown");
    const sends = msCalls.filter((c) => c.url.endsWith("/sendMail")).length;
    setFake("ok");
    const again = await call(admin(), org(), send, "/api/mail/send", mail("uncertain"));
    expect(again.status).toBe(409);
    expect(msCalls.filter((c) => c.url.endsWith("/sendMail")).length, "no second request to Microsoft").toBe(sends);
    const resolved = await call(admin(), org(), resolve, "/api/mail/resolve", { sendId: first.body.send_id, as: "failed" });
    expect(resolved.status).toBe(200);
    const retry = await call(admin(), org(), send, "/api/mail/send", mail("uncertain"));
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe("accepted");
  });

  it("concurrent sends at the limit: never more than twenty an hour", async () => {
    setFake("ok");
    const used = await ledgerCount(admin().id);
    session.client = await signedInClient(admin());
    process.env.MS_ORGANIZATION_ID = org();
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => send(post("/api/mail/send", mail(`race-${i}`)))));
    const statuses = results.map((r) => r.status);
    expect(statuses.filter((s) => s !== 200 && s !== 429)).toEqual([]);
    expect(statuses.filter((s) => s === 200)).toHaveLength(20 - used);
    expect(await ledgerCount(admin().id)).toBe(20);
  });

  it("back to real calls only after the faked tests", () => {
    setFake(null);
    expect(fake).toBeNull();
  });
});

describe("g. delivery report (read only, never fails the run)", () => {
  // Sent Items only shows Microsoft accepted a message. If an outside recipient never received it, Exchange normally
  // drops a non-delivery report (bounce) into the sending mailbox's Inbox. Read the last three days of those and print
  // the subject, sender and status codes, so the reason is in the run log. Nothing is moved, marked or deleted.
  it("prints any bounce in the test mailbox's Inbox", async () => {
    await sleep(60_000); // give a bounce for this run's outside sends time to land
    const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const list = await direct("GET", `${user(cfg.mailbox)}/mailFolders/inbox/messages?$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}&$orderby=${encodeURIComponent("receivedDateTime desc")}&$select=id,subject,from,receivedDateTime&$top=100`);
    if (list.status !== 200) {
      console.log(`[delivery report] could not list the Inbox (${list.status} ${list.code})`);
      return;
    }
    const messages = (list.json?.value ?? []) as Array<{ id: string; subject: string; from?: { emailAddress?: { address?: string; name?: string } }; receivedDateTime: string }>;
    const bounces = messages.filter((m) => /^(undeliverable|delivery has failed|mail delivery failed|returned mail|delivery status notification)/i.test(m.subject ?? "") || /postmaster|microsoftexchange|mailer-daemon/i.test(m.from?.emailAddress?.address ?? ""));
    console.log(`[delivery report] ${bounces.length} bounce(s) among ${messages.length} Inbox message(s) since ${since}`);
    for (const m of bounces.slice(0, 5)) {
      const full = await direct("GET", `${user(cfg.mailbox)}/messages/${encodeURIComponent(m.id)}?$select=body`);
      const text = String(full.json?.body?.content ?? "").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();
      const codes = [...new Set(text.match(/\b[45]\.\d{1,3}\.\d{1,3}\b|\b(?:421|450|451|452|550|551|552|553|554)\b/g) ?? [])];
      const reason = text.match(/(Remote server returned[^.]{0,300}|Diagnostic information[^.]{0,300}|Your message couldn't be delivered[^.]{0,300}|Status code[^.]{0,200})/i)?.[0] ?? text.slice(0, 400);
      console.log(`[delivery report] ${m.receivedDateTime} | from ${m.from?.emailAddress?.address ?? "?"} | ${m.subject}\n  codes: ${codes.join(", ") || "none found"}\n  reason: ${reason}`);
    }
  }, 120_000);
});
