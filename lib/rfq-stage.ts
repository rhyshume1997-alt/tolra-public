/**
 * Where an RFQ sits, from the quote linked to it (quotes.rfq_id). The RFQ's own status (new, clarification, ready) is the intake
 * status and only means something while the RFQ is outstanding: nothing updates it when a quote is made or sent, so once a quote
 * exists the stage (Quoted, Won, Lost) is the one source of truth. Issue #3 item 5; go-live polish item 11: an RFQ that already has a
 * quote, even one still being drafted, is Quoted (not New / Outstanding).
 */
export type RfqStage = "outstanding" | "quoted" | "won" | "lost";
export type LinkedQuote = { ref: string; status: string; id?: string };

export function rfqStage(rfq: { status: string }, quote: LinkedQuote | undefined): RfqStage {
  if (quote?.status === "accepted") return "won";
  if (quote?.status === "rejected") return "lost";
  if (quote) return "quoted";
  return rfq.status === "quoted" ? "quoted" : "outstanding";
}

/** Logging a clarification e-mail moves an RFQ to 'clarification' only while it is still outstanding (no quote, not 'quoted') and not already there; a quoted, won or lost RFQ is never moved back. */
export function shouldMarkClarification(rfq: { status: string }, quote: LinkedQuote | undefined): boolean {
  return rfqStage(rfq, quote) === "outstanding" && rfq.status !== "clarification";
}

/** The stage's label, saying whether the quote has gone yet ("Quoted, draft" while it is still being prepared). */
export function rfqStageLabel(stage: RfqStage, quote: LinkedQuote | undefined): string {
  if (stage === "outstanding") return "Outstanding";
  if (stage === "won") return "Won";
  if (stage === "lost") return "Lost";
  return quote?.status === "draft" ? "Quoted, draft" : "Quoted, awaiting reply";
}

/** The intake status badge (New, Clarification, Ready) is shown only while the RFQ is outstanding. */
export const showsStatusBadge = (stage: RfqStage) => stage === "outstanding";

/** The status chips filter outstanding RFQs only; an RFQ that has been quoted, won or lost is not hidden by them. */
export const matchesStatusFilter = (filters: Set<string>, stage: RfqStage, status: string) => filters.has("all") || stage !== "outstanding" || filters.has(status);

const RANK: Record<string, number> = { accepted: 4, sent: 3, draft: 2, rejected: 1 };

/**
 * The quote that speaks for each RFQ: an accepted one wins, then a sent one, then a draft, then a rejected one; among equals the
 * newest. (A copy drafted after the customer accepted must not turn a Won RFQ back into Quoted.) Rows: quotes with rfq_id set.
 */
export function linkedQuotes(rows: Array<{ id?: unknown; rfq_id?: unknown; quote_ref?: unknown; status?: unknown; created_at?: unknown }>): Map<string, LinkedQuote> {
  const best = new Map<string, LinkedQuote & { at: string }>();
  for (const row of rows) {
    if (typeof row.rfq_id !== "string" || !row.rfq_id) continue;
    const next = { id: row.id == null ? undefined : String(row.id), ref: String(row.quote_ref ?? ""), status: String(row.status ?? "draft").toLowerCase() || "draft", at: String(row.created_at ?? "") };
    const current = best.get(row.rfq_id);
    const better = !current || (RANK[next.status] ?? 0) > (RANK[current.status] ?? 0) || ((RANK[next.status] ?? 0) === (RANK[current.status] ?? 0) && next.at > current.at);
    if (better) best.set(row.rfq_id, next);
  }
  return new Map([...best].map(([id, { ref, status, id: quoteId }]) => [id, quoteId ? { ref, status, id: quoteId } : { ref, status }]));
}

export type RfqFigures = { outstanding: number; new: number; clarification: number; ready: number; quoted: number; won: number; lost: number };

/**
 * The RFQ figures, one definition for RFQ Control and the dashboard:
 *   - outstanding: RFQs with no quote yet (the "Outstanding" chip; the dashboard's "RFQs to quote" and the pipeline's "RFQs");
 *   - new / clarification / ready: outstanding RFQs by intake status (the RFQ Control tiles);
 *   - quoted / won / lost: by the linked quote.
 */
export function rfqFigures(rfqs: Array<{ id: string; status: string }>, linked: Map<string, LinkedQuote>): RfqFigures {
  const out: RfqFigures = { outstanding: 0, new: 0, clarification: 0, ready: 0, quoted: 0, won: 0, lost: 0 };
  for (const rfq of rfqs) {
    const stage = rfqStage(rfq, linked.get(rfq.id));
    out[stage] += 1;
    if (stage === "outstanding" && (rfq.status === "new" || rfq.status === "clarification" || rfq.status === "ready")) out[rfq.status] += 1;
  }
  return out;
}

/** The stored quantity and material for the RFQ's View dialog: only what was filled in (0 / blank means none was given). */
export function rfqSpec(quantity: unknown, material: unknown): { quantity: number | null; material: string } {
  const qty = Number(quantity);
  return { quantity: Number.isFinite(qty) && qty > 0 ? qty : null, material: typeof material === "string" ? material.trim() : "" };
}
