/**
 * Quote versions and per-line part details (migration 068).
 *
 * A sent quote is revised as a new version: QUO-0123, then "QUO-0123 v2", "QUO-0123 v3" (each its own quote_ref). The version it
 * replaces is "superseded": kept, read only, viewable, never decided. Only the latest version can be accepted. Every version shares
 * the quote's attachments, filed under the quote's own number (baseQuoteRef), and its job takes that number (J-0123).
 *
 * Each quote line can name its part number, drawing number and drawing revision; they print under the line's description on the
 * quote and travel to the sales order's lines and the job's worksheet. On acceptance staff tick the lines the customer's PO covers;
 * the others are "declined" and go no further than the quote.
 */

import { documentTotals } from "@/lib/money";

/** A declined quote line as read for the figures (quote_line_items where declined). */
export type DeclinedLineRow = { quote_id: unknown; quantity: unknown; unit_price: unknown; vat_pct: unknown; vat_exempt: unknown };

/**
 * Per quote, what its declined lines came to on the quote, in pounds: each line's net plus its own VAT when the quote adds VAT, rounded
 * per line as the quote is (check_document_totals). The quote's total less this is what the customer actually ordered.
 */
export function declinedValueByQuote(lines: DeclinedLineRow[], vatOn: (quoteId: string) => boolean): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of lines) {
    const id = String(line.quote_id ?? "");
    if (!id) continue;
    const { total } = documentTotals(
      [{ quantity: Number(line.quantity) || 0, unitPrice: Number(line.unit_price) || 0, vatPct: line.vat_pct == null ? 20 : Number(line.vat_pct), vatExempt: Boolean(line.vat_exempt) }],
      0,
      { vatEnabled: vatOn(id) },
    );
    out.set(id, Math.round(((out.get(id) ?? 0) + total) * 100) / 100);
  }
  return out;
}

/** The quote's own number: "QUO-0123 v2" -> "QUO-0123" (version 1 is the number itself). The database's quote_base_ref. */
export function baseQuoteRef(ref: string, version: number | null | undefined): string {
  return (version ?? 1) > 1 ? ref.replace(/\s+v\d+\s*$/, "") : ref;
}

export type PartDetails = { partNumber?: string | null; drawingNumber?: string | null; drawingRevision?: string | null };

const clean = (value: string | null | undefined) => (value ?? "").trim();

/** "Part P-100; Dwg D-200 rev C", or "" when the line has none. The database's quote_line_reference (the job's worksheet text). */
export function lineReference({ partNumber, drawingNumber, drawingRevision }: PartDetails): string {
  const part = clean(partNumber);
  const drawing = clean(drawingNumber);
  const revision = clean(drawingRevision);
  const parts: string[] = [];
  if (part) parts.push(`Part ${part}`);
  if (drawing) parts.push(`Dwg ${drawing}${revision ? ` rev ${revision}` : ""}`);
  else if (revision) parts.push(`Rev ${revision}`);
  return parts.join("; ");
}

/** A line's description as printed: the description, then its part / drawing reference on the next line when it has one. */
export function describedLine(description: string, details: PartDetails): string {
  const reference = lineReference(details);
  return reference ? `${description}\n${reference}` : description;
}

/** What the database stores for a typed part field: trimmed text, or null when blank. */
export function partField(value: string | null | undefined): string | null {
  const trimmed = clean(value);
  return trimmed ? trimmed : null;
}

/**
 * The ids to send as accept_quote's p_lines: null when every line is ticked (the whole quote, as before 068), otherwise the ticked
 * ones in quote order. Throws when none is ticked: an order needs at least one line.
 */
export function acceptedLineIds(lineIds: string[], ticked: ReadonlySet<string>): string[] | null {
  const chosen = lineIds.filter((id) => ticked.has(id));
  if (!chosen.length) throw new Error("Tick at least one line the customer ordered.");
  return chosen.length === lineIds.length ? null : chosen;
}

/** The versions of one quote, oldest first, found by following previous_version_id links (rows of any quotes, in any order). */
export function versionChain<T extends { id?: string; previousVersionId?: string | null }>(rows: T[], quote: T): T[] {
  const byId = new Map(rows.filter((row) => row.id).map((row) => [row.id!, row]));
  const next = new Map(rows.filter((row) => row.previousVersionId).map((row) => [row.previousVersionId!, row]));
  let first = quote;
  const seen = new Set<string>();
  while (first.previousVersionId && byId.has(first.previousVersionId) && !seen.has(first.previousVersionId)) {
    seen.add(first.previousVersionId);
    first = byId.get(first.previousVersionId)!;
  }
  const chain = [first];
  let current = first;
  while (current.id && next.has(current.id) && chain.length <= rows.length) {
    current = next.get(current.id)!;
    chain.push(current);
  }
  return chain;
}
