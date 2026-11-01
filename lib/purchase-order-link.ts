/**
 * A supplier purchase order linked to the customer quote or job it was bought for (migration 124), and what the quote and the job show:
 * "Bought in" (what was bought for it from suppliers) and "Profit" (sell minus buy). Office and admin only: the purchase orders, quotes and
 * invoices it reads are theirs by row rules, and the panels are not offered to workshop or viewer.
 *
 * THE PROFIT RULE (pence-exact, every figure ex VAT on both sides, carriage left out on both sides):
 *   sell  = the quote's ordered lines (a line the customer did not order, 068's "declined", is not counted), quantity x unit price;
 *           for a job, once it has an issued invoice: the issued invoices' net (subtotal) MINUS the net (subtotal) of every issued credit
 *           note against them. A draft, void or cancelled invoice, and a draft credit note, do not count. A job with no issued invoice
 *           uses its quote's ordered lines; a job with neither has no sell figure yet.
 *   buy   = the sum, over the linked supplier purchase orders that are not cancelled, of each order's ex-VAT value (total_value), or of the
 *           part of it allocated to this quote/job (linked_net) when only some of the order is for it. The allocated part is never more
 *           than the order's own value and never below 0. An order is counted once even when it is linked to both the quote and its job.
 *   profit = sell - buy; margin % = profit / sell, one decimal place (none when sell is 0).
 */
import { fromPence, gbp, linePence, toPence } from "@/lib/money";

export const LINK_PICKER_LIMIT = 25;

export type LinkKind = "quote" | "job";
export type LinkTarget = { kind: LinkKind; id: string; ref: string; customer: string };

/** The picker's option value: "quote:<id>" or "job:<id>". */
export const linkKey = (target: Pick<LinkTarget, "kind" | "id">) => `${target.kind}:${target.id}`;

export function parseLinkKey(value: string | null | undefined): { kind: LinkKind; id: string } | null {
  const match = /^(quote|job):([0-9a-f-]{36})$/i.exec(String(value ?? "").trim());
  return match ? { kind: match[1].toLowerCase() as LinkKind, id: match[2].toLowerCase() } : null;
}

/** What a purchase order row writes for a link (exactly one of the two, or neither). */
export function linkColumns(target: Pick<LinkTarget, "kind" | "id"> | null): { quote_id: string | null; job_id: string | null } {
  return { quote_id: target?.kind === "quote" ? target.id : null, job_id: target?.kind === "job" ? target.id : null };
}

export const linkLabel = (target: Pick<LinkTarget, "kind" | "ref" | "customer">) =>
  `${target.kind === "quote" ? "Quote" : "Job"} ${target.ref}${target.customer ? ` - ${target.customer}` : ""}`;

