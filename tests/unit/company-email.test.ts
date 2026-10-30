/**
 * E8 one-click e-mail (lib/email/send-company-email.ts, lib/email/providers/*, app/api/email/send, components/email/send-email-button):
 *   - Provider per company: Microsoft 365 (a delegated token) -> Resend (RESEND_API_KEY + EMAIL_FROM) -> none (a draft for Approvals);
 *     EMAIL_PROVIDER=mock only off Vercel.
 *   - Every call writes email_history first; nothing is sent when that fails; the outcome is recorded (sent_via_system / failed /
 *     unknown, never retried); the hourly company ceiling.
 *   - The preview allowlist (EMAIL_RECIPIENT_DOMAINS), CR/LF stripped from the subject, addresses and file names.
 *   - Graph /me/sendMail and Resend calls and how their answers are classified.
 *   - The route: office and admin only, support refused before any read, the document must be the caller's company's, recipients
 *     only the document's party on file / the company's own people / the allowlist, a real PDF only, the session's own client.
 *   - The dialog's words for each answer.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/supabase-admin", () => ({ createSupabaseAdminClient: () => null }));

import { GRAPH_SEND_MAIL_URL, graphMessage, microsoftProvider } from "@/lib/email/providers/microsoft";
import { mockOutbox } from "@/lib/email/providers/mock";
import { resendProvider } from "@/lib/email/providers/resend";
import type { EmailProvider, OutgoingEmail, ProviderResult } from "@/lib/email/providers/types";
import {
  type CompanyEmailInput, MOCK_REFUSED_MESSAGE, UNKNOWN_OUTCOME_MESSAGE, checkInput, cleanAddress, ledgerKey, onRecipientAllowlist, relatedType, selectProvider,
  sendCompanyEmail, stripHeader, unfilledPlaceholders,
} from "@/lib/email/send-company-email";
import { getDelegatedAccessToken } from "@/lib/integrations/microsoft/token-source";

type Row = Record<string, unknown>;

/** email_history stand-in: insert/select id/single, update/eq/eq, and the hourly count. */
type Ledger = { id: string; key: string; history: string; status: string };
/**
 * email_history and 106's ledger stand-in. The ledger functions behave as reserve_company_email / complete_company_email do (a key seen
 * before is a replay unless it failed; complete only from 'sending'); `ledger: "missing"` answers as PostgREST does before 106.
 */
