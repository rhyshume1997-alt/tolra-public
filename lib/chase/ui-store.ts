import type { SupabaseClient } from "@supabase/supabase-js";
import { stepsProblem } from "@/lib/email/chase/steps";
import type { ChaseStep } from "@/components/chase/settings-card";

export type SavedStep = ChaseStep & { id: string };
/** Preserve the database ID of unchanged offsets, and therefore their send history. */
export async function saveChaseSteps(db: SupabaseClient, org: string, before: SavedStep[], steps: ChaseStep[]) {
  const problem = stepsProblem(steps.map((s) => ({ offset: String(s.days), tone: s.tone })));
  if (problem) throw new Error(problem);
  if (before.length === steps.length && before.every(s => steps.some(n => n.days === s.days && n.tone === s.tone))) return before;
  const { data, error } = await db.rpc("save_chase_steps_atomic", { p_expected: before, p_steps: steps });
  if (error) throw new Error(error.code === "40001" ? "The chase steps changed. Reload the page." : "Could not save chase steps. Ask the person who looks after Tolra to check the setup.");
  if (!Array.isArray(data) || data.length !== steps.length || data.some((s) => typeof s.id !== "string" || !steps.some(n => n.days === s.days && n.tone === s.tone))) throw new Error("Could not check the saved steps. Reload the page.");
  return data as SavedStep[];
}

export async function approveDraft(id: string, reviewed: { subject: string; body: string }, request: typeof fetch = fetch) {
  const response = await request("/api/chase/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ history_id: id, expected_subject: reviewed.subject, expected_body: reviewed.body }) });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok || answer.status !== "sent") throw new Error(answer.error || "Could not send the reminder. Check the result before trying again.");
  return answer as { status: "sent"; recorded: boolean };
}

export async function resolveClaim(db: SupabaseClient, id: string, outcome: "confirmed" | "not_received") {
  const { error } = await db.rpc("resolve_payment_claim", { p_invoice: id, p_outcome: outcome });
  if (error) throw error;
}
