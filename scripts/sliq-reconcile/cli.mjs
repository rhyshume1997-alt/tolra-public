#!/usr/bin/env node
// SliQ to Tolra reconciliation: a READ-ONLY, OFFLINE comparison of two sets of files. See docs/go-live/sliq-reconcile.md.
//
//   node scripts/sliq-reconcile/cli.mjs --sliq <folder of SliQ CSV/XLSX exports> --tolra <snapshot folder or .json> --out <folder>
//        [--mapping <name|file>] [--encoding <enc>] [--date-format <fmt>] [--sheet <kind>=<Sheet>] [--generated-at <ISO time>]
//
// There is no write path: the only thing written is the report folder. Anything that looks like a URL, host, database connection
// string or Supabase project is refused before a file is read. No network module is imported anywhere in this tool.
import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MappingError } from "../sliq-import/mapping.mjs";

import { reconcile } from "./engine.mjs";
import { MARKER_NAME, OutputError, inspectOutDir, writeReport } from "./output.mjs";
import { csvFiles, renderMarkdown, summarise } from "./report.mjs";
import { SafeError, safeFile, safeRef, scrub } from "./safe.mjs";
import { OfflineGuardError, assertOfflineArgs } from "./screen.mjs";
import { SnapshotError, SNAPSHOT_TABLES, loadSnapshot } from "./snapshot.mjs";
import { loadSource } from "./source.mjs";

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

export const EXIT = { OK: 0, UNEXPECTED: 1, INPUT: 2, REFUSED: 3, BLOCKERS: 4, NOT_PASS: 5 };

const USAGE = `Usage: node scripts/sliq-reconcile/cli.mjs --sliq <folder> --tolra <folder|file.json> --out <folder> [options]

  --sliq <folder>        SliQ-shaped CSV / XLSX exports (the importer's files, plus the extras in docs/go-live/sliq-reconcile.md)
  --tolra <folder|file>  Tolra snapshot: a folder of <table>.json files (+ meta.json) or one JSON file { meta, tables }
  --out <folder>         where summary.json, summary.md and the mismatch CSVs are written (the only thing this tool writes)
  --mapping <name|file>  column mapping (default: sliq, which is PROVISIONAL); a name is looked up beside this tool, then in the importer
  --encoding <enc>       confirm the CSV encoding (otherwise detected)
  --date-format <fmt>    confirm the date format when the data cannot settle it (DD/MM/YYYY ...)
  --sheet <kind>=<name>  say which worksheet is which kind when several fit
  --generated-at <ISO>   fix the one timestamp in the output (for byte-identical reruns)
  --require-pass         exit 5 unless the status is PASS (INCOMPLETE then fails the command instead of exiting 0)
  --allow-other-files    write into a report folder that already holds files this tool did not write (they are never touched).
                         A file named like this tool's output (summary.json, summary.md, mismatches*.csv) is replaced only if the marker
                         ${MARKER_NAME} lists it and it still matches its recorded SHA-256; otherwise the run refuses and writes nothing

Overall status (summary.json "verdict.status"): FAIL (a BLOCKER), INCOMPLETE (no BLOCKER, but WARN or UNVERIFIED rows remain: it cannot be
signed off) or PASS (nothing outstanding). Exit codes: 0 no BLOCKER (NOT the same as PASS: read the status), 4 BLOCKER found, 5 not PASS
(only with --require-pass), 2 input or mapping problem, 3 refused by the offline guard, 1 unexpected error. The report is always written
unless the exit code is 1, 2 or 3.`;

const VALUE_OPTIONS = new Set(["--sliq", "--tolra", "--out", "--mapping", "--encoding", "--date-format", "--sheet", "--generated-at"]);
const FLAG_OPTIONS = new Set(["--require-pass", "--allow-other-files"]);

