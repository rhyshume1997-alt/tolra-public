// Xero batch send and the accountant's summary (E3). Pure, so it is unit tested: which documents a date range covers, which of them a batch
// may send, what happens to each one, and the summary's rows. No I/O here; lib/integrations/xero/batch-server.ts does the database and engine.
//
// The rules (Rhys, 30 Oct: "batch send for however long the accountant needs it"):
//   - a batch is a date range of ISSUED invoices and credit notes (never drafts, never voided or cancelled ones, never imported records);
//   - "Send unsent" covers the documents with no send row at all, or a row still waiting (pending); "Resend failed only" covers rows that
//     FAILED, and nothing else. A document already sent is never touched, one being sent or to be checked in Xero is left alone;
//   - the range is inclusive at both ends and uses the date the document carries to Xero (the same one 084's integration_document sends).

import type { SendStatus } from "@/lib/integrations/send-log";

export type BatchDocType = "invoice" | "credit_note";
export type BatchMode = "unsent" | "failed_only";

/** An issued document as the batch sees it. `date` is the document date (YYYY-MM-DD) that goes to Xero. */
export type BatchDoc = {
  docType: BatchDocType;
  id: string;
  ref: string | null;
  customer: string;
  date: string;
  status: string;
  subtotal: number | null;
  vat: number | null;
  total: number | null;
};

/** The create row of integration_sends for a document (a void row is a different action and never selected here). */
export type BatchSend = {
  id: string;
  docType: BatchDocType;
  docId: string;
  status: SendStatus;
  attempts: number;
  externalId: string | null;
  externalNumber: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  sentAt: string | null;
};

export const BATCH_MAX_DOCUMENTS = 500;
/** Documents per request from the page: small, so a request stays well inside the function's time and Xero's rate limit. */
export const BATCH_CHUNK = 3;
export const SUMMARY_MAX_ROWS = 5000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in YYYY-MM-DD form, or null. */
export function parseIsoDate(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value ? null : value;
}

export type Range = { from: string; to: string };

/** The range from the request, or the reason it is refused. Both ends are dates; from may equal to; to may not be before from. */
export function parseRange(from: unknown, to: unknown): { ok: true; range: Range } | { ok: false; error: string } {
  const f = parseIsoDate(from);
  const t = parseIsoDate(to);
  if (!f || !t) return { ok: false, error: "Choose a first and a last date." };
  if (t < f) return { ok: false, error: "The last date can't be before the first." };
  return { ok: true, range: { from: f, to: t } };
}

/** Inclusive at both ends. */
export const inRange = (date: string, range: Range): boolean => date >= range.from && date <= range.to;

