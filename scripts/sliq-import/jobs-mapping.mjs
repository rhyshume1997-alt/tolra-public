// Jobs, sales orders and opening WIP: the mapping for the three extra SliQ source files, and the header check every source file
// can be held to. Kept apart from mapping.mjs on purpose: the mapping JSON carries this in its own "jobsImport" section (so the
// whole file's checksum still covers it), and the header check reads "headerCheck" / "ignoreColumns" from the same file.
//
//   "jobsImport": {
//     "files": { "jobs": { "file": "jobs.csv", "columns": { "number": "Job No", ... } }, "salesOrders": {...}, "wip": {...} },
//     "jobStatusWords":        { "<SliQ word>": { "open": true, "status": "on_track" | "at_risk" | "overdue" } | { "open": false } },
//     "jobStageWords":         { "<SliQ word>": "material" | "setup" | "machining" | "inspection" },
//     "salesOrderStatusWords": { "<SliQ word>": "open" | "confirmed" | "in_production" | "despatched" | "converted" | "closed" },
//     "jobNumberPattern":        "^J-(\\d{1,9})$",   the digits that seed Tolra's J counter (one capture group)
//     "salesOrderNumberPattern": "^SO-(\\d{1,9})$"   the same for the SO counter
//   },
//   "headerCheck": "strict",                         every source file's header row must be exactly what the mapping names
//   "ignoreColumns": { "<kind>": ["<header>", ...] } headers a strict check accepts without a field (listed, never read)
//
// Nothing is guessed: an unlisted status or stage word is a row error, and a strict header check refuses the run with the list.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MappingError, normHeader, resolveColumn } from "./mapping.mjs";

const MAPPINGS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "mappings");

/** kind -> canonical field -> { type, required, blankOk? }. */
export const JOBS_CANONICAL = {
  jobs: {
    number: { type: "text", required: true },
    customer: { type: "text", required: true }, // the customer's account code (stable id); the name only when the customers file has no codes
    quote: { type: "text", required: false },
    salesOrder: { type: "text", required: false },
    description: { type: "text", required: false },
    status: { type: "jobStatus", required: true },
    stage: { type: "jobStage", required: false },
    dueDate: { type: "date", required: false },
    specification: { type: "text", required: false },
    startedDate: { type: "date", required: false },
    finishedDate: { type: "date", required: false },
    value: { type: "money", required: false },
  },
  salesOrders: {
    number: { type: "text", required: true },
    customer: { type: "text", required: true },
    quote: { type: "text", required: false },
    status: { type: "soStatus", required: true },
    orderDate: { type: "date", required: false },
    deliveryDate: { type: "date", required: false },
    total: { type: "money", required: false },
    notes: { type: "text", required: false },
    job: { type: "text", required: false },
  },
  wip: {
    job: { type: "text", required: true, blankOk: true }, // blank: WIP not on any job (kept, unlinked)
    description: { type: "text", required: false },
    quantity: { type: "quantity", required: false },
    value: { type: "money", required: false }, // blank stays blank: no valuation is ever worked out
    asOf: { type: "date", required: false },
    reference: { type: "text", required: false },
  },
};
export const JOB_FILE_KINDS = ["jobs", "salesOrders", "wip"];
export const JOB_IDENTIFIER_FIELDS = new Set(["number", "customer", "quote", "salesOrder", "job", "reference"]);

const JOB_STATUSES = ["on_track", "at_risk", "overdue"];
const JOB_STAGES = ["material", "setup", "machining", "inspection"];
const SO_STATUSES = ["open", "confirmed", "in_production", "despatched", "converted", "closed"];

/** The mapping file as getProfile found it (same name rules), checked to be the very file the profile was read from. */
export function readMappingRaw(idOrPath, profile) {
  const file = /^[a-z0-9-]+$/.test(idOrPath) ? path.join(MAPPINGS_DIR, `${idOrPath}.json`) : path.resolve(idOrPath);
  const bytes = readFileSync(file);
  if (profile?.fileSha256 && createHash("sha256").update(bytes).digest("hex") !== profile.fileSha256) {
    throw new MappingError(`Mapping ${file} changed while it was being read: run again.`);
  }
  return JSON.parse(bytes.toString("utf8"));
}

