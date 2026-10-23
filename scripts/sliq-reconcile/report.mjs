// Turns the comparison rows into the files a person reads: summary.json, summary.md and the mismatch CSVs. Deterministic: stable
// ordering, no absolute paths, no names, and the only moving part is the one `generatedAt` value the caller supplies.
import { createHash } from "node:crypto";

import { toCsv } from "./csv.mjs";
import { AREAS, CSV_COLUMNS, P, SEVERITIES } from "./rows.mjs";

export const REPORT_FORMAT = "sliq-tolra-reconciliation/1";

export const LIMITATIONS = [
  "Offline and read only: it compares two sets of files. It cannot tell whether the files are complete or current; a record that is in neither is invisible.",
  "Only the fields named in docs/go-live/sliq-reconcile.md are compared. Payment methods, references, addresses, contact details, notes and attachments are not.",
  "Names are never printed. Customers and suppliers are shown by account code (or a fingerprint of the name when SliQ has no code).",
  "A figure missing from either side is UNVERIFIED, never zero. The same applies to a whole file or table that was not supplied.",
  "Work-in-progress value is not derived or compared: valuation: accountant to confirm.",
  "Credit-note signs are compared, not erased: a negative SliQ credit is reported (WARN or INFO) and then compared by magnitude.",
  "Purchase-order totals are compared only when both sides declare net or gross and agree; otherwise they are UNVERIFIED.",
  "Company isolation depends on the snapshot's own organization_id values.",
  "A Tolra 'made' or 'accepted' quantity exists only if the snapshot producer derives it (job_quantities); otherwise those quantities are UNVERIFIED.",
  "The mapping decides what a SliQ column means. A provisional mapping (the default sliq one) has not been checked against JNR's real files.",
];

const zero = () => Object.fromEntries(SEVERITIES.map((s) => [s, 0]));

export function summarise(rows, ctx) {
  const bySeverity = zero();
  const byArea = Object.fromEntries(AREAS.map((a) => [a, zero()]));
  const byCode = {};
  for (const r of rows) {
    bySeverity[r.severity]++;
    byArea[r.area][r.severity]++;
    const k = `${r.area}/${r.code}`;
    byCode[k] ??= { area: r.area, code: r.code, severity: r.severity, count: 0 };
    byCode[k].count++;
  }
  // One explicit overall status. Only PASS means "nothing left": UNVERIFIED (or a warning) can never read as a pass.
  const status = bySeverity.BLOCKER ? "FAIL" : bySeverity.UNVERIFIED || bySeverity.WARN ? "INCOMPLETE" : "PASS";
  const open = `${bySeverity.BLOCKER} BLOCKER, ${bySeverity.WARN} WARN, ${bySeverity.UNVERIFIED} UNVERIFIED`;
  const verdictText = {
    FAIL: `FAIL: ${bySeverity.BLOCKER} proven difference(s) in money, identity, status or quantity.`,
    INCOMPLETE: `INCOMPLETE: no proven blocking difference, but ${bySeverity.UNVERIFIED} UNVERIFIED and ${bySeverity.WARN} WARN row(s) remain that a person must settle. This is not a pass.`,
    PASS: "PASS: no BLOCKER, WARN or UNVERIFIED rows in the data supplied (informational notes only).",
  }[status];
  const signOff =
    status === "PASS"
      ? { allowed: true, text: "Nothing outstanding in the data supplied. This is evidence for a person's sign-off, not the sign-off; the limitations below still apply." }
      : { allowed: false, text: `cannot sign off: ${open} row(s) remain. Resolve or explain each, supply any missing file or table, and run again.` };
  return {
    format: REPORT_FORMAT,
    generatedAt: ctx.generatedAt,
    mode: "dry run: read only, offline. Nothing was written to any database and no network was used.",
    verdict: { status, text: verdictText },
    signOff,
    exitCode: "0 = no BLOCKER (it does NOT mean PASS: read status); 4 = BLOCKER; 5 = not PASS when --require-pass is given",
    counts: { total: rows.length, bySeverity, byArea },
    codes: Object.values(byCode).sort((a, b) => (a.area < b.area ? -1 : a.area > b.area ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0)),
    entities: ctx.stats,
    inputs: ctx.inputs,
    limitations: LIMITATIONS,
    outputs: ctx.outputs,
  };
}