/** The day in London for an instant (the company's day, as 084's integration_document takes it). */
export function londonDate(instant: string | null | undefined): string | null {
  if (!instant) return null;
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Statuses that never go to Xero as a new document: not issued yet, or voided / cancelled. */
const NOT_SENDABLE = new Set(["", "draft", "void", "voided", "cancelled", "canceled"]);
export const isIssuedForXero = (status: string | null | undefined): boolean => !NOT_SENDABLE.has((status ?? "").toLowerCase());

type InvoiceRow = {
  id: string; invoice_ref: string | null; customer: string | null; status: string | null; invoice_date: string | null; tax_point: string | null;
  issued_at: string | null; created_at: string | null; subtotal: number | string | null; vat: number | string | null; total: number | string | null;
};
type CreditRow = {
  id: string; credit_ref: string | null; customer: string | null; status: string | null; credit_date: string | null; issued_at: string | null;
  created_at: string | null; subtotal: number | string | null; vat: number | string | null; total: number | string | null;
};

const num = (v: number | string | null | undefined): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** The columns the batch reads from invoices and credit notes. */
export const INVOICE_COLUMNS = "id, invoice_ref, customer, status, invoice_date, tax_point, issued_at, created_at, subtotal, vat, total";
export const CREDIT_COLUMNS = "id, credit_ref, customer, status, credit_date, issued_at, created_at, subtotal, vat, total";

/** The invoice's date as 084's integration_document takes it: invoice date, else tax point, else the day it was issued, else created. */
export function invoiceDocument(row: InvoiceRow): BatchDoc | null {
  const date = row.invoice_date ?? row.tax_point ?? londonDate(row.issued_at) ?? londonDate(row.created_at);
  if (!date) return null;
  return { docType: "invoice", id: row.id, ref: row.invoice_ref, customer: (row.customer ?? "").trim(), date, status: row.status ?? "", subtotal: num(row.subtotal), vat: num(row.vat), total: num(row.total) };
}

export function creditDocument(row: CreditRow): BatchDoc | null {
  const date = row.credit_date ?? londonDate(row.issued_at) ?? londonDate(row.created_at);
  if (!date) return null;
  return { docType: "credit_note", id: row.id, ref: row.credit_ref, customer: (row.customer ?? "").trim(), date, status: row.status ?? "", subtotal: num(row.subtotal), vat: num(row.vat), total: num(row.total) };
}

/** Oldest first, invoices before credit notes on the same day, then by number: the order the batch sends in. */
export function sendOrder(a: BatchDoc, b: BatchDoc): number {
  return a.date.localeCompare(b.date) || (a.docType === b.docType ? 0 : a.docType === "invoice" ? -1 : 1) || (a.ref ?? "").localeCompare(b.ref ?? "", "en", { numeric: true }) || a.id.localeCompare(b.id);
}

export const docKey = (docType: BatchDocType, id: string) => `${docType}:${id}`;

export type BatchItem = { doc: BatchDoc; send: BatchSend | null };

export type BatchSelection = {
  /** What this mode would send, in order. */
  selected: BatchItem[];
  /** The rest of the range, counted so the page can say why they are left out. */
  counts: { sent: number; sending: number; needsCheck: number; failed: number; waiting: number; notQueued: number; skipped: number; imported: number; selected: number };
};

/**
 * Which documents of the range a batch sends. Pure: the documents (issued or not, any range), their create rows and the ids of imported
 * records go in; the selection comes out.
 *   unsent:      no row, or a row still pending (never tried, or held back for a later try).
 *   failed_only: rows that failed. Nothing else.
 * Never selected in any mode: not issued, void or cancelled, imported, outside the range, sent, being sent, to be checked in Xero, skipped.
 */
export function selectBatch(input: { docs: BatchDoc[]; sends: BatchSend[]; range: Range; mode: BatchMode; imported?: ReadonlySet<string> }): BatchSelection {
  const sends = new Map(input.sends.map((s) => [docKey(s.docType, s.docId), s]));
  const counts = { sent: 0, sending: 0, needsCheck: 0, failed: 0, waiting: 0, notQueued: 0, skipped: 0, imported: 0, selected: 0 };
  const selected: BatchItem[] = [];
  for (const doc of [...input.docs].sort(sendOrder)) {
    if (!isIssuedForXero(doc.status) || !inRange(doc.date, input.range)) continue;
    if (input.imported?.has(doc.id)) {
      counts.imported += 1;
      continue;
    }
    const send = sends.get(docKey(doc.docType, doc.id)) ?? null;
    const status = send?.status ?? null;
    if (status === "sent") counts.sent += 1;
    else if (status === "sending") counts.sending += 1;
    else if (status === "needs_check") counts.needsCheck += 1;
    else if (status === "skipped") counts.skipped += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "pending") counts.waiting += 1;
    else counts.notQueued += 1;
    const take = input.mode === "failed_only" ? status === "failed" : status === null || status === "pending";
    if (take) selected.push({ doc, send });
  }
  counts.selected = selected.length;
  return { selected, counts };
}

/** What to do with one document when its turn comes (decided again on the server, from the database, not from the page's list). */
export type ChunkAction =
  | { kind: "enqueue_first" }   // no row: add it, then send it (its first attempt)
  | { kind: "send_first" }      // a row never tried: its first attempt, only this document
  | { kind: "send_queued" }     // a row waiting for a later try (rate limit, Xero down): the engine's normal claim, when its time has come
  | { kind: "retry_then_send" } // a failed row, in failed-only mode: queued again as the admin (the engine reads Xero back first)
  | { kind: "leave"; reason: string };

