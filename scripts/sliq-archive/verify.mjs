// Verifies an archive folder against its manifest. Read only: it opens the archive, the manifest and the optional metadata
// CSV for reading, and writes nothing (the CLI writes the report, only under --out). No network.
//
// Problem codes: manifest, unsafe-path, bad-entry, duplicate, missing, not-a-file, size-mismatch, hash-mismatch, extra,
// unsafe-file, metadata, relationship. Anything in `problems` makes the result FAIL; `warnings` never do.
import { readFileSync } from "node:fs";

import { decodeBytes, detectEncoding } from "../sliq-import/detect.mjs";
import { parseCsv } from "../sliq-import/parse.mjs";
import { foldKey, hashFile, byCodePoint, sha256Bytes, show, unsafePathReason, walkArchive } from "./fsread.mjs";
import { MANIFEST_FORMAT } from "./manifest.mjs";
import path from "node:path";

export const REPORT_FORMAT = "sliq-archive-verify/1";
const HEX64 = /^[0-9a-f]{64}$/;
const norm = (s) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Reads the manifest bytes, checks its own SHA-256 (against `expectedSha256`, else a beside-it `.sha256` file) and parses it. */
function loadManifest(manifestPath, expectedSha256, problems) {
  let bytes;
  try {
    bytes = readFileSync(manifestPath);
  } catch (e) {
    problems.push({ code: "manifest", path: null, message: `Cannot read the manifest ${show(manifestPath)}: ${e.code ?? e.message}` });
    return { manifest: null, manifestSha256: null, selfCheck: "unreadable" };
  }
  const actual = sha256Bytes(bytes);
  let expected = expectedSha256 ?? null;
  let source = "--manifest-sha256";
  if (expected === null) {
    try {
      const m = /^([0-9a-fA-F]{64})\b/.exec(readFileSync(`${manifestPath}.sha256`, "utf8"));
      if (m) expected = m[1];
      source = `${path.basename(manifestPath)}.sha256`;
    } catch {
      // No sidecar: reported as "not checked" below.
    }
  }
  let selfCheck = "not checked (no .sha256 file beside the manifest and no --manifest-sha256)";
  if (expected !== null) {
    if (!HEX64.test(expected.toLowerCase())) problems.push({ code: "manifest", path: null, message: `The expected manifest SHA-256 from ${source} is not 64 hex digits.` });
    else if (expected.toLowerCase() !== actual) {
      selfCheck = "MISMATCH";
      problems.push({ code: "manifest", path: null, message: `The manifest itself has changed: its SHA-256 is ${actual}, ${source} says ${expected.toLowerCase()}.` });
    } else selfCheck = `ok (matches ${source})`;
  }
  let manifest = null;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    problems.push({ code: "manifest", path: null, message: `The manifest is not valid JSON: ${e.message}` });
  }
  if (manifest && (typeof manifest !== "object" || manifest.format !== MANIFEST_FORMAT || !Array.isArray(manifest.entries))) {
    problems.push({ code: "manifest", path: null, message: `The manifest must have "format": "${MANIFEST_FORMAT}" and an "entries" list.` });
    manifest = null;
  }
  if (manifest && manifest.entries.length === 0) problems.push({ code: "manifest", path: null, message: "The manifest lists no files." });
  return { manifest, manifestSha256: actual, selfCheck };
}

