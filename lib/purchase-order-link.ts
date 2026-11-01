/**
 * A supplier purchase order linked to the customer quote or job it was bought for (migration 124), and what the quote and the job show:
 * "Bought in" (what was bought for it from suppliers) and "Profit" (sell minus buy). Office and admin only: the purchase orders, quotes and
 * invoices it reads are theirs by row rules, and the panels are not offered to workshop or viewer.
 *
 * THE PROFIT RULE (pence-exact, every figure ex VAT on both sides, carriage left out on both sides), shown as ESTIMATE or ACTUAL:
 *   ESTIMATE: sell = the quote's ordered lines (a line the customer did not order, 068's "declined", is not counted), quantity x unit
 *           price. A quote always; a job while it has no issued invoice (its quote's lines).
 *   ACTUAL: a job once it has an issued invoice: sell = the issued invoices' net (subtotal) MINUS the net (subtotal) of every issued credit
 *           note against them. A draft, void or cancelled invoice, and a draft credit note, do not count.
 *   buy   = the sum, over the linked supplier purchase orders that are not cancelled, of each order's ex-VAT value (total_value), or of the
 *           part of it allocated to this quote/job (linked_net) when only some of the order is for it. The allocated part is never more
 *           than the order's own value. An order is counted once even when it is linked to both the quote and its job.
 *   profit = sell - buy; margin % = profit / sell, one decimal place (none when sell is 0).
 *   UNAVAILABLE (no number at all): the viewer can't read invoices, quotes or purchase orders (public.section_allowed), or any input is
 *           missing or unreadable (a read failed, an order with no value, a line with no quantity or price, an issued invoice or credit
 *           note with no net, no quote lines and no issued invoice). Nothing is read as 0, and the quote's figure is never shown in place
 *           of the invoiced one to someone who can't see invoices.
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

/** A money or quantity figure as stored, or null when it is missing or not a number (never read as 0). */
function figure(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === "string" && value.trim() === "")) return null;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

const isCancelled = (status: unknown) => String(status ?? "").trim().toLowerCase() === "cancelled";

export type LinkedPo = { id: string; status?: string | null; total_value?: number | string | null; linked_net?: number | string | null };

/**
 * One linked order's ex-VAT cost to this quote/job, in pence: its value, or the allocated part of it (capped at the value). Cancelled: 0.
 * null when the figure can't be trusted: no value, a value that is not a number or below 0, or an allocated amount that is not a number
 * or below 0.
 */
export function linkedPoPence(po: LinkedPo): number | null {
  if (isCancelled(po.status)) return 0;
  const value = figure(po.total_value);
  if (value === null || value < 0) return null;
  const valuePence = toPence(value);
  if (po.linked_net === null || po.linked_net === undefined) return valuePence;
  const part = figure(po.linked_net);
  if (part === null || part < 0) return null;
  return Math.min(valuePence, toPence(part));
}

/** Bought in: the sum over the linked orders (each counted once, cancelled ones left out) and how many orders that is; null when any is unreadable. */
export function boughtIn(pos: LinkedPo[]): { pence: number; count: number } | null {
  const seen = new Map<string, LinkedPo>();
  for (const po of pos) if (!seen.has(po.id)) seen.set(po.id, po);
  const live = [...seen.values()].filter((po) => !isCancelled(po.status));
  let pence = 0;
  for (const po of live) {
    const cost = linkedPoPence(po);
    if (cost === null) return null;
    pence += cost;
  }
  return { pence, count: live.length };
}

export type SellLine = { quantity: number | string | null; unit_price?: number | string | null; unitPrice?: number | string | null; declined?: boolean | null };

/**
 * A quote's sell: its ordered lines, quantity x unit price, ex VAT, in pence (declined lines are not counted). null when there is no
 * ordered line, or any ordered line has no quantity or no unit price.
 */
export function quoteSellPence(lines: SellLine[]): number | null {
  const ordered = lines.filter((line) => !line.declined);
  if (!ordered.length) return null;
  let pence = 0;
  for (const line of ordered) {
    const quantity = figure(line.quantity);
    const price = figure(line.unitPrice ?? line.unit_price);
    if (quantity === null || price === null) return null;
    pence += linePence(quantity, price);
  }
  return pence;
}

const NOT_ISSUED = new Set(["draft", "void", "voided", "cancelled", "canceled"]);
export const invoiceCounts = (status: string | null | undefined) => !NOT_ISSUED.has(String(status ?? "").trim().toLowerCase() || "draft");

export type SellInvoice = { id: string; status?: string | null; subtotal?: number | string | null };
export type SellCredit = { invoice_id?: string | null; status?: string | null; subtotal?: number | string | null };

/**
 * A job's invoiced sell, in pence: the issued invoices' net minus the net of the issued credit notes against those invoices.
 * { issued: false } when the job has no issued invoice; pence null when an issued invoice or an issued credit note against one has no net.
 */
