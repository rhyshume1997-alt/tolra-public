/**
 * A Problem on a job (migration 117): the operator taps Problem on My jobs, picks a reason and may add a note; the job then carries a
 * visible "Problem" flag (My jobs, the Job Board, Needs attention for admin and office) until admin or office clear it with a note. Nothing
 * here blocks Start, Pause or Finish. Raising needs a connection (it is written by report_job_problem, never queued offline).
 *
 * Fail closed: until 117 is applied the table and the two functions do not exist. A read that says so (missingDbObject) is "not available":
 * every Problem control stays hidden and the flags and the Needs attention rule show nothing. Any other failed read is "unknown", which also
 * hides the controls (a write waits for a real yes) and shows no flag.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { missingDbObject } from "@/lib/db-features";
import { isNetworkError } from "@/lib/offline/store";

export const PROBLEM_REASONS = [
  { value: "material", label: "Material" },
  { value: "drawing", label: "Drawing" },
  { value: "machine", label: "Machine" },
  { value: "quality", label: "Quality" },
  { value: "tooling", label: "Tooling" },
  { value: "other", label: "Other" },
] as const;
export type ProblemReason = (typeof PROBLEM_REASONS)[number]["value"];

export const PROBLEM_NOTE_MAX = 500;
export const RESOLUTION_NOTE_MIN = 3;
export const NEEDS_CONNECTION = "Reporting a problem needs a connection";

export function reasonLabel(reason: string | null | undefined): string {
  return PROBLEM_REASONS.find((r) => r.value === reason)?.label ?? "Other";
}

export type OpenProblem = { id: string; job_id: string; reason: ProblemReason; note: string | null; reported_by: string | null; reported_at: string };

/** What a read of the open problems answered: `available` is true (117 is there), false (the table is missing) or null (could not tell). */
export type OpenProblems = { available: boolean | null; problems: OpenProblem[] };

const COLUMNS = "id, job_id, reason, note, reported_by, reported_at";

/** The company's open problems, newest first, optionally only for some jobs. Never throws: a failure is `available: null`, a missing table `false`. */
export async function loadOpenProblems(db: Pick<SupabaseClient, "from">, jobIds?: readonly string[]): Promise<OpenProblems> {
  if (jobIds && jobIds.length === 0) return { available: null, problems: [] };
  try {
    let query = db.from("job_problems").select(COLUMNS).eq("status", "open").order("reported_at", { ascending: false }).limit(500);
    if (jobIds) query = query.in("job_id", [...jobIds]);
    const { data, error } = await query;
    if (error) return { available: missingDbObject(error) ? false : null, problems: [] };
    return { available: true, problems: (data ?? []) as OpenProblem[] };
  } catch {
    return { available: null, problems: [] };
  }
}

/** The open problems of one job. */
export const problemsFor = (problems: readonly OpenProblem[], jobId: string) => problems.filter((p) => p.job_id === jobId);

/** The ids of the jobs that carry at least one open problem. */
export const jobsWithProblems = (problems: readonly OpenProblem[]): ReadonlySet<string> => new Set(problems.map((p) => p.job_id));

/** The flag on a job's card: the word, how many, and what it is about. Null when the job has no open problem. */
export function problemFlag(problems: readonly OpenProblem[]): { word: "Problem"; count: number; detail: string } | null {
  if (!problems.length) return null;
  const reasons = [...new Set(problems.map((p) => reasonLabel(p.reason)))];
  return { word: "Problem", count: problems.length, detail: `${problems.length === 1 ? "Problem reported" : `${problems.length} problems reported`}: ${reasons.join(", ")}. Waiting for the office.` };
}

export type ProblemControls = {
  /** The Problem button is on the card. */
  showReport: boolean;
  /** The office can clear problems (the Job Board panel offers Resolve). */
  canResolve: boolean;
  /** Said under the button when reporting can't be done right now (null: it can). */
  note: string | null;
};

/**
 * Who sees what. `available` is the database's answer (true only when 117 is there); a role that can't raise (viewer) gets no button; a
 * support session without write access can't raise or clear. `online` false: the button is shown but says it needs a connection.
 */
export function problemControls(input: { available: boolean | null; role: string | null | undefined; online: boolean; readOnly?: boolean }): ProblemControls {
  const staff = input.role === "admin" || input.role === "office";
  const raises = staff || input.role === "workshop";
  if (input.available !== true) return { showReport: false, canResolve: false, note: null };
  const writes = !input.readOnly;
  return {
    showReport: raises && writes,
    canResolve: staff && writes,
    note: raises && writes && !input.online ? NEEDS_CONNECTION : null,
  };
}

/** What a failed report says: a connection problem, or the database's own refusal in words. */
export function reportFailure(err: unknown): string {
  if (isNetworkError(err)) return NEEDS_CONNECTION;
  const e = err as { code?: string; message?: string } | null;
  if (missingDbObject(e)) return "Problem reports aren't available yet.";
  if (e?.code === "42501") return "You can only report a problem on a job assigned to you.";
  if (e?.code === "P0002") return "That job couldn't be found.";
  return "The problem wasn't reported. Try again.";
}

/** The key sent with a report. The same text of the same report keeps its key, so a retry after a lost answer is the same problem. */
export function requestKeyFor(previous: { key: string; signature: string } | null, signature: string, make: () => string): { key: string; signature: string } {
  return previous && previous.signature === signature ? previous : { key: make(), signature };
}

export const reportSignature = (jobId: string, reason: string, note: string) => JSON.stringify([jobId, reason, note.trim()]);

export async function reportJobProblem(db: Pick<SupabaseClient, "rpc">, jobId: string, reason: ProblemReason, note: string, requestId: string): Promise<string> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error(NEEDS_CONNECTION);
  const { data, error } = await db.rpc("report_job_problem", { p_job: jobId, p_reason: reason, p_note: note.trim() || null, p_request_id: requestId });
  if (error) throw error;
  return String(data);
}

export async function resolveJobProblem(db: Pick<SupabaseClient, "rpc">, problemId: string, note: string): Promise<void> {
  const { error } = await db.rpc("resolve_job_problem", { p_problem: problemId, p_note: note.trim() });
  if (error) throw error;
}
