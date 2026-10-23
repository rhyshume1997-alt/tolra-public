// What may appear in an output. Rows and summaries are built from an explicit allowlist: numbers (pence, quantities), ISO dates,
// a fixed vocabulary of status words, short document references and account codes, and fingerprints (an 8-hex SHA-256 prefix)
// for everything else. A free-text value (a description, a name, a note, an address, an unexpected status) is NEVER printed:
// it becomes a fingerprint, which still shows whether two values are the same.
//
// A reference is a document number or account code. A reference that does not look like one (it has a space, an "@", a run of 10
// or more digits such as a phone number, a leading "=", or is long) is replaced by a fingerprint too. A name written without
// spaces or digits cannot be told apart from a code by shape: see "Limitations" in docs/go-live/sliq-reconcile.md.
import { createHash } from "node:crypto";

export const fingerprint = (text) => createHash("sha256").update(String(text)).digest("hex").slice(0, 8);

const REF = /^[A-Za-z0-9][A-Za-z0-9._\-/#+:]{0,39}$/;
const FILE = /^[A-Za-z0-9][A-Za-z0-9._\- \[\]]{0,59}$/;
const LONG_DIGITS = /\d{10,}|\d[\d ()-]{9,}\d/;

/** A document number, account code, job number, table name, ...: kept if it looks like one, else ref-<fingerprint>. */
export function safeRef(value, prefix = "ref") {
  const s = String(value ?? "").trim();
  if (s === "") return "";
  return REF.test(s) && !LONG_DIGITS.test(s) ? s : `${prefix}-${fingerprint(s)}`;
}

/** A file or worksheet name chosen by the operator. */
export function safeFile(value) {
  const s = String(value ?? "").trim();
  return FILE.test(s) && !LONG_DIGITS.test(s) && !/@/.test(s) ? s : `file-${fingerprint(s)}`;
}

/** Free text (a description, a note, an address): only a fingerprint and the length are ever shown. */
export const safeText = (value) => (value === null || value === undefined ? value : `text-${fingerprint(String(value).trim())}`);

// Every status, stage and word this tool prints. A word outside it is shown as a fingerprint.
export const VOCAB = new Set([
  "draft", "sent", "partial", "paid", "void", "voided", "cancelled", "canceled", "credited", "written_off", "overdue", "issued", "pending",
  "accepted", "rejected", "expired", "open", "confirmed", "in_production", "converted", "despatched", "closed", "received", "partial_received",
  "awaiting", "delivered", "signed", "active", "inactive", "archived", "on_track", "at_risk", "finished", "unfinished",
  "material", "setup", "machining", "inspection", "rework", "complete", "refund", "transfer", "customer", "supplier", "recorded", "legacy",
]);
export function safeWord(value) {
  if (value === null || value === undefined) return value;
  const s = String(value).trim().toLowerCase();
  return VOCAB.has(s) ? s : `word-${fingerprint(s)}`;
}

/**
 * A message that quotes the offending value ("...") keeps its words and loses the value. Everything from the first quote to the
 * last is withheld, so a value that itself contains a quote mark cannot leave its tail behind.
 */
export const stripQuoted = (message) => String(message).replace(/"[\s\S]*"/, '"<value withheld>"');

/** An identifier key, header or other input-derived label that must not appear in a message: key-<8 hex>, like a fingerprint. */
/**
 * An error whose message was built only from constants and fingerprints, so the command line may print it as it is. Any other
 * unexpected error is reported by name only (see cli.mjs).
 */
export class SafeError extends Error {
  constructor(message) {
    super(message);
    this.name = "SafeError";
  }
}

/**
 * Last line of defence for any string that reaches an output or the terminal: an e-mail address or a phone-like number is
 * replaced even if some code path let it through. It is not the primary control (the helpers above are).
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export function scrub(text) {
  const clean = (part) =>
    part
      .replace(/[^\s@"'<>(),;]+@[^\s@"'<>(),;]+/g, "[e-mail withheld]")
      .replace(/(?<![\w.-])\+?\d[\d ()-]{8,}\d(?![\w-])/g, (m) => (/^\d{4}-\d{2}-\d{2}/.test(m) ? m : "[number withheld]"));
  const s = String(text);
  const ids = s.match(UUID) ?? []; // a UUID is an id, not a phone number
  return s.split(UUID).map(clean).reduce((acc, part, i) => acc + part + (ids[i] ?? ""), "");
}
