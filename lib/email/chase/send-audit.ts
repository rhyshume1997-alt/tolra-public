// An audit row (security_audit.audit_log, through the signed-in person's own write_audit) for an approved send that did NOT go out
// cleanly: a confirmed failure, an unknown outcome, a changed draft, or a person's explicit choice of Resend. Same conventions as
// app/api/send-job/resolve: action UPDATE on email_history, the history id as the entity, ids and codes only (never an address, subject or
// text). Best effort by design: if this write fails it is logged and NOTHING else changes (an unknown send stays unknown and is never
// retried, nothing is sent twice). It never throws.
import type { SupabaseClient } from "@supabase/supabase-js";

export type SendAuditEvent = {
  /** failed: the provider refused it for certain; unknown: held for checking; changed: the draft changed, nothing sent; provider_override: Resend chosen by an admin. */
  outcome: "failed" | "unknown" | "changed" | "provider_override";
  historyId: string;
  channel: "email-approve" | "chase-approve";
  code?: string;
  provider?: string;
};

export async function recordSendAudit(db: Pick<SupabaseClient, "rpc">, event: SendAuditEvent, userAgent: string | null = null): Promise<boolean> {
  try {
    const { error } = await db.rpc("write_audit", {
      p_action: "UPDATE",
      p_entity_table: "email_history",
      p_entity_id: event.historyId,
      p_old: null,
      p_new: { outcome: event.outcome, ...(event.provider ? { provider: event.provider } : {}) },
      p_metadata: { channel: event.channel, ...(event.code ? { code: event.code } : {}) },
      p_ip: null,
      p_user_agent: userAgent,
    });
    if (error) { console.error("[send-audit] not recorded", (error as { code?: string }).code); return false; }
    return true;
  } catch {
    console.error("[send-audit] not recorded");
    return false;
  }
}