/** Parses the metadata CSV into rows of { row, document, attachments[] }. */
function readMetadata(metadataPath, { docColumn, fileColumn }, problems) {
  let text;
  try {
    const bytes = readFileSync(metadataPath);
    text = decodeBytes(bytes, detectEncoding(bytes));
  } catch (e) {
    problems.push({ code: "metadata", path: null, message: `Cannot read the metadata CSV ${show(metadataPath)}: ${e.code ?? e.message}` });
    return [];
  }
  let parsed;
  try {
    parsed = parseCsv(text);
  } catch (e) {
    problems.push({ code: "metadata", path: null, message: `The metadata CSV cannot be parsed: ${e.message}` });
    return [];
  }
  const headers = parsed.headers.map(norm);
  const di = headers.indexOf(norm(docColumn));
  const fi = headers.indexOf(norm(fileColumn));
  for (const [name, i] of [[docColumn, di], [fileColumn, fi]]) {
    if (i < 0) problems.push({ code: "metadata", path: null, message: `The metadata CSV has no "${name}" column (columns found: ${parsed.headers.map((h) => `"${h}"`).join(", ")}).` });
  }
  if (di < 0 || fi < 0) return [];
  return parsed.rows
    .map((cells, i) => ({
      row: i + 2,
      document: (cells[di] ?? "").trim(),
      attachments: (cells[fi] ?? "").split(/[;|]/).map((s) => s.trim()).filter(Boolean),
    }))
    .filter((r) => r.document !== "" || r.attachments.length > 0);
}

/**
 * @param {object} o
 * @param {string} o.archiveDir
 * @param {string} o.manifestPath
 * @param {string} [o.expectedManifestSha256]  pin the manifest hash recorded elsewhere (for example on the sign-off sheet)
 * @param {string} [o.metadataPath]            CSV of documents and their attachment file names
 * @param {string} [o.docColumn]               default "Document"
 * @param {string} [o.fileColumn]              default "Attachment"
 * @param {string} [o.attachmentsDir]          archive-relative folder the attachment names are in; default the archive root
 */