export function invoicedSellPence(invoices: SellInvoice[], credits: SellCredit[]): { issued: false } | { issued: true; pence: number | null } {
  const issued = invoices.filter((inv) => invoiceCounts(inv.status));
  if (!issued.length) return { issued: false };
  const ids = new Set(issued.map((inv) => inv.id));
  let pence = 0;
  for (const inv of issued) {
    const net = figure(inv.subtotal);
    if (net === null) return { issued: true, pence: null };
    pence += toPence(net);
  }
  for (const cn of credits) {
    if (!cn.invoice_id || !ids.has(cn.invoice_id) || String(cn.status ?? "").trim().toLowerCase() !== "issued") continue;
    const net = figure(cn.subtotal);
    if (net === null) return { issued: true, pence: null };
    pence -= toPence(net);
  }
  return { issued: true, pence };
}

/**
 * What the quote or the job reads, each null when it was not read or the read failed (never an empty list standing in for a failure).
 * canRead: public.section_allowed for invoices, quotes and purchase orders; anything but true (hidden, not asked, the call failed) is "no".
 */
export type ProfitInputs = {
  kind: LinkKind;
  canRead: { invoices: boolean | null; quotes: boolean | null; purchaseOrders: boolean | null };
  pos: LinkedPo[] | null;
  /** A job: its invoices and the credit notes against them. Not used for a quote. */
  invoices?: SellInvoice[] | null;
  credits?: SellCredit[] | null;
  /** The quote's lines (a quote; or a job's quote, used while the job has no issued invoice). null: no quote, or not read. */
  quoteLines: SellLine[] | null;
};

export type ProfitFigure =
  | { state: "estimate" | "actual"; sellPence: number; buyPence: number; count: number; profitPence: number; marginPct: number | null }
  | { state: "unavailable"; reason: string; buy: { pence: number; count: number } | null };

const unavailable = (reason: string, buy: { pence: number; count: number } | null = null): ProfitFigure => ({ state: "unavailable", reason, buy });

/**
 * Profit, conservatively. ESTIMATE: sell from the quote's ordered lines. ACTUAL (a job with an issued invoice): sell from the issued
 * invoices' net minus the issued credit notes against them. UNAVAILABLE, with no number, when the viewer can't read invoices, quotes or
 * purchase orders, or any input is missing or unreadable. It never falls back to the quote's figure for someone who can't see invoices.
 */
export function profitFigure(input: ProfitInputs): ProfitFigure {
  if (input.canRead.invoices !== true) return unavailable("you can't see invoices");
  if (input.canRead.quotes !== true) return unavailable("you can't see quotes");
  if (input.canRead.purchaseOrders !== true) return unavailable("you can't see purchase orders");
  if (input.pos === null) return unavailable("the linked purchase orders couldn't be read");
  const buy = boughtIn(input.pos);
  if (buy === null) return unavailable("a linked purchase order has no usable value");

  let sell: number | null;
  let state: "estimate" | "actual" = "estimate";
  if (input.kind === "job") {
    if (!input.invoices) return unavailable("the job's invoices couldn't be read", buy);
    if (!input.credits) return unavailable("the credit notes couldn't be read", buy);
    const invoiced = invoicedSellPence(input.invoices, input.credits);
    if (invoiced.issued) {
      if (invoiced.pence === null) return unavailable("an issued invoice or credit note has no net amount", buy);
      sell = invoiced.pence;
      state = "actual";
    } else {
      if (!input.quoteLines) return unavailable("no issued invoice, and no quote lines to estimate from", buy);
      sell = quoteSellPence(input.quoteLines);
      if (sell === null) return unavailable("the quote has no ordered line with a quantity and price", buy);
    }
  } else {
    if (!input.quoteLines) return unavailable("the quote's lines couldn't be read", buy);
    sell = quoteSellPence(input.quoteLines);
    if (sell === null) return unavailable("the quote has no ordered line with a quantity and price", buy);
  }
  const profitPence = sell - buy.pence;
  const marginPct = sell > 0 ? Math.round((profitPence * 1000) / sell) / 10 : null;
  return { state, sellPence: sell, buyPence: buy.pence, count: buy.count, profitPence, marginPct };
}

const money = (pence: number) => gbp(fromPence(pence), 2);

/** "Bought in £120.00 (2 POs)"; "Bought in £0.00 (no purchase orders linked)"; "Bought in unavailable" when it couldn't be worked out. */
export function boughtInText(figure: ProfitFigure): string {
  const buy = figure.state === "unavailable" ? figure.buy : { pence: figure.buyPence, count: figure.count };
  if (!buy) return "Bought in unavailable";
  return `Bought in ${money(buy.pence)} (${buy.count === 0 ? "no purchase orders linked" : buy.count === 1 ? "1 PO" : `${buy.count} POs`})`;
}

/** "Profit (estimate) £80.00 (40.0%)"; "Profit (actual) -£20.00 (-10.0%)"; sell 0: no %; "Profit unavailable" with no number. */
export function profitText(figure: ProfitFigure): string {
  if (figure.state === "unavailable") return "Profit unavailable";
  const amount = figure.profitPence < 0 ? `-${money(-figure.profitPence)}` : money(figure.profitPence);
  return `Profit (${figure.state}) ${amount}${figure.marginPct === null ? "" : ` (${figure.marginPct.toFixed(1)}%)`}`;
}
