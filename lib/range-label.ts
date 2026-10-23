/**
 * A date range in plain words for a card caption: "1–19 Oct 2026", "28 Sep – 19 Oct 2026", "19 Oct 2026". Takes the YYYY-MM-DD
 * strings the date range control holds; anything else comes back as given. Pure, no time zone involved.
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function parts(value: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const m = Number(match[2]);
  if (m < 1 || m > 12) return null;
  return { y: Number(match[1]), m, d: Number(match[3]) };
}

export function rangeLabel(from: string, to: string): string {
  const a = parts(from);
  const b = parts(to);
  if (!a || !b) return [from, to].filter(Boolean).join(" to ");
  const one = (p: { y: number; m: number; d: number }) => `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
  if (from === to) return one(a);
  if (a.y === b.y && a.m === b.m) return `${a.d}–${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  if (a.y === b.y) return `${a.d} ${MONTHS[a.m - 1]} – ${one(b)}`;
  return `${one(a)} – ${one(b)}`;
}

/** The Invoices page's "Invoices Raised" caption: what the number counts and over which dates. */
export function raisedCaption(from: string, to: string): string {
  return `Issued ${rangeLabel(from, to)}. Drafts and void are not counted.`;
}

/** What the Invoices page's Show tabs count (hover text and the line beside them). */
export const INVOICE_SHOW_NOTE = "Open: still to do (drafts, unpaid). Done: every paid, void or cancelled invoice, any date.";
