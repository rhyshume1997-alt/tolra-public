// Raise an issue: the one call the form makes. Inputs: a Supabase client (the signed-in person's own session) and a checked
// RaiseIssueInput. Outputs: { ok: true } or { ok: false, error } with fixed wording. Must not change: it calls only raise_issue (release 165),
// which takes the company and the person from the session; nothing here writes a table directly, sends e-mail or calls AI.
import type { SupabaseClient } from "@supabase/supabase-js";

import { raiseIssueRefusal, type RaiseIssueInput } from "@/lib/issues/issues";

export type RaiseIssueResult = { ok: true } | { ok: false; error: string };

export async function raiseIssue(client: Pick<SupabaseClient, "rpc"> | null, input: RaiseIssueInput): Promise<RaiseIssueResult> {
  if (!client) return { ok: false, error: "Couldn't send your issue. Nothing was saved; try again." };
  try {
    const { error } = await client.rpc("raise_issue", { p_page: input.page, p_body: input.body, p_urgent: input.urgent });
    if (error) return { ok: false, error: raiseIssueRefusal(error) };
    return { ok: true };
  } catch {
    return { ok: false, error: "Can't reach the server. Check your connection and try again. Nothing was saved." };
  }
}
