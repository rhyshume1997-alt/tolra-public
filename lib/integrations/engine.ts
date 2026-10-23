// The send engine (G22): takes one company's queued documents (migration 084's send log) one at a time and pushes them to the provider.
// Issuing in Tolra never waits for this. Every rule that keeps a document from being sent twice is here or in the database:
//   - the database claims one row at a time for one sender (FOR UPDATE SKIP LOCKED) and only after its gate (connected, every account
//     and VAT rate used mapped); only that claim can write the result;
//   - every write to the provider carries the row's id as its Idempotency-Key;
//   - a second attempt, and any answer that leaves the outcome unknown (timeout, network error, 5xx), reads the provider back by the
//     Tolra number first: found = sent (if the totals agree); not found = try again later; can't tell = needs_check (a person looks);
//   - the provider's totals must equal Tolra's to the penny, or the send fails with the difference (never rounded away);
//   - a 429 stops the run until its Retry-After; nothing else is retried more than MAX_ATTEMPTS times.
// No I/O of its own: the database and the provider are passed in (lib/integrations/server.ts in the app, fakes in the unit tests).

import { createHash } from "node:crypto";

import { decideContact } from "@/lib/integrations/contacts";
import type { AccountingProvider, IntegrationDocument, Mappings, ProviderDocument, ProviderId } from "@/lib/integrations/types";
import { ProviderError } from "@/lib/integrations/types";
import { expectedTotals, missingMappings, totalsDifference, UnmappedError } from "@/lib/integrations/xero/mapper";
import { VOID_IN_XERO, voidRefusedMessage } from "@/lib/integrations/xero/policy";

export const MAX_ATTEMPTS = 6;
const CLAIM_SECONDS = 120;

/** Minutes to wait before attempt n+1 after attempt n left nothing at the provider: 1, 2, 4, 8, 16, then 60 at most. */
export function retryDelayMs(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000;
}

export type ClaimedSend = {
  id: string;
  claim: string;
  doc_type: "invoice" | "credit_note";
  doc_id: string;
  doc_ref: string | null;
  action: "create" | "void";
  attempts: number;
  external_id: string | null;
  tenant_id: string;
};

export type ContactRow = { state: "ok" | "problem"; external_contact_id: string | null; problem: string | null };

/** The database, as the server's service-role client sees it. rpc throws on a database error. */
export interface EngineDb {
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>;
  mappings(org: string, provider: ProviderId): Promise<Mappings>;
  contact(org: string, provider: ProviderId, customer: string): Promise<ContactRow | null>;
}

export type EngineDeps = {
  db: EngineDb;
  /** A usable access token for the company (refreshed under the lease when due), or null when the company must connect again. */
  accessToken(org: string, provider: ProviderId, opts?: { force?: boolean }): Promise<string | null>;
  provider(accessToken: string, tenantId: string): AccountingProvider;
  now?: () => number;
};

export type RunSummary = {
  sent: number;
  failed: number;
  needsCheck: number;
  retryLater: number;
  skipped: number;
  /** Why the run stopped early, if it did: not_connected, needs_reconnect, disconnected, unmapped, rate_limited, no_token. */
  blocked: string | null;
  unmapped: string[];
};

type Result = { status: "sent" | "failed" | "needs_check" | "pending" | "skipped"; externalId?: string | null; externalNumber?: string | null; error?: string | null; retryAt?: Date | null; stop?: string };

/** Xero no longer accepts this company's sign-in (or its access to the organisation): pause the company until an admin connects again. */
const RECONNECT_REASON = "Xero refused this company's access (the connection may have been removed in Xero): connect again.";

/**
 * opts.only: the automatic send right after one document is issued or voided (whoever issued it): only that document's first attempt.
 * Without it (an admin's Send now, the daily sweep) the whole queue, retries included.
 */
