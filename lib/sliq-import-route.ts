/**
 * Admin > Data import > SliQ go-live import (proposal p152, supabase/proposals/p152_sliq_import_route.sql): how the browser sends a
 * confirmed SliQ payload to the database. Signed in as an admin of the session's company; never the service role.
 *
 * The payload is the CONFIRMED output of the SliQ mapping (customers, suppliers, invoices with lines, payments), each row with its
 * `source_row_id` (the SliQ account code, invoice number or receipt id) and `source_sha256` (the SHA-256 of the source export as
 * received). Building it from John's files is not done here: the column mapping stays a confirmed input.
 *
 * 1. Preflight: the whole file in one call (import_sliq_preflight). Writes nothing; answers counts, problems and the money.
 * 2. Batches (import_sliq_batch), in order: customers, suppliers, invoices (each invoice batch carries its invoices' payments, as 076
 *    writes a payment only with its invoice). Each batch is one transaction, sized like 076's parts (about 500 audit rows, measured at
 *    most 1.1 s) so it finishes well inside Supabase's 8 s. The batches follow from the payload alone, so a retry (or a re-run) sends
 *    the very same batch: the database answers a committed one again ("already imported", the same counts) and never writes it twice.
 */

export type SliqEntity = "customers" | "suppliers" | "invoices";
export type SliqRow = Record<string, unknown> & { source_row_id: string };
export type SliqSourceFile = { entity: "customers" | "suppliers" | "invoices" | "payments" | "creditNotes"; name: string; sha256: string };
export type SliqPayload = {
  /** SHA-256 of the sorted "<entity>:<file sha256>" lines (lib/sliq-import-build.ts sourceKeyText); p152 checks it against source_files. */
  source_sha256: string;
  /** The original export's files and their SHA-256, recorded in every batch's audit row. */
  source_files: SliqSourceFile[];
  customers?: SliqRow[];
  suppliers?: SliqRow[];
  invoices?: SliqRow[];
  payments?: SliqRow[];
  /** Issued credit notes, each applied in full to its invoice (085); they travel in their invoice's batch. */
  credit_notes?: SliqRow[];
};
export type SliqBatch = { entity: SliqEntity; batchNo: number; rows: Partial<Record<SliqEntity | "payments" | "credit_notes", SliqRow[]>>; weight: number; records: number; lines: number };

/** About 500 audit rows a batch, as 076's IMPORT_PART_WEIGHT (at most 1.1 s measured; Supabase stops a call at 8 s). */
export const SLIQ_BATCH_WEIGHT = 500;
/** The database refuses a batch above these (p152): 2,000 records, 4,000 lines. Kept well under. */
export const SLIQ_BATCH_MAX_RECORDS = 1000;
export const SLIQ_BATCH_MAX_LINES = 2000;

export type SliqMessage = { kind: string | null; source_row_id: string | null; field: string | null; message: string; code?: string };
export type SliqCounts = { rows: number; already_imported: number; from_other_file: number; to_create: number; problems: number };
export type SliqPreflight = {
  ok: boolean;
  source_sha256: string;
  counts: Record<"customers" | "suppliers" | "invoices" | "payments" | "credit_notes", SliqCounts>;
  money: { invoiced: number; paid: number; credited: number; owed: number; customer_credit: number; excluded_invoices: number; payment_to_confirm: number };
  changed_since_import?: SliqMessage[];
  error_count: number;
  errors: SliqMessage[];
  warnings?: { kind: string | null; row: number | null; field: string | null; message: string }[];
};
export type SliqBatchResult = {
  ok: boolean;
  dry_run: boolean;
  committed: boolean;
  already_imported: boolean;
  replayed?: boolean;
  entity: SliqEntity;
  batch_no: number;
  rows: number;
  created: number;
  skipped_already_imported?: number;
  doc_counters?: Record<string, number> | null;
  error_count?: number;
  errors?: SliqMessage[];
};

