import "server-only";

// One Microsoft 365 mailbox through Microsoft Graph, with the app's own (client credentials) identity.
//
// Access is granted to the app in Exchange Online (RBAC for Applications: "Application Mail.Read" and "Application
// Mail.Send" with a management scope on the one mailbox), so the token carries no Mail roles claim and none is checked.
// Reply and forward use the one-call /reply and /forward endpoints (Mail.Send only); createReply and createForward
// (they create drafts, Mail.ReadWrite) are never used. Messages are only ever read with GET: nothing here changes,
// moves or deletes anything in the mailbox, and reading does not mark a message read.
//
// Configuration (all of these, or the feature is off): MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_MAILBOX and
// MS_ORGANIZATION_ID, the one company (uuid) that owns the mailbox: no other company's admin can use it.
// MS_MAILBOX_DENY_DOMAINS (comma separated) refuses a mailbox on those domains; MS_PAGE_SIZE (default 50) is the
// inbox page size. Production must not be configured until the connection has been approved (docs/M365-MAIL.md):
// use a test tenant first. Errors carry a safe message only: never the secret, a token, or any message content.

const GRAPH = "https://graph.microsoft.com/v1.0";
const TIMEOUT_MS = 15_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Message ids that stay the same when a message moves folder, so a stored id keeps working. */
const IMMUTABLE_IDS = 'IdType="ImmutableId"';

export type MailConfig = { tenantId: string; clientId: string; clientSecret: string; mailbox: string; organizationId: string; pageSize: number };

/**
 * outcome says what is known about a failed call that may have changed something: "failed" (Microsoft refused it, or the
 * request never went out) or "unknown" (it may have reached Microsoft: a timeout, a network error, a 5xx).
 */
export class GraphError extends Error {
  constructor(message: string, readonly status: number, readonly code: string, readonly outcome: "failed" | "unknown" = "failed") {
    super(message);
    this.name = "GraphError";
  }
}

/** null when Microsoft 365 mail isn't configured (feature off). Throws if the mailbox is on a denied domain. */
export function mailConfig(env: Record<string, string | undefined> = process.env): MailConfig | null {
  const tenantId = env.MS_TENANT_ID?.trim();
  const clientId = env.MS_CLIENT_ID?.trim();
  const clientSecret = env.MS_CLIENT_SECRET?.trim();
  const mailbox = env.MS_MAILBOX?.trim().toLowerCase();
  const organizationId = env.MS_ORGANIZATION_ID?.trim().toLowerCase();
  if (!tenantId || !clientId || !clientSecret || !mailbox || !organizationId || !UUID.test(organizationId)) return null;
  const domain = mailbox.split("@")[1] ?? "";
  const denied = (env.MS_MAILBOX_DENY_DOMAINS || "").split(",").map((d) => d.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  if (!domain || denied.includes(domain)) throw new GraphError("This mailbox is not allowed for Microsoft 365 mail", 403, "mailbox_denied");
  const pageSize = Math.min(Math.max(Math.trunc(Number(env.MS_PAGE_SIZE)) || 50, 1), 100);
  return { tenantId, clientId, clientSecret, mailbox, organizationId, pageSize };
}

type CachedToken = { key: string; token: string; expiresAt: number };
let cached: CachedToken | null = null;

/** Forgets the cached token (tests). */
export function resetTokenCache() {
  cached = null;
}

/** App token for Graph, reused until 60 seconds before it expires. */
async function accessToken(config: MailConfig): Promise<string> {
  const key = `${config.tenantId}/${config.clientId}`;
  if (cached && cached.key === key && Date.now() < cached.expiresAt - 60_000) return cached.token;
  let res: Response;
  try {
    res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: config.clientId, client_secret: config.clientSecret, scope: "https://graph.microsoft.com/.default" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Nothing has been sent to the mailbox yet, so this is a definite failure.
    throw new GraphError("Could not reach Microsoft sign-in", 502, "token_unreachable");
  }
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error?: unknown } | null;
  if (!res.ok || typeof json?.access_token !== "string") {
    // Microsoft's error code (invalid_client, ...) is safe to keep; its description can echo identifiers, so it is dropped.
    const code = typeof json?.error === "string" ? json.error.slice(0, 64) : "token_failed";
    throw new GraphError("Microsoft 365 sign-in failed. Check the app registration and secret.", 502, code);
  }
  const seconds = Number(json.expires_in);
  cached = { key, token: json.access_token, expiresAt: Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000 };
  return cached.token;
}

