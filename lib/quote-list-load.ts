/**
 * BOUNDARY (Quotes module 3, READ-ONLY LIVE PREVIEW). Inputs: a Supabase client under the signed-in person's own session (anon key plus row-level security, exactly as the real
 * Quote Generator page uses it), and today's date. Outputs: the quote list rows, the declined value per quote, the company's archive setting and the manual archive choices, and one
 * quote's lines. SELECT ONLY: this file never inserts, updates, upserts, deletes, calls a database function (rpc), touches storage, sends e-mail or calls an API route.
 * It is a COPY of the real page's row mapper and fetchAll paging (app/(dashboard)/quotes/page.tsx loadQuotes and fetchQuoteItems) and of the two reads in lib/archive.ts useArchive,
 * so the real page stays untouched; tests/unit/quoteListLoad.test.ts pins the copied text to the real source and fails when either drifts.
 * Must not change: the select columns, the order, the paging, the status rules (real lib/quote-status, lib/quote-versions) and the read-only rule (tests/unit/quotesLiveGuard.test.ts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { customerPoText } from "@/lib/customer-po";
import { databaseHas068 } from "@/lib/db-features";
import { fetchAll } from "@/lib/fetch-all";
import { effectiveQuoteStatus, storedQuoteStatus, type QuoteStatus } from "@/lib/quote-status";
import { type DeclinedLineRow, declinedValueByQuote } from "@/lib/quote-versions";

/** A client that can only be read from here: the loader calls from().select() and nothing else. */
export type ReadClient = Pick<SupabaseClient, "from">;

/** The real page's QuoteRow (the same fields, the same meaning). */
export type QuoteListRow = {
  id?: string;
  ref: string;
  customer: string;
  value: number;
  status: QuoteStatus;
  rawStatus: QuoteStatus;
  description: string;
  updatedAt?: string;
  validUntil: string;
  internalNotes: string;
  customerNotes: string;
  terms: string;
  date?: string;
  sentAt?: string;
  vatEnabled: boolean;
  issuerSnapshot?: unknown;
  customerSnapshot?: unknown;
  version: number;
  previousVersionId?: string | null;
  declinedValue?: number;
  customerPo: string;
};

export type QuoteLine = {
  id?: string; description: string; quantity: number; unitPrice: number; source: string; vatPct?: number; vatExempt?: boolean;
  partNumber?: string | null; drawingNumber?: string | null; drawingRevision?: string | null; declined?: boolean;
};

export type QuoteListResult = { rows: QuoteListRow[]; truncated: boolean; declinedTruncated: boolean; declinedLoaded: boolean };

/** One database row to the list row (copied from the real page, pinned by test). `today` is the local date as YYYY-MM-DD. */
export function mapQuoteRow(quote: Record<string, unknown>, today: string): QuoteListRow {
  return ({
        id: quote.id ? String(quote.id) : undefined,
        ref: String(quote.quote_ref || ""),
        customer: String(quote.customer || ""),
        value: Number(quote.total_value || 0),
        rawStatus: storedQuoteStatus(quote.status),
        status: effectiveQuoteStatus(storedQuoteStatus(quote.status), quote.valid_until ? String(quote.valid_until) : "", today),
        description: String(quote.description || ""),
        updatedAt: quote.updated_at ? String(quote.updated_at) : undefined,
        validUntil: quote.valid_until ? String(quote.valid_until).slice(0, 10) : "",
        internalNotes: String(quote.internal_notes || ""),
        customerNotes: String(quote.customer_notes || ""),
        terms: String(quote.terms || ""),
        date: quote.created_at ? String(quote.created_at) : undefined,
        sentAt: quote.sent_at ? String(quote.sent_at) : undefined,
        vatEnabled: quote.vat_enabled !== false,
        issuerSnapshot: quote.issuer_snapshot ?? undefined,
        customerSnapshot: quote.customer_snapshot ?? undefined,
        version: Number(quote.version ?? 1) || 1,
        previousVersionId: quote.previous_version_id ? String(quote.previous_version_id) : null,
        customerPo: customerPoText(quote.customer_po ? String(quote.customer_po) : "") ?? "",
  });
}

