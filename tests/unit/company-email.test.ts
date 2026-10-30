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
  type CompanyEmailInput, HOURLY_COMPANY_LIMIT, UNKNOWN_OUTCOME_MESSAGE, checkInput, cleanAddress, onRecipientAllowlist, relatedType, selectProvider, sendCompanyEmail, stripHeader,
} from "@/lib/email/send-company-email";
import { getDelegatedAccessToken } from "@/lib/integrations/microsoft/token-source";

type Row = Record<string, unknown>;

/** email_history stand-in: insert/select id/single, update/eq/eq, and the hourly count. */
function historyDb(opts: { insertError?: { code: string } | null; count?: number } = {}) {
  const state = { inserted: [] as Row[], updates: [] as Array<{ patch: Row; filters: Array<[string, unknown]> }>, countFilters: [] as unknown[] };
  const db = {
    from: (table: string) => {
      if (table !== "email_history") throw new Error(`unexpected table ${table}`);
      return {
        select: (_cols: string, options?: { count?: string; head?: boolean }) => {
          const chain = {
            eq: (...a: unknown[]) => { state.countFilters.push(["eq", ...a]); return chain; },
            in: (...a: unknown[]) => { state.countFilters.push(["in", ...a]); return chain; },
            gte: (...a: unknown[]) => { state.countFilters.push(["gte", ...a]); return Promise.resolve({ count: options?.head ? opts.count ?? 0 : null, error: null }); },
          };
          return chain;
        },
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
    const p = await selectProvider("org-1", { env: RESEND_ENV, getToken: async () => "tok" });
    expect(p?.name).toBe("microsoft");
  });
  it("Resend only with both RESEND_API_KEY and EMAIL_FROM; otherwise none", async () => {
    expect((await selectProvider("org-1", { env: RESEND_ENV, getToken: noToken }))?.name).toBe("resend");
    expect(await selectProvider("org-1", { env: { RESEND_API_KEY: "re_test" }, getToken: noToken })).toBeNull();
    expect(await selectProvider("org-1", { env: { EMAIL_FROM: "a@b.test" }, getToken: noToken })).toBeNull();
    expect(await selectProvider("org-1", { env: {}, getToken: noToken })).toBeNull();
  });
  it("a token lookup that throws is no token (next provider)", async () => {
    expect((await selectProvider("org-1", { env: RESEND_ENV, getToken: async () => { throw new Error("db down"); } }))?.name).toBe("resend");
  });
  it("EMAIL_PROVIDER=mock off Vercel only; on any Vercel deployment it is ignored", async () => {
    expect((await selectProvider("org-1", { env: { EMAIL_PROVIDER: "mock" }, getToken: noToken }))?.name).toBe("mock");
    expect(await selectProvider("org-1", { env: { EMAIL_PROVIDER: "mock", VERCEL_ENV: "preview" }, getToken: noToken })).toBeNull();
    expect((await selectProvider("org-1", { env: { EMAIL_PROVIDER: "mock", VERCEL_ENV: "production", ...RESEND_ENV }, getToken: noToken }))?.name).toBe("resend");
  });
  it("the Microsoft token source is a stub (null) until the connect unit lands", async () => {
    expect(await getDelegatedAccessToken("org-1")).toBeNull();
  });
});

