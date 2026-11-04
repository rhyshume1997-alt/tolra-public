// Gate over scripts/money-parity/run.sh. Fails unless:
//   * tests/db/money-rounding-parity.test.ts (PR #284) ran exactly once with exactly its one test, PASSED;
//   * tests/db/money-parity-ties.test.ts ran exactly once with exactly 38 tests, all PASSED;
//   * nothing in the report failed, was skipped, pending or todo;
//   * the tie evidence holds exactly the 38 cases, each with lib/money.ts = PostgreSQL = expected pence.
// Prints every tie: input, TS result, SQL result.
//
//   node scripts/money-parity/gate.mjs <vitest report.json> <ties.json>
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const [reportPath, tiesPath] = process.argv.slice(2);
assert(reportPath && tiesPath, "usage: gate.mjs <vitest report.json> <ties.json>");
const EXPECTED_TIES = 38;
const FILES = {
  "tests/db/money-rounding-parity.test.ts": ["CL: app and real PostgreSQL agree on penny ties, fractional lines and per-line VAT"],
  "tests/db/money-parity-ties.test.ts": EXPECTED_TIES,
};

let failures = 0;
const fail = (msg) => { console.log(`FAIL ${msg}`); failures++; };
const report = JSON.parse(readFileSync(reportPath, "utf8"));
console.log(`report: total ${report.numTotalTests}, passed ${report.numPassedTests}, failed ${report.numFailedTests}, pending ${report.numPendingTests}, todo ${report.numTodoTests ?? 0}`);
if (report.numFailedTests || report.numPendingTests || report.numTodoTests) fail("the report has failed, skipped or todo tests");
if (report.testResults.length !== Object.keys(FILES).length) fail(`expected ${Object.keys(FILES).length} files in the report, found ${report.testResults.length}`);

for (const [file, want] of Object.entries(FILES)) {
  const hits = report.testResults.filter((t) => t.name.replaceAll("\\", "/").endsWith(`/${file}`));
  if (hits.length !== 1) { fail(`${file}: expected once, found ${hits.length}`); continue; }
  const tests = hits[0].assertionResults;
  const counts = tests.reduce((a, t) => ({ ...a, [t.status]: (a[t.status] ?? 0) + 1 }), {});
  console.log(`${file}: ${JSON.stringify(counts)} (file ${hits[0].status}${hits[0].message ? `: ${hits[0].message}` : ""})`);
  for (const t of tests) if (t.status !== "passed") fail(`${file} > ${t.title}: ${t.status}`);
  if (Array.isArray(want)) {
    if (tests.length !== want.length) fail(`${file}: expected ${want.length} test(s), found ${tests.length}`);
    for (const title of want) {
      const m = tests.filter((t) => t.title === title);
      const ok = m.length === 1 && m[0].status === "passed";
      console.log(`${ok ? "PASS" : "FAIL"} ${file} > ${title}: ${m.length === 1 ? m[0].status : `found ${m.length} times`}`);
      if (!ok) failures++;
    }
  } else if (tests.length !== want) fail(`${file}: expected ${want} tests, found ${tests.length}`);
}

let ties = [];
try { ties = JSON.parse(readFileSync(tiesPath, "utf8")); } catch (e) { fail(`tie evidence ${tiesPath} unreadable: ${e.message}`); }
const keys = new Set();
let checked = 0;
for (const t of ties) {
  const ok = t.ts === t.expected && t.sql === String(t.expected);
  keys.add(`${t.kind}|${t.a}|${t.b}`);
  console.log(`${ok ? "PASS" : "FAIL"} tie ${t.kind}(${t.a}, ${t.b}): TS ${t.ts}  SQL ${t.sql}  expected ${t.expected}`);
  if (ok) checked++; else failures++;
}
if (ties.length !== EXPECTED_TIES || keys.size !== EXPECTED_TIES) fail(`expected ${EXPECTED_TIES} distinct ties, found ${ties.length} rows (${keys.size} distinct)`);
console.log(`tie cases checked: ${checked} of ${EXPECTED_TIES} (TS = SQL = expected)`);

assert.equal(failures, 0, `money-parity gate: ${failures} problem(s); a failed, skipped, missing or short proof is not accepted`);
console.log(`money-parity gate: PASSED. PR #284 parity test passed; ${checked} of ${EXPECTED_TIES} tie cases agree in lib/money.ts and PostgreSQL; 0 skipped, 0 failed.`);
