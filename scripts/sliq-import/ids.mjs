// Deterministic "old ids" for public.legacy_import_map. The existing importer keys rows by (table, old id) and a repeat run
// skips a key it has seen. SliQ has no numeric ids to offer, so each record gets a stable id made from the organisation
// and the record's natural identity (document number, customer account or name). The same file imported twice gives the same
// ids (nothing new the second time); the same data into another organisation gives different ids (no cross-tenant
// collision, because the map's primary key is global). The ids sit between 1e15 and 6e15: far above the small ids of the
// JNREng-format export, and below 2^53 so they survive JSON as plain numbers.
import { createHash } from "node:crypto";

const BASE = 1_000_000_000_000_000;

export function legacyId(organizationId, kind, identity) {
  const h = createHash("sha256").update(`sliq|${organizationId.toLowerCase()}|${kind}|${identity}`).digest();
  const n = Number(h.readBigUInt64BE(0) % 4_500_000_000_000_000n);
  return BASE + n;
}

/** Same identity for the same payment: invoice number, date, amount and its place among that invoice's payments. */
export function paymentIdentity(invoiceNumber, date, amountPence, ordinal) {
  return `${invoiceNumber}|${date ?? ""}|${amountPence}|${ordinal}`;
}

/** Document numbers are text, compared exactly as given (prefixes, leading zeros and case kept); only surrounding spaces go. */
export const normNumber = (s) => String(s ?? "").trim();

/** Customer names compared the way a person would: case, spacing, punctuation, "&"/"and" and Ltd/Limited ignored. */
export function normaliseName(name) {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\blimited\b/g, "ltd")
    .replace(/\s+/g, " ")
    .trim();
}
