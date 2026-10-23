// Strict parsing for the SliQ import: CSV text, money (exact pennies), quantities, percentages and dates.
// Nothing here guesses. Anything ambiguous throws a ParseError that names the problem; blank means "not in the source"
// and comes back as null.

export class ParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ParseError";
  }
}

/** RFC 4180-style CSV: quoted fields, doubled quotes, embedded commas and line breaks, CRLF or LF, optional BOM. */
export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let fieldStarted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === "" && !fieldStarted) {
      quoted = true;
      fieldStarted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      fieldStarted = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      fieldStarted = false;
    } else {
      field += c;
      fieldStarted = true;
    }
  }
  if (quoted) throw new ParseError("The file ends inside a quoted field (unbalanced quote).");
  if (field !== "" || fieldStarted || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const kept = rows.filter((r) => !r.every((v) => v.trim() === ""));
  if (kept.length === 0) throw new ParseError("The file is empty (no header row).");
  const headers = kept[0].map((h) => h.trim());
  const body = kept.slice(1);
  for (const [i, r] of body.entries()) {
    if (r.length !== headers.length) throw new ParseError(`Data row ${i + 1} has ${r.length} fields but the header has ${headers.length}.`);
  }
  return { headers, rows: body };
}

/**
 * Money to exact whole pennies (an integer). Accepts an optional pound sign, a leading minus or brackets (negative),
 * thousands commas in the UK form and at most two decimal places. Refuses, never rounds:
 *   "1.234,50" (European), "12.345" (more than pence), "1,23" (decimal comma), "1,234" (a lone comma group with no
 *   decimals: UK thousands or a European decimal, so ambiguous), "12.3.4", currency codes, text.
 * Blank returns null.
 */
export function parseMoneyPence(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (s === "") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith("-")) {
    if (negative) throw new ParseError(`Money "${raw}" has two minus signs.`);
    negative = true;
    s = s.slice(1).trim();
  }
  if (s.startsWith("£")) s = s.slice(1).trim();
  if (!/^[0-9][0-9,]*(\.[0-9]+)?$|^\.[0-9]+$/.test(s)) throw new ParseError(`Money "${raw}" is not a plain amount (digits, optional commas and a decimal point).`);
  const [intPart, frac = ""] = s.split(".");
  if (frac.length > 2) throw new ParseError(`Money "${raw}" has more than two decimal places: it is not rounded.`);
  let digits = intPart;
  if (intPart.includes(",")) {
    if (!/^[0-9]{1,3}(,[0-9]{3})+$/.test(intPart)) throw new ParseError(`Money "${raw}" has commas that do not group thousands (ambiguous format).`);
    if (!s.includes(".") && intPart.split(",").length === 2) {
      throw new ParseError(`Money "${raw}" is ambiguous (UK thousands or a European decimal): export it with two decimal places.`);
    }
    digits = intPart.replaceAll(",", "");
  }
  const pence = Number(digits || "0") * 100 + Number(frac.padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(pence)) throw new ParseError(`Money "${raw}" is too large.`);
  return negative ? -pence : pence;
}

/** Quantity to thousandths (an integer): up to three decimal places, no commas. Blank returns null. */
export function parseQuantityMilli(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const s = String(raw).trim();
  if (!/^-?[0-9]+(\.[0-9]{1,3})?$/.test(s)) throw new ParseError(`Quantity "${raw}" is not a number with at most three decimal places.`);
  const neg = s.startsWith("-");
  const [i, f = ""] = s.replace("-", "").split(".");
  const v = Number(i) * 1000 + Number(f.padEnd(3, "0"));
  return neg ? -v : v;
}

/** A percentage ("20", "20.00", "20%", "17.5") to hundredths of a percent (2000). Blank returns null. */
export function parsePercentCenti(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const s = String(raw).trim().replace(/%$/, "").trim();
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(s)) throw new ParseError(`VAT rate "${raw}" is not a percentage with at most two decimal places.`);
  const [i, f = ""] = s.split(".");
  const centi = Number(i) * 100 + Number(f.padEnd(2, "0"));
  if (centi > 0 && centi < 100) throw new ParseError(`VAT rate "${raw}" is under 1%: ambiguous (20% written as a fraction?). Export it as a number such as 20.`);
  return centi;
}

export const DATE_FORMATS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "DD-MM-YYYY", "DD.MM.YYYY"];

/** A date in the one format the mapping names (never auto-detected). Returns "YYYY-MM-DD". Blank returns null. */
export function parseDate(raw, format) {
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  if (!DATE_FORMATS.includes(format)) throw new ParseError(`Date format "${format}" is not supported (use one of ${DATE_FORMATS.join(", ")}).`);
  const s = String(raw).trim();
  const patterns = {
    "DD/MM/YYYY": /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    "MM/DD/YYYY": /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
    "DD-MM-YYYY": /^(\d{2})-(\d{2})-(\d{4})$/,
    "DD.MM.YYYY": /^(\d{2})\.(\d{2})\.(\d{4})$/,
    "YYYY-MM-DD": /^(\d{4})-(\d{2})-(\d{2})$/,
  };
  const m = patterns[format].exec(s);
  if (!m) throw new ParseError(`Date "${raw}" does not match the format ${format}.`);
  let [y, mo, d] = format === "YYYY-MM-DD" ? [m[1], m[2], m[3]] : format === "MM/DD/YYYY" ? [m[3], m[1], m[2]] : [m[3], m[2], m[1]];
  mo = mo.padStart(2, "0");
  d = d.padStart(2, "0");
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() !== Number(mo) - 1 || dt.getUTCDate() !== Number(d)) {
    throw new ParseError(`Date "${raw}" is not a real calendar date.`);
  }
  return `${y}-${mo}-${d}`;
}

export function penceToPounds(p) {
  if (p === null || p === undefined) return null;
  return `${p < 0 ? "-" : ""}${Math.floor(Math.abs(p) / 100)}.${String(Math.abs(p) % 100).padStart(2, "0")}`;
}
export const poundsString = (p) => (p === null || p === undefined ? "blank" : `${p < 0 ? "-" : ""}£${penceToPounds(Math.abs(p))}`);