describe("drafted fallback and history", () => {
  it("no provider: one 'drafted' history row, nothing sent, mode drafted", async () => {
    const { db, state } = historyDb();
    const result = await sendCompanyEmail(base, { db, env: {}, getToken: async () => null });
    expect(result).toEqual({ ok: true, mode: "drafted", provider: "none", historyId: "h-1" });
    expect(state.inserted).toEqual([{ organization_id: "org-1", to_email: "customer@example.com", subject: "Invoice I-1", body: "Hello", status: "drafted", related_to_type: "invoice", related_to_id: "rec-1", drafted_by: "u-1" }]);
    expect(state.updates).toEqual([]);
  });
  it("no provider and the draft can't be saved: no_provider", async () => {
    const { db } = historyDb({ insertError: { code: "42501" } });
    expect(await sendCompanyEmail(base, { db, env: {}, getToken: async () => null })).toMatchObject({ ok: false, code: "no_provider" });
    expect(await sendCompanyEmail(base, { db: null, env: {}, getToken: async () => null })).toMatchObject({ ok: false, code: "no_provider" });
  });
  it("sent: 'sending' row first, then sent_via_system with sent_at, scoped by id and company", async () => {
    const { db, state } = historyDb();
    const { provider, sent } = fakeProvider();
    const result = await sendCompanyEmail({ ...base, idempotencyKey: "key-12345678" }, { db, env: RESEND_ENV, getToken: async () => null, providers: { resend: () => provider } });
    expect(result).toEqual({ ok: true, mode: "sent", provider: "resend", providerMessageId: "re_1", historyId: "h-1" });
    expect(state.inserted[0].status).toBe("sending");
    expect(state.updates[0].patch.status).toBe("sent_via_system");
    expect(typeof state.updates[0].patch.sent_at).toBe("string");
    expect(state.updates[0].filters).toEqual([["id", "h-1"], ["organization_id", "org-1"]]);
    expect(sent[0].idempotencyKey).toBe("company-email/org-1/key-12345678");
  });
  it("the history row can't be written: nothing is sent", async () => {
    const { db } = historyDb({ insertError: { code: "42501" } });
    const { provider } = fakeProvider();
    expect(await sendCompanyEmail(base, { db, env: RESEND_ENV, getToken: async () => null, providers: { resend: () => provider } })).toMatchObject({ ok: false, code: "provider_error" });
    expect(provider.send).not.toHaveBeenCalled();
  });
  it("refused -> failed; no trustworthy answer -> unknown (never retried); provider 429 -> rate_limited", async () => {
    for (const [result, status, code, error] of [
      [{ outcome: "failed" }, "failed", "provider_error", undefined],
      [{ outcome: "unknown" }, "unknown", "provider_error", UNKNOWN_OUTCOME_MESSAGE],
      [{ outcome: "failed", rateLimited: true }, "failed", "rate_limited", undefined],
    ] as const) {
      const { db, state } = historyDb();
      const { provider } = fakeProvider(result);
      const answer = await sendCompanyEmail(base, { db, env: RESEND_ENV, getToken: async () => null, providers: { resend: () => provider } });
      expect(answer).toMatchObject({ ok: false, code });
      if (error) expect(answer).toMatchObject({ error });
      expect(state.updates[0].patch).toEqual({ status });
      expect(provider.send).toHaveBeenCalledTimes(1);
    }
  });
  it("the company's hourly ceiling: refused before any row or send", async () => {
    const { db, state } = historyDb({ count: HOURLY_COMPANY_LIMIT });
    const { provider } = fakeProvider();
    expect(await sendCompanyEmail(base, { db, env: RESEND_ENV, getToken: async () => null, providers: { resend: () => provider } })).toMatchObject({ ok: false, code: "rate_limited" });
    expect(state.inserted).toEqual([]);
    expect(provider.send).not.toHaveBeenCalled();
    expect(state.countFilters).toContainEqual(["eq", "organization_id", "org-1"]);
  });
  it("the mock provider (tests only) keeps the e-mail and sends nothing", async () => {
    const { db } = historyDb();
    expect(await sendCompanyEmail(base, { db, env: { EMAIL_PROVIDER: "mock" }, getToken: async () => null })).toMatchObject({ ok: true, mode: "sent", provider: "mock" });
    expect(mockOutbox).toHaveLength(1);
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
    expect(checkInput({ ...base, attachments: [{ filename: "a.pdf", content: new Uint8Array(3 * 1024 * 1024 + 1), contentType: "application/pdf" }] }, {})).toMatchObject({ code: "invalid" });
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
