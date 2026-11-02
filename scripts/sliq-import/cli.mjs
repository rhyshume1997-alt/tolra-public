#!/usr/bin/env node
// SliQ import: dry run first, write only when every guard passes. See docs/SLIQ-IMPORT.md.
//
//   Dry run (default; writes only the report files):
//     node scripts/sliq-import/cli.mjs <csv folder> --out <report folder> [--mapping synthetic|sliq]
//          [--database-url <local/disposable url> --organization-id <uuid>]   (adds the read-only collision check)
//          [--exclude INV-1,INV-2]                                            (documents left out by number)
//   Write (rehearsal on a disposable database only):
//     node scripts/sliq-import/cli.mjs <csv folder> --write --report <report.json> --database-url <url> --organization-id <uuid>
//          [--exclude ...] [--install-importer]
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { GuardError, assertWriteAllowed, checkDatabaseUrl, checkOrganisationId, loadReportFile, redactUrl } from "./guard.mjs";
import { assertCoreHeaders, coreHeaderProblems } from "./headers.mjs";
import { loadJobsFolder } from "./jobs-load.mjs";
import { analyseJobs, jobsVerificationCsv, renderJobsMarkdown, wipVerificationCsv } from "./jobs-plan.mjs";
import { readJobsTargetReadOnly } from "./jobs-write.mjs";
import { loadFolder, readWorkbooks } from "./load.mjs";
import { MappingError, getProfile } from "./mapping.mjs";
import { loadResolutions } from "./resolutions.mjs";
import { analyse, renderMarkdown } from "./reconcile.mjs";
import { prepareRehearsal, readTargetReadOnly, writeImport } from "./write.mjs";

/** Dry run: reads the folder (and, if given, the target read only), writes report.md and report.json. Never writes to a database. */
export async function dryRun({ folder, outDir, mapping = "sliq", databaseUrl = null, organizationId = null, excludeNumbers = [], encoding, dateFormat, sheets, resolutionsPath }) {
  const profile = getProfile(mapping);
  const workbooks = await readWorkbooks(folder);
  const loaded = loadFolder(folder, profile, { workbooks, encoding, dateFormat, sheets });
  // Jobs, sales orders and opening WIP (jobs-*.mjs) and the strict header check (headers.mjs): see loadJobs below.
  const jobsLoaded = loadJobs(folder, mapping, loaded, { workbooks, sheets });
  let target = null;
  if (databaseUrl) {
    if (!organizationId) throw new GuardError("Refusing: --organization-id is needed with --database-url (the collision check reads one organisation).");
    target = await readTargetReadOnly(databaseUrl, organizationId, loaded);
  }
  const resolutions = resolutionsPath ? loadResolutions(resolutionsPath) : null;
  const { report, plan } = analyse(loaded, { organizationId: organizationId ? organizationId.toLowerCase() : null, target, excludeNumbers, resolutions });
  // ---- jobs import (report section 14 and the two verification sheets) ----
  const jobsTarget = databaseUrl && jobsLoaded.profile ? await readJobsTargetReadOnly(databaseUrl, organizationId, jobsLoaded) : null;
  // A strict header check (the real SliQ mapping) is listed here and refuses the write (writeRun).
  report.headerCheck = { strict: jobsLoaded.headerCheck.strict, problems: coreHeaderProblems(loaded, jobsLoaded.headerCheck) };
  report.jobsImport = analyseJobs(loaded, jobsLoaded, { plan, coreReport: report, organizationId: organizationId ? organizationId.toLowerCase() : null, target: jobsTarget }).report;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(path.join(outDir, "report.md"), `${renderMarkdown(report)}\n${report.jobsImport ? `\n${renderJobsMarkdown(report.jobsImport)}\n` : ""}${headerCheckMarkdown(report.headerCheck)}`);
  if (report.jobsImport) {
    writeFileSync(path.join(outDir, "jobs-verification.csv"), jobsVerificationCsv(report.jobsImport));
    writeFileSync(path.join(outDir, "wip-verification.csv"), wipVerificationCsv(report.jobsImport));
  }
  return { report, plan, loaded };
}

/** Write: every guard, then one transaction through the existing importer. */
export async function writeRun({ folder, reportPath, mapping = "sliq", databaseUrl, organizationId, excludeNumbers = [], write = false, installImporter = false, encoding, dateFormat, sheets, resolutionsPath }) {
  // The cheap refusals come first, before any file is read.
  if (write !== true) throw new GuardError("Refusing: this is a dry run unless --write is given.");
  checkDatabaseUrl(databaseUrl);
  checkOrganisationId(organizationId);
  const profile = getProfile(mapping);
  const workbooks = await readWorkbooks(folder);
  const loaded = loadFolder(folder, profile, { workbooks, encoding, dateFormat, sheets });
  const jobsLoaded = loadJobs(folder, mapping, loaded, { workbooks, sheets });
  const org = organizationId.toLowerCase();
  const resolutions = resolutionsPath ? loadResolutions(resolutionsPath) : null;
  const { report: current } = analyse(loaded, { organizationId: org, target: null, excludeNumbers, resolutions });
  // The report on file is checked against the files and options as they are now, before the database is touched.
  const report = loadReportFile(reportPath);
  assertWriteAllowed({ write, databaseUrl, organizationId, report, current, excludeNumbers });
  assertCoreHeaders(loaded, jobsLoaded.headerCheck); // "headerCheck": "strict": every missing or unknown column refuses the write
  return writeImport({ databaseUrl, organizationId: org, loaded, excludeNumbers, installImporter, expectedRehearsalId: report.rehearsal.id, resolutions, jobsLoaded });
}

