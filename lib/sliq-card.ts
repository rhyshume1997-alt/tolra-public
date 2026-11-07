/**
 * The SliQ go-live import card's decisions, kept pure so they are unit-tested without a browser (components/sliq-import.tsx).
 */
import { isRunLabel, type SliqPreflight } from "@/lib/sliq-import-route";
import { ALL_ENTITIES, type Entity, type SliqMapping } from "@/lib/sliq-validate/validate";

/** The run label as the database takes it (trimmed, lower case), and a message when that is not what was typed. */
export function normaliseRunLabel(typed: string): { label: string; note: string | null; valid: boolean } {
  const label = typed.trim().toLowerCase();
  const valid = isRunLabel(label);
  if (!valid) return { label, valid, note: "A run label is lower-case letters, digits and hyphens (at most 40), starting with a letter or digit." };
  return { label, valid, note: label !== typed ? `The run label is used as "${label}" (spaces removed, lower case).` : null };
}

/**
 * Which chosen files are which entity, by EXACT file name as the mapping says. Lists files that match nothing and entities with no
 * file, so a renamed file is reported instead of quietly left out.
 */
export function matchFiles(mapping: SliqMapping | null, names: string[]): { byEntity: Partial<Record<Entity, string>>; unmatched: string[]; missing: Entity[]; problems: string[] } {
  const csv = names.filter((n) => !n.toLowerCase().endsWith(".json"));
  if (!mapping) {
    return { byEntity: {}, unmatched: csv, missing: [], problems: names.some((n) => n.toLowerCase().endsWith(".json")) ? [] : ["No mapping (.json) was chosen: choose it together with the SliQ files."] };
  }
  const wanted = ALL_ENTITIES.filter((e) => e !== "creditNotes" || mapping.entities.creditNotes !== undefined);
  const byEntity: Partial<Record<Entity, string>> = {};
  const unmatched: string[] = [];
  for (const n of csv) {
    const e = wanted.find((w) => mapping.entities[w]?.file === n);
    if (e) byEntity[e] = n;
    else unmatched.push(n);
  }
  const missing = wanted.filter((e) => !byEntity[e]);
  const problems: string[] = [];
  for (const n of unmatched) {
    const near = wanted.find((w) => mapping.entities[w]?.file.toLowerCase() === n.toLowerCase());
    problems.push(near ? `"${n}" is not named exactly as the mapping says ("${mapping.entities[near]!.file}"): rename the copy or fix the mapping.`
      : `"${n}" is not a file the mapping names: it is not used.`);
  }
  for (const e of missing) problems.push(`No file for ${e}: the mapping expects "${mapping.entities[e]!.file}".`);
  return { byEntity, unmatched, missing, problems };
}

/** Why "Import" can't be pressed yet, in words (empty when it can). */
export function importBlockers(s: { preflighted: boolean; preflight: SliqPreflight | null; orphanPayments: number; orphanCredits: number; labelValid: boolean; running: boolean }): string[] {
  const out: string[] = [];
  if (s.running) out.push("An import is running.");
  if (!s.preflighted || !s.preflight) out.push("Run the preflight first.");
  else if (!s.preflight.ok) out.push(`The preflight found ${s.preflight.error_count} problem(s): fix them in the source files or the mapping, then check again.`);
  if (s.orphanPayments) out.push(`${s.orphanPayments} payment(s) name an invoice that is not in the invoices file.`);
  if (s.orphanCredits) out.push(`${s.orphanCredits} credit note(s) name an invoice that is not in the invoices file.`);
  if (!s.labelValid) out.push("The run label is not valid.");
  return out;
}

/** The database has no such function: release 152 is not applied on this project (PostgREST PGRST202, or Postgres 42883). */
export function isMissingImportFunction(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "PGRST202" || error.code === "42883" || /could not find the function|function .* does not exist/i.test(error.message ?? "");
}
export const MISSING_152 = "This database does not have the SliQ import route (release 152) yet. Nothing was changed. Apply and verify release 152 first.";

type Store = Pick<Storage, "getItem" | "setItem">;
/**
 * The counters read before an import, kept per source file set (its source key) only: a reload, or a change of run label, keeps
 * them. Written ONCE per file set: a preflight after the import must not replace them with the counters the import produced.
 */
export const countersKey = (sourceSha: string) => `sliq-counters-before:${sourceSha}`;
export function saveCountersBefore(store: Store | null, sourceSha: string, counters: Record<string, number>): Record<string, number> {
  const kept = loadCountersBefore(store, sourceSha);
  if (kept) return kept;
  try { store?.setItem(countersKey(sourceSha), JSON.stringify(counters)); } catch { /* storage full or blocked: the card warns */ }
  return counters;
}
export function loadCountersBefore(store: Store | null, sourceSha: string): Record<string, number> | null {
  try {
    const raw = store?.getItem(countersKey(sourceSha));
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    return Object.values(v).every((n) => typeof n === "number") ? (v as Record<string, number>) : null;
  } catch {
    return null;
  }
}
