/**
 * Admin > Data import (migration 076): how the app sends a file to the database.
 *
 * Supabase cancels a signed-in call after 8 s (statement_timeout). The time of an import follows the audit rows it writes (one per
 * created record and line, one more per issued invoice); the dry run reports them as `size.audit_rows`. Measured on PostgreSQL 16 with
 * 077 applied and a 500,000-row audit log (docs/RELEASE.md "076", timing): about 1.4 ms per audit row in one call (JNR's 8,880 rows:
 * 12.7 s), parts of 750 at most 1.8 s, of 500 at most 1.1 s, of 250 at most 1.0 s. With 077 the time no longer grows with the audit
 * log. The limits below leave about a 3x margin (single call) and a 7x margin (parts) for slower production hardware.
 */
import { type ImportPayload, estimateSize } from "@/lib/import-build";
import { IMPORT_KINDS, type ImportKind } from "@/lib/import-targets";

/** A dry run at or under this many audit rows is committed in ONE call (one transaction, all or nothing): about 3 s at the measured rate. */
export const SINGLE_CALL_MAX_AUDIT_ROWS = 2000;

/** Above that, a large import: staged, validated whole, committed in parts of about this many audit rows (at most 1.1 s measured). */
export const IMPORT_PART_WEIGHT = 500;

export type ImportSize = { records: number; lines: number; audit_rows: number };

/** One call (`import_company_data`) or a large import in parts (`import_stage_part`, `import_validate`, `import_commit_part`). */
export function importPath(size: ImportSize): { mode: "single" } | { mode: "parts"; partWeight: number; estimatedParts: number } {
  if (size.audit_rows <= SINGLE_CALL_MAX_AUDIT_ROWS) return { mode: "single" };
  return { mode: "parts", partWeight: IMPORT_PART_WEIGHT, estimatedParts: Math.ceil(size.audit_rows / IMPORT_PART_WEIGHT) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The calls (Admin > Data). The database does every check; this only sends the file and reports what came back.

/** One line of a dry run's answer: a problem or a warning, with the file's row. */
export type DbMessage = { kind: ImportKind | null; row: number | null; field: string | null; message: string };
export type KindCounts = { created?: number; matched_existing?: number; errors?: number };

/** What import_company_data, import_validate and import_commit_part answer (076, sections 5 and 7). */
export type ImportResult = {
  ok: boolean;
  dry_run?: boolean;
  committed?: boolean;
  batch_id?: string | null;
  import_id?: string | null;
  part?: number | null;
  parts?: number | null;
  parts_committed?: number;
  size?: ImportSize;
  counts?: Record<string, KindCounts>;
  error_count?: number;
  errors?: DbMessage[];
  warning_count?: number;
  warnings?: DbMessage[];
  doc_counters?: Record<string, number> | null;
  replayed?: boolean;
};

export type UndoResult = { status: "cancelled" | "undone" | "undoing"; import_id?: string; parts_left?: number; refused_count?: number; refused?: unknown };

export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;

/** An RPC's error, thrown as an Error with the database's own code (22023, 42501 ...) so the page can show it with friendlyError. */
export class ImportCallError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "ImportCallError";
    this.code = code;
  }
}

/**
 * A failure of the road, not of the database: the API gateway's 502 ("An invalid response was received from the upstream server", from a
 * connection it reused after the API had closed it) or a dropped connection. Such a call may never have reached the database.
 */
export const isTransportError = (error: { message: string; code?: string }) =>
  !error.code && /invalid response was received|bad gateway|failed to fetch|fetch failed|networkerror|load failed/i.test(error.message);

async function call<T>(rpc: Rpc, fn: string, args: Record<string, unknown>, options: { retryTransport?: boolean } = {}): Promise<T> {
  let { data, error } = await rpc(fn, args);
  // A check (dry run, staging, validating) writes nothing and is keyed, so it is sent once more, with the same key, when the road failed.
  if (error && options.retryTransport && isTransportError(error)) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    ({ data, error } = await rpc(fn, args));
  }
  if (error) throw new ImportCallError(error.message, error.code);
  // The answer is a record. One that arrives as JSON text is read; anything else is refused, never taken for a clean answer.
  const answer = typeof data === "string" ? safeParse(data) : data;
  if (answer === null || typeof answer !== "object" || Array.isArray(answer)) throw new ImportCallError("The database's answer wasn't one this page understands, so nothing was changed. Try again.");
  return answer as T;
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/** The payload cut into parts of about `weight` audit rows (a record 1, each line 1, an invoice 2, a credit note at least 2), in kind order. Every part names the file. */
export function chunkPayload(payload: ImportPayload, weight = IMPORT_PART_WEIGHT): ImportPayload[] {
  const parts: ImportPayload[] = [];
  let current: ImportPayload | null = null;
  let used = 0;
  for (const kind of IMPORT_KINDS) {
    for (const record of payload[kind] ?? []) {
      const lines = Array.isArray(record.lines) ? record.lines.length : 0;
      const w = 1 + (kind === "credit_notes" ? Math.max(lines, 1) : lines) + (kind === "invoices" ? 1 : 0);
      if (!current || (used > 0 && used + w > weight)) {
        current = { file_name: payload.file_name, file_sha256: payload.file_sha256 };
        parts.push(current);
        used = 0;
      }
      (current[kind] ??= []).push(record);
      used += w;
    }
  }
  return parts;
}

