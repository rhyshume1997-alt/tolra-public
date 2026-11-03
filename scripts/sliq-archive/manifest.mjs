// Builds the archive manifest: one entry per file with its archive-relative path, source-relative path, size, SHA-256,
// export timestamp, record type and verification status. Read only on the archive; the caller writes the result to --out.
//
// Record type, first match wins (the same rule is in docs/go-live/sliq-archive.md):
//   1. the sidecar map (--map): an exact "path", else the longest "prefix" ending in "/";
//   2. the top-level folder name (DIR_TYPES below), case-insensitive;
//   3. for a file at the archive root, its name without extension (customers.csv is "customers");
//   4. the extension: .pdf is "documents-pdf"; DWG/DXF/STEP/IGES are "drawings";
//   5. otherwise "unclassified".
// Timestamps are never taken from file modification times: the export time is the --exported-at value, optionally
// overridden per path or prefix in the sidecar map.
import { foldKey, hashFile, byCodePoint, show, unsafePathReason, walkArchive } from "./fsread.mjs";
import path from "node:path";

export const MANIFEST_FORMAT = "sliq-archive-manifest/1";
export const MAP_FORMAT = "sliq-archive-map/1";

export class ArchiveError extends Error {}

export const DIR_TYPES = {
  customers: "customers",
  suppliers: "suppliers",
  products: "products",
  invoices: "invoices",
  quotes: "quotes",
  orders: "orders",
  "sales-orders": "orders",
  jobs: "jobs",
  payments: "payments",
  "credit-notes": "credit-notes",
  "purchase-orders": "purchase-orders",
  "delivery-notes": "delivery-notes",
  pdf: "documents-pdf",
  pdfs: "documents-pdf",
  drawings: "drawings",
  attachments: "attachments",
  templates: "templates",
  backup: "backup",
  backups: "backup",
  metadata: "metadata",
};
const STEM_TYPES = new Set(Object.values(DIR_TYPES));
const EXT_TYPES = { ".pdf": "documents-pdf", ".dwg": "drawings", ".dxf": "drawings", ".step": "drawings", ".stp": "drawings", ".iges": "drawings", ".igs": "drawings" };
const TYPE_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Strict ISO 8601 date or date-time; the string is kept exactly as given. */
export function checkExportedAt(value) {
  const ok = typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(value)
    && !Number.isNaN(Date.parse(value));
  if (!ok) throw new ArchiveError(`--exported-at must be an ISO 8601 date or date-time such as 2026-10-14 or 2026-10-14T09:30:00Z (got ${show(value)}). It is the time SliQ was exported, not read from file times.`);
  return value;
}

/** Validates a sidecar map (parsed JSON) and returns it in a lookup-friendly form. */
export function parseMap(json) {
  if (!json || typeof json !== "object" || json.format !== MAP_FORMAT) throw new ArchiveError(`The map file must have "format": "${MAP_FORMAT}".`);
  const exact = new Map();
  const prefixes = [];
  for (const [i, rule] of (json.types ?? []).entries()) {
    const where = `map types[${i}]`;
    if ((rule.path === undefined) === (rule.prefix === undefined)) throw new ArchiveError(`${where}: give exactly one of "path" or "prefix".`);
    const key = rule.path ?? rule.prefix;
    const bad = unsafePathReason(rule.prefix !== undefined ? key.replace(/\/$/, "") : key);
    if (bad) throw new ArchiveError(`${where}: ${bad}.`);
    if (rule.prefix !== undefined && !key.endsWith("/")) throw new ArchiveError(`${where}: a prefix must end in "/".`);
    if (rule.recordType !== undefined && !TYPE_RE.test(rule.recordType)) throw new ArchiveError(`${where}: recordType must be lower-case letters, digits and hyphens.`);
    if (rule.exportedAt !== undefined) checkExportedAt(rule.exportedAt);
    const r = { recordType: rule.recordType, exportedAt: rule.exportedAt };
    if (rule.path !== undefined) exact.set(key, r);
    else prefixes.push({ prefix: key, ...r });
  }
  prefixes.sort((a, b) => b.prefix.length - a.prefix.length || byCodePoint(a.prefix, b.prefix));
  const sources = new Map();
  for (const [archivePath, sourcePath] of Object.entries(json.sources ?? {})) {
    const bad = unsafePathReason(archivePath) ?? unsafePathReason(sourcePath);
    if (bad) throw new ArchiveError(`map sources "${show(archivePath)}": ${bad}.`);
    sources.set(archivePath, sourcePath);
  }
  return { exact, prefixes, sources };
}

