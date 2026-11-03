// The write-mode guard. A write needs ALL of: an explicit --write, a safe target database, an explicit organisation id, a
// reconciliation report whose checksums match the inputs as they are now, a report approved for the same exclusions, and no
// unresolved reverse-charge or discount documents. Any failure throws a GuardError that says which condition failed.
import { readFileSync } from "node:fs";

import { normNumber } from "./ids.mjs";
import { REPORT_FORMAT } from "./reconcile.mjs";

export class GuardError extends Error {
  constructor(message) {
    super(message);
    this.name = "GuardError";
  }
}

export const PROD_REF = "qngvemzbdsvtydkbplpo";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Hides the password so a URL can be shown in a message. */
export function redactUrl(url) {
  return String(url).replace(/(:\/\/[^:/@]*:)[^@]*@/, "$1***@");
}

/**
 * Accepts only: host 127.0.0.1 / localhost (loopback), or a database whose name contains "disposable" or "rehearsal".
 * Refuses outright, whatever the host: supabase.co / supabase.com, the production project ref, any "prod" name, and
 * anything named JNREng.
 */
export function checkDatabaseUrl(url) {
  if (!url || typeof url !== "string") throw new GuardError("Refusing: no target database URL (--database-url).");
  const shown = redactUrl(url);
  if (/supabase\.(co|com)/i.test(url)) throw new GuardError(`Refusing: ${shown} is a hosted Supabase address.`);
  if (url.toLowerCase().includes(PROD_REF)) throw new GuardError(`Refusing: ${shown} carries the production project reference.`);
  if (/jnreng/i.test(url)) throw new GuardError(`Refusing: ${shown} is JNREng, which is only ever read by hand, never imported into.`);
  if (/prod/i.test(url)) throw new GuardError(`Refusing: ${shown} looks like a production database.`);
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new GuardError("Refusing: the database URL cannot be parsed.");
  }
  if (!/^postgres(ql)?:$/.test(u.protocol)) throw new GuardError("Refusing: the database URL is not a postgres:// URL.");
  const host = u.hostname.toLowerCase();
  const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
  const loopback = host === "127.0.0.1" || host === "localhost";
  const disposable = /disposable|rehearsal/i.test(database);
  if (!loopback && !disposable) {
    throw new GuardError(`Refusing: ${shown} is neither on 127.0.0.1/localhost nor a database named for disposable/rehearsal use.`);
  }
  return { host, database };
}

export function checkOrganisationId(id) {
  if (!id || !UUID.test(id)) throw new GuardError("Refusing: an explicit --organization-id (a UUID) is required.");
  return id.toLowerCase();
}

export function loadReportFile(reportPath) {
  if (!reportPath) throw new GuardError("Refusing: a reconciliation report is required (--report <report.json> from a dry run).");
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (e) {
    throw new GuardError(`Refusing: the report ${reportPath} cannot be read (${e.message}).`);
  }
  if (report?.format !== REPORT_FORMAT) throw new GuardError(`Refusing: ${reportPath} is not a ${REPORT_FORMAT} report.`);
  return report;
}

