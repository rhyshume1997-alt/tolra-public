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