const linesOf = (row: SliqRow) => (Array.isArray(row.lines) ? row.lines.length : 0);
const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/**
 * The batches, in order (customers, suppliers, invoices with their payments), and the payments whose invoice is not in the file
 * (never sent in a batch: the preflight reports them as problems). Deterministic: the same payload always gives the same batches.
 */
export function planSliqBatches(payload: SliqPayload, weight = SLIQ_BATCH_WEIGHT): { batches: SliqBatch[]; orphanPayments: SliqRow[]; orphanCredits: SliqRow[] } {
  const batches: SliqBatch[] = [];
  const invoiceRefs = new Set((payload.invoices ?? []).map((i) => text(i.invoice_ref)));
  const group = (list: SliqRow[] | undefined) => {
    const by = new Map<string, SliqRow[]>();
    const orphans: SliqRow[] = [];
    for (const p of list ?? []) {
      const ref = text(p.invoice_ref);
      if (!ref || !invoiceRefs.has(ref)) { orphans.push(p); continue; }
      by.set(ref, [...(by.get(ref) ?? []), p]);
    }
    return { by, orphans };
  };
  const { by: paymentsByInvoice, orphans: orphanPayments } = group(payload.payments);
  const { by: creditsByInvoice, orphans: orphanCredits } = group(payload.credit_notes);
  const taken = new Set<string>();

  for (const entity of ["customers", "suppliers", "invoices"] as const) {
    let current: SliqBatch | null = null;
    let n = 0;
    for (const row of payload[entity] ?? []) {
      const ref = entity === "invoices" ? text(row.invoice_ref) : "";
      // An invoice's payments go with its first appearance only (a duplicate number is the preflight's problem, not a second copy).
      const first = entity === "invoices" && !taken.has(ref);
      const pays = first ? paymentsByInvoice.get(ref) ?? [] : [];
      const creds = first ? creditsByInvoice.get(ref) ?? [] : [];
      if (entity === "invoices") taken.add(ref);
      const lines = entity === "invoices" ? linesOf(row) : 0;
      // A credit note writes the note, one line and an allocation: weighed 3.
      const w = entity === "invoices" ? 2 + lines + pays.length + 3 * creds.length : 1;
      const records = 1 + pays.length + creds.length;
      if (!current || (current.weight > 0 && (current.weight + w > weight || current.records + records > SLIQ_BATCH_MAX_RECORDS || current.lines + lines > SLIQ_BATCH_MAX_LINES))) {
        n += 1;
        current = { entity, batchNo: n, rows: {}, weight: 0, records: 0, lines: 0 };
        batches.push(current);
      }
      (current.rows[entity] ??= []).push(row);
      if (pays.length) (current.rows.payments ??= []).push(...pays);
      if (creds.length) (current.rows.credit_notes ??= []).push(...creds);
      current.weight += w;
      current.records += records;
      current.lines += lines;
    }
  }
  return { batches, orphanPayments, orphanCredits };
}

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string; hint?: string } | null }>;

export class SliqCallError extends Error {
  code?: string;
  hint?: string;
  constructor(message: string, code?: string, hint?: string) {
    super(message);
    this.name = "SliqCallError";
    this.code = code;
    this.hint = hint;
  }
}

const isTransportError = (error: { message: string; code?: string }) =>
  !error.code && /invalid response was received|bad gateway|failed to fetch|fetch failed|networkerror|load failed/i.test(error.message);

async function call<T>(rpc: Rpc, fn: string, args: Record<string, unknown>): Promise<T> {
  let { data, error } = await rpc(fn, args);
  // Every call here is safe to send again with the same arguments: the preflight writes nothing, and a batch that did go in answers
  // its first result. So a failure of the road is retried once.
  if (error && isTransportError(error)) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    ({ data, error } = await rpc(fn, args));
  }
  if (error) throw new SliqCallError(error.message, error.code, error.hint);
  const answer = typeof data === "string" ? (() => { try { return JSON.parse(data); } catch { return null; } })() : data;
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) throw new SliqCallError("The database's answer wasn't one this page understands, so nothing was changed. Try again.");
  return answer as T;
}