export function chunkAction(doc: BatchDoc | null, send: BatchSend | null, mode: BatchMode, now: number): ChunkAction {
  if (!doc) return { kind: "leave", reason: "Not found in Tolra." };
  if (!isIssuedForXero(doc.status)) return { kind: "leave", reason: "Not issued, or voided: not sent." };
  if (!send) return mode === "unsent" ? { kind: "enqueue_first" } : { kind: "leave", reason: "Never sent, so not a failed one." };
  switch (send.status) {
    case "sent": return { kind: "leave", reason: "Already sent to Xero." };
    case "sending": return { kind: "leave", reason: "Being sent right now." };
    case "needs_check": return { kind: "leave", reason: "Check it in Xero first (Send log, Retry)." };
    case "skipped": return { kind: "leave", reason: send.lastError ?? "Not sent." };
    case "failed": return mode === "failed_only" ? { kind: "retry_then_send" } : { kind: "leave", reason: "Failed earlier: use Resend failed only." };
    case "pending": {
      if (mode === "failed_only") return { kind: "leave", reason: "Not a failed one." };
      if (send.attempts === 0) return { kind: "send_first" };
      const due = send.nextAttemptAt ? Date.parse(send.nextAttemptAt) : 0;
      return due > now ? { kind: "leave", reason: "Waiting for its next try." } : { kind: "send_queued" };
    }
    default: return { kind: "leave", reason: "Not sent." };
  }
}

/** One document's line in the page's report. */
export type ItemResult = {
  docType: BatchDocType;
  docId: string;
  ref: string | null;
  outcome: "sent" | "failed" | "needs_check" | "waiting" | "left" | "not_attempted";
  detail: string | null;
  externalNumber: string | null;
};