/** Plain-English message for a Graph failure; from the status and error code only. */
function safeMessage(status: number, code: string): string {
  if (status === 401) return "Microsoft 365 rejected the app's sign-in.";
  if (status === 403 || code === "ErrorAccessDenied") return "The app isn't allowed to do this on the mailbox (check the Exchange access scope for Mail.Read / Mail.Send).";
  if (status === 404 || code === "ErrorItemNotFound" || code === "MailboxNotFound") return "Mailbox or message not found.";
  if (status === 400 || status === 422) return "Microsoft 365 refused the request.";
  if (status === 429) return "Microsoft 365 is busy. Try again shortly.";
  return "Microsoft 365 mail is unavailable. Try again shortly.";
}

async function graphUrl(config: MailConfig, url: string, init: { method: "GET" | "POST"; body?: unknown; prefer?: string[] }): Promise<unknown> {
  const token = await accessToken(config);
  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        // One Prefer header with comma separated values.
        Prefer: [IMMUTABLE_IDS, ...(init.prefer ?? [])].join(", "),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // The request may have reached Microsoft before the connection failed or timed out.
    throw new GraphError("Could not reach Microsoft 365", 502, "unreachable", "unknown");
  }
  if (res.status === 401) cached = null; // The token was refused: fetch a new one next time.
  if (!res.ok) {
    const json = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
    const code = typeof json?.error?.code === "string" ? json.error.code.slice(0, 64) : `http_${res.status}`;
    // A definite 4xx means Microsoft refused it. A 5xx (or 408) may have been acted on before it failed.
    const unknown = res.status >= 500 || res.status === 408;
    throw new GraphError(safeMessage(res.status, code), res.status === 429 ? 429 : 502, code, unknown ? "unknown" : "failed");
  }
  return res.status === 202 || res.status === 204 ? null : res.json().catch(() => null);
}

const graph = (config: MailConfig, path: string, init: { method: "GET" | "POST"; body?: unknown; prefer?: string[] }) =>
  graphUrl(config, `${GRAPH}/users/${encodeURIComponent(config.mailbox)}${path}`, init);

export type InboxMessage = {
  id: string;
  internetMessageId: string | null;
  subject: string | null;
  from: string | null;
  fromName: string | null;
  receivedAt: string;
  bodyPreview: string | null;
  bodyText: string | null;
  isRead: boolean;
  parentFolderId: string | null;
  hasAttachments: boolean;
};

type GraphMessage = {
  id: string;
  internetMessageId?: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  receivedDateTime: string;
  bodyPreview?: string;
  body?: { content?: string };
  isRead?: boolean;
  parentFolderId?: string;
  hasAttachments?: boolean;
};

const SELECT = "id,internetMessageId,subject,from,receivedDateTime,bodyPreview,body,isRead,parentFolderId,hasAttachments";
const MAX_BODY = 20_000;
export const MAX_PAGES = 20;
/** A paging link is only followed when it points at Microsoft Graph itself. */
export const isGraphLink = (link: unknown): link is string => typeof link === "string" && link.startsWith(`${GRAPH}/`);
const notConfigured = () => new GraphError("Microsoft 365 mail is not configured", 503, "not_configured");

/**
 * Inbox messages received at or after `sinceIso`, oldest first, following the paging links (GET only: the mailbox is not
 * changed). Stops after `maxPages` pages and then reports more = true with the link to continue from (`nextLink`, to pass
 * back as `resumeLink`, which replaces the filter). Ids are immutable ids.
 */
