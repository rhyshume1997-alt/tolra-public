// Reads the last exact approval send link. Missing release or unreadable state keeps the attempt held.
import type { SupabaseClient } from "@supabase/supabase-js";

export async function approvalAttemptStatus(db: SupabaseClient, org: string, user: string, draft: string): Promise<"new" | "failed" | "held"> {
  try {
    const { data, error } = await db.rpc("approval_email_attempt_status", { p_org: org, p_user: user, p_draft: draft });
    return !error && (data === "new" || data === "failed") ? data : "held";
  } catch {
    return "held";
  }
}