export async function runSends(org: string, providerId: ProviderId, deps: EngineDeps,
                               opts: { maxDocuments?: number; budgetMs?: number; only?: { docType: "invoice" | "credit_note"; docId: string } } = {}): Promise<RunSummary> {
  const now = deps.now ?? Date.now;
  const started = now();
  const maxDocuments = opts.maxDocuments ?? 10;
  const budgetMs = opts.budgetMs ?? 20_000;
  const summary: RunSummary = { sent: 0, failed: 0, needsCheck: 0, retryLater: 0, skipped: 0, blocked: null, unmapped: [] };

  let token: string | null = null;
  let forcedRefresh = false;
  let mappings: Mappings | null = null;
  for (let n = 0; n < maxDocuments && now() - started < budgetMs; n += 1) {
    const claimed = await deps.db.rpc<{ blocked: string | null; unmapped?: string[]; send: ClaimedSend | null }>("integration_claim_next", {
      p_org: org, p_provider: providerId, p_lease_seconds: CLAIM_SECONDS, p_doc_type: opts.only?.docType ?? null, p_doc_id: opts.only?.docId ?? null });
    if (claimed.blocked) {
      summary.blocked = claimed.blocked;
      summary.unmapped = claimed.unmapped ?? [];
      break;
    }
    const send = claimed.send;
    if (!send) break;
    if (!token) token = await deps.accessToken(org, providerId);
    if (!token) {
      // The claim runs out and the row becomes needs_check... unless it is put back now: nothing was sent.
      await record(deps.db, send, { status: "pending", retryAt: new Date(now() + 60_000), error: "Xero sign-in is not available: connect again." });
      summary.blocked = "no_token";
      break;
    }
    mappings ??= await deps.db.mappings(org, providerId);
    const result = await processOne(org, providerId, send, deps.provider(token, send.tenant_id), mappings, deps.db, now);
    await record(deps.db, send, result);
    if (result.status === "sent") summary.sent += 1;
    else if (result.status === "failed") summary.failed += 1;
    else if (result.status === "needs_check") summary.needsCheck += 1;
    else if (result.status === "pending") summary.retryLater += 1;
    else summary.skipped += 1;
    if (result.stop === "unauthorized" && !forcedRefresh) {
      // The access token was refused: refresh it once (force) and carry on with the next document.
      forcedRefresh = true;
      token = await deps.accessToken(org, providerId, { force: true });
      if (!token) {
        summary.blocked = "needs_reconnect";
        break;
      }
    } else if (result.stop === "unauthorized" || result.stop === "forbidden") {
      // Refused again after a fresh token, or 403 (no access to the organisation): the document waits (pending, never failed) and the
      // company is paused until an admin connects again.
      await deps.db.rpc("integration_mark_needs_reconnect", { p_org: org, p_provider: providerId, p_reason: RECONNECT_REASON });
      summary.blocked = "needs_reconnect";
      break;
    } else if (result.stop) {
      summary.blocked = result.stop;
      break;
    }
  }
  return summary;
}

async function record(db: EngineDb, send: ClaimedSend, r: Result) {
  await db.rpc("integration_record_result", {
    p_send: send.id, p_claim: send.claim, p_status: r.status, p_external_id: r.externalId ?? null, p_external_number: r.externalNumber ?? null,
    p_error: r.error ?? null, p_retry_at: r.retryAt ? r.retryAt.toISOString() : null,
  });
}

/** Sent when the provider's totals are Tolra's to the penny; failed with the difference otherwise (the document is at the provider). */
function settle(doc: IntegrationDocument, found: ProviderDocument): Result {
  const diff = totalsDifference(expectedTotals(doc), found.totals);
  return diff
    ? { status: "failed", externalId: found.externalId, externalNumber: found.externalNumber, error: `${diff}. It is in Xero: check it there.` }
    : { status: "sent", externalId: found.externalId, externalNumber: found.externalNumber };
}

function laterOrFail(send: ClaimedSend, reason: string, now: () => number): Result {
  if (send.attempts >= MAX_ATTEMPTS) return { status: "failed", error: `Gave up after ${send.attempts} attempts: ${reason}` };
  return { status: "pending", error: reason, retryAt: new Date(now() + retryDelayMs(send.attempts)) };
}

