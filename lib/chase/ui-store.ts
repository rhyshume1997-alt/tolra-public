import type { SupabaseClient } from "@supabase/supabase-js";
import { stepsProblem } from "@/lib/email/chase/steps";
import type { ChaseStep } from "@/components/chase/settings-card";

export type SavedStep = ChaseStep & { id: string };
/** Preserve the database ID of unchanged offsets, and therefore their send history. */
export async function saveChaseSteps(db: SupabaseClient, org: string, before: SavedStep[], steps: ChaseStep[]) {
  const problem = stepsProblem(steps.map((s) => ({ offset: String(s.days), tone: s.tone })));
  if (problem) throw new Error(problem);
  const removed = before.filter((s) => !steps.some((next) => next.days === s.days));
  // These are separate requests in 138, not a transaction. The caller must reload after any failure.
  if (removed.length) {
    const { error } = await db.from("chase_steps").delete().eq("organization_id", org).in("id", removed.map((s) => s.id));
    if (error) throw error;
  }
  for (const step of steps) {
    const old = before.find((s) => s.days === step.days);
    if (old?.tone === step.tone) continue;
    const query = old
      ? db.from("chase_steps").update({ tone: step.tone }).eq("organization_id", org).eq("id", old.id)
      : db.from("chase_steps").insert({ organization_id: org, offset_days: step.days, tone: step.tone });
    const { data, error } = await query.select("id");
    if (error) throw error;
    if (data?.length !== 1) throw new Error("The chase steps changed. Reload the page.");
  }
}

export async function approveDraft(id: string, request: typeof fetch = fetch) {
  const response = await request("/api/chase/approve", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ history_id: id }) });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok || answer.status !== "sent") throw new Error(answer.error || "Could not send the reminder. Check the result before trying again.");
  return answer as { status: "sent"; recorded: boolean };
}

export async function resolveClaim(db: SupabaseClient, id: string, outcome: "confirmed" | "not_received") {
  const { error } = await db.rpc("resolve_payment_claim", { p_invoice: id, p_outcome: outcome });
  if (error) throw error;
}
