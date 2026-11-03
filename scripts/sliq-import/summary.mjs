#!/usr/bin/env node
// Safe-to-share summaries for the REAL dry run (REAL-DRY-RUN.md). What this prints holds only file names, column names, counts and
// totals: never a customer or supplier name, a document number, an amount per customer or document, or any row's values. Reads
// local files only; touches no database.
//
//   node scripts/sliq-import/summary.mjs headers <export folder>     the header row of every CSV and every worksheet, nothing else
//   node scripts/sliq-import/summary.mjs report <report.json>        counts and totals from a dry run's report.json
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { decodeBytes, detectEncoding } from "./detect.mjs";
import { readWorkbooks } from "./load.mjs";
import { parseCsv } from "./parse.mjs";

const pounds = (p) => (typeof p === "number" ? `£${(p / 100).toFixed(2)}` : "n/a");
const tally = (xs, key) => Object.entries(xs.reduce((m, x) => ({ ...m, [key(x)]: (m[key(x)] ?? 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join(", ") || "none";

/** The header row of each file: CSV by its first line, .xlsx by the first non-empty row of each worksheet. Row counts, no values. */
export async function headersSummary(folder) {
  const L = [`Header rows in ${path.basename(path.resolve(folder))} (file and column names only, no row data)`];
  for (const f of readdirSync(folder).filter((x) => /\.csv$/i.test(x)).sort()) {
    const bytes = readFileSync(path.join(folder, f));
    let line;
    try {
      const { headers, rows } = parseCsv(decodeBytes(bytes, detectEncoding(bytes)));
      line = `${f}: ${rows.length} data rows; columns: ${headers.map((h) => JSON.stringify(h)).join(", ")}`;
    } catch {
      line = `${f}: cannot be read as CSV (no content shown)`;
    }
    L.push(line);
  }
  for (const wb of await readWorkbooks(folder)) {
    for (const s of wb.sheets) {
      const rows = s.data.filter((r) => r.some((c) => c !== null && c !== undefined && String(c).trim() !== ""));
      const head = (rows[0] ?? []).map((c) => JSON.stringify(c === null || c === undefined ? "" : String(c).trim()));
      L.push(`${wb.file} [${s.name}]: ${Math.max(0, rows.length - 1)} data rows; columns: ${head.join(", ")}`);
    }
  }
  return L.join("\n");
}

/** Counts and totals only from a dry run's report.json. */
export function reportSummary(r) {
  const j = r.jobsImport;
  const amb = r.customerMatching?.ambiguities ?? [];
  const L = [];
  L.push(`SliQ dry-run summary (counts and totals only). Report format ${r.format}; mapping ${r.mapping?.id} (${r.mapping?.status}${r.mapping?.isProvisional ? ", provisional" : ""}).`);
  L.push(`Encoding detected: ${(r.formats?.encoding?.detected ?? []).join(", ") || "none"}; confirmed: ${r.formats?.encoding?.confirmed ?? "not confirmed"}. Date format detected: ${r.formats?.dateFormat?.detected ?? "none"}${r.formats?.dateFormat?.ambiguous ? " (ambiguous)" : ""}; confirmed: ${r.formats?.dateFormat?.confirmed ?? "not confirmed"}.`);
  L.push("Files read:");
  for (const i of r.inputs ?? []) L.push(`  ${i.kind}: ${i.file}${i.sheet ? ` [${i.sheet}]` : ""}, ${i.rows} rows${i.unmappedColumns?.length ? `; columns the mapping does not use: ${i.unmappedColumns.map((c) => JSON.stringify(c)).join(", ")}` : ""}${i.optionalColumnsMissing?.length ? `; mapped fields with no column: ${i.optionalColumnsMissing.join(", ")}` : ""}`);
  L.push(`Files not supplied: ${(r.filesNotSupplied ?? []).map((f) => (typeof f === "string" ? f : `${f.kind} (${[].concat(f.file).join(" or ")})`)).join(", ") || "none"}. Jobs files not supplied: ${j ? j.filesNotSupplied.join(", ") || "none" : "no jobs section in the mapping"}. Worksheets not matched: ${(r.unmatchedSheets ?? []).length}.`);
  const hp = r.headerCheck?.problems ?? [];
  L.push(`Header check (${r.headerCheck?.strict ? "strict" : "not strict"}): ${hp.length ? hp.map((p) => `${p.file}: missing ${p.missing.map((m) => m.columns.map((c) => JSON.stringify(c)).join(" or ")).join(", ") || "none"}; unknown ${p.unknown.map((c) => JSON.stringify(c)).join(", ") || "none"}`).join(" | ") : "every file matches the mapping"}.`);
  L.push(`Unreadable cells: ${(r.errors ?? []).length} (${tally(r.errors ?? [], (e) => `${e.file} / ${e.column}`)}).`);
  const c = r.counts ?? {};
  L.push(`Rows: customers ${c.customers}, suppliers ${c.suppliers}, products ${c.products}, quotes ${c.quotes}, invoices ${c.invoices}, credit notes ${c.creditNotes}, invoice lines ${c.invoiceLines}, payments ${c.payments}, allocations ${c.allocations}, purchase orders ${c.purchaseOrders}.`);
  const w = r.writePlan ?? {};
  L.push(`Would write: customers ${w.customers}, suppliers ${w.suppliers}, stock items ${w.stockItems}, quotes ${w.quotes}, invoices ${w.invoices}, invoice lines ${w.invoiceLines}, quote lines ${w.quoteLines}, payments ${w.payments}, purchase orders ${w.purchaseOrders}, credit notes ${w.creditNotes} (held ${w.creditNotesHeld}).`);
  L.push(`Numbers SliQ used more than once: ${(r.renames ?? []).length} copies, ${w.renamedDocuments ?? 0} renamed (${tally((r.renames ?? []).filter((x) => !x.keeps), (x) => x.kind)}).`);
  L.push(`Held: ${(r.held ?? []).length} (${tally(r.held ?? [], (h) => h.documentKind)}). Needs review (reverse charge / discount): ${(r.needsReview ?? []).length}, unresolved ${r.unresolvedReviewCount}. Excluded numbers given: ${(r.excludeNumbers ?? []).length}, unknown ${(r.unknownExcludedNumbers ?? []).length}.`);
  L.push(`Ambiguous or unmatched (ambiguity.csv): ${amb.length} rows, ${r.unresolvedMatchCount} stop the write (${tally(amb.filter((a) => a.blocksWrite), (a) => `${a.kind} ${a.status}`)}). Resolution-file problems: ${(r.customerMatching?.problems ?? []).length}.`);
  L.push(`Credit notes unresolved: ${r.unresolvedCreditNoteCount}. Payment exceptions unresolved: ${r.unresolvedPaymentCount}. Invoices without lines: ${w.invoicesWithoutLines}. Unpaid invoices: ${w.invoicesUnpaid}.`);
  L.push(`Money owed after the import (total): ${pounds(r.balances?.owedAfterImport)}. Customer credit (total): ${pounds(r.balances?.creditAfterImport)}. Net (owed less credit): ${pounds((r.balances?.owedAfterImport ?? 0) - (r.balances?.creditAfterImport ?? 0))}. Compare the net with the TOTAL on SliQ's Aged Debtors report.`);
  if (j) {
    const k = j.counts;
    L.push(`Jobs: ${k.jobRows} rows, ${k.openInFile} open, ${k.closedInFile} closed; would import ${k.jobsWritten}, held ${k.jobsHeld}, renamed copies ${k.jobsRenamed}. Highest job number ${j.numbering.highestSourceJob || "none"}; numbers outside the pattern ${j.numbering.jobNumbersOutsidePattern.length}.`);
    L.push(`Sales orders: ${k.salesOrderRows} rows; would import ${k.salesOrdersWritten}, held ${k.salesOrdersHeld}, not imported ${k.salesOrdersNotImported}, renamed copies ${k.salesOrdersRenamed}. Highest order number ${j.numbering.highestSourceSalesOrder || "none"}.`);
    L.push(`Purchase orders: ${k.purchaseOrdersWritten} written (${tally(Object.entries(j.purchaseOrders.byStatus).flatMap(([s, n]) => Array(n).fill(s)), (s) => s)}), open ${k.purchaseOrdersOpen}, job links ${k.purchaseOrdersLinked}, links not made ${k.purchaseOrderLinksNotMade}, refused for the supplier ${k.purchaseOrdersRefusedSupplier}.`);
    L.push(`Opening WIP: ${j.wip.rows} rows, total ${pounds(j.wip.totalPence)} = linked ${pounds(j.wip.linked.totalPence)} (${j.wip.linked.rows} rows) + not linked ${pounds(j.wip.unlinked.totalPence)} (${j.wip.unlinked.rows} rows); not valued ${j.wip.notValued}; repeated lines ${j.wip.repeatedLines}. Blockers: ${j.blockers.length}.`);
  }
  L.push(`Writable: ${r.writable}. Collision check against a target: ${r.collisions?.checked ? "yes" : "no"}.`);
  return L.join("\n");
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "headers" && arg) console.log(await headersSummary(arg));
  else if (cmd === "report" && arg) console.log(reportSummary(JSON.parse(readFileSync(arg, "utf8"))));
  else {
    console.error("Usage: summary.mjs headers <export folder> | summary.mjs report <report.json>");
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error("summary.mjs could not read its input (no content shown).");
    process.exit(1);
  });
}