/** Every quote, page by page, plus the declined value of accepted quotes (068). Throws on a database error: the caller shows a failed state, never sample rows. */
export async function loadQuoteList(supabase: ReadClient, today: string, has068: () => Promise<boolean> = databaseHas068): Promise<QuoteListResult> {
  // Every row, page by page (lib/fetch-all): the API returns at most 1,000 per request.
  const { rows: data, truncated } = await fetchAll((from, to) => supabase!.from("quotes").select("*").order("created_at", { ascending: false }).order("id").range(from, to));
  const rows = ((data ?? []) as Array<Record<string, unknown>>).map((quote) => mapQuoteRow(quote, today));
  // Lines left off an accepted quote's order (068), so Accepted counts only what was ordered. Before 068 there are none.
  const declinedLoaded = await has068();
  const { rows: declinedLines, truncated: declinedTruncated } = declinedLoaded
    ? await fetchAll((from, to) => supabase!.from("quote_line_items").select("quote_id, quantity, unit_price, vat_pct, vat_exempt").eq("declined", true).order("id").range(from, to))
    : { rows: [], truncated: false };
  const vatOn = new Map(rows.map((row) => [row.id ?? "", row.vatEnabled]));
  const declined = declinedValueByQuote(declinedLines as DeclinedLineRow[], (id) => vatOn.get(id) ?? true);
  for (const row of rows) if (row.id && declined.has(row.id)) row.declinedValue = declined.get(row.id);
  return { rows, truncated, declinedTruncated, declinedLoaded };
}

/** One quote's lines, in order (copied from the real page's fetchQuoteItems; pinned by test). */
export async function loadQuoteLines(supabase: ReadClient, quoteId: string, has068: () => Promise<boolean> = databaseHas068): Promise<QuoteLine[]> {
  // Part / drawing / revision and declined only once 068 is applied; before it, the lines as they were.
  const columns: string = `id, description, quantity, unit_price, source, vat_pct, vat_exempt${await has068() ? ", part_number, drawing_number, drawing_revision, declined" : ""}`;
  const { data, error } = await supabase.from("quote_line_items").select(columns).eq("quote_id", quoteId).order("position");
  if (error) throw error;
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id), description: String(row.description || ""), quantity: Number(row.quantity || 0), unitPrice: Number(row.unit_price || 0), source: String(row.source || "manual"),
      vatPct: row.vat_pct === null || row.vat_pct === undefined ? undefined : Number(row.vat_pct), vatExempt: Boolean(row.vat_exempt),
      partNumber: (row.part_number as string | null | undefined) ?? null, drawingNumber: (row.drawing_number as string | null | undefined) ?? null,
      drawingRevision: (row.drawing_revision as string | null | undefined) ?? null, declined: Boolean(row.declined),
    }));
}

export type ManualArchive = "archived" | "active";
/** The company's "archive after" months (default 12) and the manual archive choices for quotes: the two reads of lib/archive.ts useArchive, without its write. */
export async function loadArchiveState(supabase: ReadClient): Promise<{ months: number; manual: Map<string, ManualArchive> }> {
  const [{ data: settings, error: settingsError }, { rows: states }] = await Promise.all([
    supabase!.from("organization_settings").select("archive_after_months").maybeSingle(),
    fetchAll((from, to) => supabase!.from("record_archive_state").select("record_id, state").eq("record_table", "quotes").order("record_id").range(from, to), { maxRows: Number.MAX_SAFE_INTEGER }),
  ]);
  if (settingsError) throw settingsError;
  let months = 12;
  const value = Number((settings as { archive_after_months?: unknown } | null)?.archive_after_months);
  if (Number.isFinite(value) && value >= 1) months = value;
  return { months, manual: new Map(states.map((row) => [String(row.record_id), row.state as ManualArchive])) };
}
