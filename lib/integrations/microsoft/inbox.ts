import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { missingDbObject } from "@/lib/integrations/app-credentials";
import { GRAPH_BASE, type MicrosoftReady, microsoftTokenSource } from "@/lib/integrations/microsoft/client";
import type { MailSyncCode } from "@/lib/integrations/overview";
import { DbError } from "@/lib/integrations/server";
import { type GraphMessage, INBOX_SELECT, type InboxMessage, isGraphLink, toInboxMessage } from "@/lib/m365/graph";

// Reading the company's own inbox with its delegated Microsoft 365 sign-in (C1, migration 127). No tenant id, mailbox setting or Exchange
// step: the connected user's own mailbox through /me, with delegated Mail.Read. Read only: GET requests only (reading does not mark a
// message read; nothing is moved, flagged or deleted; Mail.ReadWrite is never asked for).
//
// ISOLATION: one company at a time. Its token comes from its own connection (decrypted only under its own context), every message read
// with it is recorded for that company only, and its cursor and status are saved for that company only. A failure is stored as a fixed
// code (overview.ts turns it into plain words): never Microsoft's text, a token or a message.
// IDEMPOTENT: 031's UNIQUE (organization_id, graph_message_id) through record_inbound_email (the admin's Check inbox) or 127's
// mailbox_record_inbound (the server's pass): the same page read twice stores nothing new.

const TIMEOUT_MS = 15_000;
export const MAX_PAGES = 20;
const PAGE_SIZE = 50;
/** With no cursor yet, the first check looks back this far (24 hours), as the legacy check does. */
export const FIRST_LOOKBACK_MS = 24 * 3600_000;
const IMMUTABLE_IDS = 'IdType="ImmutableId"';

/** A failed inbox read: code is what is stored and shown; refused = Microsoft answered 4xx (not 401, 403, 429): a paging link it dropped. */
export class MailReadError extends Error {
  constructor(readonly code: MailSyncCode, readonly refused = false) {
    super(`Microsoft 365 inbox read failed (${code})`);
    this.name = "MailReadError";
  }
}

/**
 * The connected user's inbox, messages received at or after `since`, oldest first, following Microsoft's paging links (only ones that
 * point at Graph itself) for at most `maxPages` pages; more = true then, with the link to carry on from. GET only.
 */
export async function listMyInbox(accessToken: string, opts: { since: string; resumeLink?: string | null; pageSize?: number; maxPages?: number },
                                  fetchImpl: typeof fetch = fetch): Promise<{ messages: InboxMessage[]; more: boolean; nextLink: string | null }> {
  const since = new Date(opts.since);
  if (Number.isNaN(since.getTime())) throw new MailReadError("unavailable");
  if (opts.resumeLink && !isGraphLink(opts.resumeLink)) throw new MailReadError("unavailable", true);
  const top = Math.min(Math.max(Math.trunc(opts.pageSize ?? PAGE_SIZE) || PAGE_SIZE, 1), 100);
  const query = `$filter=${encodeURIComponent(`receivedDateTime ge ${since.toISOString()}`)}&$orderby=${encodeURIComponent("receivedDateTime asc")}&$select=${INBOX_SELECT}&$top=${top}`;
  let url: string | null = opts.resumeLink || `${GRAPH_BASE}/me/mailFolders/inbox/messages?${query}`;
  const maxPages = opts.maxPages ?? MAX_PAGES;
  const messages: InboxMessage[] = [];
  let pages = 0;
  while (url) {
    if (pages >= maxPages) return { messages, more: true, nextLink: url };
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json", Prefer: `${IMMUTABLE_IDS}, outlook.body-content-type="text"` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new MailReadError("unavailable");
    }
    if (!res.ok) {
      // Only the status decides; Microsoft's body (which can echo identifiers) is never read into a message.
      if (res.status === 401) throw new MailReadError("signin");
      if (res.status === 403) throw new MailReadError("consent");
      if (res.status === 429) throw new MailReadError("busy");
      throw new MailReadError("unavailable", res.status >= 400 && res.status < 500 && res.status !== 408);
    }
    const json = (await res.json().catch(() => null)) as { value?: GraphMessage[]; "@odata.nextLink"?: unknown } | null;
    pages += 1;
    for (const m of json?.value ?? []) if (m && typeof m.id === "string" && typeof m.receivedDateTime === "string") messages.push(toInboxMessage(m));
    const next = json?.["@odata.nextLink"];
    if (next === undefined || next === null || next === "") url = null;
    else if (isGraphLink(next)) url = next;
    else throw new MailReadError("unavailable");
  }
  return { messages, more: false, nextLink: null };
}

