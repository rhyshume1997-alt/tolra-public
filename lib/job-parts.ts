/**
 * Parts done on a job (migration 118): the operator taps "+1 part" on My jobs; every screen then shows "N of M parts" (N logged, M the job's
 * quantity required) on My jobs, the Whole floor and the Job Board's job details. The log is append-only: a wrong tap is put right with a
 * negative entry and a note (3 to 250 characters), never edited; the total is kept between 0 and M by the database.
 *
 * Logging parts is ONLINE ONLY. It is written by log_job_parts and never put in the offline outbox: the outbox replays in order and asks
 * before it replays, and a count the server may refuse (it would go above M, or below 0) must never be shown as saved. Offline, the buttons
 * say so and nothing is queued.
 *
 * Fail closed: until 118 is applied the table and both functions do not exist. A read that says so (missingDbObject) is "not available":
 * every parts control and every "N of M" stays hidden. Any other failed read is "unknown", which hides them too (a count is never shown as
 * 0 for a read that failed), and a write waits for a real yes.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { missingDbObject } from "@/lib/db-features";
import { isNetworkError } from "@/lib/offline/store";
import { requiredParts } from "@/lib/parts-quantity";

export const PARTS_NOTE_MIN = 3;
export const PARTS_NOTE_MAX = 250;
export const PARTS_ENTRY_MAX = 100_000;
export const NEEDS_CONNECTION = "Logging parts needs a connection. Nothing was saved.";
/** Jobs asked about per request (the URL stays short and one failed chunk fails the whole answer). */
const CHUNK = 100;

/** What a read of the totals answered: `available` is true (118 is there), false (it is not) or null (could not tell). `done`: job id to N. */
export type PartsTotals = { available: boolean | null; done: ReadonlyMap<string, number> };
export const NO_PARTS: PartsTotals = { available: null, done: new Map() };

/** The parts done on each of these jobs. A job with no entries is 0 (the database returns no row for it). Never throws. */
export async function loadPartsDone(db: Pick<SupabaseClient, "rpc">, jobIds: readonly string[]): Promise<PartsTotals> {
  const ids = [...new Set(jobIds.filter(Boolean))];
  if (!ids.length) return NO_PARTS;
  try {
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
    const answers = await Promise.all(chunks.map((p_jobs) => db.rpc("job_parts_done", { p_jobs })));
    const done = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const answer of answers) {
      if (answer.error) return { available: missingDbObject(answer.error) ? false : null, done: new Map() };
      for (const row of (answer.data ?? []) as Array<{ job_id: string; parts_done: number }>) {
        if (typeof row?.job_id === "string" && Number.isFinite(Number(row.parts_done))) done.set(row.job_id, Number(row.parts_done));
      }
    }
    return { available: true, done };
  } catch {
    return NO_PARTS;
  }
}

export { requiredParts };

/** "12 of 50 parts" (in words, never a bar alone). Null when it can't be told truthfully: 118 absent or unknown, no job total, or no M. */
export function partsText(totals: Pick<PartsTotals, "available" | "done">, jobId: string, quantity: number | string | null | undefined): string | null {
  if (totals.available !== true) return null;
  const required = requiredParts(quantity);
  const done = totals.done.get(jobId);
  if (required === null || done === undefined) return null;
  return `${done} of ${required} part${required === 1 ? "" : "s"}`;
}

export type PartsControls = {
  /** The "+1 part" button and the change-count form are on the card. */
  show: boolean;
  /** "+1 part" can be tapped now (the count is below M). */
  canAdd: boolean;
  /** "Take parts off" can be used now (the count is above 0). */
  canTakeOff: boolean;
  /** Said beside the buttons when logging can't be done right now (null: it can). */
  note: string | null;
};

/**
 * Who sees what. `available` is the database's answer (true only when 118 is there); admin, office and workshop log (the server holds a
 * workshop person to jobs assigned to them, which is what My jobs lists); a viewer gets none; a job without a quantity gets none. `online`
 * false: the buttons stay but say it needs a connection.
 */
