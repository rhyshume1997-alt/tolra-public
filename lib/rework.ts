import { supabase } from "@/lib/supabase";

/**
 * Failed inspection and rework (migration 037). A failed inspection opens a rework record for the workshop: the reason, the quantity
 * affected, the instructions. The workshop starts it, books hours and material against it, scraps what can't be saved, and finishes it;
 * the job then goes back to awaiting inspection. The database does the work (the functions below); this file is the browser's side.
 */
export type ReworkStatus = "open" | "in_progress" | "finished" | "closed";

export type ReworkRecord = {
  id: string;
  job_id: string;
  inspection_id: string | null;
  status: ReworkStatus;
  reason: string;
  instructions: string;
  affects_all: boolean;
  quantity_affected: number | null;
  quantity_scrapped: number;
  quantity_remade: number;
  assigned_to: "workshop";
  raised_by: string | null;
  raised_at: string;
  started_by: string | null;
  started_at: string | null;
  finished_by: string | null;
  finished_at: string | null;
  closed_by: string | null;
  closed_at: string | null;
  closed_how: "passed" | "concession" | "superseded" | null;
  /** The order line that failed (a job made from a sales order; the quantities are then that line's), and the batch if given. */
  sales_order_line_id: string | null;
  batch_ref: string | null;
  /** A replacement rework: opened for the replacements a closed rework still owed (open_replacement_rework). */
  follow_up_of: string | null;
  /** Replacements a closed rework handed to a replacement rework. */
  quantity_carried: number;
};

export type ReworkEntry = {
  id: string;
  rework_id: string;
  kind: "hours" | "material" | "scrap" | "remake";
  hours: number | null;
  quantity: number | null;
  description: string | null;
  created_by: string | null;
  created_at: string;
};

export type ReworkSummary = {
  job_id: string;
  quantity_required: number | null;
  cycles: number;
  live_rework_id: string | null;
  live_status: ReworkStatus | null;
  quantity_in_rework: number;
  quantity_scrapped: number;
  remaining_to_make: number;
  rework_hours: number;
  material_items: number;
  /** Only for admin and office; null for everyone else. */
  material_cost: number | null;
  /** What may go out now (job_release_state): only the part in rework, and replacements still to make, are held. */
  released?: boolean;
  quantity_held?: number;
  /** Null when the job has no quantity (then a released job goes out as a whole). */
  quantity_available?: number | null;
  /** Why nothing of the job may go out (what is held can't be weighed), and what to set; null otherwise. */
  blocked?: string | null;
  /** Per order line (a job made from a sales order): what is held, still to make, and may go out. */
  lines?: ReworkLine[];
  /** How many reworks are live (one per failed order line). */
  live_count?: number;
};

export type ReworkLine = { line_id: string; description: string; ordered: number; held: number; missing: number; available: number; batches: string | null };

export const REWORK_STATUS_LABELS: Record<ReworkStatus, string> = {
  open: "Waiting for the workshop",
  in_progress: "Rework under way",
  finished: "Reworked: awaiting re-inspection",
  closed: "Closed",
};

export const CLOSED_LABELS: Record<NonNullable<ReworkRecord["closed_how"]>, string> = {
  passed: "Passed re-inspection",
  concession: "Released on a concession",
  superseded: "Failed again",
};

/** "All 10" or "4 of 10", for the board and the dialogs. */
export function quantityText(rework: Pick<ReworkRecord, "affects_all" | "quantity_affected">, ofJob?: number | string | null): string {
  const total = ofJob === null || ofJob === undefined || ofJob === "" ? null : Number(ofJob);
  if (rework.quantity_affected === null) return "All";
  if (rework.affects_all) return `All ${rework.quantity_affected}`;
  return total && Number.isFinite(total) ? `${rework.quantity_affected} of ${total}` : String(rework.quantity_affected);
}

/** Every rework the signed-in person can see (newest first), or one job's. */
export async function loadReworks(jobId?: string): Promise<ReworkRecord[]> {
  if (!supabase) return [];
  let query = supabase.from("job_rework").select("*").order("raised_at", { ascending: false }).limit(jobId ? 50 : 2000);
  if (jobId) query = query.eq("job_id", jobId);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as ReworkRecord[];
}

export async function loadReworkEntries(reworkIds: string[]): Promise<ReworkEntry[]> {
  if (!supabase || !reworkIds.length) return [];
  const { data, error } = await supabase.from("job_rework_entries").select("id, rework_id, kind, hours, quantity, description, created_by, created_at").in("rework_id", reworkIds).order("created_at");
  if (error) throw error;
  return (data ?? []) as ReworkEntry[];
}

export async function loadReworkSummary(jobId: string): Promise<ReworkSummary> {
  if (!supabase) throw new Error("Supabase is not configured.");
  const { data, error } = await supabase.rpc("job_rework_summary", { p_job: jobId });
  if (error) throw error;
  return data as ReworkSummary;
}

function client() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

/** One order line that failed: how many of it (null: all of that line), and its batch. */
export type FailedLine = { line_id: string; quantity: number | null; batch?: string | null };

/**
 * Records a failed inspection. For a job made from a sales order, lines names the order line(s) that failed, so only those are held;
 * quantity (of the job) is for a job not made from an order, or one whose order has a single line of the job's quantity.
 */
