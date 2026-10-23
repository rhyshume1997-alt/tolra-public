/** Microsoft 365 mail client (lib/m365/graph.ts) with fetch mocked: token caching, endpoints, paging, read-only mailbox access, outcomes, safe errors. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { forwardMessage, GraphError, listInboxSince, mailConfig, replyRecipients, replyToMessage, resetTokenCache, sendMail, type MailConfig } from "@/lib/m365/graph";

const ORG = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
const config: MailConfig = { tenantId: "tenant-1", clientId: "client-1", clientSecret: "s3cret-value", mailbox: "mail@fixture-tolra.onmicrosoft.com", organizationId: ORG, pageSize: 50 };
const BASE = "https://graph.microsoft.com/v1.0/users/mail%40fixture-tolra.onmicrosoft.com";

type Call = { url: string; method: string; headers: Record<string, string>; body: string | undefined };
let calls: Call[];
let graphResponse: (call: Call) => Response | Promise<Response>;
let tokenResponse: () => Response;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  calls = [];
  resetTokenCache();
  tokenResponse = () => json({ access_token: "tok-1", expires_in: 3600 });
  graphResponse = () => new Response(null, { status: 202 });
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? String(init.body) : undefined };
    calls.push(call);
    return call.url.startsWith("https://login.microsoftonline.com/") ? tokenResponse() : graphResponse(call);
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const graphCalls = () => calls.filter((c) => c.url.startsWith("https://graph.microsoft.com/"));
const message = (id: string, receivedDateTime = "2026-01-02T10:00:00Z") => ({ id, receivedDateTime, subject: `S ${id}`, from: { emailAddress: { address: "b@example.com", name: "B" } } });

describe("configuration", () => {
  const env = { MS_TENANT_ID: "t", MS_CLIENT_ID: "c", MS_CLIENT_SECRET: "s", MS_MAILBOX: "Mail@Fixture-Tolra.onmicrosoft.com", MS_ORGANIZATION_ID: ORG.toUpperCase() };

  it("is off (null) unless all five values are set and the organisation is a uuid", () => {
    expect(mailConfig({})).toBeNull();
    for (const key of Object.keys(env)) expect(mailConfig({ ...env, [key]: "" })).toBeNull();
    expect(mailConfig({ ...env, MS_ORGANIZATION_ID: "jnr" })).toBeNull();
    expect(mailConfig(env)).toEqual({ tenantId: "t", clientId: "c", clientSecret: "s", mailbox: "mail@fixture-tolra.onmicrosoft.com", organizationId: ORG, pageSize: 50 });
  });

  it("page size defaults to 50, is at least 1 and at most 100", () => {
    expect(mailConfig({ ...env, MS_PAGE_SIZE: "2" })?.pageSize).toBe(2);
    expect(mailConfig({ ...env, MS_PAGE_SIZE: "0" })?.pageSize).toBe(50);
    expect(mailConfig({ ...env, MS_PAGE_SIZE: "-5" })?.pageSize).toBe(1);
    expect(mailConfig({ ...env, MS_PAGE_SIZE: "5000" })?.pageSize).toBe(100);
    expect(mailConfig({ ...env, MS_PAGE_SIZE: "abc" })?.pageSize).toBe(50);
  });

  it("refuses a mailbox on a denied domain, whatever the case or an @ prefix", () => {
    const denied = (list: string) => () => mailConfig({ ...env, MS_MAILBOX: "boss@jnr.example", MS_MAILBOX_DENY_DOMAINS: list });
    expect(denied("other.example, JNR.example")).toThrow(/not allowed/);
    expect(denied("@jnr.example")).toThrow(GraphError);
    expect(denied("other.example")).not.toThrow();
  });
});

describe("token", () => {
  it("uses client credentials against the tenant's token endpoint", async () => {
    await listInboxSince("2026-01-01T00:00:00Z", 10, config);
    const token = calls[0];
    expect(token.url).toBe("https://login.microsoftonline.com/tenant-1/oauth2/v2.0/token");
    expect(token.method).toBe("POST");
    const form = new URLSearchParams(token.body);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("https://graph.microsoft.com/.default");
    expect(form.get("client_id")).toBe("client-1");
    expect(graphCalls()[0].headers.authorization).toBe("Bearer tok-1");
  });

  it("is reused until 60 seconds before it expires, then fetched again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const tokenCalls = () => calls.filter((c) => c.url.includes("login.microsoftonline.com")).length;
    await replyToMessage("m1", "hi", config);
    await replyToMessage("m1", "hi", config);
    expect(tokenCalls()).toBe(1);
    vi.setSystemTime(new Date("2026-01-01T00:58:30Z")); // 3510 s in: still more than 60 s left
    await replyToMessage("m1", "hi", config);
    expect(tokenCalls()).toBe(1);
    vi.setSystemTime(new Date("2026-01-01T00:59:10Z")); // 3550 s in: under 60 s left
    await replyToMessage("m1", "hi", config);
    expect(tokenCalls()).toBe(2);
  });
});

describe("endpoints", () => {
  it("lists the inbox with GET, oldest first, immutable ids, nothing else", async () => {
    graphResponse = () => json({ value: [{ id: "AAA", internetMessageId: "<x@y>", subject: "RFQ", from: { emailAddress: { address: "Buyer@Example.com", name: "Buyer" } }, receivedDateTime: "2026-01-02T10:00:00Z", bodyPreview: "p", body: { content: "text" }, isRead: false, parentFolderId: "inbox-id", hasAttachments: true }] });
    const { messages, more } = await listInboxSince("2026-01-01T09:30:00.000Z", 5, config);
    const [call] = graphCalls();
    expect(call.method).toBe("GET");
    expect(call.body).toBeUndefined();
    expect(call.headers.Prefer).toBe('IdType="ImmutableId", outlook.body-content-type="text"');
    const url = new URL(call.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${BASE}/mailFolders/inbox/messages`);
    expect(url.searchParams.get("$filter")).toBe("receivedDateTime ge 2026-01-01T09:30:00.000Z");
    expect(url.searchParams.get("$orderby")).toBe("receivedDateTime asc");
    expect(url.searchParams.get("$select")).toBe("id,internetMessageId,subject,from,receivedDateTime,bodyPreview,body,isRead,parentFolderId,hasAttachments");
    expect(url.searchParams.get("$top")).toBe("5");
    expect(more).toBe(false);
    expect(messages).toEqual([{ id: "AAA", internetMessageId: "<x@y>", subject: "RFQ", from: "buyer@example.com", fromName: "Buyer", receivedAt: "2026-01-02T10:00:00Z", bodyPreview: "p", bodyText: "text", isRead: false, parentFolderId: "inbox-id", hasAttachments: true }]);
  });

  it("rejects a malformed since date instead of putting it in the query", async () => {
    await expect(listInboxSince("x' or true", 5, config)).rejects.toMatchObject({ code: "invalid_since" });
    expect(graphCalls()).toHaveLength(0);
  });

  it("sendMail posts a plain text message and keeps it in Sent Items", async () => {
    await sendMail({ to: "a@example.com", subject: "S", body: "B" }, config);
    const [call] = graphCalls();
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${BASE}/sendMail`);
    expect(JSON.parse(call.body!)).toEqual({ message: { subject: "S", body: { contentType: "Text", content: "B" }, toRecipients: [{ emailAddress: { address: "a@example.com" } }] }, saveToSentItems: true });
  });

  it("replies with the one-call reply endpoint", async () => {
    await replyToMessage("AAA=", "thanks", config);
    const [call] = graphCalls();
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${BASE}/messages/AAA%3D/reply`);
    expect(JSON.parse(call.body!)).toEqual({ comment: "thanks" });
  });

  it("forwards with the one-call forward endpoint", async () => {
    await forwardMessage("AAA", "b@example.com", "fyi", config);
    const [call] = graphCalls();
    expect(call.method).toBe("POST");
    expect(call.url).toBe(`${BASE}/messages/AAA/forward`);
    expect(JSON.parse(call.body!)).toEqual({ comment: "fyi", toRecipients: [{ emailAddress: { address: "b@example.com" } }] });
  });

  it("never changes, moves or deletes mail, and never creates drafts (createReply / createForward need Mail.ReadWrite)", async () => {
    graphResponse = (call) => (call.method === "GET" ? json(call.url.includes("/inbox/") ? { value: [] } : { from: { emailAddress: { address: "b@example.com" } } }) : new Response(null, { status: 202 }));
    await listInboxSince("2026-01-01T00:00:00Z", 5, config);
    await replyRecipients("m", config);
    await sendMail({ to: "a@example.com", subject: "S", body: "B" }, config);
    await replyToMessage("m", "c", config);
    await forwardMessage("m", "b@example.com", "c", config);
    expect(graphCalls()).toHaveLength(5);
    for (const call of graphCalls()) {
      expect(["GET", "POST"]).toContain(call.method);
      expect(call.url).not.toMatch(/createReply|createForward|createReplyAll|\/move|\/copy|\/attachments/i);
      expect(new URL(call.url).pathname).toMatch(/\/(sendMail|reply|forward|messages|messages\/[^/]+)$/);
    }
    expect(graphCalls().filter((c) => c.method === "GET")).toHaveLength(2);
  });

  it("does nothing when mail isn't configured", async () => {
    await expect(sendMail({ to: "a@example.com", subject: "S", body: "B" }, null)).rejects.toMatchObject({ code: "not_configured", status: 503 });
    expect(calls).toHaveLength(0);
  });
});

describe("paging", () => {
  it("follows nextLink pages in order", async () => {
    const next = `${BASE}/mailFolders/inbox/messages?$skiptoken=abc`;
    graphResponse = (call) => (call.url === next ? json({ value: [message("c")] }) : json({ value: [message("a"), message("b")], "@odata.nextLink": next }));
    const { messages, more } = await listInboxSince("2026-01-01T00:00:00Z", 2, config);
    expect(messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(more).toBe(false);
    expect(graphCalls()).toHaveLength(2);
    expect(graphCalls()[1].method).toBe("GET");
    expect(graphCalls()[1].headers.Prefer).toContain("ImmutableId");
  });

  it("returns a batch of messages with the same time that is bigger than one page, all of it", async () => {
    const sameTime = (ids: string[]) => ids.map((id) => message(id, "2026-01-02T10:00:00Z"));
    graphResponse = (call) => {
      if (call.url.endsWith("page3")) return json({ value: sameTime(["g"]) });
      if (call.url.endsWith("page2")) return json({ value: sameTime(["d", "e", "f"]), "@odata.nextLink": `${BASE}/mailFolders/inbox/messages?page3` });
      return json({ value: sameTime(["a", "b", "c"]), "@odata.nextLink": `${BASE}/mailFolders/inbox/messages?page2` });
    };
    const { messages } = await listInboxSince("2026-01-02T10:00:00Z", 3, config);
    expect(messages.map((m) => m.id)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });

  it("stops at the page limit and says there is more", async () => {
    graphResponse = (call) => json({ value: [message(`m${graphCalls().indexOf(call)}`)], "@odata.nextLink": `${BASE}/mailFolders/inbox/messages?next=${graphCalls().length}` });
    const { messages, more } = await listInboxSince("2026-01-01T00:00:00Z", 1, config, 3);
    expect(messages).toHaveLength(3);
    expect(more).toBe(true);
    expect(graphCalls()).toHaveLength(3);
  });

  it("refuses a paging link that doesn't point at Microsoft Graph, without calling it", async () => {
    for (const link of ["https://evil.example/v1.0/users/x/messages", "http://graph.microsoft.com/v1.0/users/x", "https://graph.microsoft.com.evil.example/v1.0/x", "https://graph.microsoft.com/beta/users/x"]) {
      calls = [];
      graphResponse = () => json({ value: [message("a")], "@odata.nextLink": link });
      await expect(listInboxSince("2026-01-01T00:00:00Z", 1, config)).rejects.toMatchObject({ code: "bad_next_link" });
      expect(calls.filter((c) => c.url === link)).toHaveLength(0);
    }
  });
});

describe("resuming and the reply body", () => {
  it("a capped run returns the link to carry on from, and a later run resumes from it instead of filtering again", async () => {
    graphResponse = (call) => json({ value: [message(`m${graphCalls().indexOf(call)}`)], "@odata.nextLink": `${BASE}/mailFolders/inbox/messages?next=${graphCalls().length}` });
    const first = await listInboxSince("2026-01-01T00:00:00Z", 1, config, 2);
    expect(first.more).toBe(true);
    expect(first.nextLink).toBe(`${BASE}/mailFolders/inbox/messages?next=2`);
    calls = [];
    graphResponse = () => json({ value: [message("z")] });
    const second = await listInboxSince("2026-01-01T00:00:00Z", 1, config, 2, first.nextLink);
    expect(second).toMatchObject({ more: false, nextLink: null });
    expect(graphCalls().map((c) => c.url)).toEqual([first.nextLink]);
  });

  it("refuses to resume from a link that isn't Microsoft Graph's, without calling it", async () => {
    await expect(listInboxSince("2026-01-01T00:00:00Z", 1, config, 2, "https://evil.example/v1.0/x")).rejects.toMatchObject({ code: "bad_next_link" });
    expect(calls).toHaveLength(0);
  });

  it("reply names exactly the recipients it is given", async () => {
    await replyToMessage("AAA", "thanks", config, ["a@example.com", "b@example.com"]);
    expect(JSON.parse(graphCalls()[0].body!)).toEqual({ message: { toRecipients: [{ emailAddress: { address: "a@example.com" } }, { emailAddress: { address: "b@example.com" } }] }, comment: "thanks" });
  });
});

describe("reply recipients", () => {
  const recipientsFor = async (body: unknown) => {
    graphResponse = () => json(body);
    return replyRecipients("AAA", config);
  };

  it("asks for from, replyTo, toRecipients and subject with GET", async () => {
    await recipientsFor({ from: { emailAddress: { address: "b@example.com" } } });
    const [call] = graphCalls();
    expect(call.method).toBe("GET");
    expect(new URL(call.url).pathname).toBe("/v1.0/users/mail%40fixture-tolra.onmicrosoft.com/messages/AAA");
    expect(new URL(call.url).searchParams.get("$select")).toBe("from,replyTo,toRecipients,subject");
  });

  it("is replyTo when the message has any, otherwise the sender; lower case, no repeats", async () => {
    expect(await recipientsFor({ from: { emailAddress: { address: "B@Example.com" } }, replyTo: [] })).toEqual(["b@example.com"]);
    expect(await recipientsFor({ from: { emailAddress: { address: "b@example.com" } }, replyTo: [{ emailAddress: { address: "X@Other.com" } }, { emailAddress: { address: "x@other.com" } }, { emailAddress: { address: "y@other.com" } }] })).toEqual(["x@other.com", "y@other.com"]);
  });

  it("refuses a message with nobody to reply to", async () => {
    await expect(recipientsFor({})).rejects.toMatchObject({ status: 422, code: "no_reply_recipient" });
  });
});

describe("outcomes", () => {
  const mail = { to: "a@example.com", subject: "S", body: "B" };

  it("202 resolves: accepted", async () => {
    await expect(sendMail(mail, config)).resolves.toBeUndefined();
  });

  it("a definite 4xx is a failed outcome (throttling too)", async () => {
    for (const status of [400, 403, 404, 429]) {
      graphResponse = () => json({ error: { code: "x" } }, status);
      await expect(sendMail(mail, config)).rejects.toMatchObject({ outcome: "failed" });
    }
  });

  it("a timeout or network error after the request went out is an unknown outcome", async () => {
    graphResponse = () => Promise.reject(new DOMException("timed out", "TimeoutError"));
    await expect(sendMail(mail, config)).rejects.toMatchObject({ outcome: "unknown", code: "unreachable" });
    graphResponse = () => Promise.reject(new TypeError("fetch failed"));
    await expect(replyToMessage("m", "c", config)).rejects.toMatchObject({ outcome: "unknown" });
  });

  it("a 5xx or 408 is an unknown outcome", async () => {
    for (const status of [500, 502, 503, 504, 408]) {
      graphResponse = () => new Response("<html>gateway</html>", { status });
      await expect(forwardMessage("m", "b@example.com", "c", config)).rejects.toMatchObject({ outcome: "unknown" });
    }
  });

  it("failing to sign in is a definite failure: nothing was sent", async () => {
    tokenResponse = () => {
      throw new TypeError("network down");
    };
    await expect(sendMail(mail, config)).rejects.toMatchObject({ outcome: "failed", code: "token_unreachable" });
    expect(graphCalls()).toHaveLength(0);
  });
});

describe("errors", () => {
  it("maps a Graph error to a safe message without leaking its text, the secret or the token", async () => {
    graphResponse = () => json({ error: { code: "ErrorAccessDenied", message: "Access is denied for user secret-person@jnr.example, body: SECRET BODY" } }, 403);
    const err = await replyToMessage("m", "c", config).catch((e) => e);
    expect(err).toBeInstanceOf(GraphError);
    expect(err.code).toBe("ErrorAccessDenied");
    expect(err.message).toMatch(/isn't allowed/);
    for (const text of [err.message, JSON.stringify(err)]) {
      expect(text).not.toContain("secret-person");
      expect(text).not.toContain("SECRET BODY");
      expect(text).not.toContain("s3cret-value");
      expect(text).not.toContain("tok-1");
    }
  });

  it("maps throttling, missing items and server errors", async () => {
    graphResponse = () => json({ error: { code: "ErrorItemNotFound" } }, 404);
    await expect(replyToMessage("m", "c", config)).rejects.toThrow(/not found/);
    graphResponse = () => json({ error: { code: "TooManyRequests" } }, 429);
    await expect(replyToMessage("m", "c", config)).rejects.toMatchObject({ status: 429 });
    graphResponse = () => new Response("<html>gateway</html>", { status: 503 });
    await expect(replyToMessage("m", "c", config)).rejects.toMatchObject({ status: 502, code: "http_503" });
  });

  it("a failed sign-in reports the error code only, and a refused token is not reused", async () => {
    tokenResponse = () => json({ error: "invalid_client", error_description: "AADSTS7000215: Invalid client secret provided s3cret-value" }, 401);
    const err = await sendMail({ to: "a@example.com", subject: "S", body: "B" }, config).catch((e) => e);
    expect(err.code).toBe("invalid_client");
    expect(JSON.stringify(err) + err.message).not.toContain("s3cret-value");
    expect(graphCalls()).toHaveLength(0);

    tokenResponse = () => json({ access_token: "tok-1", expires_in: 3600 });
    graphResponse = () => json({ error: { code: "InvalidAuthenticationToken" } }, 401);
    await expect(sendMail({ to: "a@example.com", subject: "S", body: "B" }, config)).rejects.toThrow(/rejected/);
    graphResponse = () => new Response(null, { status: 202 });
    await sendMail({ to: "a@example.com", subject: "S", body: "B" }, config);
    expect(calls.filter((c) => c.url.includes("login.microsoftonline.com")).length).toBe(3); // failed, first good, re-fetched after the 401
  });
});
