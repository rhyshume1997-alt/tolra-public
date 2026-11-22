/**
 * PIPELINE (not revenue): quotes out with the customer and still open, by the month they were sent. Pure.
 *
 * Inputs: quotes (status, valid_until, sent_at, customer), their lines, today's London date, a range and an optional customer.
 * Output: open quotes and their value ex VAT per London month sent, the sum, and counts of quotes left out.
 * Rule (the app's own, lib/quote-status): a quote is open when its stored status is "sent" (so not draft, accepted, rejected or
 * superseded) and it has not expired (effectiveQuoteStatus: valid-until before today). Value ex VAT is the sum of its lines'
 * quantity x unit price in pence; a quote with no lines has no known value and is counted in quotesWithoutLines, not valued; a quote
 * with no sent date is counted in undatedQuotes, not placed in a month.
 * Its result shares no field name with the revenue types (invoiced.ts, cash.ts, by-customer.ts, by-part.ts); a type-level test holds
 * that (tests/unit/revenue-pipeline.test.ts), so pipeline can never be added to revenue by accident.
 * Must not change: the status rule without changing lib/quote-status first.
 */
import { calendarDate } from "@/lib/dates";
import { fromPence, linePence } from "@/lib/money";
import { customerName, inRange, periodsForRange, type RevenueRange } from "@/lib/reports/revenue/invoiced";
import { effectiveQuoteStatus, storedQuoteStatus } from "@/lib/quote-status";

export type PipelineQuote = { id?: string | null; customer?: string | null; status?: string | null; valid_until?: string | null; sent_at?: string | null };
export type PipelineQuoteLine = { quote_id?: string | null; quantity?: number | string | null; unit_price?: number | string | null; declined?: boolean | null };

export type PipelineMonth = { sentMonth: string; sentLabel: string; quoteCount: number; quotedValue: number };
export type PipelineResult = { pipelineMonths: PipelineMonth[]; quotedTotal: number; openQuotes: number; quotesWithoutLines: number; undatedQuotes: number };

export function pipelineQuotes(quotes: PipelineQuote[], lines: PipelineQuoteLine[], today: string, range: RevenueRange, customer: string | null = null): PipelineResult {
  const periods = periodsForRange(range);
  const valueOf = new Map<string, number>();
  for (const line of lines) {
    if (!line.quote_id || line.declined) continue;
    const quantity = Number(line.quantity);
    const price = Number(line.unit_price);
    if (!Number.isFinite(quantity) || !Number.isFinite(price)) continue;
    valueOf.set(line.quote_id, (valueOf.get(line.quote_id) ?? 0) + linePence(quantity, price));
  }
  const buckets = new Map(periods.map((p) => [p.key, { count: 0, pence: 0 }]));
  let openQuotes = 0;
  let quotesWithoutLines = 0;
  let undatedQuotes = 0;
  for (const quote of quotes) {
    if (customer && customerName(quote.customer) !== customer) continue;
    const stored = storedQuoteStatus(quote.status);
    if (stored !== "sent" || effectiveQuoteStatus(stored, quote.valid_until, today) !== "sent") continue;
    const day = calendarDate(quote.sent_at);
    if (!day) {
      undatedQuotes += 1;
      continue;
    }
    if (!inRange(day, range)) continue;
    const bucket = buckets.get(day.slice(0, 7));
    if (!bucket) continue;
    const pence = quote.id ? valueOf.get(quote.id) : undefined;
    if (pence === undefined) {
      quotesWithoutLines += 1;
      continue;
    }
    bucket.count += 1;
    bucket.pence += pence;
    openQuotes += 1;
  }
  const pipelineMonths = periods.map((p) => ({ sentMonth: p.key, sentLabel: p.label, quoteCount: buckets.get(p.key)!.count, quotedValue: fromPence(buckets.get(p.key)!.pence) }));
  return { pipelineMonths, quotedTotal: fromPence([...buckets.values()].reduce((sum, b) => sum + b.pence, 0)), openQuotes, quotesWithoutLines, undatedQuotes };
}