function parseArgs(argv) {
  const a = { sheets: {} };
  for (let i = 0; i < argv.length; i++) {
    let t = String(argv[i]);
    let inline = null;
    if (t.startsWith("--") && t.includes("=")) {
      inline = t.slice(t.indexOf("=") + 1);
      t = t.slice(0, t.indexOf("="));
    }
    if (t === "--help" || t === "-h") {
      a.help = true;
      continue;
    }
    if (!t.startsWith("--")) throw new UsageError("Unexpected argument: every value must follow an option.");
    const camel = t.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (FLAG_OPTIONS.has(t)) {
      if (inline !== null) throw new UsageError(`${t} takes no value.`);
      a[camel] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(t)) throw new UsageError(/^--[a-z][a-z-]{0,30}$/.test(t) ? `Unknown option ${t}.` : "Unknown option.");
    const value = inline ?? argv[++i];
    if (value === undefined || String(value).startsWith("--")) throw new UsageError(`${t} needs a value.`);
    if (t === "--sheet") {
      const [k, ...v] = String(value).split("=");
      if (!k || v.length === 0) throw new UsageError("--sheet needs kind=Name.");
      a.sheets[k] = v.join("=");
    } else a[camel] = String(value);
  }
  return a;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
/** realpath of a path that may not exist yet: the real path of its nearest existing ancestor plus the rest. */
function realish(p) {
  const rest = [];
  let cur = path.resolve(p);
  while (!existsSync(cur)) {
    rest.unshift(path.basename(cur));
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return path.join(realpathSync(cur), ...rest);
}
const within = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** Refuses an --out that is, is inside, or contains an input (symlinks resolved), and one holding files that are not ours. */
function checkOutDir(outArg, inputs, allowOther) {
  const out = realish(outArg);
  for (const [label, p] of inputs) {
    const real = realish(p);
    if (within(out, real) || within(real, out)) throw new UsageError(`--out must not be, or sit inside or around, ${label} (checked after resolving links): reports never go into, or over, the input folders.`);
  }
  if (existsSync(out)) {
    if (!statSync(out).isDirectory()) throw new UsageError("--out is not a folder.");
    inspectOutDir(out, allowOther); // throws before anything is read or written if the folder holds a file this tool cannot prove it wrote
  }
  return out;
}

/**
 * Runs the whole reconciliation. Never throws for expected problems and never calls process.exit: it returns the exit code.
 * @param argv  the arguments after the script name
 * @param io    { stdout(text), stderr(text) }
 * @param opts  { generatedAt }: tests fix the clock here
 */
export async function main(argv, io = {}, opts = {}) {
  // Nothing printed can carry an e-mail address or a phone-like number, whatever an error message was built from.
  const out = (t) => (io.stdout ?? ((x) => process.stdout.write(`${x}\n`)))(scrub(t));
  const err = (t) => (io.stderr ?? ((x) => process.stderr.write(`${x}\n`)))(scrub(t));
  try {
    assertOfflineArgs(argv); // first, before anything is read
    const a = parseArgs(argv);
    if (a.help) {
      out(USAGE);
      return EXIT.OK;
    }
    for (const need of ["sliq", "tolra", "out"]) if (!a[need]) throw new UsageError(`--${need} is required.\n\n${USAGE}`);
    if (a.generatedAt !== undefined && !ISO.test(a.generatedAt)) throw new UsageError("--generated-at must be an ISO time such as 2026-10-13T09:00:00Z.");
    const generatedAt = opts.generatedAt ?? a.generatedAt ?? new Date().toISOString();
    const sliq = path.resolve(a.sliq);
    const tolra = path.resolve(a.tolra);
    try {
      if (!statSync(sliq).isDirectory()) throw new UsageError("--sliq must be a folder.");
    } catch (e) {
      if (e instanceof UsageError) throw e;
      throw new UsageError("--sliq folder was not found.");
    }
    if (!existsSync(tolra)) throw new UsageError("--tolra was not found.");
    const outDir = checkOutDir(a.out, [["--sliq", sliq], ["--tolra", tolra]], a.allowOtherFiles === true);

    const src = await loadSource(sliq, { mapping: a.mapping, encoding: a.encoding, dateFormat: a.dateFormat, sheets: a.sheets });
    const { snapshot, files: tolraFiles } = await loadSnapshot(tolra);
    const { rows, stats } = reconcile(src, snapshot);

    const outputs = csvFiles(rows);
    const byName = (x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : x.kind < y.kind ? -1 : 1);
    const summary = summarise(rows, {
      generatedAt,
      stats,
      inputs: {
        sliq: {
          mapping: { id: safeRef(src.profile.id), status: src.profile.status, fileSha256: src.profile.fileSha256 },
          files: src.inputs.map((f) => ({ ...f, file: safeFile(f.file), sheet: f.sheet ? safeFile(f.sheet) : null })).sort(byName),
        },
        tolra: {
          files: [...tolraFiles].sort(byName),
          tablesSupplied: [...snapshot.supplied].sort(),
          tablesNotSupplied: SNAPSHOT_TABLES.filter((t) => !snapshot.supplied.has(t)).sort(),
          ignoredTables: snapshot.ignored.map((t) => safeRef(t)),
          organizationIdPresent: !!snapshot.organizationId,
        },
      },
      outputs: ["summary.json", "summary.md", ...Object.keys(outputs)],
    });
    writeReport(outDir, { "summary.json": `${JSON.stringify(summary, null, 2)}\n`, "summary.md": renderMarkdown(summary, rows), ...outputs }, a.allowOtherFiles === true);

    const c = summary.counts.bySeverity;
    if (src.profile.isProvisional) out("Provisional mapping: the column headers have not been confirmed against JNR's real SliQ files.");
    out("Dry run only: read only and offline. Nothing was written to any database or sent anywhere.");
    out(`STATUS: ${summary.verdict.status}. ${summary.verdict.text}`);
    out(`Sign-off: ${summary.signOff.allowed ? "evidence ready (a person signs)" : summary.signOff.text}`);
    out(`Rows: BLOCKER ${c.BLOCKER}, WARN ${c.WARN}, INFO ${c.INFO}, UNVERIFIED ${c.UNVERIFIED}. Report folder: ${path.relative(process.cwd(), outDir) || "."} (summary.md, summary.json, mismatches*.csv)`);
    if (c.BLOCKER > 0) return EXIT.BLOCKERS;
    if (summary.verdict.status !== "PASS") {
      out(a.requirePass ? "Exiting 5 because --require-pass was given and the status is not PASS." : "Exit code 0 here means only 'no BLOCKER'. It is NOT a pass: the status above is INCOMPLETE.");
      return a.requirePass ? EXIT.NOT_PASS : EXIT.OK;
    }
    return EXIT.OK;
  } catch (e) {
    if (e instanceof OfflineGuardError) {
      err(e.message);
      return EXIT.REFUSED;
    }
    if (e instanceof UsageError || e instanceof OutputError || e instanceof MappingError || e instanceof SnapshotError) {
      err(e.message);
      return EXIT.INPUT;
    }
    // An unexpected error's message can quote what was being read (a file name, a header, a value), so it is never printed. The
    // tool's own programming errors (SafeError) carry a message built only from constants and fingerprints, and are.
    const code = e instanceof Error && typeof e.code === "string" && /^[A-Z][A-Z0-9_]{1,30}$/.test(e.code) ? ` ${e.code}` : "";
    err(e instanceof SafeError ? `${e.name}: ${e.message}` : e instanceof Error ? `${/^[A-Za-z]{1,30}$/.test(e.name) ? e.name : "Error"}: unexpected error${code} (details withheld: they can quote the input)` : "unexpected error");
    return EXIT.UNEXPECTED;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
