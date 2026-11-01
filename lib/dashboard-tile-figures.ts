/**
 * The dashboard's quote and money tiles (E6, ISO 9001 item: dashboard speed). Migration 132 adds one read-only SECURITY INVOKER
 * function per tile (row-level security applies as to any read), so instead of reading every quote, declined quote line, RFQ and
 * unpaid invoice into the browser 1,000 rows at a time, the page makes one call per tile and gets a few dozen bytes back:
 *   Open quotes + the pipeline's accepted count   public.dashboard_open_quotes(today)
 *   Quotes sent this month                        public.dashboard_quotes_sent(first of the month)
 *   Quotes won this month                         public.dashboard_quotes_won(first of the month)
 *   Quotes, last 90 days                          public.dashboard_quote_outcomes(90 days ago, today)
 *   RFQs to quote + the pipeline's RFQs           public.dashboard_rfqs_to_quote()
 *   Money owed, Money owed by age, to confirm     public.dashboard_money_owed(today)
 *
 * The figures are the SAME as the old reads gave, to the last bit (tests/unit/dashboard-tile-figures.test.ts works both out over the
 * same rows): pence are whole numbers turned into pounds as before, the money-owed total is added in pounds in id order as before.
 * Until 132 is applied (a function is missing) the old reads run instead, moved here unchanged (quoteTilesFromRows, moneyTilesFromRows),
 * so the page works on either side of the release. Any other failure blanks only that tile's figure (a dash), never fakes one.
 * One difference by design: the old reads blanked a figure past 20,000 rows (lib/fetch-all); the functions have no such limit.
 */
import { owedByAge, quoteOutcomes, type AgeBucket } from "@/lib/dashboard-analytics";
import { missingDbObject } from "@/lib/db-missing";
import { fetchAll } from "@/lib/fetch-all";
import { quotesWon } from "@/lib/overview-metrics";
import { quoteFigures, sentSince } from "@/lib/quote-status";
import { declinedValueByQuote } from "@/lib/quote-versions";
import { invoiceLifecycle, owed } from "@/lib/receivables";
import { linkedQuotes, rfqFigures } from "@/lib/rfq-stage";

/* eslint-disable @typescript-eslint/no-explicit-any */
type DbError = { code?: string | null; message?: string | null } | null;
/** The part of the Supabase client the tiles use (the page passes its own client). */
export type TileClient = {
  rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: DbError }>;
  from: (table: string) => any;
};

/** The days the figures are counted on: today in the UK, the first of this month, 90 days ago (all YYYY-MM-DD). */
export type TileDates = { today: string; monthStart: string; ninetyDaysAgo: string };

export type QuoteTiles = {
  openQuotes: number | null;
  pipelineValue: number | null;
  /** Accepted quotes (the pipeline's "Accepted"). */
  acceptedQuotes: number | null;
  rfqsToQuote: number | null;
  quotesSentThisMonth: number | null;
  quotesWon: { count: number; undated: number } | null;
  quotes90: ReturnType<typeof quoteOutcomes> | null;
};

export type MoneyTiles = {
  /** The read behind the tiles failed (the attention list may be missing its "payment to confirm" item). */
  failed: boolean;
  /** Imported invoices whose payment is still to be confirmed. */
  toConfirm: number | null;
  unpaidInvoices: number | null;
  moneyOwed: number | null;
  owedByAge: AgeBucket[] | null;
};

// ----- the old reads (before 132), unchanged --------------------------------------------------------------------------------------
// Same rule as the invoice page (lib/receivables): collectible invoices, at what is still owed; imported invoices whose
// payment is still to be confirmed are not counted as owed (migration 027).
const unpaid = (row: any) => invoiceLifecycle(row.status) === "collectible" && !row.payment_unverified;
const owedOn = (row: any) => owed(row);