export type Recorded = { inserted: boolean; inboundEmailId: string | null };
export type PollDeps = {
  /** Where this company's check is up to (127's mailbox_sync_due). */
  cursor: { checkpoint: string | null; nextLink: string | null };
  /** THIS company's access token (renewed when due); null when it must connect again (the connection is then needs_reconnect). */
  accessToken(opts?: { force?: boolean }): Promise<string | null>;
  /** Store one message for THIS company (idempotent). */
  record(message: InboxMessage): Promise<Recorded>;
  /** Save THIS company's outcome (127's mailbox_sync_result). */
  saveResult(result: { error: MailSyncCode | null; nextLink: string | null; checkpoint: string | null }): Promise<void>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  pageSize?: number;
  maxPages?: number;
};
export type PollOutcome = {
  read: number; inserted: number; duplicates: number; more: boolean; error: MailSyncCode | null;
  /** The messages stored for the first time (for later steps such as PO capture). */
  stored: Array<{ inboundEmailId: string; message: InboxMessage }>;
};

/** One company's inbox check, start to finish. Never throws: a failure is saved (as a code) and returned. */
export async function pollMailbox(deps: PollDeps): Promise<PollOutcome> {
  const now = deps.now ?? Date.now;
  const out: PollOutcome = { read: 0, inserted: 0, duplicates: 0, more: false, error: null, stored: [] };
  const fail = async (code: MailSyncCode) => {
    out.error = code;
    await save({ error: code, nextLink: null, checkpoint: null });
    return out;
  };
  const save = async (r: { error: MailSyncCode | null; nextLink: string | null; checkpoint: string | null }) => {
    try {
      await deps.saveResult(r);
    } catch (err) {
      console.error("[mail/delegated] status not saved", err instanceof DbError ? err.code : err instanceof Error ? err.name : "error");
    }
  };

  const since = deps.cursor.checkpoint ?? new Date(now() - FIRST_LOOKBACK_MS).toISOString();
  const resume = deps.cursor.nextLink && isGraphLink(deps.cursor.nextLink) ? deps.cursor.nextLink : null;
  const read = async (force: boolean, link: string | null) => {
    let token: string | null;
    try {
      token = await deps.accessToken(force ? { force: true } : undefined);
    } catch {
      throw new MailReadError("unavailable");
    }
    if (!token) throw new MailReadError("reconnect");
    return listMyInbox(token, { since, resumeLink: link, pageSize: deps.pageSize, maxPages: deps.maxPages }, deps.fetchImpl);
  };

  let page: Awaited<ReturnType<typeof listMyInbox>>;
  try {
    try {
      page = await read(false, resume);
    } catch (err) {
      if (!(err instanceof MailReadError)) throw err;
      if (err.code === "signin") page = await read(true, resume); // a token Graph refused: renew it once
      else if (resume && err.refused) page = await read(false, null); // a paging link Microsoft dropped: start again from the checkpoint
      else throw err;
    }
  } catch (err) {
    return fail(err instanceof MailReadError ? err.code : "unavailable");
  }

  out.read = page.messages.length;
  out.more = page.more;
  for (const m of page.messages) {
    let r: Recorded;
    try {
      r = await deps.record(m);
    } catch (err) {
      console.error("[mail/delegated] store failed", err instanceof DbError ? err.code : err instanceof Error ? err.name : "error");
      // The cursor is not moved: the next check reads these again and 031's UNIQUE skips the ones already stored.
      return fail("store_failed");
    }
    if (r.inserted) {
      out.inserted += 1;
      if (r.inboundEmailId) out.stored.push({ inboundEmailId: r.inboundEmailId, message: m });
    } else out.duplicates += 1;
  }
  const newest = page.messages.length ? page.messages[page.messages.length - 1].receivedAt : null;
  await save({ error: null, nextLink: page.more ? page.nextLink : null, checkpoint: newest });
  return out;
}