export async function failInspection(args: { jobId: string; notes: string; reason: string; quantity: number | null; instructions: string; attachment?: { path: string; name: string } | null; lines?: FailedLine[] | null; batch?: string | null }) {
  const { data, error } = await client().rpc("fail_job_inspection", {
    p_job: args.jobId, p_notes: args.notes, p_reason: args.reason, p_quantity: args.lines?.length ? null : args.quantity, p_instructions: args.instructions,
    p_attachment_path: args.attachment?.path ?? null, p_attachment_name: args.attachment?.name ?? null,
    p_lines: args.lines?.length ? args.lines : null, p_batch: args.batch?.trim() || null,
  });
  if (error) throw error;
  return data as { inspection_id: string; rework_id: string; rework_ids: string[]; result: "fail"; release_decision: "held"; inspected_at: string; quantity_affected: number | null; affects_all: boolean };
}

export async function startRework(reworkId: string) {
  const { error } = await client().rpc("start_job_rework", { p_rework: reworkId });
  if (error) throw error;
}

export async function recordReworkCost(args: { reworkId: string; hours: number | null; material: string; materialCost: number | null; note: string }) {
  const { error } = await client().rpc("record_rework_cost", {
    p_rework: args.reworkId, p_hours: args.hours, p_material: args.material.trim() || null, p_material_cost: args.materialCost, p_note: args.note.trim() || null,
  });
  if (error) throw error;
}

/** The hours/material fields as typed: an entry to book, nothing typed, or the one thing wrong (the same checks the Add button makes). */
export type PendingCost =
  | { kind: "none" }
  | { kind: "error"; message: string }
  | { kind: "entry"; hours: number | null; material: string; materialCost: number | null; note: string };

export function pendingCostEntry(f: { hours: string; material: string; materialCost: string; note: string }): PendingCost {
  if (!f.hours.trim() && !f.material.trim() && !f.materialCost.trim() && !f.note.trim()) return { kind: "none" };
  const h = f.hours.trim() === "" ? null : Number(f.hours);
  if (h !== null && (!Number.isFinite(h) || h <= 0 || h > 999)) return { kind: "error", message: "Hours must be more than 0." };
  if (h === null && !f.material.trim()) return { kind: "error", message: "Enter the hours worked, the material used, or both." };
  const cost = f.materialCost.trim() === "" ? null : Number(f.materialCost);
  if (cost !== null && (!Number.isFinite(cost) || cost < 0)) return { kind: "error", message: "The material cost must be a sum of money." };
  if (cost !== null && !f.material.trim()) return { kind: "error", message: "Say which material the cost is for." };
  return { kind: "entry", hours: h, material: f.material, materialCost: cost, note: f.note };
}

/**
 * Finish with any typed-but-not-added entry: books it first and clears the fields as soon as it is saved, so if the finish then fails
 * a retry finds nothing pending and cannot book the same hours or material twice.
 */
export async function finishWithPendingCost(pending: PendingCost, steps: { book: (entry: Extract<PendingCost, { kind: "entry" }>) => Promise<void>; clear: () => void; finish: () => Promise<void> }) {
  if (pending.kind === "error") throw new Error(pending.message);
  if (pending.kind === "entry") { await steps.book(pending); steps.clear(); }
  try {
    await steps.finish();
  } catch (err) {
    if (pending.kind === "entry") throw new FinishAfterCostError(err);
    throw err;
  }
}

/** The typed hours/material were saved, then finishing the rework failed: the dialog reloads the costs and says so. */
export class FinishAfterCostError extends Error {
  constructor(readonly finishError: unknown) {
    super("Costs saved; finishing failed.");
    this.name = "FinishAfterCostError";
  }
}

export async function scrapQuantity(args: { reworkId: string; quantity: number; reason: string }) {
  const { data, error } = await client().rpc("scrap_job_quantity", { p_rework: args.reworkId, p_quantity: args.quantity, p_reason: args.reason });
  if (error) throw error;
  return data as { quantity_scrapped: number; quantity_to_rework: number | null; remaining_to_make: number };
}

/** Replacements still to make on a rework: scrapped parts not yet remade (nor handed to a replacement rework). */
export function replacementsOwed(rework: Pick<ReworkRecord, "quantity_scrapped" | "quantity_remade"> & { quantity_carried?: number | null }) {
  return Math.max(0, Number(rework.quantity_scrapped) - Number(rework.quantity_remade) - Number(rework.quantity_carried ?? 0));
}

/** Opens a replacement rework for what a closed rework still owes (office and admin): made, finished and inspected before release. */
export async function openReplacementRework(reworkId: string, instructions: string) {
  const { data, error } = await client().rpc("open_replacement_rework", { p_rework: reworkId, p_instructions: instructions.trim() });
  if (error) throw error;
  return data as { rework_id: string; follow_up_of: string; quantity: number; sales_order_line_id: string | null; batch_ref: string | null };
}

/** Finishes a started rework, recording how many replacements were made this time (required when any are owed; 0 to what is owed). */
export async function finishRework(reworkId: string, note: string, remade: number | null) {
  const { error } = await client().rpc("finish_job_rework", { p_rework: reworkId, p_note: note.trim() || null, p_remade: remade });
  if (error) throw error;
}