/** The quote tiles from every quote, declined line and RFQ row (null = that read failed), as the page worked them out before 132. */
export function quoteTilesFromRows(quoteRows: any[] | null, declinedRows: any[] | null, rfqRows: any[] | null, dates: TileDates): QuoteTiles {
  const vatOnQuote = new Map<string, boolean>((quoteRows ?? []).map((row: any) => [String(row.id), row.vat_enabled !== false]));
  const declined = declinedRows ? declinedValueByQuote(declinedRows, (id) => vatOnQuote.get(id) ?? true) : null;
  const quotes = quoteRows && declined
    ? quoteFigures(quoteRows.map((row: any) => ({ ...row, declined_value: declined.get(String(row.id)) ?? 0 })), dates.today)
    : null;
  const rfqs = rfqRows && quoteRows
    ? rfqFigures(rfqRows.map((row) => ({ id: String(row.id), status: String(row.status || "new") })), linkedQuotes(quoteRows))
    : null;
  return {
    openQuotes: quotes ? quotes.open.count : null,
    pipelineValue: quotes ? quotes.open.value : null,
    acceptedQuotes: quotes ? quotes.byStatus.accepted.count : null,
    rfqsToQuote: rfqs ? rfqs.outstanding : null,
    quotesSentThisMonth: quoteRows ? sentSince(quoteRows, dates.monthStart) : null,
    // Quotes won: accepted this calendar month (London) by quotes.accepted_at (lib/overview-metrics quotesWon).
    quotesWon: quoteRows ? quotesWon(quoteRows, dates.monthStart) : null,
    quotes90: quoteRows ? quoteOutcomes(quoteRows, dates.ninetyDaysAgo, dates.today) : null,
  };
}

/** The money tiles from the invoices whose stored status is not 'paid' (null = that read failed), as before 132. */
export function moneyTilesFromRows(rows: any[] | null, today: string): MoneyTiles {
  if (!rows) return { failed: true, toConfirm: null, unpaidInvoices: null, moneyOwed: null, owedByAge: null };
  const open = rows.filter(unpaid);
  return {
    failed: false,
    toConfirm: rows.filter((row) => row.payment_unverified).length,
    unpaidInvoices: open.length,
    moneyOwed: open.reduce((sum, row) => sum + owedOn(row), 0),
    owedByAge: owedByAge(open, today),
  };
}

