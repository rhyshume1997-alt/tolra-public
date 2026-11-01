/**
 * C1 (migration 127): reading the company's own inbox through the one-click delegated Microsoft 365 connection. Graph, Microsoft sign-in
 * and the database are faked (the fake database keeps 127's rules: due = connected + Mail.Read + same mailbox; one row per company and
 * Graph id); nothing reaches the network. Covers: scopes (Mail.Read only, never ReadWrite; an old connection's refresh asks for sending
 * only), token and row isolation between companies, idempotency (the same page twice: 0 new rows), invalid_grant leading to needs
 * reconnect, reconnect resuming from the cursor, error text with no secrets; and (option D) the server endpoint behind the browser check
 * and the Check inbox button (/api/mail/check: admin and office of the session's company only; throttled per company with 127's
 * mailbox_sync_claim; the browser gets { checked_at, new, status, reason } only), revoked reading with sending kept, Graph paging and
 * token renewal. The browser schedule itself is tests/unit/inbox-auto-check.test.ts.
 */
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// 125's PO step, kept as it is (tests/unit/po-capture-poll.test.ts covers it): only watched, to see what each check hands it.
vi.mock("@/lib/po-capture-load", async (orig) => {
  const m = await orig<typeof import("@/lib/po-capture-load")>();
  return { ...m, suggestPoLinks: vi.fn(m.suggestPoLinks) };
});

import { encryptSecret } from "@/lib/integrations/crypto";
import { finishMicrosoftConnect } from "@/lib/integrations/microsoft/connect";
import { MailReadError, listMyInbox, pollMailbox, runMailboxPollPass } from "@/lib/integrations/microsoft/inbox";
import { MICROSOFT_SCOPES, authorizeUrl, grantsMailRead, refreshTokens } from "@/lib/integrations/microsoft/oauth";
import { type MailSyncCode, mailSyncLine, mailSyncReason } from "@/lib/integrations/overview";
import { hashState } from "@/lib/integrations/xero/oauth";
import { toInboxMessage } from "@/lib/m365/graph";
import { suggestPoLinks } from "@/lib/po-capture-load";

const A = "aaaaaaaa-0000-4000-8000-00000000000a";
const B = "bbbbbbbb-0000-4000-8000-00000000000b";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const key = randomBytes(32);
const SITE = "https://app.example.test";
const msReady = { config: { clientId: "mid", clientSecret: "msecret", redirectUri: `${SITE}/api/integrations/microsoft/callback`, tenant: "organizations" }, key };
const ctx = (org: string, purpose: "refresh" | "access" | "pkce") => ({ organizationId: org, provider: "microsoft", purpose });

type Sync = { mailbox_id: string; mail_read: boolean; checkpoint: string | null; next_link: string | null; last_sync_at: string | null; last_error: MailSyncCode | null; error_count: number; claimed_at?: number | null };
type Company = { status: "connected" | "needs_reconnect" | "disconnected"; tenant_id: string; refresh_enc: string; access_enc: string | null; expires: string | null; sync?: Sync };

/** A fake service-role database keeping 084's lease and 127's rules, every rpc recorded. */
function fakeDb(companies: Record<string, Company>) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  /** The database's clock for the throttle (ms): advance it to pass the interval. */
  const clock = { now: Date.parse("2026-11-01T10:00:00Z") };
  const inbound = new Map<string, { org: string; id: string; subject: string | null }>();
  const due = (org: string | null) => Object.entries(companies)
    .filter(([o, c]) => (org === null || o === org) && c.status === "connected" && c.sync?.mail_read && c.sync.mailbox_id === c.tenant_id)
    .map(([o, c]) => ({ organization_id: o, checkpoint: c.sync!.checkpoint, next_link: c.sync!.next_link }));
  const handlers: Record<string, (a: Record<string, unknown>) => { data?: unknown; error?: { code: string; message: string } }> = {
    mailbox_sync_due: (a) => ({ data: due((a.p_org as string | null) ?? null) }),
    // 127's claim: not_readable unless due; recent within p_min_seconds of the last claim; else claimed (with the cursor).
    mailbox_sync_claim: (a) => {
      const org = a.p_org as string;
      if (!due(org).length) return { data: { state: "not_readable" } };
      const sync = companies[org].sync!;
      if (sync.claimed_at != null && clock.now - sync.claimed_at < Number(a.p_min_seconds) * 1000) return { data: { state: "recent", last_sync_at: sync.last_sync_at, last_error: sync.last_error } };
      sync.claimed_at = clock.now;
      return { data: { state: "claimed", checkpoint: sync.checkpoint, next_link: sync.next_link } };
    },
    integration_token_lease: (a) => {
      const c = companies[a.p_org as string];
      if (!c || c.status === "disconnected") return { data: null };
      return { data: { refresh_token_enc: c.refresh_enc, access_token_enc: c.access_enc, access_expires_at: c.expires, key_version: 1 } };
    },
    integration_token_store: (a) => {
      const c = companies[a.p_org as string];
      Object.assign(c, { refresh_enc: a.p_refresh_enc, access_enc: a.p_access_enc, expires: a.p_access_expires_at });
      return { data: true };
    },
    integration_token_release: () => ({ data: null }),
    integration_mark_needs_reconnect: (a) => {
      const c = companies[a.p_org as string];
      if (c?.status === "connected") c.status = "needs_reconnect";
      return { data: null };
    },
    mailbox_record_inbound: (a) => {
      const org = a.p_org as string;
      if (!due(org).length) return { error: { code: "42501", message: "This company's mailbox can't be read." } };
      const k = `${org}|${a.p_graph_message_id}`;
      if (inbound.has(k)) return { data: { inserted: false, inbound_email_id: null, rfq_id: null } };
      inbound.set(k, { org, id: String(a.p_graph_message_id), subject: (a.p_subject as string | null) ?? null });
      return { data: { inserted: true, inbound_email_id: `ie-${inbound.size}`, rfq_id: `rfq-${inbound.size}` } };
    },
    mailbox_sync_result: (a) => {
      const s = companies[a.p_org as string]?.sync;
      if (!s) return { data: null };
      if (a.p_error === null) {
        Object.assign(s, { last_sync_at: "2026-11-01T10:42:00Z", last_error: null, error_count: 0, next_link: a.p_next_link,
                           checkpoint: [s.checkpoint, a.p_checkpoint as string | null].filter(Boolean).sort().pop() ?? null });
      } else {
        Object.assign(s, { last_error: a.p_error, error_count: s.error_count + 1, mail_read: s.mail_read && a.p_error !== "consent" });
      }
      return { data: null };
    },
    mailbox_sync_connected: (a) => {
      const c = companies[a.p_org as string];
      if (!c || c.status !== "connected" || c.tenant_id !== a.p_mailbox_id) return { error: { code: "P0002", message: "not connected" } };
      const same = c.sync?.mailbox_id === a.p_mailbox_id;
      c.sync = { mailbox_id: String(a.p_mailbox_id), mail_read: Boolean(a.p_mail_read), checkpoint: same ? c.sync!.checkpoint : null, next_link: same ? c.sync!.next_link : null,
                 last_sync_at: c.sync?.last_sync_at ?? null, last_error: null, error_count: 0 };
      return { data: { mail_read: Boolean(a.p_mail_read), resumed: same } };
    },
    integration_oauth_consume: (a) => ({ data: { verifier_enc: encryptSecret("v", ctx(a.p_org as string, "pkce"), key) } }),
    integration_store_connection: (a) => {
      const c = companies[a.p_org as string];
      Object.assign(c, { status: "connected", tenant_id: a.p_tenant_id, refresh_enc: a.p_refresh_enc, access_enc: a.p_access_enc, expires: a.p_access_expires_at });
      return { data: { status: "connected" } };
    },
  };
  // integration_connections' status, read as lib/integrations/microsoft/token-source.ts does (from().select().eq().eq().maybeSingle()).
  const from = (table: string) => {
    const filters: Record<string, unknown> = {};
    const q = {
      select: () => q,
      eq: (col: string, val: unknown) => { filters[col] = val; return q; },
      maybeSingle: async () => {
        calls.push({ fn: `from:${table}`, args: { ...filters } });
        const c = table === "integration_connections" && filters.provider === "microsoft" ? companies[filters.organization_id as string] : undefined;
        return { data: c ? { status: c.status } : null, error: null };
      },
    };
    return q;
  };
  return {
    calls, inbound, companies, clock,
    client: {
      from,
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const h = handlers[fn];
        if (!h) return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } };
        const r = h(args);
        return { data: r.data ?? null, error: r.error ?? null };
      },
    } as unknown as SupabaseClient,
  };
}

