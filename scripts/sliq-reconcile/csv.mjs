// CSV output that cannot run as a spreadsheet formula. Same rule as neutraliseCsvText / csvField in lib/html.ts (the accounting
// exports): text that starts with = + - @ tab or CR gets a leading apostrophe; a well-formed plain number such as -12.50 is left
// alone because it is a number, not a formula. tests/unit/sliq-reconcile.test.ts checks this file against lib/html.ts.
const PLAIN_NUMBER = /^-?\d+(?:\.\d+)?$/;

export function neutraliseCsvText(text) {
  const s = String(text ?? "");
  return PLAIN_NUMBER.test(s) || !/^[=+\-@\t\r]/.test(s) ? s : `'${s}`;
}

/** One field: neutralised, and quoted when it holds a comma, quote or line break. */
export function csvField(value) {
  const text = neutraliseCsvText(value === null || value === undefined ? "" : String(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Header plus rows, LF line ends, final newline. `columns` are the keys read from each row object. */
export function toCsv(columns, rows) {
  const lines = [columns.map(csvField).join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvField(r[c])).join(","));
  return `${lines.join("\n")}\n`;
}