/** Like the page's qAll: every page of a read (lib/fetch-all); a failed or partial read is null. */
async function readAll(page: (from: number, to: number) => PromiseLike<{ data: any; error: unknown }>): Promise<any[] | null> {
  try {
    const { rows, truncated } = await fetchAll(page);
    return truncated ? null : rows;
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function quoteTilesFromReads(client: TileClient, dates: TileDates, has068: () => Promise<boolean>): Promise<QuoteTiles> {
  // 068 (quote versions, declined lines): read only once the database has it; before it every quote is version 1 with no declined line.
  const with068 = await has068();
  const [quoteRows, declinedRows, rfqRows] = await Promise.all([
    // accepted_at (020, set by accept_quote 058): Quotes won this month counts by the date a quote was accepted, never the date sent.
    readAll((from, to) => client.from("quotes").select(`id, quote_ref, ${with068 ? "version, " : ""}status, valid_until, total_value, vat_enabled, sent_at, accepted_at, rfq_id, created_at`).order("id").range(from, to)),
    // Lines left off an accepted quote's order (068): an accepted quote is won for its ordered lines only.
    with068
      ? readAll((from, to) => client.from("quote_line_items").select("quote_id, quantity, unit_price, vat_pct, vat_exempt").eq("declined", true).order("id").range(from, to))
      : Promise.resolve<any[]>([]),
    readAll((from, to) => client.from("rfqs").select("id, status").order("id").range(from, to)),
  ]);
  return quoteTilesFromRows(quoteRows, declinedRows, rfqRows, dates);
}

async function moneyTilesFromReads(client: TileClient, today: string): Promise<MoneyTiles> {
  const rows = await readAll((from, to) => client.from("invoices").select("id, invoice_ref, customer, total, status, amount_paid, credited_amount, refunded_amount, due_date, payment_unverified").neq("status", "paid").order("id").range(from, to));
  return moneyTilesFromRows(rows, today);
}

// ----- 132's functions --------------------------------------------------------------------------------------------------------------
type OpenAnswer = { open_count: number; open_pence: number; accepted_count: number };
type OutcomesAnswer = { accepted: number; sent: number; expired: number; rejected: number; expired_sent: number };
type OwedAnswer = { to_confirm: number; invoices: number; owed: number; not_due: number; late_1_30: number; late_31_60: number; late_60_plus: number };
export type QuoteAnswers = {
  open: OpenAnswer | null;
  sent: { count: number } | null;
  won: { count: number; undated: number } | null;
  outcomes: OutcomesAnswer | null;
  rfqs: { outstanding: number } | null;
};

/** The quote tiles from 132's answers (null = that call failed: only its tile is blank). */
export function quoteTilesFromAggregates(a: QuoteAnswers): QuoteTiles {
  const o = a.outcomes;
  // lib/quote-status quoteFigures winRate: accepted / (accepted + rejected + expired after being sent), whole percent.
  const decided = o ? Number(o.accepted) + Number(o.rejected) + Number(o.expired_sent) : 0;
  return {
    openQuotes: a.open ? Number(a.open.open_count) : null,
    pipelineValue: a.open ? Number(a.open.open_pence) / 100 : null,
    acceptedQuotes: a.open ? Number(a.open.accepted_count) : null,
    rfqsToQuote: a.rfqs ? Number(a.rfqs.outstanding) : null,
    quotesSentThisMonth: a.sent ? Number(a.sent.count) : null,
    quotesWon: a.won ? { count: Number(a.won.count), undated: Number(a.won.undated) } : null,
    quotes90: o
      ? {
          outcomes: [
            { key: "accepted", label: "Accepted", count: Number(o.accepted) },
            { key: "sent", label: "Awaiting reply", count: Number(o.sent) },
            { key: "expired", label: "Expired", count: Number(o.expired) },
            { key: "rejected", label: "Rejected", count: Number(o.rejected) },
          ],
          winRate: decided ? Math.round((Number(o.accepted) / decided) * 100) : null,
        }
      : null,
  };
}

/** The money tiles from 132's answer (null = the call failed). Buckets as lib/dashboard-analytics owedByAge labels them. */
export function moneyTilesFromAggregate(a: OwedAnswer | null): MoneyTiles {
  if (!a) return { failed: true, toConfirm: null, unpaidInvoices: null, moneyOwed: null, owedByAge: null };
  return {
    failed: false,
    toConfirm: Number(a.to_confirm),
    unpaidInvoices: Number(a.invoices),
    moneyOwed: Number(a.owed),
    owedByAge: [
      { key: "not_due", label: "Not due yet", light: "green", value: Number(a.not_due) / 100 },
      { key: "late_1_30", label: "1–30 days late", light: "amber", value: Number(a.late_1_30) / 100 },
      { key: "late_31_60", label: "31–60 days late", light: "red", value: Number(a.late_31_60) / 100 },
      { key: "late_60_plus", label: "60+ days late", light: "red", value: Number(a.late_60_plus) / 100 },
    ],
  };
}

type Answer = { ok: true; data: any } | { ok: false; missing: boolean };
async function call(client: TileClient, fn: string, args: Record<string, unknown>): Promise<Answer> {
  try {
    const { data, error } = await client.rpc(fn, args);
    if (error) {
      if (missingDbObject(error)) return { ok: false, missing: true };
      throw error;
    }
    return data && typeof data === "object" ? { ok: true, data } : { ok: false, missing: false };
  } catch (err) {
    console.error(err);
    return { ok: false, missing: false };
  }
}
const answer = <T,>(a: Answer): T | null => (a.ok ? (a.data as T) : null);

/** The quote tiles: one call per tile (132), or the old reads while 132 is not applied. */
export async function loadQuoteTiles(client: TileClient, dates: TileDates, has068: () => Promise<boolean>): Promise<QuoteTiles> {
  const [open, sent, won, outcomes, rfqs] = await Promise.all([
    call(client, "dashboard_open_quotes", { p_today: dates.today }),
    call(client, "dashboard_quotes_sent", { p_since: dates.monthStart }),
    call(client, "dashboard_quotes_won", { p_since: dates.monthStart }),
    call(client, "dashboard_quote_outcomes", { p_since: dates.ninetyDaysAgo, p_today: dates.today }),
    call(client, "dashboard_rfqs_to_quote", {}),
  ]);
  if ([open, sent, won, outcomes, rfqs].some((a) => !a.ok && a.missing)) return quoteTilesFromReads(client, dates, has068);
  return quoteTilesFromAggregates({ open: answer(open), sent: answer(sent), won: answer(won), outcomes: answer(outcomes), rfqs: answer(rfqs) });
}

/** The money tiles: one call (132), or the old read while 132 is not applied. */
export async function loadMoneyTiles(client: TileClient, today: string): Promise<MoneyTiles> {
  const owedAnswer = await call(client, "dashboard_money_owed", { p_today: today });
  if (!owedAnswer.ok && owedAnswer.missing) return moneyTilesFromReads(client, today);
  return moneyTilesFromAggregate(answer<OwedAnswer>(owedAnswer));
}