/** The words for what the database says about a document after its turn. */
export function resultFor(doc: BatchDoc, send: BatchSend | null): ItemResult {
  const base = { docType: doc.docType, docId: doc.id, ref: doc.ref, externalNumber: send?.externalNumber ?? null };
  if (!send) return { ...base, outcome: "not_attempted", detail: null };
  switch (send.status) {
    case "sent": return { ...base, outcome: "sent", detail: null };
    case "failed": return { ...base, outcome: "failed", detail: send.lastError ?? "Xero refused it." };
    case "needs_check": return { ...base, outcome: "needs_check", detail: send.lastError ?? "Check it in Xero before sending it again." };
    case "pending": return { ...base, outcome: "waiting", detail: send.lastError ? `Trying again soon: ${send.lastError}` : "Waiting to send." };
    case "sending": return { ...base, outcome: "waiting", detail: "Being sent." };
    default: return { ...base, outcome: "left", detail: send.lastError ?? "Not sent." };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// The accountant's summary.

export type SummaryRow = {
  number: string;
  type: string;
  action: string;
  customer: string;
  date: string;
  subtotal: number | null;
  vat: number | null;
  total: number | null;
  xeroNumber: string | null;
  xeroId: string | null;
  sentAt: string | null;
  status: string;
  error: string | null;
};

const STATUS_WORDS: Record<SendStatus | "not_queued", string> = {
  pending: "Waiting to send", sending: "Sending", sent: "Sent", failed: "Failed", needs_check: "Check in Xero", skipped: "Not sent", not_queued: "Not sent",
};

/**
 * One line per send row of the range (document joined to its row), and one line ("Not sent") for each issued document of the range that
 * has no row, so the accountant sees what is missing as well as what went. Void rows are lines of their own. Sorted by document date.
 */
export function summaryRows(input: { docs: BatchDoc[]; sends: Array<BatchSend & { action: "create" | "void"; externalId: string | null }>; range: Range }): SummaryRow[] {
  const byDoc = new Map<string, BatchDoc>();
  for (const d of input.docs) byDoc.set(docKey(d.docType, d.id), d);
  const rows: Array<SummaryRow & { order: BatchDoc }> = [];
  const seen = new Set<string>();
  for (const s of input.sends) {
    const doc = byDoc.get(docKey(s.docType, s.docId));
    if (!doc || !inRange(doc.date, input.range)) continue;
    if (s.action === "create") seen.add(docKey(doc.docType, doc.id));
    rows.push({
      order: doc, number: doc.ref ?? "", type: doc.docType === "credit_note" ? "Credit note" : "Invoice", action: s.action === "void" ? "Void" : "Create",
      customer: doc.customer, date: doc.date, subtotal: doc.subtotal, vat: doc.vat, total: doc.total, xeroNumber: s.externalNumber, xeroId: s.externalId,
      sentAt: s.sentAt, status: STATUS_WORDS[s.status] ?? s.status, error: s.status === "sent" ? null : s.lastError,
    });
  }
  for (const doc of input.docs) {
    if (!isIssuedForXero(doc.status) || !inRange(doc.date, input.range) || seen.has(docKey(doc.docType, doc.id))) continue;
    rows.push({
      order: doc, number: doc.ref ?? "", type: doc.docType === "credit_note" ? "Credit note" : "Invoice", action: "Create", customer: doc.customer, date: doc.date,
      subtotal: doc.subtotal, vat: doc.vat, total: doc.total, xeroNumber: null, xeroId: null, sentAt: null, status: STATUS_WORDS.not_queued, error: null,
    });
  }
  rows.sort((a, b) => sendOrder(a.order, b.order) || a.action.localeCompare(b.action));
  return rows.map((r) => {
    const { order, ...row } = r;
    void order;
    return row;
  });
}

type Col = { header: string; type: "text" | "number" | "money" | "date"; value: (row: SummaryRow) => string | number | null };

/** The summary's columns (lib/spreadsheet.ts's column spec: CSV with the formula guard, or .xlsx). */
export const SUMMARY_COLUMNS: Col[] = [
  { header: "Document number", type: "text", value: (r) => r.number },
  { header: "Type", type: "text", value: (r) => r.type },
  { header: "Action", type: "text", value: (r) => r.action },
  { header: "Customer", type: "text", value: (r) => r.customer },
  { header: "Issued date", type: "date", value: (r) => r.date },
  { header: "Net", type: "money", value: (r) => r.subtotal },
  { header: "VAT", type: "money", value: (r) => r.vat },
  { header: "Total", type: "money", value: (r) => r.total },
  { header: "Xero number", type: "text", value: (r) => r.xeroNumber },
  { header: "Xero id", type: "text", value: (r) => r.xeroId },
  { header: "Sent at", type: "text", value: (r) => r.sentAt },
  { header: "Status", type: "text", value: (r) => r.status },
  { header: "Error", type: "text", value: (r) => r.error },
];

/** A download name that is safe on every system: "Xero-summary-<company>-<from>-to-<to>". */
export function summaryFileName(company: string | null | undefined, range: Range, ext: "csv" | "xlsx"): string {
  const name = (company ?? "").normalize("NFKD").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "company";
  return `Xero-summary-${name}-${range.from}-to-${range.to}.${ext}`;
}

/** Pause (seconds) before the next attempt after Xero's rate limit: what the row says, never less than 1 or more than 90. */
export function pauseSeconds(nextAttemptAt: string | null | undefined, now: number): number {
  const at = nextAttemptAt ? Date.parse(nextAttemptAt) : NaN;
  const seconds = Number.isFinite(at) ? Math.ceil((at - now) / 1000) : 60;
  return Math.min(90, Math.max(1, seconds));
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Documents issued before Xero was connected may already be in Xero (from SliQ, or by hand); a first attempt does not look first.

/** The page's default From: the day Xero was connected, else 1 January of this year. */
export function defaultFrom(connectedOn: string | null | undefined, today: string): string {
  return parseIsoDate(connectedOn) ?? `${today.slice(0, 4)}-01-01`;
}

/** A range starting before the connection day needs the explicit "include earlier documents" tick (the server refuses it without). */
export function startsBeforeConnection(from: string, connectedOn: string | null | undefined): boolean {
  return !!connectedOn && from < connectedOn;
}
