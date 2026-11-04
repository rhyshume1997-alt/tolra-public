/**
 * The "Received by" line on a printed delivery note. A note recorded as signed prints who signed for it and when (signed_by_name is
 * typed by staff when they mark it signed; signed_at is when); any other note prints blank lines to fill in by hand.
 */
export function deliveryNoteReceivedLine(note: { status?: string | null; signedByName?: string | null; signedAt?: string | null }, formatDate: (iso: string) => string): string {
  const name = note.signedByName?.trim();
  if ((note.status ?? "").toLowerCase() === "signed" && name) {
    return `Received by: ${name}   Date: ${note.signedAt ? formatDate(note.signedAt) : "__________"}   Signature: __________________`;
  }
  return "Received by: __________________ Signature: __________________ Date: __________";
}

/**
 * The goods-out wording printed on every delivery note output (the print sheet, and the PDF that is downloaded, emailed or exported).
 * This is the one place to change it. A per-company wording can later be passed as `override` to the functions below without touching
 * the layouts; until a company has one, this default is used.
 */
export const DELIVERY_NOTE_GOODS_OUT_WORDING = "Goods out: the items listed above were despatched.";

/** The wording to print: the company's own when it has one (not blank), otherwise the default. */
export function deliveryNoteGoodsOutWording(override?: string | null): string {
  const own = override?.trim();
  return own || DELIVERY_NOTE_GOODS_OUT_WORDING;
}

/** The closing block of a delivery note, in print order: the goods-out wording, then the "Received by / Signature / Date" line. */
export function deliveryNoteSignOffLines(
  note: { status?: string | null; signedByName?: string | null; signedAt?: string | null },
  formatDate: (iso: string) => string,
  override?: string | null,
): [string, string] {
  return [deliveryNoteGoodsOutWording(override), deliveryNoteReceivedLine(note, formatDate)];
}
