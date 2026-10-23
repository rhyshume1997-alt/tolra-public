/**
 * What the Job Board shows for a job's files and description, the same on the Table, List and Cards views.
 *
 * A job converted from a quote keeps its drawings as job_files rows (kind 'drawing', references to the quote's attachments,
 * migration 034/058) and the customer's PO as kind 'customer_po' (067); the jobs.drawings column is only the older name list. The
 * board reads those rows with the person's own session (row-level security: same company, any of the four roles), no SQL change.
 */
import { fetchAll } from "@/lib/fetch-all";
import { supabase } from "@/lib/supabase";

export type BoardFiles = { drawings: string[]; attachments: string[] };

type FileRow = { job_id?: unknown; kind?: unknown; file_name?: unknown };

const EMPTY: BoardFiles = { drawings: [], attachments: [] };

/** Distinct, non-empty names in the order given. */
function distinctNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name && !seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

/** Group job_files rows by job: drawings, and the other attachments (the customer's PO). Rows of any other kind are ignored. */
export function groupBoardFiles(rows: readonly FileRow[]): Map<string, BoardFiles> {
  const map = new Map<string, BoardFiles>();
  for (const row of rows) {
    if (typeof row.job_id !== "string" || typeof row.file_name !== "string") continue;
    if (row.kind !== "drawing" && row.kind !== "customer_po") continue;
    const entry = map.get(row.job_id) ?? { drawings: [], attachments: [] };
    (row.kind === "drawing" ? entry.drawings : entry.attachments).push(row.file_name);
    map.set(row.job_id, entry);
  }
  for (const [id, entry] of map) map.set(id, { drawings: distinctNames(entry.drawings), attachments: distinctNames(entry.attachments) });
  return map;
}

/** Every job's current drawings and attachments in one paged read; null when they can't be read (the board still shows without them). */
export async function loadBoardJobFiles(): Promise<Map<string, BoardFiles> | null> {
  if (!supabase) return null;
  const client = supabase;
  try {
    const { rows } = await fetchAll((from, to) => client.from("job_files").select("id, job_id, kind, file_name")
      .in("kind", ["drawing", "customer_po"]).is("superseded_at", null).is("deleted_at", null).order("created_at").order("id").range(from, to));
    return groupBoardFiles(rows);
  } catch {
    return null;
  }
}

/** A job's drawings (the older jobs.drawings names plus its job_files rows) and attachments, each name once. */
export function jobBoardFiles(job: { id: string; drawings?: readonly string[] }, byJob: ReadonlyMap<string, BoardFiles> | null | undefined): BoardFiles {
  const files = byJob?.get(job.id) ?? EMPTY;
  return { drawings: distinctNames([...(job.drawings ?? []), ...files.drawings]), attachments: files.attachments };
}

/** The text a conversion writes when it has nothing better ("Converted from SO-0002", convert_sales_order). */
const PLACEHOLDER = /^\s*Converted from\s+\S+\s*$/i;
/** A line of the workshop specification the conversion writes: "- <description> [<part / drawing>] x <quantity>". */
const SPEC_LINE = /^- (.+?)(?: \[[^\]]*\])? x [\d.,]+\s*$/;
export const MAX_DESCRIPTION_LENGTH = 300;

/**
 * The description to show for a job. A job made from an accepted quote is described as "Converted from SO-0002", which says nothing
 * about the work; its specification already lists the ordered quote lines, so the board shows those descriptions instead (distinct,
 * in order, cut at MAX_DESCRIPTION_LENGTH). Any description a person wrote is shown as it is.
 */
export function boardDescription(description: string | null | undefined, specification: string | null | undefined): string {
  const text = description ?? "";
  if (!PLACEHOLDER.test(text)) return text;
  const lines = distinctNames((specification ?? "").split("\n").flatMap((line) => SPEC_LINE.exec(line)?.[1] ?? []));
  if (!lines.length) return text;
  const joined = lines.join("; ");
  return joined.length > MAX_DESCRIPTION_LENGTH ? `${joined.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…` : joined;
}

/**
 * The Job Board's wide Table view: the column headings between the selection box and Actions (those two are always there), with
 * their widths. There is ONE work column, Description (boardDescription already carries the quote lines); the raw auto-written
 * specification is not a column of its own, so it does not repeat the job's work. Nothing reads a saved column preference here,
 * so a stored "specification" entry is never looked at.
 */
export const JOB_TABLE_COLUMNS: ReadonlyArray<{ label: string; width: string }> = [
  { label: "Job No", width: "w-28" }, { label: "Customer", width: "w-44" }, { label: "Description", width: "w-64" },
  { label: "Drawings", width: "w-56" }, { label: "Stage", width: "w-28" }, { label: "Machine", width: "w-56" },
  { label: "Operator", width: "w-44" }, { label: "Due", width: "w-28" }, { label: "Started", width: "w-36" },
  { label: "Finished", width: "w-36" }, { label: "Status", width: "w-44" },
];
