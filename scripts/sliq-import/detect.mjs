// Encoding and date-format detection. Both are only ever PROPOSED here: the report shows what was detected, and a write needs
// the operator to confirm them explicitly (flags or the mapping file) and to agree with the detection.

export const ENCODINGS = ["ascii", "utf-8", "utf-8-bom", "utf-16le", "windows-1252"];

/** The encoding of a CSV file: a BOM, else valid UTF-8, else Windows-1252 (SliQ and Excel on Windows). */
export function detectEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8-bom";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.every((b) => b < 0x80)) return "ascii"; // plain ASCII reads the same in every encoding below
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "utf-8";
  } catch {
    return "windows-1252";
  }
}

export function decodeBytes(bytes, encoding) {
  if (!ENCODINGS.includes(encoding)) throw new Error(`Unsupported encoding "${encoding}" (use ${ENCODINGS.join(", ")}).`);
  const label = encoding === "utf-8-bom" || encoding === "ascii" ? "utf-8" : encoding;
  return new TextDecoder(label, { fatal: encoding !== "windows-1252" }).decode(bytes);
}

/**
 * Proposes a date format from the values seen in date columns.
 * Returns { format, ambiguous, examples, conflict }: ISO dates are unambiguous; with d/m/y, any first part above 12 means
 * day-first, any second part above 12 means month-first; when every part is 12 or less the data cannot say, so
 * ambiguous is true (the proposal is the UK reading, which still has to be confirmed explicitly).
 */
export function detectDateFormat(values) {
  const vals = values.map((v) => String(v).trim()).filter(Boolean);
  const seen = { iso: 0, slash: 0, dash: 0, dot: 0, other: 0 };
  let firstOver = false;
  let secondOver = false;
  const examples = [];
  for (const v of vals) {
    let m;
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) seen.iso++;
    else if ((m = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{4})$/.exec(v))) {
      seen[m[2] === "/" ? "slash" : m[2] === "-" ? "dash" : "dot"]++;
      const [a, b] = [Number(m[1]), Number(m[3])];
      if (a > 12) firstOver = true;
      if (b > 12) secondOver = true;
    } else seen.other++;
    if (examples.length < 3 && !examples.includes(v)) examples.push(v);
  }
  if (vals.length === 0) return { format: null, ambiguous: false, examples, conflict: null };
  const kinds = Object.entries(seen).filter(([, n]) => n > 0).map(([k]) => k);
  if (kinds.length !== 1 || seen.other > 0) return { format: null, ambiguous: false, examples, conflict: `mixed or unrecognised date shapes (${kinds.join(", ")})` };
  if (seen.iso) return { format: "YYYY-MM-DD", ambiguous: false, examples, conflict: null };
  const sep = seen.slash ? "/" : seen.dash ? "-" : ".";
  if (firstOver && secondOver) return { format: null, ambiguous: false, examples, conflict: "some dates have a first part above 12 and others a second part above 12" };
  if (sep !== "/") return { format: sep === "-" ? "DD-MM-YYYY" : "DD.MM.YYYY", ambiguous: !firstOver, examples, conflict: null };
  if (firstOver) return { format: "DD/MM/YYYY", ambiguous: false, examples, conflict: null };
  if (secondOver) return { format: "MM/DD/YYYY", ambiguous: false, examples, conflict: null };
  return { format: "DD/MM/YYYY", ambiguous: true, examples, conflict: null };
}
