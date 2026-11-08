// The idempotency key of one approval ATTEMPT. The first attempt of a draft uses the draft's own stable key, so a double click, a retry
// after a lost answer or a second window can never send twice (106's ledger replays the earlier answer). A confirmed failure, or a
// failure a person has checked and recorded as "not sent", moves to the next attempt number, so a retry goes through the ledger as a NEW
// reservation (nothing went out under the old one) and is itself protected the same way. An UNKNOWN outcome never moves the key: the
// ledger keeps replaying it until a person resolves it. Any trouble reading the earlier attempts keeps the base key (the safer one).
import type { SupabaseClient } from "@supabase/supabase-js";

export async function attemptKey(db: SupabaseClient, org: string, base: string, relatedId: string, draftId: string): Promise<string> {
  try {
    const { data, error } = await db.from("email_history").select("id").eq("organization_id", org).eq("related_to_id", relatedId).eq("status", "failed").neq("id", draftId);
    if (error || !Array.isArray(data) || data.length === 0) return base;
    return `${base}:r${data.length}`;
  } catch {
    return base;
  }
}