const company = (org: string, mailbox: string, token: string, opts: Partial<Company> = {}, sync: Partial<Sync> = {}): Company => ({
  status: "connected", tenant_id: mailbox,
  refresh_enc: encryptSecret(`RT-${token}`, ctx(org, "refresh"), key),
  access_enc: encryptSecret(token, ctx(org, "access"), key),
  expires: new Date(Date.now() + 3_600_000).toISOString(),
  sync: { mailbox_id: mailbox, mail_read: true, checkpoint: null, next_link: null, last_sync_at: null, last_error: null, error_count: 0, ...sync },
  ...opts,
});

const msg = (id: string, at: string, subject = `RFQ ${id}`) => ({ id, internetMessageId: `<${id}@example.test>`, subject, from: { emailAddress: { address: "Buyer@Example.test", name: "Buyer" } },
                                                                     receivedDateTime: at, bodyPreview: "Please quote", body: { content: "Body" }, isRead: false });

type Seen = { url: string; method: string; auth: string | null; body?: string };
/** Microsoft: a token endpoint and a Graph that answers by the bearer token (each token sees its own mailbox only). */
function fakeMicrosoft(mailboxes: Record<string, { status?: number; body?: unknown; pages?: unknown[] }>, token?: (form: URLSearchParams) => Response, sendable = new Set<string>()) {
  const seen: Seen[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    seen.push({ url: String(url), method: init?.method ?? "GET", auth: headers.get("authorization"), body: init?.body ? String(init.body) : undefined });
    if (String(url).includes("/oauth2/v2.0/token")) {
      const form = new URLSearchParams(String(init?.body));
      if (token) return token(form);
      const rt = form.get("refresh_token") ?? "";
      return new Response(JSON.stringify({ access_token: rt.replace(/^RT-/, ""), refresh_token: rt, expires_in: 3600, scope: form.get("scope") }), { status: 200 });
    }
    if (String(url) === "https://graph.microsoft.com/v1.0/me/sendMail") return new Response(null, { status: sendable.has((headers.get("authorization") ?? "").replace(/^Bearer /, "")) ? 202 : 401 });
    const box = mailboxes[(headers.get("authorization") ?? "").replace(/^Bearer /, "")];
    if (!box) return new Response(JSON.stringify({ error: { code: "InvalidAuthenticationToken" } }), { status: 401 });
    if (box.status && box.status !== 200) return new Response(JSON.stringify(box.body ?? {}), { status: box.status });
    const pageNo = Number(new URL(String(url)).searchParams.get("$skiptoken") ?? "0");
    const pages = box.pages ?? [box.body];
    const next = pageNo + 1 < pages.length ? `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=${pageNo + 1}` : undefined;
    return new Response(JSON.stringify({ value: pages[pageNo] ?? [], ...(next ? { "@odata.nextLink": next } : {}) }), { status: 200 });
  });
  return { seen, fetchImpl: fetchImpl as unknown as typeof fetch };
}

const PAGE_A = [msg("a-1", "2026-11-01T09:00:00Z"), msg("a-2", "2026-11-01T09:05:00Z")];
const PAGE_B = [msg("b-1", "2026-11-01T08:00:00Z", "B secret project")];

describe("scopes: delegated Mail.Read only, never Mail.ReadWrite; an old connection keeps sending", () => {
  it("Connect asks for offline_access, User.Read, Mail.Send, Mail.Read and nothing that writes mail", () => {
    const url = new URL(authorizeUrl(msReady.config, "s", "c"));
    expect(url.searchParams.get("scope")).toBe("offline_access User.Read Mail.Send Mail.Read");
    expect(MICROSOFT_SCOPES.join(" ")).not.toMatch(/ReadWrite|Mail\.Read\.Shared|MailboxSettings|\.default/i);
  });

  it("reads Microsoft's granted scope list: bare or Graph URI; ReadWrite or Send alone is not Mail.Read", () => {
    expect(grantsMailRead("openid profile Mail.Read Mail.Send User.Read")).toBe(true);
    expect(grantsMailRead("https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send")).toBe(true);
    expect(grantsMailRead("Mail.ReadWrite Mail.Send")).toBe(false);
    expect(grantsMailRead("Mail.Send User.Read")).toBe(false);
    expect(grantsMailRead(null)).toBe(false);
  });

  it("a refresh asks for what that connection consented to: Mail.Read once allowed, sending only for a connection made before C1", async () => {
    const db = fakeDb({ [A]: company(A, "oid-a", "AT-A", { access_enc: null, expires: null }), [B]: company(B, "oid-b", "AT-B", { access_enc: null, expires: null }, { mail_read: false }) });
    const ms = fakeMicrosoft({ "AT-A": { body: [] } });
    const { microsoftTokenSource } = await import("@/lib/integrations/microsoft/client");
    const source = microsoftTokenSource(db.client, msReady, ms.fetchImpl);
    expect(await source(A)).toBe("AT-A");
    expect(await source(B)).toBe("AT-B");
    const scopes = ms.seen.filter((s) => s.url.includes("/token")).map((s) => new URLSearchParams(s.body).get("scope"));
    expect(scopes).toEqual(["offline_access User.Read Mail.Send Mail.Read", "offline_access Mail.Send User.Read"]);
    // B (sending only) is still connected: nothing was refused.
    expect(db.companies[B].status).toBe("connected");
    // refreshTokens' default is the sending-only set (what every connection made before C1 consented to).
    const plain = fakeMicrosoft({});
    await refreshTokens(msReady.config, "RT-x", plain.fetchImpl);
    expect(new URLSearchParams(plain.seen[0].body).get("scope")).toBe("offline_access Mail.Send User.Read");
  });

  it("Connect records whether Mail.Read was granted, for this company and this mailbox; before 127 it still connects", async () => {
    const db = fakeDb({ [A]: company(A, "oid-a", "AT-A", { status: "disconnected" }, { mail_read: false }) });
    const fetchImpl = vi.fn(async (url: string) => (String(url).includes("/token")
      ? new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 3600, scope: "Mail.Read Mail.Send User.Read profile openid email" }), { status: 200 })
      : new Response(JSON.stringify({ id: "oid-a", mail: "office@a.example.test" }), { status: 200 })));
    expect(await finishMicrosoftConnect(db.client, A, ADMIN, "st", "code", msReady, { fetchImpl: fetchImpl as never })).toEqual({ ok: true, mailbox: "office@a.example.test", mailRead: true });
    expect(db.calls.find((c) => c.fn === "mailbox_sync_connected")!.args).toEqual({ p_org: A, p_mailbox_id: "oid-a", p_mail_read: true });
    expect(db.calls[0]).toMatchObject({ fn: "integration_oauth_consume", args: { p_org: A, p_state_hash: hashState("st") } });
    // 127 not applied: the sign-in is stored (sending works), reading stays off.
    const before127 = { rpc: async (fn: string, args: Record<string, unknown>) => (fn === "mailbox_sync_connected" ? { data: null, error: { code: "PGRST202", message: "Could not find the function" } } : db.client.rpc(fn, args)) };
    expect(await finishMicrosoftConnect(before127 as never, A, ADMIN, "st", "code", msReady, { fetchImpl: fetchImpl as never })).toEqual({ ok: true, mailbox: "office@a.example.test", mailRead: false });
  });
});

