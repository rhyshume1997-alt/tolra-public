/** Strict value parsers for the SliQ validator. Integer arithmetic only: no float is ever used for money. */

export const DATE_FORMATS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD", "DD-MM-YYYY", "DD.MM.YYYY"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Money text to whole pence. Accepts an optional pound sign, a minus or brackets, UK thousands commas and at most two
 * decimal places. Refuses (never rounds): three or more decimals, European formats, "1,234" with no decimals (ambiguous),
 * exponents, text. "0.1" and "0.2" are 10 and 20 pence exactly, so 0.1 + 0.2 is 30 pence, not 0.30000000000000004.
 */
export function parsePence(raw: string): Parsed<number> {
  let s = raw.trim();
  if (s === "") return { ok: false, reason: "blank amount" };
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith("-")) {
    if (negative) return { ok: false, reason: `amount "${raw}" has two minus signs` };
    negative = true;
    s = s.slice(1).trim();
  }
  if (s.startsWith("£")) s = s.slice(1).trim();
  if (!/^[0-9][0-9,]*(\.[0-9]+)?$|^\.[0-9]+$/.test(s)) return { ok: false, reason: `amount "${raw}" is not a plain amount` };
  const [intPart, frac = ""] = s.split(".");
  if (frac.length > 2) return { ok: false, reason: `amount "${raw}" has more than two decimal places (not rounded)` };
  let digits = intPart;
  if (intPart.includes(",")) {
    if (!/^[0-9]{1,3}(,[0-9]{3})+$/.test(intPart)) return { ok: false, reason: `amount "${raw}" has commas that do not group thousands` };
    if (!s.includes(".") && intPart.split(",").length === 2) {
      return { ok: false, reason: `amount "${raw}" is ambiguous (UK thousands or a European decimal)` };
    }
    digits = intPart.replaceAll(",", "");
  }
  const pence = Number(digits || "0") * 100 + Number(frac.padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(pence)) return { ok: false, reason: `amount "${raw}" is too large` };
  return { ok: true, value: negative ? -pence : pence };
}

export function penceToString(p: number): string {
  const a = Math.abs(p);
  return `${p < 0 ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}

const PATTERNS: Record<DateFormat, RegExp> = {
  "DD/MM/YYYY": /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  "MM/DD/YYYY": /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  "DD-MM-YYYY": /^(\d{1,2})-(\d{1,2})-(\d{4})$/,
  "DD.MM.YYYY": /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/,
  "YYYY-MM-DD": /^(\d{4})-(\d{2})-(\d{2})$/,
};

/** A date in exactly the stated format and a real calendar date. Returns YYYY-MM-DD. */
export function parseDate(raw: string, format: DateFormat): Parsed<string> {
  const m = PATTERNS[format].exec(raw.trim());
  if (!m) return { ok: false, reason: `date "${raw}" does not match ${format}` };
  const [y, mo, d] = format === "YYYY-MM-DD" ? [m[1], m[2], m[3]] : format === "MM/DD/YYYY" ? [m[3], m[1], m[2]] : [m[3], m[2], m[1]];
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() !== Number(mo) - 1 || dt.getUTCDate() !== Number(d)) {
    return { ok: false, reason: `date "${raw}" is not a real calendar date` };
  }
  return { ok: true, value: `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}` };
}