/** The jobs files: their checksums join loaded.inputs, so a changed jobs file makes the report stale. Their headers are always strict. */
function loadJobs(folder, mapping, loaded, opts) {
  return loadJobsFolder(folder, mapping, loaded, opts);
}

function headerCheckMarkdown(h) {
  if (!h?.strict) return "";
  const lines = h.problems.flatMap((p) => [...p.missing.map((m) => `* ${p.file}: missing column ${m.columns.map((c) => `"${c}"`).join(" or ")} (for "${m.field}")`), ...p.unknown.map((u) => `* ${p.file}: unknown column "${u}"`)]);
  return `\n## 16. Header check (strict)\n\n${lines.length ? `**A write is refused until these are fixed:**\n\n${lines.join("\n")}` : "Every file's header row is exactly what the mapping names."}\n`;
}

function parseArgs(argv) {
  const a = { _: [], exclude: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    if (t === "--write") a.write = true;
    else if (t === "--install-importer") a.installImporter = true;
    else if (t === "--out") a.out = next();
    else if (t === "--mapping") a.mapping = next();
    else if (t === "--encoding") a.encoding = next();
    else if (t === "--resolutions") a.resolutions = next();
    else if (t === "--date-format") a.dateFormat = next();
    else if (t === "--sheet") {
      const [k, ...v] = next().split("=");
      (a.sheets ??= {})[k] = v.join("=");
    }
    else if (t === "--report") a.report = next();
    else if (t === "--database-url") a.databaseUrl = next();
    else if (t === "--organization-id") a.organizationId = next();
    else if (t === "--exclude") a.exclude.push(...next().split(",").map((s) => s.trim()).filter(Boolean));
    else if (t.startsWith("--")) throw new Error(`Unknown option ${t}`);
    else a._.push(t);
  }
  return a;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a._[0] === "prepare-rehearsal") {
    const url = a.databaseUrl ?? process.env.SLIQ_IMPORT_DATABASE_URL;
    const id = await prepareRehearsal(url);
    console.log(`Rehearsal identity of ${redactUrl(url)}: ${id}\nRun the dry run against this database (--database-url) so the report records it.`);
    return;
  }
  const folder = a._[0];
  if (!folder) throw new Error("Usage: cli.mjs <csv folder> [--out dir] [--write --report report.json --database-url url --organization-id uuid]");
  if (a.write) {
    const res = await writeRun({ folder, reportPath: a.report, mapping: a.mapping, databaseUrl: a.databaseUrl ?? process.env.SLIQ_IMPORT_DATABASE_URL, organizationId: a.organizationId, excludeNumbers: a.exclude, write: true, installImporter: a.installImporter, encoding: a.encoding, dateFormat: a.dateFormat, sheets: a.sheets, resolutionsPath: a.resolutions });
    console.log(`Written to ${redactUrl(a.databaseUrl ?? "")}:`, JSON.stringify(res.created), "importer tables:", JSON.stringify(res.importer.tables));
    if (res.jobs) console.log("Jobs import:", JSON.stringify(res.jobs));
    return;
  }
  const out = a.out ?? path.join("sliq-import-report");
  const { report } = await dryRun({ folder, outDir: out, mapping: a.mapping, databaseUrl: a.databaseUrl ?? null, organizationId: a.organizationId ?? null, excludeNumbers: a.exclude, encoding: a.encoding, dateFormat: a.dateFormat, sheets: a.sheets, resolutionsPath: a.resolutions });
  if (report.mapping.isProvisional) console.log("Provisional mapping, confirm against the real headers. A write is refused until the mapping file is marked confirmed.");
  console.log(`Dry run only: nothing was written to any database. Report: ${path.join(out, "report.md")} and report.json`);
  console.log(`Writable: ${report.writable}. Held: ${report.held.length}. Needs review: ${report.needsReview.length}. Errors: ${report.errors.length}.`);
  if (report.headerCheck.strict && report.headerCheck.problems.length) console.log(`Header check (strict): ${report.headerCheck.problems.length} file(s) do not match the mapping; a write is refused. See report section 16.`);
  const j = report.jobsImport;
  if (j) console.log(`Jobs: ${j.counts.openInFile} open in the file, ${j.counts.jobsWritten} to import, ${j.counts.jobsHeld} held, ${j.counts.closedInFile} closed. Sales orders ${j.counts.salesOrdersWritten}. PO job links ${j.counts.purchaseOrdersLinked}. WIP rows ${j.counts.wipRows}.${j.blockers.length ? ` Write refused: ${j.blockers.join("; ")}` : ""} Sheets: jobs-verification.csv, wip-verification.csv`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e instanceof MappingError || e instanceof GuardError ? e.message : e);
    process.exit(e instanceof MappingError ? 2 : e instanceof GuardError ? 3 : 1);
  });
}