describe("read only: GET on the connected user's own inbox", () => {
  it("one GET per page on /me/mailFolders/inbox/messages, immutable ids, text bodies; no write of any kind", async () => {
    const ms = fakeMicrosoft({ "AT-A": { pages: [PAGE_A.slice(0, 1), PAGE_A.slice(1)] } });
    const r = await listMyInbox("AT-A", { since: "2026-11-01T00:00:00Z" }, ms.fetchImpl);
    expect(r.messages.map((m) => m.id)).toEqual(["a-1", "a-2"]);
    expect(r.messages[0].from).toBe("buyer@example.test");
    expect(ms.seen.map((s) => s.method)).toEqual(["GET", "GET"]);
    expect(ms.seen[0].url.startsWith("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?")).toBe(true);
    expect(ms.seen[0].url).toContain(encodeURIComponent("receivedDateTime ge 2026-11-01T00:00:00.000Z"));
    const init = (ms.fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0][1];
    expect(new Headers(init.headers).get("prefer")).toBe('IdType="ImmutableId", outlook.body-content-type="text"');
    expect(ms.seen.some((s) => /\/users\//.test(s.url))).toBe(false);
  });

  it("a paging link that is not Graph's is never followed", async () => {
    await expect(listMyInbox("AT-A", { since: "2026-11-01T00:00:00Z", resumeLink: "https://evil.example/steal" }, fakeMicrosoft({}).fetchImpl)).rejects.toBeInstanceOf(MailReadError);
  });
});

describe("isolation: each company's token is used only for that company, and its rows are written only for it", () => {
  it("the pass reads A with A's token into A, B with B's token into B; nothing crosses", async () => {
    const db = fakeDb({ [A]: company(A, "oid-a", "AT-A"), [B]: company(B, "oid-b", "AT-B") });
    const ms = fakeMicrosoft({ "AT-A": { body: PAGE_A }, "AT-B": { body: PAGE_B } });
    const summary = await runMailboxPollPass({ service: db.client, ready: msReady, fetchImpl: ms.fetchImpl });
    expect(summary).toEqual({ companies: 2, checked: 2, read: 3, inserted: 3, duplicates: 0, failed: 0, throttled: 0, poSuggested: 0, poFailed: 0 });
    expect([...db.inbound.values()].map((r) => `${r.org === A ? "A" : "B"}:${r.id}`).sort()).toEqual(["A:a-1", "A:a-2", "B:b-1"]);
    for (const c of db.calls.filter((x) => x.fn === "mailbox_record_inbound")) {
      expect(String(c.args.p_graph_message_id).startsWith(c.args.p_org === A ? "a-" : "b-")).toBe(true);
    }
    for (const c of db.calls.filter((x) => ["mailbox_sync_result", "integration_token_lease"].includes(x.fn))) expect([A, B]).toContain(c.args.p_org);
    expect(new Set(ms.seen.map((s) => s.auth))).toEqual(new Set(["Bearer AT-A", "Bearer AT-B"]));
    expect(db.companies[A].sync!.checkpoint).toBe("2026-11-01T09:05:00Z");
    expect(db.companies[B].sync!.checkpoint).toBe("2026-11-01T08:00:00Z");
  });

  it("a sign-in stored under another company's context can't be used: that company is marked needs_reconnect, nothing is read or written for it", async () => {
    const swapped = company(B, "oid-b", "AT-B");
    swapped.access_enc = encryptSecret("AT-A", ctx(A, "access"), key); // A's token, copied into B's row
    swapped.refresh_enc = encryptSecret("RT-AT-A", ctx(A, "refresh"), key);
    const db = fakeDb({ [A]: company(A, "oid-a", "AT-A"), [B]: swapped });
    const ms = fakeMicrosoft({ "AT-A": { body: PAGE_A } });
    const summary = await runMailboxPollPass({ service: db.client, ready: msReady, fetchImpl: ms.fetchImpl });
    expect(summary.failed).toBe(1);
    expect(db.companies[B].status).toBe("needs_reconnect");
    expect(db.companies[B].sync!.last_error).toBe("reconnect");
    expect([...db.inbound.values()].every((r) => r.org === A)).toBe(true);
    expect(ms.seen.filter((s) => s.auth === "Bearer AT-A")).toHaveLength(1); // A's token used once, for A only
  });

  it("B failing (Microsoft refuses reading: 403) never stops A, and B's failure is a code (no B data in A's results or the summary)", async () => {
    const db = fakeDb({ [A]: company(A, "oid-a", "AT-A"), [B]: company(B, "oid-b", "AT-B") });
    const ms = fakeMicrosoft({ "AT-A": { body: PAGE_A }, "AT-B": { status: 403, body: { error: { code: "ErrorAccessDenied", message: "B secret project denied for boss@b.example" } } } });
    const summary = await runMailboxPollPass({ service: db.client, ready: msReady, fetchImpl: ms.fetchImpl });
    expect(summary).toMatchObject({ checked: 2, inserted: 2, failed: 1 });
    expect(JSON.stringify(summary)).not.toMatch(/secret|boss@|b\.example/);
    expect(db.companies[B].sync).toMatchObject({ last_error: "consent", mail_read: false, error_count: 1 });
    expect(db.companies[B].status).toBe("connected"); // sending is untouched
    expect(db.companies[A].sync).toMatchObject({ last_error: null, error_count: 0 });
    // B now asks for "Reconnect to allow reading mail" and is not checked again until it does.
    expect(mailSyncLine({ mail_read: false, last_sync_at: null, last_error: "consent", error_count: 1 }, (t) => t)?.text).toMatch(/^Reconnect to allow reading mail/);
    const again = await runMailboxPollPass({ service: db.client, ready: msReady, fetchImpl: ms.fetchImpl });
    expect(again.companies).toBe(1);
  });
});

describe("idempotent ingestion", () => {
  it("the same page twice gives 0 new rows the second time; the cursor is kept per connection", async () => {
    const db = fakeDb({ [A]: company(A, "oid-a", "AT-A") });
    const ms = fakeMicrosoft({ "AT-A": { body: PAGE_A } });
    const first = await runMailboxPollPass({ service: db.client, ready: msReady, fetchImpl: ms.fetchImpl });
    // Within 90 seconds the company is not checked again (the throttle); after it, it is.
    expect(await runMailboxPollPass({ service: db.client, ready: msReady, fetchImpl: ms.fetchImpl })).toMatchObject({ companies: 1, checked: 0, throttled: 1 });
    db.clock.now += 91_000;
    const second = await runMailboxPollPass({ service: db.client, ready: msReady, fetchImpl: ms.fetchImpl });
    expect([first.inserted, first.duplicates]).toEqual([2, 0]);
    expect([second.inserted, second.duplicates]).toEqual([0, 2]);
    expect(db.inbound.size).toBe(2);
    // The second check starts from the first's newest message.
    expect(ms.seen[1].url).toContain(encodeURIComponent("receivedDateTime ge 2026-11-01T09:05:00.000Z"));
  });

  it("a check stopped at its page limit keeps Microsoft's paging link and carries on from it next time", async () => {
    const db = fakeDb({ [A]: company(A, "oid-a", "AT-A") });
    const ms = fakeMicrosoft({ "AT-A": { pages: [PAGE_A.slice(0, 1), PAGE_A.slice(1)] } });
    const tokens = async () => "AT-A";
    const { recordForCompany, saveResultFor } = await import("@/lib/integrations/microsoft/inbox");
    const run = () => pollMailbox({ cursor: { checkpoint: db.companies[A].sync!.checkpoint, nextLink: db.companies[A].sync!.next_link }, accessToken: tokens,
                                    record: recordForCompany(db.client, A), saveResult: saveResultFor(db.client, A), fetchImpl: ms.fetchImpl, maxPages: 1 });
    expect(await run()).toMatchObject({ read: 1, inserted: 1, more: true });
    expect(db.companies[A].sync!.next_link).toBe("https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=1");
    expect(await run()).toMatchObject({ read: 1, inserted: 1, more: false });
    expect(db.companies[A].sync!.next_link).toBeNull();
    expect(db.inbound.size).toBe(2);
  });

  it("a store failure leaves the cursor where it was (the next check re-reads; nothing is lost or doubled)", async () => {
    const db = fakeDb({ [A]: company(A, "oid-a", "AT-A") });
    const ms = fakeMicrosoft({ "AT-A": { body: PAGE_A } });
    let n = 0;
    const out = await pollMailbox({ cursor: { checkpoint: null, nextLink: null }, accessToken: async () => "AT-A", fetchImpl: ms.fetchImpl,
      record: async () => { n += 1; if (n === 2) throw new Error("db down"); return { inserted: true, inboundEmailId: "x" }; },
      saveResult: async (r) => { await db.client.rpc("mailbox_sync_result", { p_org: A, p_error: r.error, p_next_link: r.nextLink, p_checkpoint: r.checkpoint }); } });
    expect(out.error).toBe("store_failed");
    expect(db.companies[A].sync).toMatchObject({ checkpoint: null, last_error: "store_failed", error_count: 1 });
  });
});

describe("expired consent: invalid_grant marks needs reconnect, polling stops, reconnecting resumes without duplicates", () => {
  it("invalid_grant: needs_reconnect, the reason stored as a code; the next pass does not touch it", async () => {
    const db = fakeDb({ [A]: company(A, "oid-a", "AT-A", { access_enc: null, expires: null }) });
    const ms = fakeMicrosoft({ "AT-A": { body: PAGE_A } }, () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "AADSTS700082: The refresh token has expired. Trace ID: 1234 user boss@a.example" }), { status: 400 }));
    const first = await runMailboxPollPass({ service: db.client, ready: msReady, fetchImpl: ms.fetchImpl });
    expect(first).toMatchObject({ checked: 1, failed: 1, inserted: 0 });
    expect(db.companies[A].status).toBe("needs_reconnect");
    expect(db.companies[A].sync!.last_error).toBe("reconnect");
    expect(String(db.calls.find((c) => c.fn === "integration_mark_needs_reconnect")!.args.p_reason)).not.toMatch(/AADSTS|boss@|Trace/);
    expect(ms.seen.filter((s) => s.url.includes("graph.microsoft.com"))).toHaveLength(0);
    const before = ms.seen.length;
    expect(await runMailboxPollPass({ service: db.client, ready: msReady, fetchImpl: ms.fetchImpl })).toMatchObject({ companies: 0, checked: 0 });
    expect(ms.seen.length).toBe(before);
  });

  it("reconnecting the same mailbox clears the failure, keeps the cursor and resumes: messages already stored are not stored again", async () => {
    const db = fakeDb({ [A]: company(A, "oid-a", "AT-A") });
    const ms = fakeMicrosoft({ "AT-A": { body: PAGE_A }, AT: { body: [...PAGE_A, msg("a-3", "2026-11-01T09:10:00Z")] } });
    await runMailboxPollPass({ service: db.client, ready: msReady, fetchImpl: ms.fetchImpl });
    db.companies[A].status = "needs_reconnect";
    db.companies[A].sync!.last_error = "reconnect";
    const connectFetch = vi.fn(async (url: string, init?: RequestInit) => (String(url).includes("/token")
      ? new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT-AT", expires_in: 3600, scope: "Mail.Read Mail.Send User.Read" }), { status: 200 })
      : String(url).includes("/me?") ? new Response(JSON.stringify({ id: "oid-a", mail: "office@a.example.test" }), { status: 200 }) : ms.fetchImpl(url, init)));
    expect(await finishMicrosoftConnect(db.client, A, ADMIN, "st", "code", msReady, { fetchImpl: connectFetch as never })).toMatchObject({ ok: true, mailRead: true });
    expect(db.companies[A].sync).toMatchObject({ checkpoint: "2026-11-01T09:05:00Z", last_error: null, error_count: 0 });
    db.clock.now += 91_000;
    const resumed = await runMailboxPollPass({ service: db.client, ready: msReady, fetchImpl: ms.fetchImpl });
    expect(resumed).toMatchObject({ checked: 1, inserted: 1, duplicates: 2, failed: 0 });
    expect([...db.inbound.keys()].sort()).toEqual([`${A}|a-1`, `${A}|a-2`, `${A}|a-3`]);
    expect(ms.seen.at(-1)!.url).toContain(encodeURIComponent("receivedDateTime ge 2026-11-01T09:05:00.000Z"));
  });

  it("Graph refuses a token once (401): it is renewed and the check goes on", async () => {
    const tokens: Array<boolean | undefined> = [];
    const ms = fakeMicrosoft({ "AT-new": { body: PAGE_A } });
    const out = await pollMailbox({ cursor: { checkpoint: null, nextLink: null }, fetchImpl: ms.fetchImpl,
      accessToken: async (o) => { tokens.push(o?.force); return o?.force ? "AT-new" : "AT-stale"; },
      record: async () => ({ inserted: true, inboundEmailId: "x" }), saveResult: async () => undefined });
    expect(out).toMatchObject({ error: null, inserted: 2 });
    expect(tokens).toEqual([undefined, true]);
  });
});