const recordArgs = (m: InboxMessage) => ({
  p_graph_message_id: m.id, p_internet_message_id: m.internetMessageId, p_from_address: m.from, p_from_name: m.fromName, p_subject: m.subject,
  p_received_at: m.receivedAt, p_body_preview: m.bodyPreview, p_body_text: m.bodyText,
});

/** As the signed-in admin (Check inbox): 031's record_inbound_email, which takes the company from the session. */
export function recordAsAdmin(userClient: SupabaseClient) {
  return async (m: InboxMessage): Promise<Recorded> => {
    const { data, error } = await userClient.rpc("record_inbound_email", recordArgs(m));
    if (error) throw new DbError(error.message, error.code);
    const row = data as { inserted?: boolean; inbound_email_id?: string | null } | null;
    return { inserted: row?.inserted === true, inboundEmailId: row?.inbound_email_id ?? null };
  };
}

/** As the server (the background pass): 127's mailbox_record_inbound for this one company. */
export function recordForCompany(service: SupabaseClient, org: string) {
  return async (m: InboxMessage): Promise<Recorded> => {
    const { data, error } = await service.rpc("mailbox_record_inbound", { p_org: org, ...recordArgs(m) });
    if (error) throw new DbError(error.message, error.code);
    const row = data as { inserted?: boolean; inbound_email_id?: string | null } | null;
    return { inserted: row?.inserted === true, inboundEmailId: row?.inbound_email_id ?? null };
  };
}

/** Save this one company's outcome. */
export function saveResultFor(service: SupabaseClient, org: string) {
  return async (r: { error: MailSyncCode | null; nextLink: string | null; checkpoint: string | null }) => {
    const { error } = await service.rpc("mailbox_sync_result", { p_org: org, p_error: r.error, p_next_link: r.nextLink, p_checkpoint: r.checkpoint });
    if (error) throw new DbError(error.message, error.code);
  };
}

export type MailboxPassSummary = { companies: number; checked: number; read: number; inserted: number; duplicates: number; failed: number; skipped?: string };

/**
 * The background pass: every connection whose inbox may be read now (127's mailbox_sync_due: connected, Mail.Read, the same mailbox),
 * one company at a time, each with only its own token, rows and cursor. A company that fails (or must reconnect) never stops the next.
 * Counts only in the result. Stops starting new companies after budgetMs.
 */
export async function runMailboxPollPass(deps: { service: SupabaseClient; ready: MicrosoftReady; fetchImpl?: typeof fetch; now?: () => number; budgetMs?: number }): Promise<MailboxPassSummary> {
  const now = deps.now ?? Date.now;
  const started = now();
  const summary: MailboxPassSummary = { companies: 0, checked: 0, read: 0, inserted: 0, duplicates: 0, failed: 0 };
  const { data, error } = await deps.service.rpc("mailbox_sync_due", { p_org: null });
  if (error) {
    if (missingDbObject(error)) return { ...summary, skipped: "database update 127 is not applied" };
    throw new DbError(error.message, error.code);
  }
  const rows = (data ?? []) as Array<{ organization_id: string; checkpoint: string | null; next_link: string | null }>;
  summary.companies = rows.length;
  const tokens = microsoftTokenSource(deps.service, deps.ready, deps.fetchImpl);
  for (const row of rows) {
    if (deps.budgetMs !== undefined && now() - started > deps.budgetMs) break;
    const org = row.organization_id;
    const outcome = await pollMailbox({
      cursor: { checkpoint: row.checkpoint, nextLink: row.next_link },
      accessToken: (opts) => tokens(org, opts),
      record: recordForCompany(deps.service, org),
      saveResult: saveResultFor(deps.service, org),
      fetchImpl: deps.fetchImpl,
      now,
    });
    summary.checked += 1;
    summary.read += outcome.read;
    summary.inserted += outcome.inserted;
    summary.duplicates += outcome.duplicates;
    if (outcome.error) summary.failed += 1;
  }
  return summary;
}
