import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { FinanceCheckKind } from "@/lib/ai/finance-check/check";

/** The four audit event names (reviewers' spec v1). */
export const AI_AUDIT_ACTIONS = ["ai_finance_check_requested", "ai_finance_check_completed", "ai_suggestion_accepted", "ai_suggestion_rejected"] as const;
export type AiAuditAction = (typeof AI_AUDIT_ACTIONS)[number];

export const KIND_TABLE: Record<FinanceCheckKind, "invoices" | "purchase_orders" | "credit_notes"> = {
  invoice: "invoices", purchase_order: "purchase_orders", credit_note: "credit_notes",
};

/** Metadata is ids, kinds, codes and counts only: no names, no amounts, no document text. */
export type AiAuditMetadata = { kind: FinanceCheckKind; suggestion_id?: string; code?: string; count?: number; codes?: string[]; checker: "rules-v1" };

/**
 * Records one event through the app's audit path (write_audit, as the caller: their JWT, their company). No IP or user agent is
 * sent. Returns false when the database refuses it, and the caller then answers "not available": the check never runs unaudited.
 *
 * NOTE (needs SQL, not written here): write_audit only accepts actions and tables listed in audit_event_allowed (latest 076). These
 * four lower-case names, and the credit_notes table, are not listed, so the database refuses them (42501) until a migration adds them.
 */
export async function writeAiAudit(supabase: SupabaseClient, action: AiAuditAction, kind: FinanceCheckKind, documentId: string, metadata: Omit<AiAuditMetadata, "kind" | "checker"> = {}): Promise<boolean> {
  const { error } = await supabase.rpc("write_audit", {
    p_action: action,
    p_entity_table: KIND_TABLE[kind],
    p_entity_id: documentId,
    p_old: null,
    p_new: null,
    p_metadata: { ...metadata, kind, checker: "rules-v1" } satisfies AiAuditMetadata,
    p_ip: null,
    p_user_agent: null,
  });
  if (error) {
    console.error("[ai-finance-check] audit refused", action, error.code ?? "error");
    return false;
  }
  return true;
}