describe("sync failures in plain words, never a token or Microsoft's text", () => {
  it("each code has a plain reason; an unknown code reads as 'didn't answer'", () => {
    for (const code of ["reconnect", "consent", "signin", "busy", "unavailable", "store_failed"] as const) {
      expect(mailSyncReason(code)).toMatch(/^[A-Z][^<>{}]+\.$/);
      expect(mailSyncReason(code)).not.toMatch(/token|AADSTS|Bearer|http/i);
    }
    expect(mailSyncReason("Bearer eyJ0eXAi.secret")).toBe(mailSyncReason("unavailable"));
  });

  it("the card line: 'Last checked 10:42', 'Couldn't check mail: ...', or the ask to reconnect", () => {
    const time = () => "10:42";
    expect(mailSyncLine({ mail_read: true, last_sync_at: "2026-11-01T10:42:00Z", last_error: null, error_count: 0 }, time)).toEqual({ tone: "ok", text: "Last checked 10:42", reconnect: false });
    expect(mailSyncLine({ mail_read: true, last_sync_at: null, last_error: "busy", error_count: 3 }, time)).toEqual({ tone: "error", text: "Couldn't check mail: Microsoft 365 is busy. Tolra will try again shortly.", reconnect: false });
    expect(mailSyncLine({ mail_read: true, last_sync_at: null, last_error: "reconnect", error_count: 1 }, time)?.reconnect).toBe(true);
    const old = mailSyncLine({ mail_read: false, last_sync_at: null, last_error: null, error_count: 0 }, time)!;
    expect(old.text).toContain("Reconnect to allow reading mail");
    expect(old.text).toContain("Sending keeps working");
    expect(mailSyncLine(null, time)).toBeNull();
  });

  it("a Graph error body (identifiers, a token) never reaches the error, the stored code or the log", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ms = fakeMicrosoft({ "AT-A": { status: 500, body: { error: { code: "InternalServerError", message: "boss@a.example Bearer AT-A eyJ secret" } } } });
    const saved: unknown[] = [];
    const out = await pollMailbox({ cursor: { checkpoint: null, nextLink: null }, accessToken: async () => "AT-A", fetchImpl: ms.fetchImpl,
      record: async () => ({ inserted: true, inboundEmailId: "x" }), saveResult: async (r) => { saved.push(r); } });
    expect(out.error).toBe("unavailable");
    expect(saved).toEqual([{ error: "unavailable", nextLink: null, checkpoint: null }]);
    await expect(listMyInbox("AT-A", { since: "2026-11-01T00:00:00Z" }, ms.fetchImpl)).rejects.toThrow("Microsoft 365 inbox read failed (unavailable)");
    expect(JSON.stringify([out, saved, errors.mock.calls])).not.toMatch(/boss@|AT-A|eyJ|secret/);
    errors.mockRestore();
  });
});


