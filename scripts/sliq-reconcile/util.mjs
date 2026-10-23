// Small shared helpers: comparing one value from each side, summing, and a short fingerprint for names.
import { normaliseName } from "../sliq-import/ids.mjs";

import { NOT_SUPPLIED, P, Q, UNKNOWN } from "./rows.mjs";
import { VOCAB, fingerprint as fp8, safeRef } from "./safe.mjs";

export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
export const fingerprint = fp8;
/** Names never go in the outputs: a name is shown as name-<8 hex of its normalised form>, which still lets two sides be compared by eye. */
export const nameRef = (name) => `name-${fingerprint(normaliseName(name))}`;

/** A text value is shown only if it is an ISO date, a plain number, a known status word or a short reference; otherwise as a fingerprint. */
function shownText(v) {
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) || /^-?\d+(\.\d+)?$/.test(s) || /^name-[0-9a-f]{8}$/.test(s) || /^text-[0-9a-f]{8}$/.test(s) || VOCAB.has(s.toLowerCase())) return s;
  return safeRef(s, "ref");
}
const show = (unit, v) => (unit === "p" ? P(v) : unit === "q" ? Q(v) : shownText(v));

/**
 * Compares one value from each side. undefined = the column/file was not supplied; null = known empty. Either one on either side
 * makes the check UNVERIFIED (a missing value is never read as zero). Equal values add no row.
 * @param o { area, code, ids, field, s, t, unit ("p" pence | "q" thousandths | "t" text), sev (severity when they differ), why (extra reason) }
 * @returns "equal" | "different" | "unverified"
 */
export function cmpVal(ctx, o) {
  if (o.s === null && o.t === null) return "equal"; // blank on both sides: nothing to disagree about
  const sMissing = o.s === undefined || o.s === null;
  const tMissing = o.t === undefined || o.t === null;
  const unit = o.unit ?? "t";
  if (sMissing || tMissing) {
    const side = (v, name) => (v === undefined ? `${name} did not supply it` : `${name} has it blank`);
    const reasons = [sMissing ? side(o.s, "SliQ") : null, tMissing ? side(o.t, "Tolra") : null].filter(Boolean).join("; ");
    ctx.add({
      area: o.area, code: `${o.code}_unverified`, ids: o.ids, field: o.field,
      source: sMissing ? (o.s === undefined ? NOT_SUPPLIED : UNKNOWN) : show(unit, o.s), target: tMissing ? (o.t === undefined ? NOT_SUPPLIED : UNKNOWN) : show(unit, o.t),
      severity: "UNVERIFIED", reason: `Cannot compare: ${reasons}. A missing value is not read as zero.${o.why ? ` ${o.why}` : ""}`,
    });
    return "unverified";
  }
  if (o.s === o.t) return "equal";
  ctx.add({
    area: o.area, code: o.code, ids: o.ids, field: o.field, source: show(unit, o.s), target: show(unit, o.t),
    diff: unit === "t" ? null : o.t - o.s, unit, severity: o.sev ?? "BLOCKER", reason: o.why ?? "The two sides disagree.",
  });
  return "different";
}