/** The jobs part of a mapping (or null when the mapping has none: jobs, sales orders and WIP are then not read at all). */
export function getJobsProfile(raw) {
  const j = raw.jobsImport;
  if (!j) return null;
  const problems = [];
  const files = {};
  for (const kind of JOB_FILE_KINDS) {
    const f = j.files?.[kind] ?? {};
    files[kind] = { file: [].concat(f.file ?? `${kind}.csv`), columns: f.columns ?? {} };
    for (const field of Object.keys(files[kind].columns)) if (!(field in JOBS_CANONICAL[kind])) problems.push(`jobsImport.files.${kind}: "${field}" is not a field of ${kind}`);
  }
  const jobStatusWords = j.jobStatusWords ?? {};
  for (const [w, v] of Object.entries(jobStatusWords)) {
    if (typeof v !== "object" || v === null || typeof v.open !== "boolean") problems.push(`jobStatusWords "${w}": give { "open": true, "status": ... } or { "open": false }`);
    else if (v.open && !JOB_STATUSES.includes(v.status)) problems.push(`jobStatusWords "${w}": status must be one of ${JOB_STATUSES.join(", ")}`);
  }
  const jobStageWords = j.jobStageWords ?? {};
  for (const [w, v] of Object.entries(jobStageWords)) if (!JOB_STAGES.includes(v)) problems.push(`jobStageWords "${w}": must be one of ${JOB_STAGES.join(", ")}`);
  const salesOrderStatusWords = j.salesOrderStatusWords ?? {};
  for (const [w, v] of Object.entries(salesOrderStatusWords)) if (!SO_STATUSES.includes(v)) problems.push(`salesOrderStatusWords "${w}": must be one of ${SO_STATUSES.join(", ")}`);
  const pattern = (key, dflt) => {
    const s = j[key] ?? dflt;
    try {
      const re = new RegExp(s);
      if (new RegExp(`${re.source}|`).exec("").length !== 2) problems.push(`${key}: needs exactly one capture group (the number)`);
      return re;
    } catch (e) {
      problems.push(`${key}: ${e.message}`);
      return null;
    }
  };
  const jobNumberPattern = pattern("jobNumberPattern", "^J-(\\d{1,9})$");
  const salesOrderNumberPattern = pattern("salesOrderNumberPattern", "^SO-(\\d{1,9})$");
  if (problems.length) throw new MappingError(`The mapping's jobsImport section cannot be used:\n${problems.map((p) => `  - ${p}`).join("\n")}`, problems.map((p) => ({ problem: "jobsImport", detail: p })));
  return { files, jobStatusWords, jobStageWords, salesOrderStatusWords, jobNumberPattern, salesOrderNumberPattern };
}

/** Header check settings: { strict, ignore: { kind: Set(normalised header) } }. */
export function getHeaderCheck(raw) {
  const ignore = {};
  for (const [k, list] of Object.entries(raw.ignoreColumns ?? {})) ignore[k] = new Set([].concat(list).map(normHeader));
  return { strict: raw.headerCheck === "strict", ignore };
}

/**
 * One file's header row against its column spec. Missing: a mapped column (required or optional) that is not in the file.
 * Unknown: a header that no field uses and that the ignore list does not name. A header twice is listed as well.
 */
export function compareHeaders(columns, canonical, headers, ignore = new Set()) {
  const norm = headers.map(normHeader);
  const missing = [];
  const used = new Set();
  for (const field of Object.keys(canonical)) {
    const r = resolveColumn(columns[field], norm);
    if (!r.mapped) continue;
    for (const h of r.present) used.add(normHeader(h));
    const absent = r.wanted.filter((w) => !norm.includes(normHeader(w)));
    if (r.present.length === 0 || (r.join && absent.length)) missing.push({ field, columns: r.present.length === 0 ? r.wanted : absent });
  }
  const unknown = headers.filter((h) => !used.has(normHeader(h)) && !ignore.has(normHeader(h)) && normHeader(h) !== "");
  const twice = [...new Set(norm.filter((h, i) => h && norm.indexOf(h) !== i))];
  return { missing, unknown, twice };
}

export function describeHeaderProblems(list) {
  const lines = [];
  for (const p of list) {
    for (const m of p.missing) lines.push(`  - ${p.file}: missing column ${m.columns.map((c) => `"${c}"`).join(" or ")} (for "${m.field}")`);
    for (const u of p.unknown) lines.push(`  - ${p.file}: unknown column "${u}" (no field uses it; map it, or list it under "ignoreColumns" once it is checked)`);
    for (const t of p.twice ?? []) lines.push(`  - ${p.file}: column "${t}" appears more than once`);
  }
  return `The header rows do not match the mapping (header check "strict"):\n${lines.join("\n")}\nNothing was imported. Fix the export or the mapping, then run again.`;
}
