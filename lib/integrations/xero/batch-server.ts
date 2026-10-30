import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { RunSummary } from "@/lib/integrations/engine";
import {
  BATCH_MAX_DOCUMENTS, CREDIT_COLUMNS, INVOICE_COLUMNS, type BatchDoc, type BatchDocType, type BatchMode, type BatchSend, type ItemResult, type Range,
  chunkAction, creditDocument, docKey, invoiceDocument, pauseSeconds, resultFor, selectBatch, sendOrder,
} from "@/lib/integrations/xero/batch";
import type { SendStatus } from "@/lib/integrations/send-log";

// The server's side of the Xero batch (E3): reads the documents of a date range and their send rows, and sends a few of them per call
// through the existing engine (lib/integrations/engine.ts: one claim per document, Idempotency-Key per row, read-back on a repeat attempt,
// the provider's totals checked to the penny). Nothing here sends by itself: it queues a send row for a document that has none (exactly
// what 084's issue trigger inserts) and asks the engine to claim it.

const PAGE = 1000;
const IMPORT_CHUNK = 100;

type SendRow = {
  id: string; doc_type: BatchDocType; doc_id: string; action: "create" | "void"; status: SendStatus; attempts: number; external_id: string | null;
  external_number: string | null; last_error: string | null; next_attempt_at: string | null; sent_at: string | null;
};
export const SEND_COLUMNS = "id, doc_type, doc_id, action, status, attempts, external_id, external_number, last_error, next_attempt_at, sent_at";

export const toBatchSend = (r: SendRow): BatchSend & { action: "create" | "void" } => ({
  id: r.id, docType: r.doc_type, docId: r.doc_id, action: r.action, status: r.status, attempts: r.attempts, externalId: r.external_id,
  externalNumber: r.external_number, lastError: r.last_error, nextAttemptAt: r.next_attempt_at, sentAt: r.sent_at,
});