export async function listInboxSince(
  sinceIso: string,
  top?: number,
  config: MailConfig | null = mailConfig(),
  maxPages = MAX_PAGES,
  resumeLink?: string | null,
): Promise<{ messages: InboxMessage[]; more: boolean; nextLink: string | null }> {
  if (!config) throw notConfigured();
  const since = new Date(sinceIso);
  if (Number.isNaN(since.getTime())) throw new GraphError("Invalid date", 400, "invalid_since");
  const limit = Math.min(Math.max(Math.trunc(top ?? config.pageSize) || config.pageSize, 1), 100);
  const query = `$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}&$orderby=${encodeURIComponent("receivedDateTime asc")}&$select=${SELECT}&$top=${limit}`;
  const messages: InboxMessage[] = [];
  if (resumeLink && !isGraphLink(resumeLink)) throw new GraphError("Unexpected response from Microsoft 365", 502, "bad_next_link");
  let url: string | null = resumeLink || `${GRAPH}/users/${encodeURIComponent(config.mailbox)}/mailFolders/inbox/messages?${query}`;
  let pages = 0;
  while (url) {
    if (pages >= maxPages) return { messages, more: true, nextLink: url };
    // Ask for the body as text so no HTML is stored.
    const json = (await graphUrl(config, url, { method: "GET", prefer: ['outlook.body-content-type="text"'] })) as { value?: GraphMessage[]; "@odata.nextLink"?: unknown } | null;
    pages += 1;
    for (const m of json?.value ?? []) {
      messages.push({
        id: m.id,
        internetMessageId: m.internetMessageId ?? null,
        subject: m.subject ?? null,
        from: m.from?.emailAddress?.address?.toLowerCase() ?? null,
        fromName: m.from?.emailAddress?.name ?? null,
        receivedAt: m.receivedDateTime,
        bodyPreview: m.bodyPreview ?? null,
        bodyText: m.body?.content ? m.body.content.slice(0, MAX_BODY) : null,
        isRead: m.isRead === true,
        parentFolderId: m.parentFolderId ?? null,
        hasAttachments: m.hasAttachments === true,
      });
    }
    const next = json?.["@odata.nextLink"];
    if (next === undefined || next === null || next === "") url = null;
    else if (isGraphLink(next)) url = next;
    else throw new GraphError("Unexpected response from Microsoft 365", 502, "bad_next_link");
  }
  return { messages, more: false, nextLink: null };
}

/** Where /reply would go: the message's replyTo addresses when it has any, otherwise its sender. */
export async function replyRecipients(messageId: string, config: MailConfig | null = mailConfig()): Promise<string[]> {
  if (!config) throw notConfigured();
  const json = (await graph(config, `/messages/${encodeURIComponent(messageId)}?$select=from,replyTo,toRecipients,subject`, { method: "GET" })) as {
    from?: { emailAddress?: { address?: string } };
    replyTo?: Array<{ emailAddress?: { address?: string } }>;
  } | null;
  const addresses = (list: Array<{ emailAddress?: { address?: string } }> | undefined) => (list ?? []).map((r) => r.emailAddress?.address?.trim().toLowerCase()).filter((a): a is string => Boolean(a));
  const replyTo = addresses(json?.replyTo);
  const effective = replyTo.length ? replyTo : addresses(json?.from ? [json.from] : []);
  if (!effective.length) throw new GraphError("This message has no sender to reply to", 422, "no_reply_recipient");
  return [...new Set(effective)];
}

const recipients = (addresses: string | string[]) => (Array.isArray(addresses) ? addresses : [addresses]).map((address) => ({ emailAddress: { address } }));

/** New message from the mailbox (plain text), kept in its Sent Items. Resolves when Microsoft accepts it (202). */
export async function sendMail({ to, subject, body, replyTo }: { to: string | string[]; subject: string; body: string; replyTo?: string }, config: MailConfig | null = mailConfig()) {
  if (!config) throw notConfigured();
  await graph(config, "/sendMail", {
    method: "POST",
    body: { message: { subject, body: { contentType: "Text", content: body }, toRecipients: recipients(to), ...(replyTo ? { replyTo: recipients(replyTo) } : {}) }, saveToSentItems: true },
  });
}

/**
 * Replies in one call (Mail.Send only). Resolves when Microsoft accepts it (202). With `toRecipients` the reply goes to
 * exactly those addresses (the ones that were checked), whatever the original's Reply-To is by then.
 */
export async function replyToMessage(messageId: string, comment: string, config: MailConfig | null = mailConfig(), toRecipients?: string[]) {
  if (!config) throw notConfigured();
  await graph(config, `/messages/${encodeURIComponent(messageId)}/reply`, {
    method: "POST",
    body: toRecipients ? { message: { toRecipients: recipients(toRecipients) }, comment } : { comment },
  });
}

/** Forwards the message in one call (Mail.Send only). Resolves when Microsoft accepts it (202). */
export async function forwardMessage(messageId: string, to: string | string[], comment: string, config: MailConfig | null = mailConfig()) {
  if (!config) throw notConfigured();
  await graph(config, `/messages/${encodeURIComponent(messageId)}/forward`, { method: "POST", body: { comment, toRecipients: recipients(to) } });
}
