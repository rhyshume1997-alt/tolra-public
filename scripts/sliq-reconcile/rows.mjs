// The mismatch row: what every check produces. Severities:
//   BLOCKER     a proven difference that changes money, identity or what is owed/still to make. Must be resolved or explained.
//   WARN        a proven difference that does not change a balance (wording, date, link, a source anomaly), or a data fault to fix.
//   INFO        a fact worth knowing that is not a fault (how a record was matched, a record that only Tolra has).
//   UNVERIFIED  the data needed to decide is missing or ambiguous. NOT zero, NOT a pass: a person must decide.
import { penceToPounds } from "../sliq-import/parse.mjs";

import { SafeError, fingerprint, safeFile, safeRef, scrub } from "./safe.mjs";

export const SEVERITIES = ["BLOCKER", "WARN", "INFO", "UNVERIFIED"];
export const CSV_COLUMNS = ["area", "identifier", "field", "source_value", "target_value", "difference", "severity", "reason"];

// Areas, in the order they appear in the outputs.
export const AREAS = [
  "inputs", "company-isolation", "identity", "relationships", "numbering", "opening", "receivables", "payments", "credits", "refunds", "payables",
  "quotes", "sales-orders", "purchase-orders", "commitments", "jobs", "wip", "deliveries", "historical", "target-integrity",
];

export const NOT_SUPPLIED = "(not supplied)";
export const UNKNOWN = "(unknown)";
export const NONE = "(none)";

const sevRank = new Map(SEVERITIES.map((s, i) => [s, i]));
const areaRank = new Map(AREAS.map((a, i) => [a, i]));

/** Pence as pounds ("120.00", "-0.50"); null as blank. */
export const P = (p) => (p === null || p === undefined ? "" : penceToPounds(p));
/** Thousandths as a plain number ("10", "2.5"). */
export const Q = (m) => {
  if (m === null || m === undefined) return "";
  const sign = m < 0 ? "-" : "";
  const a = Math.abs(m);
  const frac = String(a % 1000).padStart(3, "0").replace(/0+$/, "");
  return `${sign}${Math.floor(a / 1000)}${frac ? `.${frac}` : ""}`;
};

// The identifier keys a row may carry. A key outside this list is a programming error (it throws), so a new kind of value cannot
// reach an output without being named here. "ref" keys hold a document number or account code (safeRef); "file" keys a file or
// worksheet name (safeFile); "composite" keys hold text this tool builds from already-safe parts (amounts, dates, references).
const REF_KEYS = new Set([
  "invoice", "credit note", "quote", "sales order", "purchase order", "job", "delivery note", "supplier bill", "customer", "supplier",
  "document", "refund", "number", "invoice/credit note", "table", "company", "customer or supplier",
]);
const FILE_KEYS = new Set(["file", "mapping", "snapshot", "column"]);
const COMPOSITE_KEYS = new Set(["payment", "line", "row", "total", "matching", "level", "allocation", "tolra payment", "open jobs", "commitments", "customers", "suppliers", "row id"]);
const COMPOSITE = /^[A-Za-z0-9 ._\-/#+:>,()=]{1,160}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LONG_DIGITS = /\d{10,}|\d[\d ()-]{9,}\d/;

function safeIdValue(key, value) {
  const v = String(value);
  if (key === "row id" && UUID.test(v)) return v;
  if (REF_KEYS.has(key)) return safeRef(v);
  if (FILE_KEYS.has(key)) return safeFile(v);
  if (COMPOSITE_KEYS.has(key)) return COMPOSITE.test(v) && !LONG_DIGITS.test(v.replace(/\d{4}-\d{2}-\d{2}/g, "")) ? v : `ref-${fingerprint(v)}`;
  // The key may be hostile (an e-mail address, a name, a phone number, control characters): the message is a constant and
  // carries nothing derived from it, not even a fingerprint.
  throw new SafeError("an identifier key is not on the output allowlist (scripts/sliq-reconcile/rows.mjs)");
}

export const ids = (obj) =>
  Object.entries(obj)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${safeIdValue(k, v)}`)
    .join(";");

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function makeCollector() {
  const rows = [];
  return {
    rows,
    /** { area, code, ids, field, source, target, diff (pence or milli or null), unit ("p"|"q"|null), severity, reason } */
    add(r) {
      if (!SEVERITIES.includes(r.severity)) throw new SafeError("bad severity");
      if (!areaRank.has(r.area)) throw new SafeError("bad area");
      let difference = "";
      if (r.diff !== null && r.diff !== undefined) difference = r.unit === "q" ? Q(r.diff) : P(r.diff);
      rows.push({
        area: r.area, code: r.code, identifier: ids(r.ids ?? {}), field: r.field,
        source_value: scrub(r.source ?? ""), target_value: scrub(r.target ?? ""), difference, severity: r.severity, reason: scrub(r.reason),
      });
    },
  };
}

/** Stable order: area, identifier, field, severity, reason. Plain code-unit comparison, no locale. Exact duplicates are removed. */
export function sortRows(rows) {
  const sorted = [...rows].sort(
    (a, b) =>
      areaRank.get(a.area) - areaRank.get(b.area) || cmp(a.identifier, b.identifier) || cmp(a.field, b.field) || sevRank.get(a.severity) - sevRank.get(b.severity) ||
      cmp(a.code, b.code) || cmp(a.source_value, b.source_value) || cmp(a.target_value, b.target_value) || cmp(a.reason, b.reason),
  );
  return sorted.filter((r, i) => i === 0 || JSON.stringify(r) !== JSON.stringify(sorted[i - 1]));
}