const md = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(summary, rows) {
  const L = [];
  const { counts } = summary;
  L.push(`# SliQ to Tolra reconciliation: ${summary.verdict.status}`, "");
  L.push(`Generated: ${summary.generatedAt}`, "");
  L.push(`**${summary.verdict.text}**`, "");
  L.push(`**Sign-off: ${summary.signOff.allowed ? "evidence ready" : summary.signOff.text}**`, "");
  if (summary.signOff.allowed) L.push(summary.signOff.text, "");
  L.push(`${summary.mode} The exit code 0 means only "no BLOCKER"; it is not a pass.`, "");
  L.push("## Rows by severity", "", "| Severity | Rows | Meaning |", "|---|---:|---|");
  const meaning = {
    BLOCKER: "proven difference in money, identity, status or quantity",
    WARN: "proven difference that does not move a balance, or a data fault",
    INFO: "a fact, not a fault",
    UNVERIFIED: "the data cannot settle it: a person must decide (not zero, not a pass)",
  };
  for (const s of SEVERITIES) L.push(`| ${s} | ${counts.bySeverity[s]} | ${meaning[s]} |`);
  L.push("", "## Rows by area", "", `| Area | ${SEVERITIES.join(" | ")} |`, `|---|${SEVERITIES.map(() => "---:").join("|")}|`);
  for (const a of AREAS) if (SEVERITIES.some((s) => counts.byArea[a][s])) L.push(`| ${a} | ${SEVERITIES.map((s) => counts.byArea[a][s]).join(" | ")} |`);
  const e = summary.entities;
  L.push("", "## Records seen", "", "| Record | SliQ | Tolra |", "|---|---:|---:|");
  const pairs = [["customers", "customers", "customers"], ["suppliers", "suppliers", "suppliers"], ["invoices", "invoices", "invoices"], ["credit notes", "creditNotes", "creditNotes"], ["payments (incl. reversals)", "payments", "payments"], ["credit allocations", "allocations", "allocations"], ["refunds", "refunds", "refunds"], ["supplier bills", "supplierBills", "supplierBills"], ["quotes", "quotes", "quotes"], ["sales orders", "salesOrders", "salesOrders"], ["purchase orders", "purchaseOrders", "purchaseOrders"], ["jobs", "jobs", "jobs"]];
  for (const [label, a, b] of pairs) L.push(`| ${label} | ${e.source[a]} | ${e.tolra[b]} |`);
  L.push(`| delivery notes (SliQ lines / Tolra notes) | ${e.source.deliveryLines} | ${e.tolra.deliveryNotes} |`);
  if (e.receivables) {
    L.push("", "## Control totals", "", "| Total | SliQ | Tolra |", "|---|---:|---:|");
    L.push(`| Outstanding customer receivables (invoices both sides can state) | ${P(e.receivables.source)} | ${P(e.receivables.target)} |`);
    for (const [k, v] of Object.entries(e.commitments)) L.push(`| ${k.replace(/_/g, " ")} (value) | ${v.sourceTotal === null ? "unknown" : P(v.sourceTotal)} | ${v.targetTotal === null ? "unknown" : P(v.targetTotal)} |`);
  }
  L.push("", "## Open jobs and work in progress", "", `Open jobs: ${e.wip.sourceOpenJobs} in SliQ, ${e.wip.tolraOpenJobs === null ? "not supplied" : e.wip.tolraOpenJobs} in Tolra. Stage and quantities are compared per job (see the mismatch files).`, "", `**${e.wip.valuation}.** No work-in-progress value is derived or compared.`);
  L.push("", "## What was read", "", "| Side | File | Rows | SHA-256 |", "|---|---|---:|---|");
  for (const f of summary.inputs.sliq.files) L.push(`| SliQ | ${md(f.file)}${f.sheet ? ` [${md(f.sheet)}]` : ""} (${f.kind}) | ${f.rows} | ${f.sha256.slice(0, 16)}... |`);
  for (const f of summary.inputs.tolra.files) L.push(`| Tolra | ${md(f.file)} | | ${f.sha256.slice(0, 16)}... |`);
  L.push("", `Mapping: ${summary.inputs.sliq.mapping.id} (${summary.inputs.sliq.mapping.status}).`);
  const blockers = rows.filter((r) => r.severity === "BLOCKER").slice(0, 25);
  if (blockers.length) {
    L.push("", `## First blockers (${blockers.length} of ${counts.bySeverity.BLOCKER})`, "", "| Area | Identifier | Field | SliQ | Tolra | Difference |", "|---|---|---|---|---|---:|");
    for (const r of blockers) L.push(`| ${r.area} | ${md(r.identifier)} | ${md(r.field)} | ${md(r.source_value)} | ${md(r.target_value)} | ${md(r.difference)} |`);
    L.push("", "The CSV files have every row with its reason.");
  }
  L.push("", "## What UNVERIFIED means", "", "A value that is missing or ambiguous on either side, or a whole file or table that was not supplied. It is not zero and it is not a pass. Someone who knows the real position (The JNR controller, the accountant) must confirm it, or the missing file must be supplied and the comparison run again.");
  L.push("", "## Limitations", "", ...summary.limitations.map((x) => `- ${x}`));
  return `${L.join("\n")}\n`;
}

/** { "mismatches.csv": text, "mismatches-<area>.csv": text } */
export function csvFiles(rows) {
  const files = { "mismatches.csv": toCsv(CSV_COLUMNS, rows) };
  for (const a of AREAS) {
    const part = rows.filter((r) => r.area === a);
    if (part.length) files[`mismatches-${a}.csv`] = toCsv(CSV_COLUMNS, part);
  }
  return files;
}

export const sha = (text) => createHash("sha256").update(text).digest("hex");
