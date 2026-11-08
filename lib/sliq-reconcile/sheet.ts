import type { ReconcileReport, SourceTotals } from "./reconcile";

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const pence = (p: number) => `${p < 0 ? "-" : ""}${Math.floor(Math.abs(p) / 100)}.${String(Math.abs(p) % 100).padStart(2, "0")}`;

/** Plain-text signing sheet. The overall result is FAIL unless every difference is zero. */
export function renderSigningSheet(
  source: SourceTotals,
  report: ReconcileReport,
  meta: { company: string; importedOn: string },
): string {
  const L: string[] = [];
  L.push("SLIQ IMPORT RECONCILIATION - SIGNING SHEET");
  L.push(`Company: ${meta.company}`);
  L.push(`Import date: ${meta.importedOn}`);
  // PASS needs a passing report AND every source file named with a 64-character SHA-256 (the paper binds the totals to the files).
  const hashesOk = source.files.length > 0 && source.files.every((f) => f.name !== "" && /^[0-9a-f]{64}$/.test(f.sha256));
  L.push(`Overall result: ${report.pass && hashesOk ? "PASS - all differences are zero" : "FAIL - do not sign"}`);
  if (!hashesOk) L.push("  (a source file's SHA-256 is missing or not 64 hex characters: the sheet can't be signed)");
  L.push("");
  L.push("SOURCE FILES (SHA-256)");
  for (const f of source.files) L.push(`  ${f.name}  ${f.sha256}`);
  L.push("");
  L.push("SOURCE TOTALS");
  for (const [k, v] of Object.entries(source.counts)) L.push(`  count ${k}: ${v}`);
  L.push(`  invoice total: ${pence(source.invoiceTotalPence)}`);
  L.push(`  payments total: ${pence(source.paymentsTotalPence)}`);
  L.push(`  credits total: ${pence(source.creditsTotalPence ?? 0)}`);
  L.push(`  outstanding: ${pence(source.outstandingPence)}`);
  L.push("");
  L.push("DATABASE TOTALS");
  for (const [k, v] of Object.entries(report.db.counts)) L.push(`  count ${k}: ${v}`);
  L.push(`  invoice total: ${pence(report.db.invoicedPence)}`);
  L.push(`  payments total: ${pence(report.db.paidPence)}`);
  L.push(`  credits total: ${pence(report.db.creditsPence)}`);
  L.push(`  outstanding: ${pence(report.db.outstandingPence)}`);
  L.push("");
  L.push("CHECKS (difference must be zero)");
  const w = Math.max(...report.rows.map((r) => r.check.length), 5);
  L.push(`  ${pad("check", w)}  ${pad("source", 12)}  ${pad("database", 12)}  ${pad("difference", 10)}  result`);
  for (const r of report.rows) {
    L.push(`  ${pad(r.check, w)}  ${pad(r.source, 12)}  ${pad(r.database, 12)}  ${pad(r.difference, 10)}  ${r.status}`);
  }
  const details = [...report.db.dupDetail, ...report.db.overpaidDetail];
  if (details.length) {
    L.push("");
    L.push("DETAIL OF PROBLEMS FOUND");
    for (const d of details) L.push(`  ${d}`);
  }
  L.push("");
  L.push("DOCUMENT COUNTERS (last number used)");
  L.push(`  ${pad("prefix", 8)}  ${pad("before", 10)}  after`);
  for (const p of Array.from(new Set([...Object.keys(report.countersBefore), ...Object.keys(report.countersAfter)])).sort()) {
    L.push(`  ${pad(p, 8)}  ${pad(String(report.countersBefore[p] ?? "none"), 10)}  ${report.countersAfter[p] ?? "none"}`);
  }
  L.push("");
  L.push("SIGNED");
  L.push("  John: ______________________  Date: ____________");
  L.push("  Rhys: ______________________  Date: ____________");
  return L.join("\n") + "\n";
}