/** What to record when a call to the provider was refused for now (rate limit, token), or null for the caller to decide. */
function holdBack(err: unknown, now: () => number): Result | null {
  if (!(err instanceof ProviderError)) return null;
  if (err.outcome === "rate_limited") return { status: "pending", error: err.message, retryAt: new Date(now() + (err.retryAfterMs ?? 60_000)), stop: "rate_limited" };
  if (err.outcome === "unauthorized") return { status: "pending", error: err.message, retryAt: new Date(now() + 60_000), stop: "unauthorized" };
  if (err.outcome === "forbidden") return { status: "pending", error: err.message, retryAt: new Date(now() + 60_000), stop: "forbidden" };
  return null;
}

/** The provider's copy by the Tolra number: the document, null (it has none), or an error (can't tell). */
async function readBack(provider: AccountingProvider, doc: IntegrationDocument): Promise<{ found: ProviderDocument | null } | { error: unknown }> {
  if (!doc.number) return { found: null };
  try {
    return { found: await provider.readBack(doc.doc_type, doc.number) };
  } catch (error) {
    return { error };
  }
}

const checkMessage = (why: string) => `${why}. Could not check Xero afterwards: look for it in Xero before sending it again.`;

async function processOne(org: string, providerId: ProviderId, send: ClaimedSend, provider: AccountingProvider, mappings: Mappings, db: EngineDb, now: () => number): Promise<Result> {
  const doc = await db.rpc<IntegrationDocument | null>("integration_document", { p_org: org, p_doc_type: send.doc_type, p_doc_id: send.doc_id });
  if (!doc) return { status: "failed", error: "The document was not found in Tolra." };
  return send.action === "void" ? processVoid(send, doc, provider, now) : processCreate(org, providerId, send, doc, provider, mappings, db, now);
}

async function processCreate(org: string, providerId: ProviderId, send: ClaimedSend, doc: IntegrationDocument, provider: AccountingProvider, mappings: Mappings, db: EngineDb, now: () => number): Promise<Result> {
  const missing = missingMappings(doc, mappings);
  if (missing.length) return { status: "pending", error: `Not mapped yet: ${missing.join(", ")}`, retryAt: new Date(now() + 5 * 60_000) };

  // A second attempt (or a row that already has the provider's id): read back first, so a document that did arrive is not sent twice.
  if (send.attempts > 1 || send.external_id) {
    const back = await readBack(provider, doc);
    if ("error" in back) return holdBack(back.error, now) ?? { status: "needs_check", error: checkMessage("This is a repeat attempt") };
    if (back.found) return settle(doc, back.found);
  }

  let contactId: string;
  try {
    const contact = await resolveContact(org, providerId, doc.customer, provider, db);
    if ("problem" in contact) return { status: "failed", error: `Contact: ${contact.problem}` };
    contactId = contact.id;
  } catch (err) {
    const held = holdBack(err, now);
    if (held) return held;
    // Nothing of the document has been sent yet: a contact that may have been created is found by name next time.
    const message = err instanceof Error ? err.message : "Contact lookup failed";
    return err instanceof ProviderError && err.outcome === "failed" ? { status: "failed", error: `Contact: ${message}` } : laterOrFail(send, `Contact: ${message}`, now);
  }

  try {
    const pushed = doc.doc_type === "invoice"
      ? await provider.pushInvoice(doc, mappings, contactId, `tolra-${send.id}`)
      : await provider.pushCreditNote(doc, mappings, contactId, `tolra-${send.id}`);
    return settle(doc, pushed);
  } catch (err) {
    if (err instanceof UnmappedError) return { status: "pending", error: err.message, retryAt: new Date(now() + 5 * 60_000) };
    const held = holdBack(err, now);
    if (held) return held;
    if (err instanceof ProviderError && err.outcome === "unknown") {
      const back = await readBack(provider, doc);
      // The read-back refused for access (401 / 403) or the rate limit: as on the main path (needs_reconnect, or later), not needs_check.
      if ("error" in back) return holdBack(back.error, now) ?? { status: "needs_check", error: checkMessage(err.message) };
      if (back.found) return settle(doc, back.found);
      return laterOrFail(send, `${err.message}; Xero has no copy, so it will be sent again`, now);
    }
    return { status: "failed", error: err instanceof Error ? err.message : "Not sent" };
  }
}

