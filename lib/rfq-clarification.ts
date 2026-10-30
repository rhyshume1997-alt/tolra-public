/**
 * RFQ Control's "I sent it" for a clarification e-mail (migration 110): one call to public.log_rfq_clarification, which logs the
 * e-mail as sent manually and moves an outstanding RFQ (New or Ready, no quote yet) to Awaiting clarification in one transaction.
 * Before 110 these were two requests, and a failed second one left the e-mail logged with the RFQ unmoved. The database re-checks
 * the company, role and sections and takes the address from the RFQ itself; its refusals carry rfq_* hints (lib/friendly-error.ts).
 */
type RpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};

export type RfqClarificationResult = { status: string; moved: boolean };

/** Throws the database error (for friendlyError) when nothing was logged; otherwise the RFQ's status now and whether it moved. */
export async function logRfqClarification(db: RpcClient, rfqId: string, subject: string, body: string): Promise<RfqClarificationResult> {
  const { data, error } = await db.rpc("log_rfq_clarification", { p_rfq_id: rfqId, p_subject: subject, p_body: body });
  if (error) throw error;
  const out = (data ?? {}) as { rfq?: { status?: unknown } | null; moved?: unknown };
  return { status: typeof out.rfq?.status === "string" ? out.rfq.status : "", moved: out.moved === true };
}

export const rfqClarificationToast = (moved: boolean) =>
  moved ? "Logged as sent manually. The RFQ is now awaiting clarification." : "Logged as sent manually";
