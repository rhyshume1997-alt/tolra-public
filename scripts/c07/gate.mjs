// C07 gate over the vitest JSON reports of scripts/c07/run-safeupdate.sh. Fails unless:
//   * every expected test file ran, in the report it is expected in, with at least one test;
//   * every test in those files PASSED (no failed, skipped, pending, todo or empty file);
//   * every named test below is present, by its describe path and title, exactly once, and PASSED. The first five are the
//     tests that are skipped wherever safeupdate cannot be LOADed (describe.runIf(LOADABLE)); naming them means a skip cannot
//     slip through as "nothing failed".
//
//   node scripts/c07/gate.mjs <direct-session report.json> <importer-role report.json>
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [directReport, importerReport] = process.argv.slice(2);
assert(directReport && importerReport, "usage: gate.mjs <direct-session report.json> <importer-role report.json>");

const PR2 = "tests/db/data-import-pr2.test.ts";
const SU = "tests/db/data-import-safeupdate.test.ts";
const C07 = "tests/db/c07-safeupdate.test.ts";
const SLIQ = "tests/db/sliq-import.test.ts";
const FILES = { [directReport]: [PR2, SU], [importerReport]: [C07, SLIQ] };

const DIRECT = "in a direct session with safeupdate loaded";
const API = "through the API (PostgREST: safeupdate preloaded by Supabase)";
const SMALL = "small file: a dry run answers the counts and writes nothing; the commit writes every record; the same file again matches them";
const BAD = "small file with a problem: refused whole, every problem reported, nothing written";
const LARGE = "large file: staged, validated whole, committed part by part, then undone back to nothing";
/** [file, describe path, title]. TARGET: the five LOADABLE-gated tests. */
const TARGET = [
  [PR2, ["with pg-safeupdate loaded (as in Supabase's API sessions)"], "the small and the large path, credit notes and delivery notes included, then undo"],
  [SU, [DIRECT], "safeupdate is in force in these sessions: an UPDATE or DELETE without WHERE is refused, also inside a function"],
  [SU, [DIRECT], SMALL],
  [SU, [DIRECT], BAD],
  [SU, [DIRECT], LARGE],
];
const ALSO = [
  [SU, [], "is checked somewhere: the API, or a direct session with safeupdate loaded (CI: the API)"],
  [SU, [API], SMALL],
  [SU, [API], BAD],
  [SU, [API], LARGE],
];

const seen = [];
let failures = 0;
for (const [report, files] of Object.entries(FILES)) {
  const r = JSON.parse(readFileSync(report, "utf8"));
  for (const file of files) {
    const hits = r.testResults.filter((t) => t.name.replaceAll("\\", "/").endsWith(`/${file}`));
    if (hits.length !== 1) {
      console.log(`FAIL ${file}: expected in ${report} once, found ${hits.length}`);
      failures++;
      continue;
    }
    const tests = hits[0].assertionResults;
    if (tests.length === 0) {
      console.log(`FAIL ${file}: no test ran (${hits[0].status}: ${hits[0].message ?? ""})`);
      failures++;
    }
    for (const t of tests) {
      seen.push({ file, path: t.ancestorTitles, title: t.title, status: t.status });
      if (t.status !== "passed") {
        console.log(`FAIL ${file} > ${[...t.ancestorTitles, t.title].join(" > ")}: ${t.status}`);
        failures++;
      }
    }
    const counts = tests.reduce((a, t) => ({ ...a, [t.status]: (a[t.status] ?? 0) + 1 }), {});
    console.log(`${file}: ${JSON.stringify(counts)}`);
  }
}

for (const [label, list] of [["TARGET (LOADABLE)", TARGET], ["ALSO REQUIRED", ALSO]]) {
  for (const [file, path, title] of list) {
    const m = seen.filter((t) => t.file === file && t.title === title && JSON.stringify(t.path) === JSON.stringify(path));
    const status = m.length === 1 ? m[0].status : `found ${m.length} times`;
    const ok = m.length === 1 && m[0].status === "passed";
    console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${file} > ${[...path, title].join(" > ")}: ${status}`);
    if (!ok) failures++;
  }
}

assert.equal(failures, 0, `C07 gate: ${failures} problem(s); a failed, skipped, missing or empty proof is not accepted`);
console.log(`C07 gate: ${seen.length} tests passed across ${Object.values(FILES).flat().length} files; the 5 LOADABLE targets and the 4 API/guard tests passed by name; 0 skipped, 0 failed.`);
