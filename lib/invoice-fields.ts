/**
 * The invoice note and the delivery address (migration 073). Both are nullable columns on invoices, written on a DRAFT with Edit Draft
 * (replace_draft_invoice) and fixed once the invoice is issued, like every other detail. Before 073 the columns don't exist: a row
 * read with select("*") simply has no such key, which is how the screens know not to show or send them.
 */
export const INVOICE_NOTE_MAX = 200;
export const DELIVERY_ADDRESS_MAX = 500;

/** The column's value as loaded: undefined = the database has no such column (before 073); null = none set. */
export function optionalColumn(row: Record<string, unknown>, column: string): string | null | undefined {
  if (!Object.prototype.hasOwnProperty.call(row, column)) return undefined;
  const value = row[column];
  return value === null || value === undefined || String(value).trim() === "" ? null : String(value);
}

/** Why the note can't be saved, or null. One line, at most 200 characters. */
export function invoiceNoteProblem(note: string): string | null {
  if (/[\r\n]/.test(note)) return "The invoice note is one line (no line breaks).";
  if (note.trim().length > INVOICE_NOTE_MAX) return `The invoice note is at most ${INVOICE_NOTE_MAX} characters.`;
  return null;
}

/** Why the delivery address can't be saved, or null. */
export function deliveryAddressProblem(address: string): string | null {
  if (address.trim().length > DELIVERY_ADDRESS_MAX) return `The delivery address is at most ${DELIVERY_ADDRESS_MAX} characters.`;
  return null;
}

/** The delivery address as printed lines (one per line typed, or per comma), or undefined when there is none. */
export function deliveryAddressLines(address: string | null | undefined): string[] | undefined {
  const lines = String(address ?? "").split(/\r?\n|,\s*/).map((line) => line.trim()).filter(Boolean);
  return lines.length ? lines : undefined;
}
