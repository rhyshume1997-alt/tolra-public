// node --test: the go-live smoke gate fails on a FAIL, a missing step, a duplicate, an unknown step, a skipped or failed test in a
// report, and a failed SHA check; it passes only on a complete all-PASS set. Also: every step in steps.mjs is written somewhere, under
// exactly its number and name, and nothing writes a step that is not in the list.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { evaluate } from "./gate.mjs";
import { STEPS } from "./steps.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const all = (verdict = () => "PASS") => STEPS.map((s) => `SMOKE ${s.n} ${s.name}: ${verdict(s)} [00:00:00Z] synthetic`).join("\n");
const SHAS = "candidate (app tree under test): x\nbranch head: y\nSHA check PASSED\n";
const PW = JSON.stringify({ stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 } });
const VT = JSON.stringify({ numTotalTests: 9, numPassedTests: 9, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0 });
const run = (over = {}) => evaluate({ results: all(), shas: SHAS, playwright: PW, vitest: VT, ...over });

test("a complete all-PASS set passes, with KNOWN GAP and FINDING lines reported but not failing", () => {
  const out = run({ results: `${all()}\nKNOWN GAP x: y\nFINDING z: w` });
  assert.deepEqual(out.problems, []);
  assert.equal(out.counts.pass, STEPS.length);
  assert.deepEqual([out.gaps.length, out.findings.length], [1, 1]);
});

test("a seeded FAIL fails the gate", () => {
  const out = run({ results: all((s) => (s.n === 25 ? "FAIL" : "PASS")) });
  assert.ok(out.problems.some((p) => /SMOKE 25 dln-from-sales-order: FAIL/.test(p)));
  assert.equal(out.counts.fail, 1);
});

test("a missing step fails the gate", () => {
  const out = run({ results: all().split("\n").filter((l) => !l.startsWith("SMOKE 33 ")).join("\n") });
  assert.ok(out.problems.some((p) => /SMOKE 33 chase-pass-drafts-only: MISSING/.test(p)));
  assert.equal(out.counts.missing, 1);
});

test("a skipped test in either report fails the gate, and so does a missing or unreadable report", () => {
  assert.ok(run({ playwright: JSON.stringify({ stats: { expected: 1, unexpected: 0, skipped: 1, flaky: 0 } }) }).problems.some((p) => /skipped/.test(p)));
  assert.ok(run({ vitest: JSON.stringify({ numTotalTests: 9, numPassedTests: 8, numFailedTests: 0, numPendingTests: 1, numTodoTests: 0 }) }).problems.some((p) => /skipped/.test(p)));
  assert.ok(run({ playwright: null }).problems.includes("Playwright report missing"));
  assert.ok(run({ vitest: "{" }).problems.some((p) => /unreadable/.test(p)));
  assert.ok(run({ playwright: JSON.stringify({ stats: { expected: 0, unexpected: 0, skipped: 0, flaky: 0 } }) }).problems.includes("Playwright: no test passed"));
});

test("a line spelled 'SKIP', a duplicate, an unknown step and a garbled line all fail the gate", () => {
  assert.ok(run({ results: all().replace("SMOKE 12 sliq-repeat-no-duplicate: PASS", "SMOKE 12 sliq-repeat-no-duplicate: SKIP") }).problems.some((p) => /unreadable line|MISSING/.test(p)));
  assert.ok(run({ results: `${all()}\nSMOKE 12 sliq-repeat-no-duplicate: PASS again` }).problems.some((p) => /reported 2 times/.test(p)));
  assert.ok(run({ results: `${all()}\nSMOKE 99 made-up: PASS` }).problems.some((p) => /unexpected step SMOKE 99/.test(p)));
  assert.ok(run({ results: `${all()}\nhello` }).problems.some((p) => /unreadable line/.test(p)));
});

test("a failed or absent SHA check fails the gate; no results file fails it", () => {
  assert.ok(run({ shas: "SHA check FAILED" }).problems.includes("SHA check did not pass"));
  assert.ok(run({ shas: null }).problems.includes("SHA check output missing"));
  assert.ok(run({ results: null }).problems.includes("results file missing"));
});

test("steps.mjs has numbers 1..N once each and unique names", () => {
  assert.deepEqual(STEPS.map((s) => s.n), STEPS.map((_, i) => i + 1));
  assert.equal(new Set(STEPS.map((s) => s.name)).size, STEPS.length);
});

test("every step in steps.mjs is written under its number and name, and nothing writes a step that is not in the list", () => {
  const files = [
    ...readdirSync(path.join(ROOT, "tests/e2e/golive-smoke")).filter((f) => f.endsWith(".ts")).map((f) => `tests/e2e/golive-smoke/${f}`),
    "scripts/golive-smoke/install-releases.sh", ".github/workflows/golive-smoke.yml",
  ];
  const written = [];
  for (const f of files) {
    const text = readFileSync(path.join(ROOT, f), "utf8");
    for (const m of text.matchAll(/\bstep\((\d+), "([a-z0-9-]+)"/g)) written.push(`${m[1]} ${m[2]}`);
    for (const m of text.matchAll(/smoke_line "?(\d+)"? "?([a-z0-9-]+)"? (?:PASS|FAIL|"\$)/g)) written.push(`${m[1]} ${m[2]}`);
  }
  // install-releases.sh writes 3-5 in a loop ("release-${release%%_*}"): count them as written once each.
  written.push("3 release-145", "4 release-146", "5 release-147");
  const want = STEPS.map((s) => `${s.n} ${s.name}`);
  assert.deepEqual([...new Set(written)].sort(), [...want].sort());
});