// ------------------------------------------------------------------------------------------------------------------------------------
// Graph paging and token renewal (ChatGPT condition 6), against a mocked Graph and Microsoft sign-in.
describe("Graph paging: @odata.nextLink over several pages, a page limit with more, and resuming", () => {
  const P = [[msg("p-1", "2026-11-01T09:00:00Z")], [msg("p-2", "2026-11-01T09:01:00Z")], [msg("p-3", "2026-11-01T09:02:00Z")]];
  const link = (n: number) => `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=${n}`;

  it("follows every nextLink to the end (3 pages, 3 GETs), more = false", async () => {
    const ms = fakeMicrosoft({ "AT-A": { pages: P } });
    const r = await listMyInbox("AT-A", { since: "2026-11-01T00:00:00Z" }, ms.fetchImpl);
    expect(r).toMatchObject({ more: false, nextLink: null });
    expect(r.messages.map((m) => m.id)).toEqual(["p-1", "p-2", "p-3"]);
    expect(ms.seen.map((x) => x.url)).toEqual([expect.stringContaining("$top=50"), link(1), link(2)]);
  });

  it("stops at the page limit with more = true and the link to carry on from; resuming reads only what is left", async () => {
    const ms = fakeMicrosoft({ "AT-A": { pages: P } });
    const first = await listMyInbox("AT-A", { since: "2026-11-01T00:00:00Z", maxPages: 2 }, ms.fetchImpl);
    expect(first).toMatchObject({ more: true, nextLink: link(2) });
    expect(first.messages.map((m) => m.id)).toEqual(["p-1", "p-2"]);
    expect(ms.seen).toHaveLength(2); // the third page was not fetched
    const rest = await listMyInbox("AT-A", { since: "2026-11-01T00:00:00Z", resumeLink: first.nextLink, maxPages: 2 }, ms.fetchImpl);
    expect(rest).toMatchObject({ more: false, nextLink: null });
    expect(rest.messages.map((m) => m.id)).toEqual(["p-3"]);
    expect(ms.seen.at(-1)!.url).toBe(link(2));
  });

  it("through the cron pass: the stored link resumes the next pass, and no message is stored twice", async () => {
    const db = fakeDb({ [A]: company(A, "oid-a", "AT-A") });
    const ms = fakeMicrosoft({ "AT-A": { pages: P } });
    const { recordForCompany, saveResultFor } = await import("@/lib/integrations/microsoft/inbox");
    const run = () => pollMailbox({ cursor: { checkpoint: db.companies[A].sync!.checkpoint, nextLink: db.companies[A].sync!.next_link }, accessToken: async () => "AT-A",
                                    record: recordForCompany(db.client, A), saveResult: saveResultFor(db.client, A), fetchImpl: ms.fetchImpl, maxPages: 2 });
    expect(await run()).toMatchObject({ read: 2, inserted: 2, more: true });
    expect(db.companies[A].sync!.next_link).toBe(link(2));
    expect(await run()).toMatchObject({ read: 1, inserted: 1, more: false });
    expect(db.companies[A].sync).toMatchObject({ next_link: null, checkpoint: "2026-11-01T09:02:00Z" });
    expect([...db.inbound.keys()].sort()).toEqual([`${A}|p-1`, `${A}|p-2`, `${A}|p-3`]);
  });

  it("a stored paging link Microsoft no longer accepts (400) is dropped and the check starts again from the checkpoint", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(String(url));
      return String(url).includes("skiptoken=9") ? new Response("{}", { status: 400 }) : new Response(JSON.stringify({ value: P[0] }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await pollMailbox({ cursor: { checkpoint: "2026-11-01T08:00:00Z", nextLink: link(9) }, accessToken: async () => "AT-A", fetchImpl,
      record: async () => ({ inserted: true, inboundEmailId: "x" }), saveResult: async () => undefined });
    expect(out).toMatchObject({ error: null, inserted: 1 });
    expect(seen[0]).toBe(link(9));
    expect(seen[1]).toContain(encodeURIComponent("receivedDateTime ge 2026-11-01T08:00:00.000Z"));
  });
});

describe("token renewal: an expired access token is renewed once, the new refresh token stored; a refused renewal means reconnect", () => {
  it("expired: one refresh_token call, the NEW refresh token is what is stored, the new access token reads; the next check needs no call", async () => {
    const db = fakeDb({ [A]: company(A, "oid-a", "AT-A", { access_enc: null, expires: new Date(Date.now() - 60_000).toISOString() }) });
    const ms = fakeMicrosoft({ "AT-NEW": { body: PAGE_A } }, () => new Response(JSON.stringify({ access_token: "AT-NEW", refresh_token: "RT-NEW", expires_in: 3600, scope: "Mail.Read Mail.Send" }), { status: 200 }));
    const { checkCompanyInbox } = await import("@/lib/integrations/microsoft/inbox");
    expect(await checkCompanyInbox({ service: db.client, ready: msReady, org: A, fetchImpl: ms.fetchImpl })).toMatchObject({ status: "checked", new: 2 });
    const tokenCalls = ms.seen.filter((x) => x.url.includes("/oauth2/v2.0/token"));
    expect(tokenCalls).toHaveLength(1);
    const form = new URLSearchParams(tokenCalls[0].body);
    expect([form.get("grant_type"), form.get("refresh_token")]).toEqual(["refresh_token", "RT-AT-A"]);
    const { decryptSecret } = await import("@/lib/integrations/crypto");
    expect(decryptSecret(db.companies[A].refresh_enc, ctx(A, "refresh"), key)).toBe("RT-NEW");
    expect(decryptSecret(db.companies[A].access_enc!, ctx(A, "access"), key)).toBe("AT-NEW");
    expect(ms.seen.filter((x) => x.url.includes("graph.microsoft.com")).every((x) => x.auth === "Bearer AT-NEW")).toBe(true);
    db.clock.now += 91_000;
    await checkCompanyInbox({ service: db.client, ready: msReady, org: A, fetchImpl: ms.fetchImpl });
    expect(ms.seen.filter((x) => x.url.includes("/oauth2/v2.0/token"))).toHaveLength(1);
  });

  it("Graph refuses the token twice (401, 401): renewed once only, then the check fails as 'signin' (no loop)", async () => {
    const tokens: Array<boolean | undefined> = [];
    const ms = fakeMicrosoft({});
    const out = await pollMailbox({ cursor: { checkpoint: null, nextLink: null }, fetchImpl: ms.fetchImpl,
      accessToken: async (o) => { tokens.push(o?.force); return "AT-unknown"; },
      record: async () => ({ inserted: true, inboundEmailId: "x" }), saveResult: async () => undefined });
    expect(out.error).toBe("signin");
    expect(tokens).toEqual([undefined, true]);
    expect(ms.seen).toHaveLength(2);
  });

  it("a refused renewal (invalid_grant) marks the connection needs_reconnect and the check answers needs_reconnect in plain words", async () => {
    const db = fakeDb({ [A]: company(A, "oid-a", "AT-A", { access_enc: null, expires: null }) });
    const ms = fakeMicrosoft({}, () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "AADSTS50173 boss@a.example" }), { status: 400 }));
    const { checkCompanyInbox } = await import("@/lib/integrations/microsoft/inbox");
    const reply = await checkCompanyInbox({ service: db.client, ready: msReady, org: A, fetchImpl: ms.fetchImpl });
    expect(reply).toEqual({ checked_at: expect.any(String), new: 0, status: "needs_reconnect", reason: "Couldn't check mail: Microsoft needs you to sign in again. Click Reconnect." });
    expect(db.companies[A].status).toBe("needs_reconnect");
    expect(JSON.stringify(reply)).not.toMatch(/AADSTS|boss@/);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------
// Revoked consent stops reading without breaking sending (ChatGPT condition 5). ONE refresh token covers reading and sending.
describe("revoked reading: polling stops, sending goes on where the sign-in still allows it; a fully revoked sign-in fails sending clearly", () => {
  const email = { to: ["buyer@example.test"], cc: [], subject: "Quote Q-1", text: "Hello", attachments: [] };
  const ENV = ["INTEGRATIONS_ENCRYPTION_KEY"];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.INTEGRATIONS_ENCRYPTION_KEY = key.toString("base64");
  });
  afterEach(() => {
    for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    service = null;
  });

  it("Mail.Read withdrawn, Mail.Send kept: the renewal for reading is refused, the sending-only one works; reading stops, sending works", async () => {
    const db = fakeDb({ [A]: company(A, "oid-a", "AT-A", { access_enc: null, expires: null }) });
    service = db;
    // Microsoft: a renewal asking for Mail.Read is refused (invalid_grant); one asking for sending only is granted (a Mail.Send token).
    const ms = fakeMicrosoft({ "AT-SEND": { status: 403, body: { error: { code: "ErrorAccessDenied", message: "AT-SEND boss@a.example" } } } },
      (form) => (form.get("scope")!.includes("Mail.Read")
        ? new Response(JSON.stringify({ error: "invalid_grant", error_description: "AADSTS65001 consent" }), { status: 400 })
        : new Response(JSON.stringify({ access_token: "AT-SEND", refresh_token: "RT-SEND", expires_in: 3600, scope: "Mail.Send User.Read" }), { status: 200 })),
      new Set(["AT-SEND"]));
    const { checkCompanyInbox } = await import("@/lib/integrations/microsoft/inbox");
    const reply = await checkCompanyInbox({ service: db.client, ready: msReady, org: A, fetchImpl: ms.fetchImpl });
    expect(reply).toEqual({ checked_at: expect.any(String), new: 0, status: "needs_reconnect", reason: "Couldn't check mail: Tolra isn't allowed to read this mailbox. Click Reconnect to allow reading mail." });
    expect(ms.seen.filter((x) => x.url.includes("/token")).map((x) => new URLSearchParams(x.body).get("scope"))).toEqual(["offline_access User.Read Mail.Send Mail.Read", "offline_access Mail.Send User.Read"]);
    expect(db.companies[A].status).toBe("connected"); // the connection is NOT needs_reconnect: sending is still allowed
    expect(db.companies[A].sync).toMatchObject({ mail_read: false, last_error: "consent" });
    expect(db.inbound.size).toBe(0);
    // Polling stops: the next check (after the interval) reads nothing, and neither does the cron pass.
    db.clock.now += 91_000;
    const graphReads = () => ms.seen.filter((x) => x.url.includes("/mailFolders/")).length;
    const reads = graphReads();
    expect(await checkCompanyInbox({ service: db.client, ready: msReady, org: A, fetchImpl: ms.fetchImpl })).toMatchObject({ status: "not_connected" });
    expect(await runMailboxPollPass({ service: db.client, ready: msReady, fetchImpl: ms.fetchImpl })).toMatchObject({ companies: 0 });
    expect(graphReads()).toBe(reads);
    // Sending: the company mailer gets the stored Mail.Send token and Graph accepts the e-mail.
    const { selectProvider } = await import("@/lib/email/send-company-email");
    const { microsoftProvider } = await import("@/lib/email/providers/microsoft");
    const provider = await selectProvider(A, { env: {}, providers: { microsoft: (t) => microsoftProvider(t, ms.fetchImpl) } });
    expect(provider && provider !== "refused" ? provider.name : provider).toBe("microsoft");
    expect(await (provider as { send: (e: typeof email) => Promise<{ outcome: string }> }).send(email)).toMatchObject({ outcome: "accepted" });
    // Its access token expires: the renewal now asks for sending only (reading is off), and is granted. Still connected.
    db.companies[A].expires = new Date(Date.now() - 60_000).toISOString();
    const { getDelegatedAccessToken } = await import("@/lib/integrations/microsoft/token-source");
    vi.stubGlobal("fetch", ms.fetchImpl);
    try {
      expect(await getDelegatedAccessToken(A)).toBe("AT-SEND");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(new URLSearchParams(ms.seen.filter((x) => x.url.includes("/token")).at(-1)!.body).get("scope")).toBe("offline_access Mail.Send User.Read");
    expect(db.companies[A].status).toBe("connected");
    expect(JSON.stringify(reply)).not.toMatch(/AT-SEND|boss@|AADSTS/);
  });

  it("the whole sign-in revoked (the one token covers both): reading stops AND Microsoft sending stops, and the mailer says so (draft, or its next provider)", async () => {
    const db = fakeDb({ [A]: company(A, "oid-a", "AT-A", { access_enc: null, expires: null }) });
    service = db;
    const ms = fakeMicrosoft({}, () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }), new Set(["AT-A"]));
    const { checkCompanyInbox } = await import("@/lib/integrations/microsoft/inbox");
    expect(await checkCompanyInbox({ service: db.client, ready: msReady, org: A, fetchImpl: ms.fetchImpl })).toMatchObject({ status: "needs_reconnect" });
    // Both renewals were tried (reading, then sending only), both refused: the connection needs reconnecting.
    expect(ms.seen.filter((x) => x.url.includes("/token"))).toHaveLength(2);
    expect(db.companies[A].status).toBe("needs_reconnect");
    const { getDelegatedAccessToken } = await import("@/lib/integrations/microsoft/token-source");
    expect(await getDelegatedAccessToken(A)).toBeNull(); // no Microsoft token for sending
    const { selectProvider } = await import("@/lib/email/send-company-email");
    // No other provider: null = the e-mail is saved as a draft for Approvals (mode "drafted"), never reported as sent.
    expect(await selectProvider(A, { env: {} })).toBeNull();
    // With Resend set up it goes through Resend instead (from EMAIL_FROM, not the company's mailbox).
    const resend = await selectProvider(A, { env: { RESEND_API_KEY: "re_test", EMAIL_FROM: "Tolra <noreply@example.test>" } });
    expect(resend && resend !== "refused" ? resend.name : resend).toBe("resend");
    expect(ms.seen.some((x) => x.url.endsWith("/me/sendMail"))).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------------
// The route behind the browser check and the Check inbox button: /api/mail/check (ChatGPT conditions 1, 2, 3, 7).
let service: ReturnType<typeof fakeDb> | null = null;
let who: { role: string; org: string; sessionOrg?: string; member?: boolean; aal?: "aal1" | "aal2" } = { role: "admin", org: A };
const userRpc: Array<{ fn: string; args: Record<string, unknown> }> = [];
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => service?.client ?? null }));
vi.mock("@/lib/integrations/app-credentials", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/app-credentials")>()),
  getAppCredentials: async () => ({ provider: "microsoft", clientId: "mid", clientSecret: "msecret", redirectUri: `${SITE}/api/integrations/microsoft/callback`, source: "env" }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [] }), headers: async () => new Headers() }));
