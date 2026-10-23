// Credit notes and their allocations are never written (Tolra has no credit-note type) and never netted into invoices. A write
// is therefore refused while any credit note or allocation is unresolved, unless a REVIEWED resolution file covers it. The file
// is checksummed into the report, so changing it after approval makes the report stale.
//
//   {
//     "format": "sliq-credit-note-resolutions/1",
//     "resolutions": [
//       { "number": "CN-001", "decision": "record-outside-tolra", "allocation": { "invoice": "S1003", "amount": "24.00" }, "note": "..." },
//       { "number": "CN-002", "decision": "not-needed", "allocation": null }
//     ]
//   }
//
// decision: "record-outside-tolra" (a person records it by hand after the import), "not-needed" (reviewed: nothing to carry
// over) or "excluded" (left out on purpose). The file never makes the importer write anything: it only records the review.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { MappingError } from "./mapping.mjs";
import { ParseError, parseMoneyPence } from "./parse.mjs";

export const RESOLUTION_FORMAT = "sliq-credit-note-resolutions/1";
export const DECISIONS = ["record-outside-tolra", "not-needed", "excluded"];

export function loadResolutions(file) {
  let bytes;
  let data;
  try {
    bytes = readFileSync(file);
    data = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    throw new MappingError(`The credit-note resolution file ${file} cannot be read (${e.message}).`);
  }
  if (data?.format !== RESOLUTION_FORMAT || !Array.isArray(data.resolutions)) throw new MappingError(`${file} is not a ${RESOLUTION_FORMAT} file (needs "format" and a "resolutions" list).`);
  return { file: path.basename(file), sha256: createHash("sha256").update(bytes).digest("hex"), entries: data.resolutions };
}

/**
 * @returns {{file, sha256, covered: object[], unresolved: {number, reason}[], problems: string[]}}
 * Every credit note, and every allocation row that points at a missing document, is unresolved unless an entry names its number
 * with a valid decision. Where the source has allocations for a credit note, the entry must repeat them (invoice and amount).
 */
export function resolveCreditNotes({ creditNotes, allocations, invoiceNumbers, resolutions }) {
  const entries = new Map();
  const problems = [];
  for (const e of resolutions?.entries ?? []) {
    const n = String(e?.number ?? "").trim();
    if (!n) problems.push("a resolution has no credit note number");
    else if (entries.has(n)) problems.push(`credit note ${n} has more than one resolution`);
    else entries.set(n, e);
  }
  const covered = [];
  const unresolved = [];
  const numbers = new Set([...creditNotes.map((c) => c.number), ...allocations.filter((a) => a.status !== "ok").map((a) => a.creditNote)]);
  for (const n of numbers) {
    const e = entries.get(n);
    if (!e) {
      unresolved.push({ number: n, reason: "no reviewed resolution: not written, not netted, decision needed" });
      continue;
    }
    const bad = [];
    if (!DECISIONS.includes(e.decision)) bad.push(`decision must be one of ${DECISIONS.join(", ")}`);
    let alloc = null;
    if (e.allocation) {
      try {
        const amount = parseMoneyPence(e.allocation.amount);
        if (amount === null) bad.push("allocation amount is blank");
        else if (!invoiceNumbers.has(String(e.allocation.invoice ?? "").trim())) bad.push(`allocation invoice ${e.allocation.invoice} is not in the invoice file`);
        else alloc = { invoice: String(e.allocation.invoice).trim(), amount };
      } catch (err) {
        if (!(err instanceof ParseError)) throw err;
        bad.push(`allocation amount: ${err.message}`);
      }
    }
    const source = allocations.filter((a) => a.creditNote === n && a.status === "ok");
    if (source.length > 0) {
      const ok = alloc && source.length === 1 && source[0].invoice === alloc.invoice && source[0].amount === alloc.amount;
      if (!ok) bad.push("the source has an allocation for this credit note and the resolution does not repeat it exactly (invoice and amount)");
    }
    if (bad.length) unresolved.push({ number: n, reason: `resolution is not valid: ${bad.join("; ")}` });
    else covered.push({ number: n, decision: e.decision, allocation: alloc, note: e.note ?? null });
  }
  for (const n of entries.keys()) if (!numbers.has(n)) problems.push(`resolution for ${n}, which is not a credit note in the source`);
  return { file: resolutions?.file ?? null, sha256: resolutions?.sha256 ?? null, covered, unresolved, problems };
}
