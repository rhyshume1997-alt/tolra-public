#!/usr/bin/env node
// SliQ archive: write a manifest for an archive folder, and verify the folder against it later. See docs/go-live/sliq-archive.md.
//
//   node scripts/sliq-archive/cli.mjs manifest <archive dir> --out <dir> --exported-at <ISO 8601 date or time>
//        [--map <sidecar.json>] [--csv] [--overwrite]
//   node scripts/sliq-archive/cli.mjs verify <archive dir> --manifest <manifest.json> [--manifest-sha256 <hex>]
//        [--metadata <csv> [--doc-column <header>] [--file-column <header>] [--attachments-dir <archive folder>]]
//        [--out <dir>]
//
// Exit codes: 0 pass, 1 the archive or manifest failed a check (or a manifest could not be built), 2 wrong usage.
// The archive is only ever read. Files are written only inside --out (manifest.json, manifest.json.sha256, manifest.csv,
// verify-report.txt, verify-report.json). Output safety, the same for both commands:
//   * --out is refused (exit 2, before anything is read or written) if it is the archive, is inside it, or contains it,
//     checked after resolving symbolic links, so an alias outside the archive that points into it is refused too;
//   * an output file that already exists as a symbolic link is refused (exit 2), with or without --overwrite: it is never
//     written through and never replaced. Refuse was chosen over replace so a link is something a person looks at;
//   * every file is written to a temporary name in --out and renamed into place, after all targets have been checked, so a
//     refusal writes nothing and a reader never sees half a file.
// Nothing here uses the network.
import { closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { overlaps, realish, sha256Bytes } from "./fsread.mjs";
import { ArchiveError, buildManifest, manifestCsv } from "./manifest.mjs";
import { renderText, verifyArchive } from "./verify.mjs";

class UsageError extends Error {}

const FLAGS = new Set(["--csv", "--overwrite"]);
const VALUE_OPTIONS = new Set(["--out", "--exported-at", "--map", "--manifest", "--manifest-sha256", "--metadata", "--doc-column", "--file-column", "--attachments-dir"]);

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (FLAGS.has(t)) a[t.slice(2)] = true;
    else if (VALUE_OPTIONS.has(t)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${t} needs a value.`);
      a[t.slice(2)] = v;
    } else if (t.startsWith("--")) throw new UsageError(`Unknown option ${t}.`);
    else a._.push(t);
  }
  return a;
}

/** The real path of --out, or a UsageError if it is missing, is the archive, is inside it, or contains it (links resolved). */
export function safeOutDir(archiveDir, out) {
  if (!out) throw new UsageError("--out <dir> is required.");
  let real;
  try {
    if (overlaps(archiveDir, out)) {
      throw new UsageError("Refusing: --out is the archive folder, is inside the archive folder, or contains it (checked after resolving symbolic links). The archive is never written to; use a folder beside it.");
    }
    real = realish(out);
  } catch (e) {
    if (e instanceof UsageError) throw e;
    throw new UsageError(`Refusing: cannot resolve --out or the archive folder: ${e.message}`);
  }
  return real;
}

const lstatOrNull = (p) => {
  try {
    return lstatSync(p);
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    throw e;
  }
};

/**
 * Writes `files` ({ name: text }) into `outDir` and nothing else. All targets are checked first (a symbolic link or a folder
 * in the way, or an existing file when `overwrite` is false, refuses the whole run with nothing written). Each file is then
 * written to a temporary name in `outDir` (created exclusively, so it cannot go through a link) and renamed over its target.
 * rename replaces a link itself and never follows it, so a link swapped in after the check still cannot redirect a write.
 */
export function writeOutputs(archiveDir, outDir, files, { overwrite, existsMessage }) {
  const names = Object.keys(files);
  const dirStat = lstatOrNull(outDir);
  if (dirStat && !dirStat.isDirectory()) throw new UsageError("--out exists and is not a folder.");
  for (const name of names) {
    const st = lstatOrNull(path.join(outDir, name));
    if (!st) continue;
    if (st.isSymbolicLink()) throw new UsageError(`Refusing: ${name} in --out is a symbolic link. Output files are never written through a link, and links are not replaced; remove it yourself or use a clean folder.`);
    if (!st.isFile()) throw new UsageError(`Refusing: ${name} in --out exists and is not a regular file.`);
    if (!overwrite) throw new UsageError(existsMessage);
  }
  mkdirSync(outDir, { recursive: true });
  // Check again once the folder exists, so nothing is written if it turned out to overlap the archive.
  if (overlaps(archiveDir, outDir)) throw new UsageError("Refusing: --out is the archive folder, is inside the archive folder, or contains it.");
  const tag = `${process.pid}-${Date.now().toString(36)}`;
  const temps = [];
  let renamed = 0;
  try {
    for (const [i, name] of names.entries()) {
      const tmp = path.join(outDir, `.sliq-archive-tmp-${tag}-${i}`);
      const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o644);
      temps.push([tmp, path.join(outDir, name)]);
      try {
        writeFileSync(fd, files[name]);
      } finally {
        closeSync(fd);
      }
    }
    for (const [tmp, target] of temps) {
      renameSync(tmp, target);
      renamed++;
    }
  } catch (e) {
    for (const [tmp] of temps.slice(renamed)) {
      try {
        unlinkSync(tmp);
      } catch {
        // never created or already gone
      }
    }
    throw e;
  }
}

export function runManifest(a, log) {
  const [archiveDir] = a._.slice(1);
  if (!archiveDir) throw new UsageError("Usage: manifest <archive dir> --out <dir> --exported-at <ISO 8601>");
  if (!a["exported-at"]) throw new UsageError("--exported-at is required: the time SliQ was exported, as ISO 8601 (file times are not used).");
  const out = safeOutDir(archiveDir, a.out);
  let map = null;
  if (a.map) {
    try {
      map = JSON.parse(readFileSync(a.map, "utf8"));
    } catch (e) {
      throw new UsageError(`Cannot read the --map file: ${e.message}`);
    }
  }
  const manifest = buildManifest({ archiveDir, exportedAt: a["exported-at"], map });
  const jsonPath = path.join(out, "manifest.json");
  const csvPath = path.join(out, "manifest.csv");
  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  writeOutputs(archiveDir, out, {
    "manifest.json": text,
    "manifest.json.sha256": `${sha256Bytes(Buffer.from(text))}  manifest.json\n`,
    ...(a.csv ? { "manifest.csv": manifestCsv(manifest) } : {}),
  }, { overwrite: a.overwrite === true, existsMessage: `Refusing to overwrite an existing manifest in ${out}. Use a new folder, or --overwrite if replacing it is intended.` });
  log(`Manifest: ${manifest.entryCount} files, ${manifest.totalBytes} bytes, written to ${jsonPath}${a.csv ? ` and ${csvPath}` : ""}.`);
  log(`Manifest SHA-256: ${sha256Bytes(Buffer.from(text))} (also in manifest.json.sha256). Record it on the sign-off sheet.`);
  log("Record types: " + Object.entries(manifest.recordTypes).map(([k, v]) => `${k} ${v}`).join(", ") + (manifest.recordTypes.unclassified ? "  (unclassified files need a --map rule or a folder from the documented layout)" : ""));
  log("Entries are marked unverified: run the verify command to check them against the archive.");
  return 0;
}

export function runVerify(a, log) {
  const [archiveDir] = a._.slice(1);
  if (!archiveDir || !a.manifest) throw new UsageError("Usage: verify <archive dir> --manifest <manifest.json> [--metadata <csv>] [--out <dir>]");
  const out = a.out ? safeOutDir(archiveDir, a.out) : null;
  const report = verifyArchive({
    archiveDir,
    manifestPath: a.manifest,
    expectedManifestSha256: a["manifest-sha256"]?.toLowerCase(),
    metadataPath: a.metadata,
    docColumn: a["doc-column"],
    fileColumn: a["file-column"],
    attachmentsDir: a["attachments-dir"],
  });
  const text = renderText(report);
  log(text.trimEnd());
  if (out) {
    writeOutputs(archiveDir, out, { "verify-report.txt": text, "verify-report.json": `${JSON.stringify(report, null, 2)}\n` }, { overwrite: true, existsMessage: "" });
  }
  return report.result === "PASS" ? 0 : 1;
}

/** Runs the CLI with an argv list; returns the exit code. Output goes through `log` (default console.log). */
export function main(argv, log = console.log) {
  try {
    const a = parseArgs(argv);
    const command = a._[0];
    if (command === "manifest") return runManifest(a, log);
    if (command === "verify") return runVerify(a, log);
    throw new UsageError("Usage: cli.mjs manifest|verify <archive dir> ... (see the header of scripts/sliq-archive/cli.mjs)");
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      return 2;
    }
    if (e instanceof ArchiveError) {
      console.error(e.message);
      return 1;
    }
    console.error(e?.code === "ENOENT" || e?.code === "ENOTDIR" ? `Cannot read ${e.path ?? "a path"}: ${e.code}` : e);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
