// The report folder: which files this tool may replace or remove there, and the atomic write.
//
// A file this tool did not write is never replaced, removed or written through, whatever its name. The tool records what it wrote in
// a marker (.sliq-reconcile-output.json: file NAMES and their SHA-256, no paths, no clock). On a later run a file that has one of the
// generated names may be replaced only if the marker lists it AND its content still matches the recorded SHA-256. Any other file
// with a generated name (a foreign summary.json, a hand-edited earlier output, a link, a folder) makes the run refuse before
// anything is written. Messages carry counts and fixed generated names only, never the name of a foreign file.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import { AREAS } from "./rows.mjs";

export class OutputError extends Error {
  constructor(message) {
    super(message);
    this.name = "OutputError";
  }
}

export const MARKER_NAME = ".sliq-reconcile-output.json";
export const MARKER_FORMAT = "sliq-reconcile-output/1";
/** Every file name the report can contain (besides the marker). Exact names: nothing else is ever replaced or removed. */
export const GENERATED_NAMES = new Set(["summary.json", "summary.md", "mismatches.csv", ...AREAS.map((a) => `mismatches-${a}.csv`)]);
const TMP = /^\.sliq-reconcile-tmp-[0-9a-z-]+$/;
const SHA = /^[0-9a-f]{64}$/;
const MAX_MARKER_BYTES = 1024 * 1024;

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

const invalidMarker = (why) =>
  new OutputError(`--out holds ${MARKER_NAME}, but it is not a valid marker written by this tool (${why}). Nothing was written or removed. Use a new or empty folder, or delete the report files and the marker by hand.`);

/** The marker's { name: sha256 } as a Map; empty when there is none. Names only: a separator, "..", or any name this tool does not generate is refused. */
function readMarker(dir, entries) {
  if (!entries.includes(MARKER_NAME)) return new Map();
  const file = path.join(dir, MARKER_NAME);
  const st = lstatSync(file);
  if (!st.isFile()) throw invalidMarker("it is not a plain file");
  if (st.size > MAX_MARKER_BYTES) throw invalidMarker("it is too large");
  let json;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw invalidMarker("it is not valid JSON");
  }
  if (json === null || typeof json !== "object" || Array.isArray(json) || json.format !== MARKER_FORMAT) throw invalidMarker("unknown format");
  const files = json.files;
  if (files === null || typeof files !== "object" || Array.isArray(files)) throw invalidMarker("no file list");
  const listed = new Map();
  for (const [name, hash] of Object.entries(files)) {
    if (!GENERATED_NAMES.has(name)) throw invalidMarker("it lists a name that is not a file name this tool generates");
    if (typeof hash !== "string" || !SHA.test(hash)) throw invalidMarker("it lists a checksum that is not a SHA-256");
    listed.set(name, hash);
  }
  return listed;
}

const names = (list) => list.slice(0, 10).join(", ") + (list.length > 10 ? ", ..." : "");

/**
 * Decides, before anything is written, what this run may replace or remove in an existing report folder. Throws OutputError
 * (nothing touched) if it holds a file this tool cannot prove it wrote. Returns { removable }: the marker-listed files that are
 * still exactly as written (a run removes those it does not rewrite).
 */
export function inspectOutDir(dir, allowOther) {
  const entries = readdirSync(dir);
  const marker = readMarker(dir, entries);
  const foreign = entries.filter((f) => f !== MARKER_NAME && !GENERATED_NAMES.has(f) && !TMP.test(f));
  if (foreign.length > 0 && !allowOther) {
    throw new OutputError(`--out already holds ${foreign.length} file(s) or folder(s) this tool did not write. Use an empty or new folder, or pass --allow-other-files (they are left untouched).`);
  }
  const notListed = [];
  const changed = [];
  const notPlain = [];
  const removable = [];
  for (const f of entries.filter((e) => GENERATED_NAMES.has(e)).sort()) {
    const full = path.join(dir, f);
    if (!lstatSync(full).isFile()) notPlain.push(f);
    else if (!marker.has(f)) notListed.push(f);
    else if (sha256(readFileSync(full)) !== marker.get(f)) changed.push(f);
    else removable.push(f);
  }
  if (notListed.length + changed.length + notPlain.length > 0) {
    const why = [
      notListed.length ? `not recorded in ${MARKER_NAME} as written by this tool: ${names(notListed)}` : "",
      changed.length ? `changed since this tool wrote them (the SHA-256 differs): ${names(changed)}` : "",
      notPlain.length ? `not plain files (a folder or a link): ${names(notPlain)}` : "",
    ].filter(Boolean);
    throw new OutputError(
      `--out holds file(s) named like this tool's output that it cannot prove it wrote (${why.join("; ")}). Nothing was written, replaced or removed, with or without --allow-other-files. Use a new or empty folder, or move those files away.`,
    );
  }
  return { removable };
}

/**
 * Writes the report and its marker. Every file goes to a temporary name in the same folder and is renamed into place, so a reader never
 * sees half a file and nothing is written through a link. The marker is renamed last. The folder is inspected first: see inspectOutDir.
 */
export function writeReport(outDir, files, allowOther) {
  for (const name of Object.keys(files)) if (!GENERATED_NAMES.has(name)) throw new Error("a report file name is not one the tool generates (scripts/sliq-reconcile/output.mjs)");
  mkdirSync(outDir, { recursive: true });
  const { removable } = inspectOutDir(outDir, allowOther);
  const marker = { format: MARKER_FORMAT, files: Object.fromEntries(Object.keys(files).sort().map((n) => [n, sha256(files[n])])) };
  const all = { ...files, [MARKER_NAME]: `${JSON.stringify(marker, null, 2)}\n` };
  const tag = `${process.pid}-${Date.now().toString(36)}`;
  const temps = [];
  try {
    for (const [name, text] of Object.entries(all)) {
      const tmp = path.join(outDir, `.sliq-reconcile-tmp-${tag}-${temps.length}`);
      writeFileSync(tmp, text, { flag: "wx" });
      temps.push([tmp, path.join(outDir, name)]);
    }
    // A report folder holds one run: files this tool wrote earlier (and that are untouched since) go first.
    for (const f of removable) if (!(f in files)) unlinkSync(path.join(outDir, f));
    for (const [tmp, target] of temps) renameSync(tmp, target);
  } catch (e) {
    for (const [tmp] of temps) rmSync(tmp, { force: true });
    throw e;
  }
}