export type Progress = { phase: "staging" | "checking" | "committing" | "undoing"; done: number; total: number };

/**
 * The dry run: one call for a small file; for a large one every part is staged, then import_validate checks the WHOLE file at once.
 * Nothing is written either way. The path is chosen from the most the file can write (estimateSize): a single dry run of a large file
 * would run past Supabase's 8 s.
 */
export async function runDryRun(
  rpc: Rpc, payload: ImportPayload, ids: { importId: string; opId: string }, onProgress?: (p: Progress) => void,
): Promise<{ result: ImportResult; path: ReturnType<typeof importPath> }> {
  const path = importPath(estimateSize(payload));
  if (path.mode === "single") {
    const result = await call<ImportResult>(rpc, "import_company_data", { p_payload: payload, p_dry_run: true, p_client_op_id: ids.opId }, { retryTransport: true });
    return { result, path };
  }
  const parts = chunkPayload(payload);
  for (let i = 0; i < parts.length; i += 1) {
    onProgress?.({ phase: "staging", done: i, total: parts.length });
    await call(rpc, "import_stage_part", { p_import_id: ids.importId, p_part: i + 1, p_payload: parts[i] }, { retryTransport: true });
  }
  onProgress?.({ phase: "checking", done: parts.length, total: parts.length });
  const result = await call<ImportResult>(rpc, "import_validate", { p_import_id: ids.importId, p_part_weight: IMPORT_PART_WEIGHT, p_client_op_id: ids.opId }, { retryTransport: true });
  return { result, path };
}

/** Commits a small import: one call, one transaction. The same key on a retry answers the first result. */
export function commitSingle(rpc: Rpc, payload: ImportPayload, opId: string): Promise<ImportResult> {
  return call<ImportResult>(rpc, "import_company_data", { p_payload: payload, p_dry_run: false, p_client_op_id: opId });
}

/**
 * Commits a validated large import part by part, from `startPart` (1, or the part that failed). Stops at the first part that fails and says
 * which (the page offers Retry this part, and Undo). `opIds` keeps one key per part: a retry of a part sends the SAME key, so if the first
 * attempt did go in and only its answer was lost, 076 answers that part again and commits nothing twice.
 */
export async function commitParts(
  rpc: Rpc, importId: string, opIds: Map<number, string>, onProgress?: (p: Progress) => void, startPart = 1,
): Promise<{ last: ImportResult | null; failed: boolean; part: number; error?: Error }> {
  let last: ImportResult | null = null;
  let part = startPart;
  for (;;) {
    let key = opIds.get(part);
    if (!key) {
      key = crypto.randomUUID();
      opIds.set(part, key);
    }
    try {
      last = await call<ImportResult>(rpc, "import_commit_part", { p_import_id: importId, p_client_op_id: key });
    } catch (err) {
      return { last, failed: true, part, error: err instanceof Error ? err : new Error(String(err)) };
    }
    const total = last.parts ?? 0;
    if (!last.ok) return { last, failed: true, part };
    const done = last.parts_committed ?? part;
    onProgress?.({ phase: "committing", done, total });
    if (done >= total) return { last, failed: false, part };
    part += 1;
  }
}

/** Undoes (or cancels) a large import, one part per call, last first, until it says undone or cancelled. Records changed or used since are kept and reported. */
export async function undoImport(rpc: Rpc, importId: string, onProgress?: (p: Progress) => void): Promise<UndoResult> {
  let total = 0;
  for (let guard = 0; guard < 1100; guard += 1) {
    const result = await call<UndoResult>(rpc, "import_undo", { p_import_id: importId, p_client_op_id: crypto.randomUUID() });
    const left = result.parts_left ?? 0;
    total = Math.max(total, left + 1);
    onProgress?.({ phase: "undoing", done: Math.max(0, total - left - 1), total });
    if (result.status !== "undoing") return result;
  }
  throw new ImportCallError("The undo did not finish. Press Undo again.");
}