export function verifyArchive({ archiveDir, manifestPath, expectedManifestSha256, metadataPath, docColumn = "Document", fileColumn = "Attachment", attachmentsDir = "" }) {
  const problems = [];
  const warnings = [];
  const { manifest, manifestSha256, selfCheck } = loadManifest(manifestPath, expectedManifestSha256, problems);

  const { files, problems: walkProblems } = walkArchive(archiveDir);
  const onDisk = new Map(files.map((f) => [f.path, f]));
  const linkAt = new Map(walkProblems.map((p) => [p.path, p.problem]));

  const results = []; // { path, index, status, problems[] }
  const listed = new Set();
  if (manifest) {
    // Group entries that share a path, exactly or ignoring case, so every member of a clash is reported.
    const groups = new Map();
    manifest.entries.forEach((e, i) => {
      if (e && typeof e.path === "string") {
        const k = foldKey(e.path);
        groups.set(k, [...(groups.get(k) ?? []), { i, p: e.path }]);
      }
    });
    manifest.entries.forEach((e, i) => {
      const res = { path: e && typeof e.path === "string" ? e.path : `(entry ${i + 1})`, index: i, problems: [] };
      const fail = (code, message) => res.problems.push({ code, message });
      if (!e || typeof e !== "object" || Array.isArray(e)) {
        fail("bad-entry", "the entry is not an object");
        results.push(res);
        return;
      }
      const bad = unsafePathReason(e.path);
      if (bad) fail("unsafe-path", `unsafe path in the manifest: ${bad}; it was not opened`);
      if (e.sourcePath !== undefined && unsafePathReason(e.sourcePath)) fail("unsafe-path", `unsafe source path in the manifest: ${unsafePathReason(e.sourcePath)}`);
      if (!Number.isSafeInteger(e.size) || e.size < 0) fail("bad-entry", "size must be a whole number of bytes");
      if (typeof e.sha256 !== "string" || !HEX64.test(e.sha256)) fail("bad-entry", "sha256 must be 64 lower-case hex digits");
      if (typeof e.path === "string" && !bad) {
        const group = groups.get(foldKey(e.path));
        if (group.length > 1) {
          const others = group.filter((g) => g.i !== i).map((g) => g.p);
          const exact = others.every((o) => o === e.path);
          fail("duplicate", exact
            ? `duplicate path: listed ${group.length} times in the manifest`
            : `case-insensitive duplicate: differs only by case or Unicode form from ${others.map(show).join(", ")}`);
        }
        listed.add(e.path);
        if (!res.problems.some((p) => p.code === "unsafe-path" || p.code === "bad-entry")) {
          const f = onDisk.get(e.path);
          if (!f) {
            const l = linkAt.get(e.path);
            if (l) fail("not-a-file", `${l}; not read`);
            else fail("missing", "file is in the manifest but missing from the archive");
          } else {
            const got = hashFile(path.join(archiveDir, ...e.path.split("/")));
            if (got.size !== e.size) fail("size-mismatch", `size mismatch: manifest says ${e.size} bytes, archive has ${got.size}`);
            if (got.sha256 !== e.sha256) fail("hash-mismatch", `SHA-256 mismatch (corrupted or altered): manifest says ${e.sha256}, archive has ${got.sha256}`);
          }
        }
      }
      results.push(res);
    });
  }

  // Files in the archive that the manifest does not list. A manifest kept inside the archive is not counted.
  const own = new Set();
  for (const mp of [manifestPath, `${manifestPath}.sha256`]) {
    const rel = path.relative(path.resolve(archiveDir), path.resolve(mp)).split(path.sep).join("/");
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) own.add(rel);
  }
  const extras = [];
  if (manifest) {
    for (const f of files) if (!listed.has(f.path) && !own.has(f.path)) extras.push({ path: f.path, message: "extra file: in the archive but not in the manifest" });
    for (const w of walkProblems) if (!listed.has(w.path)) extras.push({ path: w.path, message: `${w.problem}` });
  }
  extras.sort((a, b) => byCodePoint(a.path, b.path));

  // Document-to-file relationships from the metadata CSV.
  const relationships = [];
  if (metadataPath) {
    const rows = readMetadata(metadataPath, { docColumn, fileColumn }, problems);
    const dirBad = attachmentsDir === "" ? null : unsafePathReason(attachmentsDir.replace(/\/$/, ""));
    if (dirBad) problems.push({ code: "metadata", path: null, message: `--attachments-dir is not a safe archive path: ${dirBad}.` });
    const base = attachmentsDir === "" ? "" : `${attachmentsDir.replace(/\/$/, "")}/`;
    const manifestByPath = new Map(manifest ? results.map((r) => [r.path, r]) : []);
    const manifestByFold = new Map(manifest ? [...manifestByPath.keys()].map((p) => [foldKey(p), p]) : []);
    const referenced = new Set();
    for (const r of rows) {
      if (r.document === "") {
        relationships.push({ row: r.row, document: "", file: r.attachments.join("; "), ok: false, message: `row ${r.row} lists an attachment but no document reference` });
        continue;
      }
      for (const name of r.attachments) {
        const rel = `${base}${name}`;
        const rec = { row: r.row, document: r.document, file: rel, ok: false, message: "" };
        const bad = dirBad ? null : unsafePathReason(rel);
        if (bad) rec.message = `attachment name is unsafe: ${bad}`;
        else if (!manifest) rec.message = "cannot be checked: the manifest could not be read";
        else if (manifestByPath.has(rel)) {
          referenced.add(rel);
          const res = manifestByPath.get(rel);
          if (res.problems.length === 0) rec.ok = true;
          else if (res.problems.some((p) => p.code === "missing")) rec.message = "the file is in the manifest but missing from the archive";
          else rec.message = `the file fails verification (${[...new Set(res.problems.map((p) => p.code))].join(", ")}); see its entry`;
        } else if (manifestByFold.has(foldKey(rel))) rec.message = `not in the manifest under that name; the manifest has ${show(manifestByFold.get(foldKey(rel)))} (differs only by case)`;
        else rec.message = "not in the manifest (and not in the archive listing)";
        relationships.push(rec);
      }
    }
    if (manifest) {
      for (const e of manifest.entries) {
        if (e && e.recordType === "attachments" && typeof e.path === "string" && !referenced.has(e.path)) warnings.push(`attachment ${show(e.path)} is not referenced by any row of the metadata CSV`);
      }
    }
    relationships.sort((a, b) => a.row - b.row || byCodePoint(a.document, b.document) || byCodePoint(a.file, b.file));
    warnings.sort(byCodePoint);
  }

  results.sort((a, b) => byCodePoint(a.path, b.path) || a.index - b.index);
  const counts = {};
  const count = (code) => (counts[code] = (counts[code] ?? 0) + 1);
  for (const p of problems) count(p.code);
  for (const r of results) for (const p of r.problems) count(p.code);
  for (const x of extras) count(x.message.startsWith("extra file") ? "extra" : "unsafe-file");
  for (const rel of relationships) if (!rel.ok) count("relationship");

  const failedEntries = results.filter((r) => r.problems.length > 0).length;
  const pass = Object.keys(counts).length === 0;
  return {
    format: REPORT_FORMAT,
    result: pass ? "PASS" : "FAIL",
    manifest: { sha256: manifestSha256, selfCheck, format: manifest?.format ?? null, exportedAt: manifest?.exportedAt ?? null, entryCount: manifest ? manifest.entries.length : null },
    summary: { entries: results.length, entriesPassed: results.length - failedEntries, entriesFailed: failedEntries, extraFiles: extras.length, relationshipsChecked: relationships.length, relationshipsFailed: relationships.filter((x) => !x.ok).length, problemCounts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => byCodePoint(a, b))) },
    problems,
    entries: results.map((r) => ({ path: r.path, status: r.problems.length ? "FAIL" : "PASS", problems: r.problems })),
    extraFiles: extras,
    relationships,
    warnings,
  };
}

