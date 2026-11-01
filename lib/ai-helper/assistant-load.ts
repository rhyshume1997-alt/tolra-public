import type { SupabaseClient } from "@supabase/supabase-js";

import type { AssistantTopic } from "@/lib/ai-helper/assistant";
import { ASSISTANT_MAX_RECORDS } from "@/lib/ai-helper/limits";

/**
 * The assistant's read helpers (the "predefined tools" of PLAN.md item 1, chosen by the server from the person's topic, never by the
 * model). Each is one SELECT with the person's OWN session (RLS and the role decide what comes back), filtered to their company as
 * well, newest first, at most ASSISTANT_MAX_RECORDS rows. Only references, statuses and dates are selected: no amounts, no notes,
 * descriptions or specifications, no contact details. Read only.
 */
const COLUMNS: Record<AssistantTopic, { table: "quotes" | "jobs"; select: string }> = {
  quotes: { table: "quotes", select: "id, organization_id, quote_ref, customer, status, valid_until, sent_at, accepted_at, rejected_at, created_at" },
  jobs: { table: "jobs", select: "id, organization_id, job_no, customer, stage, status, date_required, due_date, started_at, finished_at, inspected_at, created_at" },
};

export async function loadAssistantRows(db: Pick<SupabaseClient, "from">, topic: AssistantTopic, organizationId: string): Promise<Record<string, unknown>[]> {
  const { table, select } = COLUMNS[topic];
  const { data, error } = await db.from(table).select(select).eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(ASSISTANT_MAX_RECORDS);
  if (error) throw new Error(`assistant read ${table}: ${error.code ?? "error"}`);
  return (data ?? []) as unknown as Record<string, unknown>[];
}