/** Day before and after, for the timestamp columns, so the exact (London) day is decided in code, not by the database's time zone. */
function shiftDay(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Every page of a query (PostgREST caps one answer), up to `cap` rows. */
async function pages<T>(run: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, cap: number): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < cap; from += PAGE) {
    const { data, error } = await run(from, Math.min(from + PAGE, cap) - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * The company's issued (and not-issued, filtered later) invoices and credit notes whose document date MAY fall in the range: a wider
 * database filter, then the exact day is decided by selectBatch / inRange. `client` is scoped to the company (RLS, or the service role
 * with the organisation filter below).
 */
export async function loadDocuments(client: SupabaseClient, org: string, range: Range, cap = BATCH_MAX_DOCUMENTS * 4): Promise<BatchDoc[]> {
  const lo = shiftDay(range.from, -1);
  const hi = shiftDay(range.to, 1);
  const inv = await pages<Parameters<typeof invoiceDocument>[0]>((a, b) => client.from("invoices").select(INVOICE_COLUMNS).eq("organization_id", org)
    .not("status", "in", "(draft,void,voided,cancelled,canceled)")
    .or([
      `and(invoice_date.gte.${range.from},invoice_date.lte.${range.to})`,
      `and(invoice_date.is.null,tax_point.gte.${range.from},tax_point.lte.${range.to})`,
      `and(invoice_date.is.null,tax_point.is.null,issued_at.gte.${lo}T00:00:00Z,issued_at.lt.${hi}T23:59:59Z)`,
      `and(invoice_date.is.null,tax_point.is.null,issued_at.is.null,created_at.gte.${lo}T00:00:00Z,created_at.lt.${hi}T23:59:59Z)`,
    ].join(",")).order("id").range(a, b), cap);
  const cre = await pages<Parameters<typeof creditDocument>[0]>((a, b) => client.from("credit_notes").select(CREDIT_COLUMNS).eq("organization_id", org)
    .not("status", "in", "(draft,void,voided,cancelled,canceled)")
    .gte("credit_date", range.from).lte("credit_date", range.to).order("id").range(a, b), cap);
  const docs: BatchDoc[] = [];
  for (const r of inv) { const d = invoiceDocument(r); if (d) docs.push(d); }
  for (const r of cre) { const d = creditDocument(r); if (d) docs.push(d); }
  return docs.sort(sendOrder);
}

/** The send rows (create and void) for these documents, read with the service role (office may not read the log) and the organisation filter. */
export async function loadSendRows(client: SupabaseClient, org: string, docs: BatchDoc[]): Promise<Array<BatchSend & { action: "create" | "void" }>> {
  const out: Array<BatchSend & { action: "create" | "void" }> = [];
  const want = new Set(docs.map((d) => docKey(d.docType, d.id)));
  // By company and provider; the rows of the range are picked in code (a long id list in a URL is the failure to avoid).
  const rows = await pages<SendRow>((a, b) => client.from("integration_sends").select(SEND_COLUMNS).eq("organization_id", org).eq("provider", "xero").order("id").range(a, b), 200_000);
  for (const r of rows) if (want.has(docKey(r.doc_type, r.doc_id))) out.push(toBatchSend(r));
  return out;
}

/** Ids of imported records among these documents (import_record_keys): never queued by 084's trigger, so never by the batch. */
export async function loadImportedIds(client: SupabaseClient, org: string, docs: BatchDoc[]): Promise<Set<string>> {
  const found = new Set<string>();
  const ids = docs.map((d) => d.id);
  for (let i = 0; i < ids.length; i += IMPORT_CHUNK) {
    const { data, error } = await client.from("import_record_keys").select("record_id").eq("organization_id", org).in("record_id", ids.slice(i, i + IMPORT_CHUNK));
    if (error) throw new Error(error.message);
    for (const r of (data ?? []) as Array<{ record_id: string }>) found.add(r.record_id);
  }
  return found;
}

export type Preview = {
  connected: boolean;
  truncated: boolean;
  counts: ReturnType<typeof selectBatch>["counts"];
  items: Array<{ docType: BatchDocType; id: string; ref: string | null; customer: string; date: string; total: number | null; state: string }>;
};

/** The preview: what the mode would send for the range, as plain rows. Capped at BATCH_MAX_DOCUMENTS (the rest is left for a narrower range). */
export async function previewBatch(opts: { docsClient: SupabaseClient; service: SupabaseClient; org: string; range: Range; mode: BatchMode }): Promise<Preview> {
  const docs = await loadDocuments(opts.docsClient, opts.org, opts.range);
  const [sends, imported, conn] = await Promise.all([
    loadSendRows(opts.service, opts.org, docs),
    loadImportedIds(opts.service, opts.org, docs),
    opts.service.from("integration_connections").select("status").eq("organization_id", opts.org).eq("provider", "xero").maybeSingle(),
  ]);
  const selection = selectBatch({ docs, sends: sends.filter((s) => s.action === "create"), range: opts.range, mode: opts.mode, imported });
  const truncated = selection.selected.length > BATCH_MAX_DOCUMENTS || docs.length >= BATCH_MAX_DOCUMENTS * 4;
  return {
    connected: (conn.data as { status?: string } | null)?.status === "connected",
    truncated,
    counts: selection.counts,
    items: selection.selected.slice(0, BATCH_MAX_DOCUMENTS).map(({ doc, send }) => ({
      docType: doc.docType, id: doc.id, ref: doc.ref, customer: doc.customer, date: doc.date, total: doc.total,
      state: send ? send.status : "not_queued",
    })),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Sending a few documents.

/** What the chunk needs from the outside. Fakes in the unit tests; the database and the engine in the route (batchDeps). */
export interface ChunkDeps {
  /** The document as the signed-in admin sees it (their company only), or null. */
  loadDoc(docType: BatchDocType, id: string): Promise<BatchDoc | null>;
  /** The document's create row, or null. */
  loadSend(docType: BatchDocType, id: string): Promise<BatchSend | null>;
  /** Whether the document is an imported record (never queued). */
  isImported(id: string): Promise<boolean>;
  /** Adds the create row exactly as 084's issue trigger does; false when the company is not connected. A row that exists is left alone. */
  enqueue(doc: BatchDoc): Promise<void>;
  /** Queues a failed row again as the signed-in admin (integration_retry_send: admin and two-step checked by the database). */
  retry(sendId: string): Promise<void>;
  /** One engine run for one document: `only` = its first attempt only; without it the engine's normal claim. */
  run(only: { docType: BatchDocType; docId: string } | null): Promise<RunSummary>;
  now(): number;
}

export type ChunkOutcome = {
  results: ItemResult[];
  /** Why the chunk stopped before the end, if it did. rate_limited carries the seconds to wait. */
  stopped: null | { reason: "rate_limited" | "not_connected" | "needs_reconnect" | "unmapped" | "no_token" | "disconnected" | "time" | "other"; pauseSeconds?: number; unmapped?: string[] };
  /** Items the chunk did not reach (the page sends them again). */
  remaining: Array<{ docType: BatchDocType; id: string }>;
};

const STOP_REASONS = new Set(["rate_limited", "not_connected", "needs_reconnect", "unmapped", "no_token", "disconnected"]);
/** After this long a chunk starts no new document (the route's limit is 60 s; one document may need several Xero calls). */
export const CHUNK_BUDGET_MS = 35_000;

export async function runBatchChunk(deps: ChunkDeps, items: Array<{ docType: BatchDocType; id: string }>, mode: BatchMode): Promise<ChunkOutcome> {
  const started = deps.now();
  const results: ItemResult[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const rest = items.slice(i);
    if (i > 0 && deps.now() - started > CHUNK_BUDGET_MS) return { results, stopped: { reason: "time" }, remaining: rest };
    const doc = await deps.loadDoc(item.docType, item.id);
    let send = doc ? await deps.loadSend(item.docType, item.id) : null;
    if (doc && !send && mode === "unsent" && (await deps.isImported(doc.id))) {
      results.push({ docType: doc.docType, docId: doc.id, ref: doc.ref, outcome: "left", detail: "An imported record: not sent.", externalNumber: null });
      continue;
    }
    if (!doc) {
      results.push({ docType: item.docType, docId: item.id, ref: null, outcome: "left", detail: "Not found in Tolra.", externalNumber: null });
      continue;
    }
    const action = chunkAction(doc, send, mode, deps.now());
    if (action.kind === "leave") {
      // Already sent is a result, not a refusal: the report says so and nothing is touched.
      results.push(send?.status === "sent"
        ? { ...resultFor(doc, send), detail: action.reason }
        : { docType: doc.docType, docId: doc.id, ref: doc.ref, outcome: "left", detail: action.reason, externalNumber: send?.externalNumber ?? null });
      continue;
    }
    let only: { docType: BatchDocType; docId: string } | null = { docType: doc.docType, docId: doc.id };
    if (action.kind === "enqueue_first") await deps.enqueue(doc);
    else if (action.kind === "retry_then_send") {
      if (!send) throw new Error("retry without a row");
      await deps.retry(send.id);
      only = null;
    } else if (action.kind === "send_queued") only = null;

    // The engine takes the oldest due row when it is not told which one, so a few passes (bounded) until this document has been tried.
    let blocked: string | null = null;
    for (let pass = 0; pass < (only ? 1 : 3); pass += 1) {
      const summary = await deps.run(only);
      send = await deps.loadSend(doc.docType, doc.id);
      if (summary.blocked) { blocked = summary.blocked; break; }
      if (send?.status !== "pending" || (send.nextAttemptAt && Date.parse(send.nextAttemptAt) > deps.now())) break;
    }
    results.push(resultFor(doc, send));
    if (blocked) {
      const reason = STOP_REASONS.has(blocked) ? (blocked as NonNullable<ChunkOutcome["stopped"]>["reason"]) : "other";
      return {
        results,
        stopped: { reason, pauseSeconds: reason === "rate_limited" ? pauseSeconds(send?.nextAttemptAt, deps.now()) : undefined },
        remaining: (blocked === "rate_limited" ? [item] : []).concat(items.slice(i + 1)),
      };
    }
  }
  return { results, stopped: null, remaining: [] };
}