/** Plain-text report. Same input, same text: sorted, no clock, no absolute paths. */
export function renderText(report) {
  const out = ["SliQ archive verification", ""];
  const m = report.manifest;
  out.push(`Manifest: ${m.format ?? "unreadable"}, ${m.entryCount ?? "?"} entries, exported ${m.exportedAt ?? "?"}`);
  out.push(`Manifest SHA-256: ${m.sha256 ?? "unreadable"}; self-check ${m.selfCheck}`, "");
  for (const p of report.problems) out.push(`FAIL  ${p.message}`);
  if (report.problems.length) out.push("");
  for (const e of report.entries) {
    out.push(`${e.status}  ${show(e.path)}`);
    for (const p of e.problems) out.push(`      - ${p.message}`);
  }
  if (report.extraFiles.length) {
    out.push("", "Files in the archive that the manifest does not list:");
    for (const x of report.extraFiles) out.push(`FAIL  ${show(x.path)}`, `      - ${x.message}`);
  }
  if (report.relationships.length) {
    out.push("", "Document to file relationships (metadata CSV):");
    for (const r of report.relationships) out.push(r.ok ? `PASS  ${show(r.document)} -> ${show(r.file)}` : `FAIL  ${show(r.document) || "(no document)"} -> ${show(r.file)}`, ...(r.ok ? [] : [`      - row ${r.row}: ${r.message}`]));
  }
  if (report.warnings.length) {
    out.push("", "Warnings (do not change the result):");
    for (const w of report.warnings) out.push(`WARN  ${w}`);
  }
  const s = report.summary;
  const detail = Object.entries(s.problemCounts).map(([k, v]) => `${v} ${k}`).join(", ");
  out.push("", `Entries: ${s.entriesPassed} passed, ${s.entriesFailed} failed of ${s.entries}. Extra files: ${s.extraFiles}. Relationships: ${s.relationshipsChecked - s.relationshipsFailed} ok, ${s.relationshipsFailed} failed.`);
  out.push(report.result === "PASS" ? "RESULT: PASS" : `RESULT: FAIL (${detail})`);
  return `${out.join("\n")}\n`;
}