function historyDb(opts: { insertError?: { code: string } | null; ledger?: "missing"; reserveError?: { code: string } } = {}) {
  const state = { inserted: [] as Row[], updates: [] as Array<{ patch: Row; filters: Array<[string, unknown]> }>,
    ledger: [] as Ledger[], history: new Map<string, string>(), rpcs: [] as Array<{ fn: string; args: Row }> };
  const db = {
    rpc: async (fn: string, args: Row) => {
      state.rpcs.push({ fn, args });
      if (opts.ledger === "missing") return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${fn}` } };
      if (fn === "reserve_company_email") {
        if (opts.reserveError) return { data: null, error: opts.reserveError };
        const mode = String(args.p_mode);
        const prior = state.ledger.find((l) => l.key === args.p_key);
        if (prior && prior.status !== "failed") return { data: { send_id: prior.id, history_id: prior.history, status: prior.status, replay: true }, error: null };
        if (prior) { prior.status = mode; state.history.set(prior.history, mode); return { data: { send_id: prior.id, history_id: prior.history, status: mode, replay: false }, error: null }; }
        const history = `h-${state.history.size + 1}`;
        state.history.set(history, mode);
        const row = { id: `s-${state.ledger.length + 1}`, key: String(args.p_key), history, status: mode };
        state.ledger.push(row);
        return { data: { send_id: row.id, history_id: history, status: mode, replay: false }, error: null };
      }
      if (fn === "complete_company_email") {
        const row = state.ledger.find((l) => l.id === args.p_send && l.status === "sending");
        if (!row) return { data: null, error: { code: "P0002" } };
        row.status = String(args.p_outcome);
        state.history.set(row.history, row.status === "accepted" ? "sent_via_system" : row.status);
        return { data: null, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
    from: (table: string) => {
      if (table !== "email_history") throw new Error(`unexpected table ${table}`);
      return {
        insert: (row: Row) => {
          state.inserted.push(row);
          return { select: () => ({ single: async () => (opts.insertError ? { data: null, error: opts.insertError } : { data: { id: `h-${state.inserted.length}` }, error: null }) }) };
        },
        update: (patch: Row) => {
          const entry = { patch, filters: [] as Array<[string, unknown]> };
          state.updates.push(entry);
          const chain = { eq: (c: string, v: unknown) => { entry.filters.push([c, v]); return entry.filters.length >= 2 ? Promise.resolve({ error: null }) : chain; } };
          return chain;
        },
      };
    },
  };
  return { db: db as never, state };
}

function fakeProvider(result: Partial<ProviderResult> = {}) {
  const sent: OutgoingEmail[] = [];
  const provider: EmailProvider = { name: "resend", send: vi.fn(async (email: OutgoingEmail) => { sent.push(email); return { outcome: "accepted", detail: "ok", providerMessageId: "re_1", ...result } as ProviderResult; }) };
  return { provider, sent };
}

const base: CompanyEmailInput = { organizationId: "org-1", userId: "u-1", kind: "invoice", to: ["Customer@Example.com"], subject: "Invoice I-1", text: "Hello", recordId: "rec-1" };
const RESEND_ENV = { RESEND_API_KEY: "re_test", EMAIL_FROM: "Acme <billing@acme.test>" };

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => undefined); });
afterEach(() => { vi.restoreAllMocks(); mockOutbox.length = 0; });

describe("provider selection", () => {
  const noToken = async () => null;
  it("Microsoft when the company has a delegated token, before Resend", async () => {
    expect(await selectProvider("org-1", { env: RESEND_ENV, getToken: async () => "tok" })).toMatchObject({ name: "microsoft" });
  });
  it("Resend only with both RESEND_API_KEY and EMAIL_FROM; otherwise none", async () => {
    expect(await selectProvider("org-1", { env: RESEND_ENV, getToken: noToken })).toMatchObject({ name: "resend" });
    expect(await selectProvider("org-1", { env: { RESEND_API_KEY: "re_test" }, getToken: noToken })).toBeNull();
    expect(await selectProvider("org-1", { env: { EMAIL_FROM: "a@b.test" }, getToken: noToken })).toBeNull();
    expect(await selectProvider("org-1", { env: {}, getToken: noToken })).toBeNull();
  });
  it("a token lookup that throws is no token (next provider)", async () => {
    expect(await selectProvider("org-1", { env: RESEND_ENV, getToken: async () => { throw new Error("db down"); } })).toMatchObject({ name: "resend" });
  });
  it("EMAIL_PROVIDER=mock off Vercel only; on any Vercel deployment it is refused (never a silent fall-through to Resend)", async () => {
    expect(await selectProvider("org-1", { env: { EMAIL_PROVIDER: "mock" }, getToken: noToken })).toMatchObject({ name: "mock" });
    expect(await selectProvider("org-1", { env: { EMAIL_PROVIDER: "mock", VERCEL_ENV: "preview" }, getToken: noToken })).toBe("refused");
    expect(await selectProvider("org-1", { env: { EMAIL_PROVIDER: "mock", VERCEL_ENV: "production", ...RESEND_ENV }, getToken: noToken })).toBe("refused");
  });
  it("the Microsoft token source is a stub (null) until the connect unit lands", async () => {
    expect(await getDelegatedAccessToken("org-1")).toBeNull();
  });
});

describe("the send ledger (106): drafts, sends and retries", () => {
  const env = (extra: Record<string, string> = {}) => ({ ...RESEND_ENV, ...extra });
  const go = (db: never, provider: EmailProvider | null, input: CompanyEmailInput = base, extraEnv: Record<string, string> = {}) =>
    sendCompanyEmail(input, { db, env: provider ? env(extraEnv) : { ...extraEnv }, getToken: async () => null, providers: provider ? { resend: () => provider } : undefined });

  it("no provider: reserved as a draft (one history row), nothing sent", async () => {
    const { db, state } = historyDb();
    expect(await go(db, null)).toEqual({ ok: true, mode: "drafted", provider: "none", historyId: "h-1" });
    expect(state.rpcs).toHaveLength(1);
    expect(state.rpcs[0]).toMatchObject({ fn: "reserve_company_email", args: { p_org: "org-1", p_user: "u-1", p_to: "customer@example.com", p_subject: "Invoice I-1", p_body: "Hello", p_related_type: "invoice", p_related_id: "rec-1", p_mode: "drafted" } });
    expect(String(state.rpcs[0].args.p_key)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sent: reserved 'sending', then completed 'accepted'; the Resend key is the ledger key", async () => {
    const { db, state } = historyDb();
    const { provider, sent } = fakeProvider();
    expect(await go(db, provider, { ...base, idempotencyKey: "invoice:rec-1:send-1" })).toEqual({ ok: true, mode: "sent", provider: "resend", providerMessageId: "re_1", historyId: "h-1" });
    expect(state.rpcs.map((r) => r.fn)).toEqual(["reserve_company_email", "complete_company_email"]);
    expect(state.rpcs[1].args).toEqual({ p_org: "org-1", p_user: "u-1", p_send: "s-1", p_outcome: "accepted" });
    expect(state.history.get("h-1")).toBe("sent_via_system");
    expect(sent[0].idempotencyKey).toBe(`company-email/${state.rpcs[0].args.p_key}`);
  });

  it("a retry with the same key never sends twice or writes a second row, whatever the provider", async () => {
    for (const name of ["resend", "microsoft"] as const) {
      const { db, state } = historyDb();
      const { provider } = fakeProvider();
      provider.name = name;
      const input = { ...base, idempotencyKey: "invoice:rec-1:send-1" };
      expect(await go(db, provider, input)).toMatchObject({ ok: true, mode: "sent" });
      expect(await go(db, provider, input)).toMatchObject({ ok: true, mode: "sent", historyId: "h-1" });
      expect(provider.send).toHaveBeenCalledTimes(1);
      expect(state.history.size).toBe(1);
    }
  });

  it("a retried draft is the same draft; a send still under way or unknown is never sent again", async () => {
    const draft = historyDb();
    const input = { ...base, idempotencyKey: "invoice:rec-1:send-2" };
    await go(draft.db, null, input);
    expect(await go(draft.db, null, input)).toEqual({ ok: true, mode: "drafted", provider: "none", historyId: "h-1" });
    expect(draft.state.history.size).toBe(1);
    for (const outcome of ["unknown", "hang"] as const) {
      const { db, state } = historyDb();
      const { provider } = fakeProvider({ outcome: outcome === "hang" ? "accepted" : "unknown" });
      if (outcome === "hang") state.ledger.push({ id: "s-9", key: ledgerKey(input), history: "h-9", status: "sending" });
      else await go(db, provider, input);
      const again = await go(db, provider, input);
      expect(again).toMatchObject({ ok: false, code: "provider_error" });
      expect(provider.send).toHaveBeenCalledTimes(outcome === "hang" ? 0 : 1);
    }
  });

  it("a definite refusal may be tried again with the same key (same history row)", async () => {
    const { db, state } = historyDb();
    const refused = fakeProvider({ outcome: "failed" });
    const input = { ...base, idempotencyKey: "invoice:rec-1:send-3" };
    expect(await go(db, refused.provider, input)).toMatchObject({ ok: false, code: "provider_error" });
    expect(state.history.get("h-1")).toBe("failed");
    const ok = fakeProvider();
    expect(await go(db, ok.provider, input)).toMatchObject({ ok: true, mode: "sent", historyId: "h-1" });
    expect(state.history.size).toBe(1);
  });

  it("refused -> failed; no trustworthy answer -> unknown; provider 429 -> rate_limited; Graph's 3 MB -> its own message", async () => {
    for (const [result, ledger, code, error] of [
      [{ outcome: "failed" }, "failed", "provider_error", undefined],
      [{ outcome: "unknown" }, "unknown", "provider_error", UNKNOWN_OUTCOME_MESSAGE],
      [{ outcome: "failed", rateLimited: true }, "failed", "rate_limited", undefined],
      [{ outcome: "failed", detail: "attachment_too_large" }, "failed", "invalid", "The PDF is too large for your Microsoft 365 mailbox (3 MB at most). Use Open in my mail app instead."],
    ] as const) {
      const { db, state } = historyDb();
      const { provider } = fakeProvider(result);
      const answer = await go(db, provider);
      expect(answer).toMatchObject({ ok: false, code });
      if (error) expect(answer).toMatchObject({ error });
      expect(state.ledger[0].status).toBe(ledger);
    }
  });

  it("the ledger refuses: the hourly ceiling (PT429), not allowed (42501), anything else: nothing is sent", async () => {
    for (const [reserveError, code] of [[{ code: "PT429" }, "rate_limited"], [{ code: "42501" }, "invalid"], [{ code: "XX000" }, "provider_error"]] as const) {
      const { db } = historyDb({ reserveError });
      const { provider } = fakeProvider();
      expect(await go(db, provider)).toMatchObject({ ok: false, code });
      expect(provider.send).not.toHaveBeenCalled();
    }
    const { db } = historyDb({ reserveError: { code: "XX000" } });
    expect(await go(db, null)).toMatchObject({ ok: false, code: "no_provider" });
  });

  it("the ledger key: same company, kind, document and caller key give the same key; anything else (or no key) a new one", () => {
    const input = { ...base, idempotencyKey: "invoice-reminder:inv-1:2026-W45" };
    expect(ledgerKey(input)).toBe(ledgerKey({ ...input }));
    expect(ledgerKey(input)).not.toBe(ledgerKey({ ...input, recordId: "rec-2" }));
    expect(ledgerKey(input)).not.toBe(ledgerKey({ ...input, organizationId: "org-2" }));
    expect(ledgerKey(input)).not.toBe(ledgerKey({ ...input, kind: "invoice_reminder" }));
    expect(ledgerKey(base)).not.toBe(ledgerKey(base));
    expect(checkInput(input, {})).toHaveProperty("email");
    expect(checkInput({ ...base, idempotencyKey: "bad key with spaces" }, {})).toMatchObject({ code: "invalid" });
    expect(checkInput({ ...base, idempotencyKey: "short" }, {})).toMatchObject({ code: "invalid" });
  });

  it("before 106 is applied: written straight to email_history (sent or drafted), as before", async () => {
    const { db, state } = historyDb({ ledger: "missing" });
    const { provider } = fakeProvider();
    expect(await go(db, provider)).toEqual({ ok: true, mode: "sent", provider: "resend", providerMessageId: "re_1", historyId: "h-1" });
    expect(state.inserted[0]).toMatchObject({ status: "sending", organization_id: "org-1", drafted_by: "u-1" });
    expect(state.updates[0].patch.status).toBe("sent_via_system");
    expect(state.updates[0].filters).toEqual([["id", "h-1"], ["organization_id", "org-1"]]);
    const drafted = historyDb({ ledger: "missing" });
    expect(await go(drafted.db, null)).toMatchObject({ ok: true, mode: "drafted" });
    expect(drafted.state.inserted[0].status).toBe("drafted");
    const broken = historyDb({ ledger: "missing", insertError: { code: "42501" } });
    const p2 = fakeProvider();
    expect(await go(broken.db, p2.provider)).toMatchObject({ ok: false, code: "provider_error" });
    expect(p2.provider.send).not.toHaveBeenCalled();
  });

  it("no database client: nothing sent", async () => {
    expect(await sendCompanyEmail(base, { db: null, env: {}, getToken: async () => null })).toMatchObject({ ok: false, code: "no_provider" });
  });

  it("EMAIL_PROVIDER=mock: tests only, keeps the e-mail; on any Vercel deployment the send fails with a fixed error", async () => {
    const { db } = historyDb();
    expect(await sendCompanyEmail(base, { db, env: { EMAIL_PROVIDER: "mock" }, getToken: async () => null })).toMatchObject({ ok: true, mode: "sent", provider: "mock" });
    expect(mockOutbox).toHaveLength(1);
    for (const VERCEL_ENV of ["preview", "production"]) {
      const fresh = historyDb();
      expect(await sendCompanyEmail(base, { db: fresh.db, env: { EMAIL_PROVIDER: "mock", VERCEL_ENV, ...RESEND_ENV, EMAIL_RECIPIENT_DOMAINS: "example.com" }, getToken: async () => null }))
        .toEqual({ ok: false, error: MOCK_REFUSED_MESSAGE, code: "no_provider" });
      expect(fresh.state.rpcs).toEqual([]);
    }
  });

  it("an unfilled known placeholder (e.g. {{greeting}}) never reaches anyone; the person's own {{text}} passes", async () => {
    const { db, state } = historyDb();
    expect(await go(db, null, { ...base, text: "{{greeting}},\n\nInvoice I-1 is overdue." })).toMatchObject({ ok: false, code: "invalid" });
    expect(await go(db, null, { ...base, subject: "Invoice {{ document_number }}" })).toMatchObject({ ok: false, code: "invalid" });
    expect(state.rpcs).toEqual([]);
    expect(unfilledPlaceholders("{{greeting}} {{payment_note}} {{my_own}}")).toEqual(["greeting", "payment_note"]);
    expect(await go(db, null, { ...base, text: "Use the code {{my_own}}" })).toMatchObject({ ok: true });
  });

  it("related_to_type fits email_history's check", () => {
    expect(relatedType("invoice_reminder")).toBe("invoice");
    expect(relatedType("timesheet")).toBe("general");
    expect(relatedType("alert", "nonsense")).toBe("general");
    expect(relatedType("test", "delivery_note")).toBe("delivery_note");
  });
});

describe("allowlist on previews", () => {
  const preview = (list?: string) => ({ VERCEL_ENV: "preview", EMAIL_RECIPIENT_DOMAINS: list });
  it("a preview sends only to allowlisted domains or addresses (an empty list refuses everyone)", () => {
    expect(checkInput(base, preview("example.com"))).toHaveProperty("email");
    expect(checkInput(base, preview("other.test, customer@example.com"))).toHaveProperty("email");
    expect(checkInput(base, preview("other.test"))).toMatchObject({ code: "recipient_refused" });
    expect(checkInput(base, preview(""))).toMatchObject({ code: "recipient_refused" });
    expect(checkInput(base, preview(undefined))).toMatchObject({ code: "recipient_refused" });
    expect(checkInput({ ...base, cc: ["boss@elsewhere.test"] }, preview("example.com"))).toMatchObject({ code: "recipient_refused" });
  });
  it("production and local runs are not restricted by the list (the route decides who may be written to)", () => {
    expect(checkInput(base, { VERCEL_ENV: "production", EMAIL_RECIPIENT_DOMAINS: "other.test" })).toHaveProperty("email");
    expect(checkInput(base, {})).toHaveProperty("email");
  });
  it("domains, @domains and single addresses, case-insensitive", () => {
    expect(onRecipientAllowlist("a@example.com", "@example.com")).toBe(true);
    expect(onRecipientAllowlist("a@sub.example.com", "example.com")).toBe(false);
    expect(onRecipientAllowlist("a@example.com", " A@EXAMPLE.COM ")).toBe(true);
  });
  it("a refused preview send writes nothing and sends nothing", async () => {
    const { db, state } = historyDb();
    const { provider } = fakeProvider();
    expect(await sendCompanyEmail(base, { db, env: { ...RESEND_ENV, ...preview("other.test") }, getToken: async () => null, providers: { resend: () => provider } })).toMatchObject({ ok: false, code: "recipient_refused" });
    expect(state.rpcs).toEqual([]);
    expect(state.inserted).toEqual([]);
    expect(provider.send).not.toHaveBeenCalled();
  });
});

describe("header stripping and input checks", () => {
  it("the subject is one line; a CR/LF in an address makes it invalid; file names lose CR/LF, quotes and slashes", () => {
    const out = checkInput({ ...base, subject: "Invoice\r\nBcc: evil@x.test", attachments: [{ filename: "a\r\n\"b/c\\.pdf", content: new Uint8Array([1]), contentType: "application/pdf\r\nX: y" }] }, {});
    if (!("email" in out)) throw new Error("expected ok");
    expect(out.email.subject).toBe("Invoice Bcc: evil@x.test");
    expect(out.email.attachments[0].filename).toBe("a _b_c_.pdf");
    expect(out.email.attachments[0].contentType).toBe("application/octet-stream");
    expect(cleanAddress("a@example.com\r\nBcc: evil@x.test")).toBeNull();
    expect(cleanAddress(" A@Example.COM ")).toBe("a@example.com");
    expect(cleanAddress("Name <a@example.com>")).toBeNull();
    expect(stripHeader("a b\0c")).toBe("a b c");
    expect(checkInput({ ...base, to: ["ok@example.com", "x@y\nz.test"] }, {})).toMatchObject({ code: "invalid" });
  });
  it("refuses empty recipients, subject or text, too many recipients, large attachments; de-duplicates", () => {
    expect(checkInput({ ...base, to: [] }, {})).toMatchObject({ code: "invalid" });
    expect(checkInput({ ...base, subject: "\r\n" }, {})).toMatchObject({ code: "invalid" });
    expect(checkInput({ ...base, text: "  " }, {})).toMatchObject({ code: "invalid" });
    expect(checkInput({ ...base, to: Array.from({ length: 11 }, (_, i) => `p${i}@example.com`) }, {})).toMatchObject({ code: "invalid" });
    expect(checkInput({ ...base, attachments: [{ filename: "a.pdf", content: new Uint8Array(5 * 1024 * 1024 + 1), contentType: "application/pdf" }] }, {})).toMatchObject({ code: "invalid" });
    const out = checkInput({ ...base, to: ["a@example.com", "A@example.com"], cc: ["a@example.com", "b@example.com"] }, {});
    expect(out).toMatchObject({ email: { to: ["a@example.com"], cc: ["b@example.com"] } });
  });
});

describe("providers", () => {
  const email: OutgoingEmail = { to: ["a@example.com"], cc: ["b@example.com"], subject: "S", text: "T", attachments: [{ filename: "x.pdf", content: Buffer.from("%PDF-1"), contentType: "application/pdf" }] };
  it("Microsoft: POST /me/sendMail with the bearer token; 202 accepted, 429 rate limited, 400 refused, 500 or a network error unknown", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const respond = (status: number) => vi.fn(async (url: string, init: RequestInit) => { calls.push([url, init]); return new Response(null, { status }); });
    expect(await microsoftProvider("tok", respond(202) as never).send(email)).toMatchObject({ outcome: "accepted" });
    expect(calls[0][0]).toBe(GRAPH_SEND_MAIL_URL);
    expect((calls[0][1].headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(String(calls[0][1].body))).toEqual(graphMessage(email));
    expect(graphMessage(email).message.attachments?.[0]).toEqual({ "@odata.type": "#microsoft.graph.fileAttachment", name: "x.pdf", contentType: "application/pdf", contentBytes: Buffer.from("%PDF-1").toString("base64") });
    expect(await microsoftProvider("tok", respond(429) as never).send(email)).toMatchObject({ outcome: "failed", rateLimited: true });
    expect(await microsoftProvider("tok", respond(400) as never).send(email)).toMatchObject({ outcome: "failed" });
    expect(await microsoftProvider("tok", respond(409) as never).send(email)).toMatchObject({ outcome: "unknown" });
    expect(await microsoftProvider("tok", respond(500) as never).send(email)).toMatchObject({ outcome: "unknown" });
    expect(await microsoftProvider("tok", (async () => { throw new TypeError("fetch failed"); }) as never).send(email)).toMatchObject({ outcome: "unknown" });
    // Over Graph's 3 MB inline limit: refused before any request.
    const never = vi.fn();
    const big = { ...email, attachments: [{ filename: "x.pdf", content: Buffer.alloc(3 * 1024 * 1024 + 1), contentType: "application/pdf" }] };
    expect(await microsoftProvider("tok", never as never).send(big)).toEqual({ outcome: "failed", detail: "attachment_too_large" });
    expect(never).not.toHaveBeenCalled();
  });
  it("Resend: from, to, cc, attachments and the idempotency key; its 429 is rate limited", async () => {
    const send = vi.fn(async () => ({ data: { id: "re_9" }, error: null }));
    expect(await resendProvider("k", "Acme <a@acme.test>", { emails: { send } } as never).send({ ...email, idempotencyKey: "company-email/o/k" })).toMatchObject({ outcome: "accepted", providerMessageId: "re_9" });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ from: "Acme <a@acme.test>", to: ["a@example.com"], cc: ["b@example.com"], subject: "S", text: "T", attachments: [expect.objectContaining({ filename: "x.pdf" })] }), { idempotencyKey: "company-email/o/k" });
    const limited = vi.fn(async () => ({ data: null, error: { name: "rate_limit_exceeded", statusCode: 429, message: "slow down" } }));
    expect(await resendProvider("k", "a@acme.test", { emails: { send: limited } } as never).send(email)).toMatchObject({ outcome: "failed", rateLimited: true });
  });
});

describe("the send dialog's words", async () => {
  const { OUTCOME_TEXT, SendEmailForm, sendOutcomeFrom, splitAddresses } = await import("@/components/email/send-email-button");
  it("Sent / Saved as draft for Approvals / the error", () => {
    expect(sendOutcomeFrom(200, { status: "sent" })).toEqual({ kind: "sent" });
    expect(sendOutcomeFrom(200, { status: "drafted" })).toEqual({ kind: "drafted" });
    expect(sendOutcomeFrom(403, { error: "This can only be sent to the customer's e-mail address on file." })).toEqual({ kind: "error", message: "This can only be sent to the customer's e-mail address on file." });
    expect(sendOutcomeFrom(403, { error: "Forbidden" })).toEqual({ kind: "error", message: "You can't send this e-mail." });
    expect(sendOutcomeFrom(500, {})).toEqual({ kind: "error", message: "Couldn't send the e-mail. Try again." });
    expect(OUTCOME_TEXT).toEqual({ sent: "Sent", drafted: "Saved as draft for Approvals" });
    expect(splitAddresses(" a@x.test, b@y.test;c@z.test ")).toEqual(["a@x.test", "b@y.test", "c@z.test"]);
  });
  it("renders the outcome and the mail-app link", () => {
    const noop = () => undefined;
    const props = { to: "a@x.test", subject: "S", body: "B", attach: true, canAttach: true, pdfName: "q.pdf", sending: false, onTo: noop, onSubject: noop, onBody: noop, onAttach: noop, onSend: noop, onClose: noop, mailto: "mailto:a%40x.test?subject=S&body=B" };
    const drafted = renderToStaticMarkup(createElement(SendEmailForm, { ...props, outcome: { kind: "drafted" } }));
    expect(drafted).toContain("Saved as draft for Approvals");
    expect(drafted).toContain(">Close<");
    const fresh = renderToStaticMarkup(createElement(SendEmailForm, { ...props, outcome: null }));
    expect(fresh).toContain("Attach q.pdf");
    expect(fresh).toContain('href="mailto:a%40x.test?subject=S&amp;body=B"');
    expect(fresh).toContain("Open in my mail app");
    expect(renderToStaticMarkup(createElement(SendEmailForm, { ...props, outcome: { kind: "error", message: "Nope" } }))).toContain('role="alert"');
  });
});
