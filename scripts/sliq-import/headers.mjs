// The header check for the main SliQ files (customers, invoices, quotes, ... purchase orders). load.mjs already stops on a missing
// REQUIRED column; a mapping that says "headerCheck": "strict" (the real SliQ files) is also refused, with one list, when a file
// lacks an optional column the mapping names or has a column no field uses (unless "ignoreColumns" lists it). The jobs files
// (jobs-load.mjs) are always checked this way. Reads only what loadFolder recorded per file; changes nothing.
import { describeHeaderProblems } from "./jobs-mapping.mjs";
import { CANONICAL, MappingError, normHeader } from "./mapping.mjs";

export function coreHeaderProblems(loaded, headerCheck) {
  const out = [];
  for (const i of loaded.inputs) {
    if (!CANONICAL[i.kind] || !loaded.profile.files[i.kind]) continue;
    const spec = loaded.profile.files[i.kind].columns;
    const ignore = headerCheck.ignore[i.kind] ?? new Set();
    const missing = (i.optionalColumnsMissing ?? []).map((field) => {
      const s = spec[field];
      return { field, columns: Array.isArray(s) ? s : s?.anyOf ?? [s] };
    });
    const unknown = (i.unmappedColumns ?? []).filter((h) => normHeader(h) !== "" && !ignore.has(normHeader(h)));
    if (missing.length || unknown.length) out.push({ kind: i.kind, file: i.sheet ? `${i.file} [${i.sheet}]` : i.file, missing, unknown, twice: [] });
  }
  return out;
}

/** Throws a MappingError listing every missing and unknown column when the mapping's header check is strict. */
export function assertCoreHeaders(loaded, headerCheck) {
  if (!headerCheck?.strict) return [];
  const problems = coreHeaderProblems(loaded, headerCheck);
  if (problems.length) throw new MappingError(describeHeaderProblems(problems), problems.map((p) => ({ file: p.file, problem: "header row", detail: JSON.stringify({ missing: p.missing, unknown: p.unknown }) })));
  return [];
}