const EMPTY_MAP = { exact: new Map(), prefixes: [], sources: new Map() };

export function classify(archivePath, map = EMPTY_MAP) {
  const rule = map.exact.get(archivePath) ?? map.prefixes.find((r) => archivePath.startsWith(r.prefix));
  if (rule?.recordType) return { recordType: rule.recordType, exportedAt: rule.exportedAt };
  const parts = archivePath.split("/");
  const dirType = parts.length > 1 ? DIR_TYPES[parts[0].toLowerCase()] : undefined;
  if (dirType) return { recordType: dirType, exportedAt: rule?.exportedAt };
  const ext = path.posix.extname(archivePath).toLowerCase();
  if (parts.length === 1) {
    const stem = path.posix.basename(archivePath, path.posix.extname(archivePath)).toLowerCase();
    if (STEM_TYPES.has(stem)) return { recordType: stem, exportedAt: rule?.exportedAt };
  }
  return { recordType: EXT_TYPES[ext] ?? "unclassified", exportedAt: rule?.exportedAt };
}

/**
 * Walks `archiveDir` and returns the manifest object. Refuses an empty archive, links, unsafe names and names that differ
 * only by case, because none of those can be verified reliably later.
 */
export function buildManifest({ archiveDir, exportedAt, map }) {
  const stamp = checkExportedAt(exportedAt);
  const lookup = map ? parseMap(map) : EMPTY_MAP;
  const { files, problems } = walkArchive(archiveDir);
  const refused = problems.map((p) => `${show(p.path)}: ${p.problem}`);
  const seen = new Map();
  for (const f of files) {
    const bad = unsafePathReason(f.path);
    if (bad) refused.push(`${show(f.path)}: ${bad}`);
    const key = foldKey(f.path);
    if (seen.has(key)) refused.push(`${show(f.path)}: differs only by case or Unicode form from ${show(seen.get(key))}`);
    else seen.set(key, f.path);
  }
  if (files.length === 0 && refused.length === 0) refused.push("the archive contains no files");
  for (const p of lookup.sources.keys()) if (!files.some((f) => f.path === p)) refused.push(`map sources names ${show(p)}, which is not in the archive`);
  if (refused.length) throw new ArchiveError(`Cannot build a manifest:\n${refused.map((r) => `  - ${r}`).join("\n")}`);

  const entries = files.map((f) => {
    const { size, sha256 } = hashFile(path.join(archiveDir, ...f.path.split("/")));
    const c = classify(f.path, lookup);
    return {
      path: f.path,
      sourcePath: lookup.sources.get(f.path) ?? f.path,
      size,
      sha256,
      exportedAt: c.exportedAt ?? stamp,
      recordType: c.recordType,
      status: "unverified",
    };
  });
  const byType = {};
  for (const e of entries) byType[e.recordType] = (byType[e.recordType] ?? 0) + 1;
  return {
    format: MANIFEST_FORMAT,
    exportedAt: stamp,
    entryCount: entries.length,
    totalBytes: entries.reduce((n, e) => n + e.size, 0),
    recordTypes: Object.fromEntries(Object.entries(byType).sort(([a], [b]) => byCodePoint(a, b))),
    entries,
  };
}

// The same formula guard as scripts/sliq-reconcile/csv.mjs and lib/html.ts (kept here: this tool imports only its own files):
// text that starts with = + - @ tab or CR gets a leading apostrophe, so a file named "=HYPERLINK(...).pdf" can't run as a
// formula when manifest.csv is opened; a plain number such as a size is left alone.
const csvCell = (v) => {
  const s = String(v);
  const text = /^-?\d+(?:\.\d+)?$/.test(s) || !/^[=+\-@\t\r]/.test(s) ? s : `'${s}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** A flat copy of the entries for opening in Excel. manifest.json stays the authoritative file. */
export function manifestCsv(manifest) {
  const head = ["path", "source_path", "size", "sha256", "exported_at", "record_type", "status"];
  const rows = manifest.entries.map((e) => [e.path, e.sourcePath, e.size, e.sha256, e.exportedAt, e.recordType, e.status]);
  return `${[head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n")}\n`;
}
