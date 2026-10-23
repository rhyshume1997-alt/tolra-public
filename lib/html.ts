/** Escape text for safe interpolation into HTML strings. */
export function esc(value: unknown) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A well-formed plain number ("12", "-12.50"): safe in a spreadsheet, and must stay a number (money columns). */
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

/**
 * Neutralise spreadsheet formulas in text going into a CSV cell: a value that starts with =, +, - , @, a tab or a
 * carriage return would be run as a formula by Excel and Sheets, so it gets a leading apostrophe. A well-formed plain
 * number is left alone (a negative amount is "-12.50", not a formula). Use for TEXT fields; pass numbers through
 * csvField / csvCell, which never touch them.
 */
export function neutraliseCsvText(text: string) {
  return PLAIN_NUMBER.test(text) || !/^[=+\-@\t\r]/.test(text) ? text : `'${text}`;
}

/** Make a value safe for a CSV cell: neutralise spreadsheet formulas and always quote it. */
export function csvCell(value: unknown) {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : String(value ?? "");
  return `"${neutraliseCsvText(text).replaceAll('"', '""')}"`;
}

/**
 * One CSV field for the accounting exports (summary.csv, payments.csv): a number is written with two decimals and never
 * altered, text is neutralised as above, and quoted only when it needs it. null / undefined is an empty field.
 */
export function csvField(value: string | number | null | undefined) {
  const text = typeof value === "number" ? value.toFixed(2) : neutraliseCsvText(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
