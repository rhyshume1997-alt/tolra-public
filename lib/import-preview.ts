/**
 * Admin > Data: what the preview shows, worked out from the database's dry run (076, 085) and the payload that was sent. Per kind: created, matched
 * (skipped: a matched row is never updated), linked, problems; one line per problem or warning with the file's row.
 */
import type { DbMessage, ImportResult } from "@/lib/data-import";
import type { BuiltImport } from "@/lib/import-build";
import { IMPORT_KINDS, type ImportKind, KIND_LABEL } from "@/lib/import-targets";

export type PreviewRow = {
  kind: ImportKind;
  /** Rows in the file for this kind. */
  rows: number;
  created: number;
  matched: number;
  /** Created records that took their link to another record (null: this kind has no links). */
  linked: number | null;
  problems: number;
  warnings: number;
};

/** The fields that link a record to another by number, per kind (076 links by document number first, then by name). */
const LINK_FIELDS: Partial<Record<ImportKind, string[]>> = {
  sales_orders: ["quote_ref"], jobs: ["quote_ref", "so_number"], invoices: ["job_no"], delivery_notes: ["job_no", "so_number", "invoice_ref"],
};

const NOT_LINKED = /^Not linked to/;

/**
 * Linked = created records the file gave a link for, less the ones 076 warned it could not link ("Not linked to ..."). The database does
 * not count links, so this is that difference, never more than created. A payment and a credit note are always written with their
 * invoice: all linked.
 */
export function previewRows(built: BuiltImport, result: ImportResult): PreviewRow[] {
  const rows: PreviewRow[] = [];
  for (const kind of IMPORT_KINDS) {
    const counts = result.counts?.[kind];
    const inFile = built.records[kind];
    if (!inFile && !counts) continue;
    const created = counts?.created ?? 0;
    const warnings = (result.warnings ?? []).filter((w) => w.kind === kind);
    let linked: number | null = null;
    if (kind === "payments" || kind === "credit_notes") linked = created;
    else if (LINK_FIELDS[kind]) {
      const fields = LINK_FIELDS[kind]!;
      const given = (built.payload[kind] ?? []).filter((record) => fields.some((f) => typeof record[f] === "string" && String(record[f]).trim() !== "")).length;
      // One record may say "Not linked to ..." for each of its links: it counts once.
      const unlinked = new Set(warnings.filter((w) => NOT_LINKED.test(w.message)).map((w, i) => w.row ?? `#${i}`)).size;
      linked = Math.max(0, Math.min(created, given) - unlinked);
    }
    rows.push({
      kind, rows: inFile, created, matched: counts?.matched_existing ?? 0, linked,
      problems: (result.errors ?? []).filter((e) => e.kind === kind).length, warnings: warnings.length,
    });
  }
  return rows;
}

/** "Invoices, row 4, invoice_ref: Invoice number is required." */
export function describeMessage(m: Pick<DbMessage, "kind" | "row" | "field" | "message">): string {
  const where = [m.kind ? KIND_LABEL[m.kind] : null, m.row !== null && m.row !== undefined ? `row ${m.row}` : null, m.field].filter(Boolean).join(", ");
  return where ? `${where}: ${m.message}` : m.message;
}

/** The dry run is clean: the database found no problem and nothing was left out of the check. Warnings do not stop an import. */
export function isClean(result: ImportResult | null, clientProblems: number): boolean {
  return Boolean(result && result.ok && (result.error_count ?? 0) === 0 && clientProblems === 0);
}

export function totalCreated(result: ImportResult | null): number {
  return Object.values(result?.counts ?? {}).reduce((sum, c) => sum + (c.created ?? 0), 0);
}

/** "INV-0001": the next number Tolra issues, from the counters 076 reseeds (a counter holds the last number used). */
export function nextNumbers(counters: Record<string, number> | null | undefined): string[] {
  return Object.entries(counters ?? {})
    .filter(([prefix]) => ["QUO", "INV", "PO", "SO", "J", "DLN"].includes(prefix))
    .map(([prefix, last]) => `${prefix}-${String(last + 1).padStart(4, "0")}`);
}