async function processVoid(send: ClaimedSend, doc: IntegrationDocument, provider: AccountingProvider, now: () => number): Promise<Result> {
  // Q11 (lib/integrations/xero/policy.ts): voids are sent as voids unless the accountant decides otherwise.
  if (!VOID_IN_XERO) return { status: "skipped", error: "Voids are not sent to Xero: void or credit it in Xero by hand." };
  if (!send.external_id) return { status: "failed", error: "Its invoice has no Xero id." };
  if (send.attempts > 1) {
    const back = await readBack(provider, doc);
    if ("error" in back) return holdBack(back.error, now) ?? { status: "needs_check", error: checkMessage("This is a repeat attempt") };
    if (back.found?.status === "VOIDED") return { status: "sent", externalId: back.found.externalId, externalNumber: back.found.externalNumber };
  }
  try {
    const result = await provider.voidInvoice(send.external_id, `tolra-${send.id}`);
    return result.status === "VOIDED"
      ? { status: "sent", externalId: result.externalId, externalNumber: result.externalNumber }
      : { status: "failed", error: voidRefusedMessage(`it is ${result.status || "not voided"} in Xero`) };
  } catch (err) {
    const held = holdBack(err, now);
    if (held) return held;
    if (err instanceof ProviderError && err.outcome === "unknown") {
      const back = await readBack(provider, doc);
      // The read-back refused for access (401 / 403) or the rate limit: as on the main path (needs_reconnect, or later), not needs_check.
      if ("error" in back) return holdBack(back.error, now) ?? { status: "needs_check", error: checkMessage(err.message) };
      if (back.found?.status === "VOIDED") return { status: "sent", externalId: back.found.externalId, externalNumber: back.found.externalNumber };
      return laterOrFail(send, `${err.message}; not voided in Xero yet`, now);
    }
    return { status: "failed", error: voidRefusedMessage(err instanceof Error ? err.message : "refused") };
  }
}

/** The provider's contact for the customer: the stored match, or a lookup by exact name (link one, create none, two is a problem). */
async function resolveContact(org: string, providerId: ProviderId, customer: string, provider: AccountingProvider, db: EngineDb): Promise<{ id: string } | { problem: string }> {
  const name = customer.trim();
  const stored = await db.contact(org, providerId, name);
  if (stored?.state === "ok" && stored.external_contact_id) return { id: stored.external_contact_id };
  if (stored?.state === "problem") return { problem: stored.problem ?? "an admin must choose the Xero contact" };
  const decision = decideContact(name, await provider.findContacts(name));
  if (decision.kind === "problem") {
    await db.rpc("integration_contact_record", { p_org: org, p_provider: providerId, p_customer: name, p_external_contact_id: null, p_matched_by: null, p_problem: decision.reason });
    return { problem: decision.reason };
  }
  const id = decision.kind === "link"
    ? decision.id
    : (await provider.createContact(name, `tolra-contact-${createHash("sha256").update(`${org}:${name}`).digest("hex").slice(0, 40)}`)).id;
  const row = await db.rpc<{ state: string; external_contact_id: string | null; problem: string | null }>("integration_contact_record",
    { p_org: org, p_provider: providerId, p_customer: name, p_external_contact_id: id, p_matched_by: decision.kind === "link" ? "exact_name" : "created", p_problem: null });
  // A match made meanwhile (or an admin's choice) wins over this one.
  if (row?.state === "ok" && row.external_contact_id) return { id: row.external_contact_id };
  return { problem: row?.problem ?? "an admin must choose the Xero contact" };
}
