import { supabase } from "@/lib/supabase";

export async function markSentManually(emailHistoryId: string, sentAt = new Date().toISOString()) {
  if (!supabase) return { ok: false, error: "Supabase is not configured" };
  const { error } = await supabase
    .from("email_history")
    .update({ status: "sent_manually", sent_at: sentAt })
    .eq("id", emailHistoryId);

  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
