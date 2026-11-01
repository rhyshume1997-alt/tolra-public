/**
 * The inbox check's PO step (migration 125): after new messages are stored, each one with a PO number is matched (lib/po-capture) against
 * the company's sent and accepted quotes and its purchase orders, and the candidates are saved as SUGGESTIONS only
 * (link_inbound_email p_how 'suggested'). Nothing is linked and nothing downstream changes until a person clicks Link.
 *
 * It never fails or blocks the inbox check: every error is caught and reported in the result. It reads only the company's own records
 * through the signed-in admin's session (row level security applies). Without 125 it does nothing (status "off"); without 123
 * (quotes.customer_po) customer POs are matched only by the quote's number or the customer's open quotes (customerPo false).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { missingDbObject } from "@/lib/db-features";
import { fetchAll } from "@/lib/fetch-all";
import { type InboundForMatch, type PurchaseOrderCandidate, type QuoteCandidate, emailList, extractPoNumbers, matchInboundEmail } from "@/lib/po-capture";

export type PoCaptureContext = { customerPo: boolean; quotes: QuoteCandidate[]; purchaseOrders: PurchaseOrderCandidate[] };
export type PoCaptureSummary = { status: "ok" | "off" | "failed" | "skipped"; customerPo: boolean | null; checked: number; suggested: number; failed: number };
export type StoredMessage = { inboundEmailId: string; email: InboundForMatch };

type Row = Record<string, unknown>;
const text = (v: unknown) => (v == null ? "" : String(v));
const key = (v: unknown) => text(v).trim().toLowerCase();

/** Is 125 applied? A one-row GET of the new column (a missing column means no). Any other failure is not an answer: treated as no. */
export async function hasEmailLinks(db: SupabaseClient): Promise<boolean> {
  const { error } = await db.from("inbound_emails").select("link_status").limit(1);
  return !error;
}

/** The company's quotes (sent, accepted) and purchase orders (not draft), with the addresses we hold for their customer or supplier. */
export async function loadPoCaptureContext(db: SupabaseClient): Promise<PoCaptureContext> {
  let customerPo = true;
  const quoteColumns = (withPo: boolean) => `id, quote_ref, customer, status, rfq_id${withPo ? ", customer_po" : ""}`;
  const quotePage = (withPo: boolean) => (from: number, to: number) =>
    db.from("quotes").select(quoteColumns(withPo)).in("status", ["sent", "accepted"]).order("created_at", { ascending: false }).order("id").range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: unknown }>;
  let quotes: Row[];
  try {
    quotes = (await fetchAll<Row>(quotePage(true))).rows;
  } catch (err) {
    if (!missingDbObject(err as { code?: string; message?: string })) throw err;
    customerPo = false; // 123 not applied: no quotes.customer_po
    quotes = (await fetchAll<Row>(quotePage(false))).rows;
  }
  const customers = (await fetchAll<Row>((from, to) => db.from("customers").select("id, name, email").order("id").range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: unknown }>)).rows;
  const rfqIds = [...new Set(quotes.map((q) => text(q.rfq_id)).filter(Boolean))];
  const rfqEmail = new Map<string, string>();
  for (let i = 0; i < rfqIds.length; i += 200) {
    const { data, error } = await db.from("rfqs").select("id, email").in("id", rfqIds.slice(i, i + 200));
    if (error) throw error;
    for (const r of (data ?? []) as Row[]) rfqEmail.set(text(r.id), text(r.email));
  }
  const orders = (await fetchAll<Row>((from, to) => db.from("purchase_orders").select("id, po_ref, po_number, supplier, status").neq("status", "draft").order("id").range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: unknown }>)).rows;
  const suppliers = (await fetchAll<Row>((from, to) => db.from("suppliers").select("id, name, email").order("id").range(from, to) as unknown as PromiseLike<{ data: Row[] | null; error: unknown }>)).rows;

  const byName = (rows: Row[]) => {
    const map = new Map<string, string[]>();
    for (const r of rows) map.set(key(r.name), [...(map.get(key(r.name)) ?? []), ...emailList(text(r.email))]);
    return map;
  };
  const customerEmails = byName(customers);
  const supplierEmails = byName(suppliers);
  return {
    customerPo,
    quotes: quotes.map((q) => ({
      id: text(q.id), ref: text(q.quote_ref), status: text(q.status) || null, customer: text(q.customer),
      customerPo: customerPo && q.customer_po ? text(q.customer_po) : null,
      customerEmails: [...(customerEmails.get(key(q.customer)) ?? []), ...emailList(rfqEmail.get(text(q.rfq_id)))],
    })),
    purchaseOrders: orders.map((o) => ({
      id: text(o.id), ref: text(o.po_ref || o.po_number), status: text(o.status) || null, supplier: text(o.supplier),
      supplierEmails: supplierEmails.get(key(o.supplier)) ?? [],
    })),
  };
}

/**
 * Matches the newly stored messages and saves their suggestions. Only messages that carry a PO number load anything; the context is
 * loaded once per check. Never throws.
 */
export async function suggestPoLinks(db: SupabaseClient, stored: readonly StoredMessage[]): Promise<PoCaptureSummary> {
  const summary: PoCaptureSummary = { status: "ok", customerPo: null, checked: 0, suggested: 0, failed: 0 };
  try {
    const withPo = stored.filter((m) => extractPoNumbers(m.email).length > 0);
    if (!withPo.length) return { ...summary, status: "skipped" };
    if (!(await hasEmailLinks(db))) return { ...summary, status: "off" };
    const ctx = await loadPoCaptureContext(db);
    summary.customerPo = ctx.customerPo;
    for (const m of withPo) {
      summary.checked += 1;
      let suggestions;
      try {
        suggestions = matchInboundEmail(m.email, ctx).suggestions;
      } catch {
        summary.failed += 1;
        continue;
      }
      for (const s of suggestions) {
        const { error } = await db.rpc("link_inbound_email", { p_email: m.inboundEmailId, p_kind: s.kind, p_target: s.id, p_po: s.po, p_how: "suggested" });
        if (error) {
          summary.failed += 1;
          console.error("[mail/poll] PO suggestion not saved", error.code);
        } else summary.suggested += 1;
      }
    }
    return summary;
  } catch (err) {
    console.error("[mail/poll] PO matching skipped", (err as { code?: string } | null)?.code ?? "error");
    return { ...summary, status: "failed" };
  }
}