/** `current` is the report analyse() makes now from the files as they are. */
export function assertWriteAllowed({ write, databaseUrl, organizationId, report, current, excludeNumbers = [] }) {
  if (write !== true) throw new GuardError("Refusing: this is a dry run unless --write is given.");
  const db = checkDatabaseUrl(databaseUrl);
  const org = checkOrganisationId(organizationId);
  if (!report) throw new GuardError("Refusing: a reconciliation report is required (--report <report.json> from a dry run).");
  if (current.mapping.isStub) throw new GuardError("Refusing: the SliQ column mapping is still a stub.");
  if (!current.mapping.confirmed) throw new GuardError("Refusing: provisional mapping, confirm against the real headers. Mark the mapping file confirmed only after checking it against the JNR controller's real files.");
  const key = (i) => `${i.kind}|${i.file}|${i.sheet ?? ""}|${i.sha256}|${i.bytes}|${i.rows}`;
  const was = new Set(report.inputs.map(key));
  const now = new Set(current.inputs.map(key));
  const changed = [...now].filter((k) => !was.has(k)).concat([...was].filter((k) => !now.has(k)));
  if (changed.length > 0) {
    throw new GuardError(`Refusing: the report is stale. Its file checksums, sizes or row counts differ from the files now in the folder (${[...new Set(changed.map((c) => c.split("|")[1]))].join(", ")}). Run the dry run again and have the new report approved.`);
  }
  if (report.mapping?.id !== current.mapping.id) throw new GuardError("Refusing: the report was made with a different column mapping.");
  if (report.organizationId !== org) throw new GuardError("Refusing: the report was made for a different organisation than --organization-id.");
  if (!report.collisions?.checked) throw new GuardError("Refusing: the report did not check number collisions against the target. Re-run the dry run with --database-url and --organization-id (read only).");
  const fmt = current.formats;
  if (fmt.encoding.perFile.length > 0) {
    if (!fmt.encoding.confirmed) throw new GuardError(`Refusing: the file encoding is not confirmed (detected ${fmt.encoding.detected.join(", ")}). Pass --encoding or record it in the mapping file.`);
    const off = fmt.encoding.perFile.filter((e) => e.detected !== "ascii" && e.detected !== fmt.encoding.confirmed);
    if (off.length > 0) throw new GuardError(`Refusing: the confirmed encoding ${fmt.encoding.confirmed} does not match what was detected (${off.map((e) => `${e.file}: ${e.detected}`).join("; ")}).`);
  }
  if (fmt.dateFormat.valuesSeen > 0) {
    if (!fmt.dateFormat.confirmed) throw new GuardError(`Refusing: the date format is not confirmed (detected ${fmt.dateFormat.detected ?? "none"}). Pass --date-format or record it in the mapping file.`);
    if (!fmt.dateFormat.ambiguous && fmt.dateFormat.detected && fmt.dateFormat.detected !== fmt.dateFormat.confirmed) {
      throw new GuardError(`Refusing: the confirmed date format ${fmt.dateFormat.confirmed} does not match what was detected (${fmt.dateFormat.detected}).`);
    }
  }
  if (report.formats?.dateFormat?.used !== fmt.dateFormat.used) throw new GuardError("Refusing: the report was made with a different date format.");
  const sorted = (xs) => xs.map(normNumber).sort().join(",");
  if (sorted(report.excludeNumbers ?? []) !== sorted(excludeNumbers)) throw new GuardError("Refusing: the report was approved with a different list of excluded numbers.");
  // Everything the approval covered must be exactly what is being run now: the whole mapping file and every option.
  const diff = [];
  if (report.approval?.mappingSha256 !== current.approval.mappingSha256) diff.push("the mapping file");
  for (const k of Object.keys(current.approval.options)) {
    if (JSON.stringify(report.approval?.options?.[k] ?? null) !== JSON.stringify(current.approval.options[k])) diff.push(k === "resolutionsSha256" ? "the credit-note resolution file" : k);
  }
  if (!report.approval || diff.length > 0 || report.approval.sha256 !== current.approval.sha256) {
    throw new GuardError(`Refusing: what was approved differs from what is being run (${diff.join(", ") || "approval record missing or changed"}). Run the dry run again and have the new report approved.`);
  }
  if (!report.rehearsal?.id) {
    throw new GuardError("Refusing: the report carries no rehearsal identity. Prepare the disposable copy (cli.mjs prepare-rehearsal), then re-run the dry run against it so the report records its identity.");
  }
  if (!report.writable || !current.writable) throw new GuardError("Refusing: the report lists rows that could not be read, or unknown excluded numbers. Fix the source and re-run the dry run.");
  if (current.unresolvedCreditNoteCount > 0) {
    const list = current.creditNoteResolution.unresolved.map((n) => n.number).join(", ");
    throw new GuardError(`Refusing: credit notes or allocations are unresolved: ${list}. Tolra has no credit-note type; give each a reviewed decision in a resolution file (--resolutions).`);
  }
  if (current.unresolvedMatchCount > 0) {
    const list = current.customerMatching.ambiguities.filter((n) => n.blocksWrite).map((n) => `${n.kind} ${n.number}`);
    throw new GuardError(`Refusing: ${list.length} customer or supplier match(es) are ambiguous or unmatched (${list.slice(0, 10).join(", ")}${list.length > 10 ? ", ..." : ""}). See ambiguity.csv; name the account in the resolutions file (customerMatches / customerNames) or exclude the document by number.`);
  }
  if (current.unresolvedPaymentCount > 0) {
    const list = current.balances.exceptions.filter((n) => n.blocksWrite).map((n) => n.number);
    throw new GuardError(`Refusing: payment exceptions are unresolved: ${list.join(", ")}. An imported invoice gets its real balance, so fix the source or exclude each by number (--exclude).`);
  }
  if (current.unresolvedReviewCount > 0) {
    const list = current.needsReview.filter((n) => n.blocksWrite && !n.excluded).map((n) => n.number).join(", ");
    throw new GuardError(`Refusing: documents flagged for reverse charge or discounts are unresolved: ${list}. Resolve them in the source or exclude each by number (--exclude).`);
  }
  return { ...db, organizationId: org };
}
