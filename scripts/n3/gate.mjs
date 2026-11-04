import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(r.success, true);
assert.equal(r.numTotalTests, 8);
assert.equal(r.numPassedTests, 8);
assert.equal(r.numFailedTests, 0);
assert.equal(r.numPendingTests, 0);
assert.equal(r.numTodoTests ?? 0, 0);
const tests = r.testResults.flatMap(s => s.assertionResults);
assert.equal(tests.length, 8);
for (let i = 1; i <= 8; i++) {
  const matches = tests.filter(t => t.title.startsWith(`N3-${String(i).padStart(2, "0")} `));
  assert.equal(matches.length, 1);
  assert.equal(matches[0].status, "passed");
}
console.log("PASS N3: all eight named database rehearsal checks passed; zero skips");