vi.mock("@supabase/ssr", () => {
  const chain = (result: unknown) => {
    const c: unknown = new Proxy(() => undefined, { get: (_, prop) => (prop === "maybeSingle" || prop === "single" ? () => Promise.resolve({ data: result, error: null }) : () => c) });
    return c;
  };
  return {
    createServerClient: () => ({
      auth: {
        getUser: async () => ({ data: { user: { id: ADMIN } }, error: null }),
        mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: who.aal ?? "aal2" }, error: null }) },
      },
      from: (table: string) => (table === "user_profiles"
        ? chain({ id: ADMIN, email: "a@example.test", full_name: "A", role: who.role, secondary_role: null, organization_id: who.org, active: true, must_change_password: false })
        : chain(null)),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        userRpc.push({ fn, args });
        if (fn === "current_user_organization_id") return { data: who.sessionOrg ?? who.org, error: null };
        if (fn === "has_org_role") return { data: who.member !== false && (args.allowed_roles as string[]).includes(who.role), error: null };
        return { data: null, error: null };
      },
    }),
  };
});

describe("/api/mail/check: admin and office of the session's company only; one real check per company per 90 s; a summary only", () => {
  const ENV = ["MS_TENANT_ID", "MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_MAILBOX", "MS_ORGANIZATION_ID", "INTEGRATIONS_ENCRYPTION_KEY", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "REQUIRE_ADMIN_MFA"];
  const saved: Record<string, string | undefined> = {};
  let ms: ReturnType<typeof fakeMicrosoft>;
  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon", INTEGRATIONS_ENCRYPTION_KEY: key.toString("base64"),
      // The legacy app-only mailbox is configured for A too: this endpoint never uses it (that stays on /api/mail/poll).
      MS_TENANT_ID: "t", MS_CLIENT_ID: "c", MS_CLIENT_SECRET: "s", MS_MAILBOX: "legacy@a.example.test", MS_ORGANIZATION_ID: A });
    delete process.env.REQUIRE_ADMIN_MFA;
    who = { role: "office", org: A };
    userRpc.length = 0;
    ms = fakeMicrosoft({ "AT-A": { body: PAGE_A }, "AT-B": { body: PAGE_B } });
    vi.stubGlobal("fetch", ms.fetchImpl);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    for (const k of ENV) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    service = null;
  });
  const post = (body = "{}", headers: Record<string, string> = {}) => new Request("https://app.test/api/mail/check", { method: "POST", body, headers });
  const graphReads = () => ms.seen.filter((x) => x.url.includes("graph.microsoft.com/v1.0/me/mailFolders/")).length;
  const SECRETS = /AT-A|AT-B|RT-|oid-|skiptoken|Bearer|msecret|service|graph\.microsoft|login\.microsoftonline/;

  it("A's office user: the server reads A's mailbox with A's token and stores it for A; the browser gets { checked_at, new, status, reason } only", async () => {
    service = fakeDb({ [A]: company(A, "oid-a", "AT-A"), [B]: company(B, "oid-b", "AT-B") });
    const { POST } = await import("@/app/api/mail/check/route");
    const res = await POST(post());
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({ checked_at: expect.any(String), new: 2, status: "checked", reason: "Inbox checked: 2 new e-mails." });
    expect(Object.keys(body).sort()).toEqual(["checked_at", "new", "reason", "status"]);
    expect(JSON.stringify(body)).not.toMatch(SECRETS);
    expect(ms.seen.every((x) => x.url.startsWith("https://graph.microsoft.com/v1.0/me/") && x.auth === "Bearer AT-A" && x.method === "GET")).toBe(true);
    expect(ms.seen.some((x) => x.url.includes("login.microsoftonline.com") || x.url.includes("/users/"))).toBe(false); // no app-only token, no legacy mailbox
    expect(service.calls.filter((c) => c.fn === "mailbox_record_inbound").every((c) => c.args.p_org === A)).toBe(true);
    expect([...service.inbound.values()].every((r) => r.org === A)).toBe(true);
    expect(userRpc.some((c) => c.fn === "record_inbound_email")).toBe(false); // office can't call 031's admin function: the server stores it
    // 125's PO step ran on the server's client for A only, on A's two new messages; nothing of it reaches the browser (the shape above).
    const [poClient, poStored, poScope] = vi.mocked(suggestPoLinks).mock.calls.at(-1)!;
    expect(poClient).toBe(service.client);
    expect(poScope).toEqual({ org: A });
    expect(poStored.map((m) => m.inboundEmailId)).toEqual(["ie-1", "ie-2"]);
    expect(userRpc.some((c) => c.fn === "link_inbound_email")).toBe(false);
  });

  it("throttle: another check within 90 s (another tab, the admin, the button) reads nothing and answers recent; after 90 s it reads again, storing nothing twice", async () => {
    service = fakeDb({ [A]: company(A, "oid-a", "AT-A") });
    const { POST } = await import("@/app/api/mail/check/route");
    await POST(post());
    expect(graphReads()).toBe(1);
    service.clock.now += 30_000;
    who = { role: "admin", org: A };
    const recent = await (await POST(post())).json();
    expect(recent).toEqual({ checked_at: "2026-11-01T10:42:00Z", new: 0, status: "recent", reason: "The inbox was checked a moment ago. Tolra checks it again in a few minutes." });
    expect(graphReads()).toBe(1);
    service.clock.now += 61_000;
    expect(await (await POST(post())).json()).toMatchObject({ status: "checked", new: 0 });
    expect(graphReads()).toBe(2);
    expect(service.inbound.size).toBe(2);
  });

  it("two users at the same moment: one real poll between them", async () => {
    service = fakeDb({ [A]: company(A, "oid-a", "AT-A") });
    const { POST } = await import("@/app/api/mail/check/route");
    const replies = await Promise.all([POST(post()), POST(post()), POST(post())].map(async (r) => (await r).json()));
    expect(replies.map((r) => r.status).sort()).toEqual(["checked", "recent", "recent"]);
    expect(graphReads()).toBe(1);
    expect(service.calls.filter((c) => c.fn === "mailbox_sync_claim")).toHaveLength(3);
  });

  it("B's user reaches only B's mailbox; a company named in the request is ignored (the company is always the session's)", async () => {
    service = fakeDb({ [A]: company(A, "oid-a", "AT-A"), [B]: company(B, "oid-b", "AT-B") });
    who = { role: "office", org: B };
    const { POST } = await import("@/app/api/mail/check/route");
    expect(await (await POST(post(JSON.stringify({ organization_id: A, p_org: A })))).json()).toMatchObject({ status: "checked", new: 1 });
    expect(new Set(ms.seen.map((x) => x.auth))).toEqual(new Set(["Bearer AT-B"]));
    expect([...service.inbound.values()].map((r) => r.org)).toEqual([B]);
    expect(service.calls.some((c) => c.args.p_org === A)).toBe(false);
  });

  it.each(["workshop", "viewer"])("%s: 403 on POST and GET; no claim, no token, nothing read", async (role) => {
    service = fakeDb({ [A]: company(A, "oid-a", "AT-A") });
    who = { role, org: A };
    const { GET, POST } = await import("@/app/api/mail/check/route");
    expect((await POST(post())).status).toBe(403);
    expect((await GET()).status).toBe(403);
    expect(service.calls).toHaveLength(0);
    expect(ms.seen).toHaveLength(0);
  });

  it("an admin on aal1 where the app requires the second step (aal2): 403 mfa_required, nothing read; on aal2: allowed", async () => {
    service = fakeDb({ [A]: company(A, "oid-a", "AT-A") });
    process.env.REQUIRE_ADMIN_MFA = "true";
    who = { role: "admin", org: A, aal: "aal1" };
    const { POST } = await import("@/app/api/mail/check/route");
    const res = await POST(post());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "mfa_required" });
    expect(service.calls).toHaveLength(0);
    who = { role: "admin", org: A, aal: "aal2" };
    expect(await (await POST(post())).json()).toMatchObject({ status: "checked" });
  });

  it("another company's user is refused: a session for another company than the person's, or no active membership in it (403, nothing read)", async () => {
    service = fakeDb({ [A]: company(A, "oid-a", "AT-A"), [B]: company(B, "oid-b", "AT-B") });
    const { POST } = await import("@/app/api/mail/check/route");
    who = { role: "office", org: B, sessionOrg: A };
    expect((await POST(post())).status).toBe(403);
    who = { role: "office", org: A, member: false };
    expect((await POST(post())).status).toBe(403);
    expect(service.calls).toHaveLength(0);
    expect(ms.seen).toHaveLength(0);
  });

  it("a cross-site request is refused before anything else", async () => {
    service = fakeDb({ [A]: company(A, "oid-a", "AT-A") });
    const { POST } = await import("@/app/api/mail/check/route");
    expect((await POST(post("{}", { origin: "https://evil.example", host: "app.test" }))).status).toBe(403);
    expect(userRpc).toHaveLength(0);
    expect(service.calls).toHaveLength(0);
  });

  it("GET: available for a company whose inbox can be read; not for one without Mail.Read, or with no server set-up; reads nothing", async () => {
    service = fakeDb({ [A]: company(A, "oid-a", "AT-A"), [B]: company(B, "oid-b", "AT-B", {}, { mail_read: false }) });
    const { GET } = await import("@/app/api/mail/check/route");
    expect(await (await GET()).json()).toEqual({ available: true });
    who = { role: "admin", org: B };
    expect(await (await GET()).json()).toEqual({ available: false });
    service = null;
    expect(await (await GET()).json()).toEqual({ available: false });
    expect(ms.seen).toHaveLength(0);
  });

  it("not connected (no Mail.Read, or no service role on the server): not_connected in plain words, nothing read", async () => {
    service = fakeDb({ [A]: company(A, "oid-a", "AT-A", {}, { mail_read: false }) });
    const { POST } = await import("@/app/api/mail/check/route");
    expect(await (await POST(post())).json()).toEqual({ checked_at: null, new: 0, status: "not_connected", reason: "Tolra isn't reading this company's inbox. An admin can connect Microsoft 365 in Settings." });
    service = null;
    expect(await (await POST(post())).json()).toMatchObject({ status: "not_connected" });
    expect(ms.seen).toHaveLength(0);
  });

  it("a Graph failure answers with the plain reason only; a database failure is a 500 with the same small shape", async () => {
    service = fakeDb({ [A]: company(A, "oid-a", "AT-A") });
    ms = fakeMicrosoft({ "AT-A": { status: 429, body: { error: { message: "AT-A throttled boss@a.example" } } } });
    vi.stubGlobal("fetch", ms.fetchImpl);
    const { POST } = await import("@/app/api/mail/check/route");
    const body = await (await POST(post())).json();
    expect(body).toEqual({ checked_at: expect.any(String), new: 0, status: "failed", reason: "Couldn't check mail: Microsoft 365 is busy. Tolra will try again shortly." });
    expect(JSON.stringify(body)).not.toMatch(/AT-A|boss@/);
    const broken = { rpc: async (fn: string, args: Record<string, unknown>) => (fn === "mailbox_sync_claim" ? { data: null, error: { code: "57014", message: "canceling statement due to statement timeout: secret" } } : service!.client.rpc(fn, args)) };
    service = { ...service, client: broken as unknown as SupabaseClient };
    const res = await POST(post());
    expect(res.status).toBe(500);
    const failed = await res.json();
    expect(Object.keys(failed).sort()).toEqual(["checked_at", "new", "reason", "status"]);
    expect(JSON.stringify(failed)).not.toMatch(/secret|57014/);
  });
});