export function partsControls(input: { available: boolean | null; role: string | null | undefined; online: boolean; readOnly?: boolean; required: number | null; done: number | undefined }): PartsControls {
  const logs = input.role === "admin" || input.role === "office" || input.role === "workshop";
  if (input.available !== true || !logs || input.readOnly || input.required === null || input.done === undefined) return { show: false, canAdd: false, canTakeOff: false, note: null };
  return {
    show: true,
    canAdd: input.done < input.required,
    canTakeOff: input.done > 0,
    note: input.online ? (input.done >= input.required ? "All the parts are logged." : null) : NEEDS_CONNECTION,
  };
}

/** What a failed entry says, in words: a connection problem, or the database's own refusal. */
export function partsFailure(err: unknown): string {
  if (isNetworkError(err)) return NEEDS_CONNECTION;
  const e = err as { code?: string; message?: string } | null;
  if (missingDbObject(e)) return "Counting parts isn't available yet.";
  const message = e?.message ?? "";
  if (e?.code === "22003") return /below 0/i.test(message) ? "That would take the count below 0. Nothing was saved." : "That would take the count above the quantity required. Nothing was saved.";
  if (e?.code === "42501") return "You can only log parts on a job assigned to you.";
  if (e?.code === "55000") return "That job is finished. Nothing was saved.";
  if (e?.code === "P0002") return "That job couldn't be found.";
  if (e?.code === "22023" && /no quantity/i.test(message)) return "That job has no quantity to count against.";
  if (e?.code === "22023") return "That entry isn't valid. Nothing was saved.";
  return "The parts weren't logged. Try again.";
}

/**
 * The key sent with an entry. Each new tap is a new key, so two taps are two parts; an entry that did not get a definite answer (the
 * connection dropped, so the server may or may not have it) keeps its key, so sending the same entry again is still one entry.
 */
export function opKeyFor(previous: { key: string; signature: string } | null, signature: string, make: () => string): { key: string; signature: string } {
  return previous && previous.signature === signature ? previous : { key: make(), signature };
}

export const entrySignature = (jobId: string, quantity: number, note: string) => JSON.stringify([jobId, quantity, note.trim()]);

/** True when the failure left the outcome unknown (the entry may have been saved), so its key must be kept for the retry. */
export const outcomeUnknown = (err: unknown) => isNetworkError(err) || !(err && typeof err === "object" && "code" in err && typeof (err as { code?: unknown }).code === "string" && (err as { code: string }).code.length > 0);

/** Validates a typed entry before it is sent. `takeOff`: a correction (negative) that must say why. Returns the signed quantity, or the words. */
export function parseEntry(input: { amount: string; takeOff: boolean; note: string }): { ok: true; quantity: number; note: string } | { ok: false; message: string } {
  const text = input.amount.trim();
  if (!/^\d+$/.test(text)) return { ok: false, message: "Enter a whole number of parts." };
  const amount = Number(text);
  if (amount < 1 || amount > PARTS_ENTRY_MAX) return { ok: false, message: `Enter a number from 1 to ${PARTS_ENTRY_MAX.toLocaleString("en-GB")}.` };
  const note = input.note.trim();
  if (note.length > PARTS_NOTE_MAX) return { ok: false, message: `Keep the note to ${PARTS_NOTE_MAX} characters.` };
  if (input.takeOff && note.length < PARTS_NOTE_MIN) return { ok: false, message: `Say why you are taking parts off (at least ${PARTS_NOTE_MIN} characters).` };
  return { ok: true, quantity: input.takeOff ? -amount : amount, note };
}

/** Logs parts (positive) or takes parts off (negative, with a note). Needs a connection: nothing is queued. */
export async function logJobParts(db: Pick<SupabaseClient, "rpc">, jobId: string, quantity: number, note: string, opId: string): Promise<string> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new Error(NEEDS_CONNECTION);
  const { data, error } = await db.rpc("log_job_parts", { p_job: jobId, p_quantity: quantity, p_note: note.trim() || null, p_client_op_id: opId });
  if (error) throw error;
  return String(data);
}
