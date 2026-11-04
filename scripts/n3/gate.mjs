import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(r.total, 9);
assert.equal(r.passed, 9);
assert.equal(r.failed, 0);
assert.equal(r.skipped, 0);
assert.equal(r.todo, 0);
assert.equal(r.suiteErrors, 0);
assert.equal(r.checks.length, 9);
for (let i = 1; i <= 9; i++) {
  const matches = r.checks.filter(t => t.id === `N3-${String(i).padStart(2, "0")}`);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].status, "pass");
}
console.log("PASS N3: all nine named database rehearsal checks passed; zero skips");
