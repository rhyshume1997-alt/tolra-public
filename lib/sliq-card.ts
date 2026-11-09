/**
 * The SliQ go-live import card's decisions, kept pure so they are unit-tested without a browser (components/sliq-import.tsx).
 */
import { friendlyError } from "@/lib/friendly-error";
import {
  type Rpc, type SliqBatchResult, type SliqPayload, type SliqPreflight, type SliqRunProgress, SLIQ_BATCH_WEIGHT, isRunLabel, planSliqBatches, preflightTooLarge,
  sliqPreflight, sliqRunBatches,
} from "@/lib/sliq-import-route";
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

/** Records this run wrote: a batch already imported (a replay, which carries the first run's counts) wrote nothing. */
export const recordsCreated = (results: Pick<SliqBatchResult, "already_imported" | "created">[]): number =>
  results.reduce((s, r) => s + (r.already_imported ? 0 : r.created ?? 0), 0);

/** The database has no such function: release 152 is not applied on this project (PostgREST PGRST202, or Postgres 42883). */
export function isMissingImportFunction(error: { message?: string; code?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "PGRST202" || error.code === "42883" || /could not find the function|function .* does not exist/i.test(error.message ?? "");
}
export const MISSING_152 = "This database does not have the SliQ import route (release 152) yet. Nothing was changed. Apply and verify release 152 first.";

/** Postgres 57014: the database stopped the call at its time limit (hosted: 8 s). The call's transaction is rolled back whole. */
export const isStatementTimeout = (error: { code?: string } | null | undefined) => error?.code === "57014";
/**
 * The plain words for a statement timeout, per step (candidate 2F). Nothing is retried for it (lib/sliq-import-route retries only a
 * failure of the road, which has no code): the same call would take as long again.
 */
export function statementTimeoutMessage(step: "preflight" | "batch" | "reconcile"): string {
  const what = step === "preflight"
    ? "The preflight took longer than the database's time limit and was stopped. Nothing was written (the preflight never writes)."
    : step === "batch"
      ? "This batch took longer than the database's time limit and was stopped. Nothing in this batch was written: it was rolled back whole. Batches before it are in Tolra and answer \"already imported\" if sent again."
      : "The reconciliation took longer than the database's time limit and was stopped. It only reads, so nothing was changed.";
  return `${what} Don't keep retrying: it would take as long again. Tell Rhys, or split the export by date into smaller file sets.`;
}

type Store = Pick<Storage, "getItem" | "setItem">;
/**
 * The counters read before an import, kept per source file set (its source key) only: a reload, or a change of run label, keeps
 * them. Written ONCE per file set: a preflight after the import must not replace them with the counters the import produced.
 */
export const countersKey = (sourceSha: string) => `sliq-counters-before:${sourceSha}`;
export function saveCountersBefore(store: Store | null, sourceSha: string, counters: Record<string, number>, options: { nothingImportedYet?: boolean } = {}):
  Record<string, number> {
  // Nothing of this file set is in Tolra yet (a first preflight, or after a restore of the pre-import backup): what the database says
  // now IS "before", so it replaces anything stored. Otherwise the first reading is kept.
  const kept = options.nothingImportedYet ? null : loadCountersBefore(store, sourceSha);
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

export type CardPhase = "idle" | "checked" | "preflighted" | "importing" | "done" | "failed";

/** The INV-gap override sent with every preflight and batch: on only when the admin ticked the box (strictly true), else off. */
export const invGapOptions = (ticked: unknown): { allowInvGap: boolean } => ({ allowInvGap: ticked === true });

/**
 * After the INV-gap box changes (either way): the preflight made under the old answer no longer stands, also after a failed batch;
 * the card goes back to "checked" and the preflight must be run again before Import.
 */
export function afterInvGapChange(phase: CardPhase): { phase: CardPhase; clearPreflight: true; clearFailure: boolean } {
  const back = phase === "preflighted" || phase === "failed";
  return { phase: back ? "checked" : phase, clearPreflight: true, clearFailure: back };
}

/** Import can start only after a clean preflight (phase "preflighted") with nothing blocking it, and never while a run is going. */
export const canStartImport = (phase: CardPhase, blockers: string[], running: boolean) => phase === "preflighted" && blockers.length === 0 && !running;

/**
 * Where the batch plan does not carry every row of the payload (candidate 2F, final pass): per section, the rows in the batches plus
 * the orphans the page refuses must equal the rows built from the files. Suppliers matter most: the database's reconciliation does
 * not count them, so a plan that dropped them would otherwise pass everything. Empty when it matches.
 */
export function planCountProblems(payload: SliqPayload, weight = SLIQ_BATCH_WEIGHT): string[] {
  const plan = planSliqBatches(payload, weight);
  const out: string[] = [];
  for (const k of ["customers", "suppliers", "invoices", "payments", "credit_notes"] as const) {
    const planned = plan.batches.reduce((n, b) => n + (b.rows[k] ?? []).length, 0)
      + (k === "payments" ? plan.orphanPayments.length : k === "credit_notes" ? plan.orphanCredits.length : 0);
    const built = (payload[k] ?? []).length;
    if (planned !== built) out.push(`${k}: ${built} in the files but ${planned} in the import plan`);
  }
  return out;
}

/** The card's preflight: refused in the page when too large (nothing sent), else one call with the INV-gap answer; plain words on failure. */
export async function runSliqPreflightStep(rpc: Rpc, payload: SliqPayload, allowInvGap: boolean): Promise<{ preflight: SliqPreflight; message?: undefined } | { preflight?: undefined; message: string }> {
  const tooLarge = preflightTooLarge(payload);
  if (tooLarge) return { message: tooLarge };
  try {
    return { preflight: await sliqPreflight(rpc, payload, invGapOptions(allowInvGap)) };
  } catch (e) {
    const ce = e as { code?: string; message?: string };
    return { message: isMissingImportFunction(ce) ? MISSING_152 : isStatementTimeout(ce) ? statementTimeoutMessage("preflight") : friendlyError(e) };
  }
}

/**
 * The card's import from batch `startAt`: nothing is sent when the plan does not carry every row; otherwise the batches in order with
 * the INV-gap answer, stopping at the first that fails (lib/sliq-import-route), and the failure in plain words. Never throws.
 */
export async function runSliqImportStep(
  rpc: Rpc, payload: SliqPayload, label: string, startAt: number, allowInvGap: boolean, onProgress?: (p: SliqRunProgress) => void,
  problems: string[] = planCountProblems(payload),
): Promise<{ results: SliqBatchResult[]; failedAt: number | null; failure: string | null }> {
  if (problems.length) return { results: [], failedAt: startAt, failure: `Nothing was sent: the import plan does not carry every row of the files (${problems.join("; ")}).` };
  let out: Awaited<ReturnType<typeof sliqRunBatches>>;
  try {
    out = await sliqRunBatches(rpc, payload, label, onProgress, startAt, SLIQ_BATCH_WEIGHT, invGapOptions(allowInvGap));
  } catch (e) {
    return { results: [], failedAt: startAt, failure: friendlyError(e) };
  }
  if (out.failedAt === null) return { results: out.results, failedAt: null, failure: null };
  const failure = out.error
    ? (isStatementTimeout(out.error as { code?: string }) ? statementTimeoutMessage("batch") : friendlyError(out.error))
    : (out.last?.errors ?? []).slice(0, 5).map((m) => `${m.source_row_id ?? ""} ${m.message}`).join("; ");
  return { results: out.results, failedAt: out.failedAt, failure };
}