/** The search text made safe for a PostgREST filter: its wildcard, list and quote characters are dropped. */
export function sanitiseLinkTerm(term: string): string {
  return term.replace(/[%_*,()"'\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

/** The part of the Supabase client used here (a test stands in for it). */
type Query = {
  select(columns: string): Query;
  eq(column: string, value: unknown): Query;
  neq(column: string, value: unknown): Query;
  in(column: string, values: unknown[]): Query;
  or(filter: string): Query;
  ilike(column: string, pattern: string): Query;
  order(column: string, options: { ascending: boolean }): Query;
  limit(n: number): PromiseLike<{ data: unknown; error: { message: string } | null }>;
};
export type LinkClient = { from(table: "quotes" | "jobs" | "quote_line_items"): Query };

const rowsOf = (data: unknown) => (Array.isArray(data) ? (data as Record<string, unknown>[]) : []);

/**
 * The newest quotes and jobs matching the search (by number or customer), each newest first, quotes then jobs. Superseded quote versions
 * and internal jobs are left out. `truncated` when either list had more than the limit; `failed` when either query failed.
 */
export async function findLinkTargets(client: LinkClient, term: string): Promise<{ targets: LinkTarget[]; truncated: boolean; failed: boolean }> {
  const clean = sanitiseLinkTerm(term);
  let quotes = client.from("quotes").select("id, quote_ref, customer").neq("status", "superseded");
  if (clean) quotes = quotes.or(`quote_ref.ilike.%${clean}%,customer.ilike.%${clean}%`);
  let jobs = client.from("jobs").select("id, job_no, customer").eq("is_internal", false);
  if (clean) jobs = jobs.or(`job_no.ilike.%${clean}%,customer.ilike.%${clean}%`);
  const [q, j] = await Promise.all([
    quotes.order("created_at", { ascending: false }).limit(LINK_PICKER_LIMIT + 1),
    jobs.order("created_at", { ascending: false }).limit(LINK_PICKER_LIMIT + 1),
  ]);
  if (q.error || j.error || !Array.isArray(q.data) || !Array.isArray(j.data)) return { targets: [], truncated: false, failed: true };
  const qs = rowsOf(q.data).map((r): LinkTarget => ({ kind: "quote", id: String(r.id), ref: String(r.quote_ref ?? ""), customer: String(r.customer ?? "") }));
  const js = rowsOf(j.data).map((r): LinkTarget => ({ kind: "job", id: String(r.id), ref: String(r.job_no ?? ""), customer: String(r.customer ?? "") }));
  return { targets: [...qs.slice(0, LINK_PICKER_LIMIT), ...js.slice(0, LINK_PICKER_LIMIT)], truncated: qs.length > LINK_PICKER_LIMIT || js.length > LINK_PICKER_LIMIT, failed: false };
}

/**
 * Quotes with a line that looks like what is being ordered (the PO line's description, 3 characters or more): a suggestion only, never
 * applied by itself. Superseded, rejected and expired-by-status quotes are left out. Newest first, at most 3.
 */
export async function suggestQuotesForItem(client: LinkClient, description: string): Promise<LinkTarget[]> {
  const clean = sanitiseLinkTerm(description);
  if (clean.length < 3) return [];
  const lines = await client.from("quote_line_items").select("quote_id").ilike("description", `%${clean}%`).order("created_at", { ascending: false }).limit(20);
  if (lines.error) return [];
  const ids = [...new Set(rowsOf(lines.data).map((r) => String(r.quote_id ?? "")).filter(Boolean))];
  if (!ids.length) return [];
  const quotes = await client.from("quotes").select("id, quote_ref, customer, status").in("id", ids).order("created_at", { ascending: false }).limit(10);
  if (quotes.error) return [];
  return rowsOf(quotes.data)
    .filter((r) => !["superseded", "rejected"].includes(String(r.status ?? "").toLowerCase()))
    .slice(0, 3)
    .map((r) => ({ kind: "quote", id: String(r.id), ref: String(r.quote_ref ?? ""), customer: String(r.customer ?? "") }));
}

// ----- the profit maths -----------------------------------------------------------------------------------------

export type LinkedPo = { id: string; status?: string | null; total_value?: number | string | null; linked_net?: number | string | null };

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/** One linked order's ex-VAT cost to this quote/job, in pence: its value, or the allocated part of it (0 to the value). Cancelled: 0. */
export function linkedPoPence(po: LinkedPo): number {
  if (String(po.status ?? "").trim().toLowerCase() === "cancelled") return 0;
  const value = Math.max(0, toPence(num(po.total_value)));
  if (po.linked_net === null || po.linked_net === undefined || po.linked_net === "") return value;
  return Math.min(value, Math.max(0, toPence(num(po.linked_net))));
}

/** Bought in: the sum over the linked orders (each counted once, cancelled ones left out) and how many orders that is. */
export function boughtIn(pos: LinkedPo[]): { pence: number; count: number } {
  const seen = new Map<string, LinkedPo>();
  for (const po of pos) if (!seen.has(po.id)) seen.set(po.id, po);
  const live = [...seen.values()].filter((po) => String(po.status ?? "").trim().toLowerCase() !== "cancelled");
  return { pence: live.reduce((sum, po) => sum + linkedPoPence(po), 0), count: live.length };
}

export type SellLine = { quantity: number | string | null; unit_price?: number | string | null; unitPrice?: number | string | null; declined?: boolean | null };

/** A quote's sell: its ordered lines, quantity x unit price, ex VAT, in pence (declined lines are not counted). */
export function quoteSellPence(lines: SellLine[]): number {
  return lines.filter((line) => !line.declined).reduce((sum, line) => sum + linePence(num(line.quantity), num(line.unitPrice ?? line.unit_price)), 0);
}

const NOT_ISSUED = new Set(["draft", "void", "voided", "cancelled", "canceled"]);
export const invoiceCounts = (status: string | null | undefined) => !NOT_ISSUED.has(String(status ?? "").trim().toLowerCase() || "draft");

export type SellInvoice = { id: string; status?: string | null; subtotal?: number | string | null };
export type SellCredit = { invoice_id?: string | null; status?: string | null; subtotal?: number | string | null };

/**
 * A job's invoiced sell, in pence: the issued invoices' net minus the net of the issued credit notes against those invoices. null when the
 * job has no issued invoice (then its quote is used).
 */
export function invoicedSellPence(invoices: SellInvoice[], credits: SellCredit[]): number | null {
  const issued = invoices.filter((inv) => invoiceCounts(inv.status));
  if (!issued.length) return null;
  const ids = new Set(issued.map((inv) => inv.id));
  const invoiced = issued.reduce((sum, inv) => sum + toPence(num(inv.subtotal)), 0);
  const credited = credits
    .filter((cn) => cn.invoice_id && ids.has(cn.invoice_id) && String(cn.status ?? "").trim().toLowerCase() === "issued")
    .reduce((sum, cn) => sum + toPence(num(cn.subtotal)), 0);
  return invoiced - credited;
}

export type Profit = { sellPence: number | null; buyPence: number; count: number; profitPence: number | null; marginPct: number | null; basis: "quote" | "invoiced" | "none" };

export function profitOf(sellPence: number | null, buy: { pence: number; count: number }, basis: Profit["basis"]): Profit {
  if (sellPence === null) return { sellPence: null, buyPence: buy.pence, count: buy.count, profitPence: null, marginPct: null, basis: "none" };
  const profitPence = sellPence - buy.pence;
  const marginPct = sellPence > 0 ? Math.round((profitPence * 1000) / sellPence) / 10 : null;
  return { sellPence, buyPence: buy.pence, count: buy.count, profitPence, marginPct, basis };
}

const money = (pence: number) => gbp(fromPence(pence), 2);

/** "Bought in £120.00 (2 POs)"; "Bought in £0.00 (no purchase orders linked)". */
export function boughtInText(profit: Pick<Profit, "buyPence" | "count">): string {
  return `Bought in ${money(profit.buyPence)} (${profit.count === 0 ? "no purchase orders linked" : profit.count === 1 ? "1 PO" : `${profit.count} POs`})`;
}

/** "Profit £80.00 (40.0%)"; a loss reads "Profit -£20.00 (-10.0%)"; no sell yet: "Profit: no sell price yet"; sell 0: no %. */
export function profitText(profit: Pick<Profit, "profitPence" | "marginPct">): string {
  if (profit.profitPence === null) return "Profit: no sell price yet";
  const amount = profit.profitPence < 0 ? `-${money(-profit.profitPence)}` : money(profit.profitPence);
  return `Profit ${amount}${profit.marginPct === null ? "" : ` (${profit.marginPct.toFixed(1)}%)`}`;
}