describe("PO capture (125) on the delegated check: suggest only, for that company only, never failing the check", () => {
  const poSpy = vi.mocked(suggestPoLinks);
  const SUMMARY = { status: "ok" as const, customerPo: true, checked: 1, suggested: 1, failed: 0 };
  beforeEach(() => poSpy.mockClear());

  it("the pass hands each company only the messages it stored for the first time, scoped to that company; counts in the summary", async () => {
    const db = fakeDb({ [A]: company(A, "oid-a", "AT-A"), [B]: company(B, "oid-b", "AT-B") });
    const ms = fakeMicrosoft({ "AT-A": { body: [msg("a-1", "2026-11-01T09:00:00Z", "PO 4471 for QUO-0012")] }, "AT-B": { body: PAGE_B } });
    poSpy.mockResolvedValueOnce(SUMMARY).mockResolvedValueOnce({ ...SUMMARY, status: "failed", suggested: 0 });
    const summary = await runMailboxPollPass({ service: db.client, ready: msReady, fetchImpl: ms.fetchImpl });
    expect(summary).toMatchObject({ checked: 2, inserted: 2, failed: 0, poSuggested: 1, poFailed: 1 });
    expect(poSpy).toHaveBeenCalledTimes(2);
    const byOrg = new Map(poSpy.mock.calls.map(([client, stored, scope]) => [scope!.org, { client, stored }]));
    expect([...byOrg.keys()].sort()).toEqual([A, B]);
    expect(byOrg.get(A)!.client).toBe(db.client);
    expect(byOrg.get(A)!.stored).toEqual([{ inboundEmailId: "ie-1", email: { fromAddress: "buyer@example.test", subject: "PO 4471 for QUO-0012", bodyText: expect.anything() } }]);
    expect(byOrg.get(B)!.stored.map((m) => m.email.subject)).toEqual(["B secret project"]);
  });

  it("a message read again (already stored) is not matched again, and the check stands", async () => {
    const db = fakeDb({ [A]: company(A, "oid-a", "AT-A") });
    const ms = fakeMicrosoft({ "AT-A": { body: PAGE_A } });
    await runMailboxPollPass({ service: db.client, ready: msReady, fetchImpl: ms.fetchImpl, minIntervalSeconds: 0 });
    poSpy.mockClear();
    const again = await runMailboxPollPass({ service: db.client, ready: msReady, fetchImpl: ms.fetchImpl, minIntervalSeconds: 0 });
    expect(again).toMatchObject({ checked: 1, inserted: 0, duplicates: 2, failed: 0, poSuggested: 0, poFailed: 0 });
    expect(poSpy.mock.calls.map(([, stored, scope]) => [stored.length, scope])).toEqual([[0, { org: A }]]);
    // The real step with this fake database (no PO tables): nothing to match, so skipped, and the check stands.
    expect(await poSpy.mock.results[0].value).toMatchObject({ status: "skipped", suggested: 0 });
  });

  it("the real step on the server's client: every read is the company's and the only write is 127's suggestion (no link_inbound_email)", async () => {
    const reads: Array<{ table: string; filters: Record<string, unknown> }> = [];
    const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const rows: Record<string, unknown[]> = {
      inbound_emails: [{ link_status: null }], quotes: [{ id: "q1", quote_ref: "QUO-0012", customer: "Acme Ltd", status: "sent", rfq_id: null, customer_po: null }],
      customers: [{ id: "c1", name: "Acme Ltd", email: "buyer@example.test" }], rfqs: [], purchase_orders: [], suppliers: [],
    };
    const client = {
      from: (table: string) => {
        const filters: Record<string, unknown> = {};
        const done = (data: unknown) => { reads.push({ table, filters }); return Promise.resolve({ data, error: null }); };
        const q: Record<string, unknown> = {
          select: () => q, in: () => q, neq: () => q, order: () => q,
          eq: (c: string, v: unknown) => { filters[c] = v; return q; },
          limit: () => done(rows[table]),
          range: (from: number) => done(from > 0 ? [] : rows[table]),
        };
        return q;
      },
      rpc: async (fn: string, args: Record<string, unknown>) => { rpcs.push({ fn, args }); return { data: { changed: true }, error: null }; },
    } as unknown as SupabaseClient;
    const { suggestForCompany } = await import("@/lib/integrations/microsoft/inbox");
    const out = await suggestForCompany(client, A, { read: 1, inserted: 1, duplicates: 0, more: false, error: null,
      stored: [{ inboundEmailId: "ie-1", message: toInboxMessage(msg("a-1", "2026-11-01T09:00:00Z", "PO 4471 for QUO-0012") as never) }] });
    expect(out).toMatchObject({ status: "ok", suggested: 1, failed: 0 });
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((r) => r.filters.organization_id === A)).toBe(true);
    expect(rpcs).toEqual([{ fn: "mailbox_suggest_email_link", args: { p_org: A, p_email: "ie-1", p_kind: "quote", p_target: "q1", p_po: "4471" } }]);
  });
});
