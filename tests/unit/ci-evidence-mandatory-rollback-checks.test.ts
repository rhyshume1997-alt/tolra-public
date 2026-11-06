/**
 * The 146 rollback/reinstall step in ci.yml is informational. The rollback evidence that GATES the release is different: the named-case checks in the
 * "Evidence: database suite, skips, named cases, release refusals" step run `scripts/ci-evidence.mjs named evidence/db.json CASES <test files>` and fail CI
 * (exit 1) when a named file is missing from the report or has a case that did not pass. That step is not continue-on-error and ends with `exit $rc`.
 * This test proves both halves: the script fails on missing/failed evidence, and ci.yml still names the rollback-refusal proofs inside that gating step.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const evidenceScript = path.join(root, "scripts/ci-evidence.mjs");
const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");

const REQUIRED_ROLLBACK_PROOFS = [
  "tests/db/rollback-data-refusal.test.ts", // 141/143/145/147/148 data-refusing rollbacks and 149/151 refusals
  "tests/db/tolra-provided-ai.test.ts", // 146 rollback refusal with an outstanding reservation, second install refused
  "tests/db/job-delivery-note-147.test.ts", // 147 rollback refusal then eligible rollback and re-release
  "tests/db/job-profitability-148.test.ts", // 148 rollback refusal then eligible rollback
  "tests/db/release-order-guards.test.ts", // each release refused out of order
];

const file = (name: string, statuses: string[]) => ({ name: `/x/${name}`, status: "passed", assertionResults: statuses.map((status, i) => ({ ancestorTitles: ["g"], title: `t${i}`, status })) });
function named(report: unknown, suffix: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "evn-"));
  const f = path.join(dir, "db.json");
  writeFileSync(f, JSON.stringify(report));
  const r = spawnSync("node", [evidenceScript, "named", f, "CASES", suffix], { encoding: "utf8" });
  return { code: r.status, out: r.stdout };
}

describe("mandatory rollback evidence (named cases) fails CI when evidence is missing", () => {
  const suffix = "tests/db/rollback-data-refusal.test.ts";
  it("passes when every case of the file passed", () => {
    const r = named({ testResults: [file(suffix, ["passed", "passed"])] }, suffix);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^PASS CASES /m);
  });
  it("FAILS (exit 1) when the file is absent from the report: required rollback evidence missing", () => {
    const r = named({ testResults: [file("tests/db/other.test.ts", ["passed"])] }, suffix);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^FAIL CASES .*0\/0 passed/m);
  });
  it("FAILS (exit 1) when one case failed or was skipped", () => {
    expect(named({ testResults: [file(suffix, ["passed", "failed"])] }, suffix).code).toBe(1);
    expect(named({ testResults: [file(suffix, ["passed", "skipped"])] }, suffix).code).toBe(1);
  });
});

describe("ci.yml keeps those named proofs inside the gating evidence step", () => {
  const start = ci.indexOf('name: "Evidence: database suite, skips, named cases, release refusals, rehearsal');
  const next = ci.indexOf("\n      - name:", start + 10);
  const step = ci.slice(start, next);
  it("the step exists, runs when the report exists, is not continue-on-error and exits with the accumulated failure", () => {
    expect(start).toBeGreaterThan(-1);
    expect(step).toMatch(/if: \$\{\{ always\(\) && hashFiles\('evidence\/db\.json'\) != '' \}\}/);
    expect(step).not.toMatch(/continue-on-error/);
    expect(step).toMatch(/^\s*exit \$rc\s*$/m);
  });
  it.each(REQUIRED_ROLLBACK_PROOFS)("%s is named in that step and a failure sets rc=1", (proof) => {
    const line = step.split("\n").find((l) => l.includes("ci-evidence.mjs named evidence/db.json CASES") && l.includes(proof));
    expect(line, `${proof} must be named in the gating evidence step`).toBeTruthy();
    expect(line).toMatch(/\|\| rc=1/);
  });
});