/** The SHA-256 of the source export, as 64 lower-case hex characters, or null. */
export function cleanSha(value: unknown): string | null {
  const s = text(value).toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

export function sliqPreflight(rpc: Rpc, payload: SliqPayload): Promise<SliqPreflight> {
  const { source_sha256, source_files, ...sections } = payload;
  return call<SliqPreflight>(rpc, "import_sliq_preflight", { p_source_sha256: source_sha256, p_source_files: source_files, p_payload: sections });
}

export type SliqRunProgress = { done: number; total: number; batch?: SliqBatch };

/**
 * Commits the batches in order from `startAt` (0, or the batch that failed). Stops at the first batch that fails and says which; the
 * page offers "Retry from this batch", which sends the same batches again (committed ones answer "already imported").
 */
export async function sliqRunBatches(
  rpc: Rpc, payload: SliqPayload, runLabel: string, onProgress?: (p: SliqRunProgress) => void, startAt = 0, weight = SLIQ_BATCH_WEIGHT,
): Promise<{ results: SliqBatchResult[]; failedAt: number | null; error?: Error; last?: SliqBatchResult }> {
  const { batches } = planSliqBatches(payload, weight);
  const results: SliqBatchResult[] = [];
  for (let i = startAt; i < batches.length; i += 1) {
    const b = batches[i];
    onProgress?.({ done: i, total: batches.length, batch: b });
    let result: SliqBatchResult;
    try {
      result = await call<SliqBatchResult>(rpc, "import_sliq_batch", {
        p_source_sha256: payload.source_sha256, p_source_files: payload.source_files, p_run_label: runLabel, p_entity: b.entity, p_batch_no: b.batchNo, p_rows: b.rows, p_dry_run: false,
      });
    } catch (err) {
      return { results, failedAt: i, error: err instanceof Error ? err : new Error(String(err)) };
    }
    results.push(result);
    if (!result.ok) return { results, failedAt: i, last: result };
  }
  onProgress?.({ done: batches.length, total: batches.length });
  return { results, failedAt: null };
}

/** Run labels: lower-case letters, digits and hyphens, at most 40 (p152). A new label is a fresh run (after a wipe). */
export const isRunLabel = (label: string) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(label);

/** Reads and checks the confirmed payload file (JSON). Throws with a plain message when it is not one. */
export function parseSliqPayload(json: string): SliqPayload {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { throw new Error("The file is not JSON."); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The file must be one record with customers, suppliers, invoices and payments.");
  const r = raw as Record<string, unknown>;
  const sha = cleanSha(r.source_sha256);
  if (!sha) throw new Error("The file has no source_sha256 (the SHA-256 of the SliQ export as received).");
  const files = r.source_files;
  if (!Array.isArray(files) || files.length === 0 || files.some((f) => !f || typeof f !== "object" || !cleanSha((f as Record<string, unknown>).sha256) || !text((f as Record<string, unknown>).name))) {
    throw new Error("The file has no source_files (entity, name and SHA-256 of each original SliQ export file).");
  }
  const out: SliqPayload = { source_sha256: sha, source_files: files as SliqSourceFile[] };
  for (const key of Object.keys(r)) {
    if (key === "source_sha256" || key === "source_files") continue;
    if (!["customers", "suppliers", "invoices", "payments", "credit_notes"].includes(key)) throw new Error(`Unknown section "${key}".`);
    const list = r[key];
    if (!Array.isArray(list)) throw new Error(`"${key}" must be a list.`);
    for (const [i, row] of list.entries()) {
      if (!row || typeof row !== "object" || Array.isArray(row) || !text((row as Record<string, unknown>).source_row_id)) {
        throw new Error(`${key} row ${i + 1} has no source_row_id.`);
      }
    }
    (out as Record<string, unknown>)[key] = list;
  }
  return out;
}
