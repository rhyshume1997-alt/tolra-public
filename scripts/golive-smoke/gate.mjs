// Go-live smoke gate. Fails (exit 1) unless every step in scripts/golive-smoke/steps.mjs appears exactly once in the results file as
// "SMOKE <n> <name>: PASS", with no FAIL, no unknown or duplicate line, no missing step; the SHA check passed; and the Playwright and
// Vitest JSON reports (when given) have no failed, skipped, flaky, pending or todo test and at least one passed test. Prints every
// SMOKE line, the KNOWN GAP and FINDING lines (reported, never hidden; they do not fail the gate), the counts and the SHAs.
//
//   node scripts/golive-smoke/gate.mjs --results <results.txt> --shas <shas.txt> [--playwright <report.json>] [--vitest <report.json>]
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { STEPS } from "./steps.mjs";

const LINE = /^SMOKE (\d+) ([a-z0-9-]+): (PASS|FAIL)\b ?(.*)$/;

/** The gate over the given texts (null = file missing). Returns { problems, report } so it can be unit tested without files. */
export function evaluate({ results, shas, playwright, vitest, steps = STEPS }) {
  const problems = [];
  const report = [];
  if (results === null) problems.push("results file missing");
  const lines = (results ?? "").split("\n").map((l) => l.trimEnd()).filter(Boolean);
  const seen = new Map();
  const gaps = [];
  const findings = [];
  for (const line of lines) {
    if (line.startsWith("KNOWN GAP ")) { gaps.push(line); continue; }
    if (line.startsWith("FINDING ")) { findings.push(line); continue; }
    const m = LINE.exec(line);
    if (!m) { problems.push(`unreadable line: ${line.slice(0, 200)}`); continue; }
    const key = `${m[1]} ${m[2]}`;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push({ verdict: m[3], line });
  }
  let pass = 0, fail = 0, missing = 0;
  for (const step of steps) {
    const key = `${step.n} ${step.name}`;
    const hits = seen.get(key) ?? [];
    seen.delete(key);
    if (hits.length === 0) { missing++; problems.push(`SMOKE ${key}: MISSING (never reported; ${step.where})`); report.push(`SMOKE ${key}: MISSING`); continue; }
    if (hits.length > 1) problems.push(`SMOKE ${key}: reported ${hits.length} times`);
    for (const h of hits) report.push(h.line);
    if (hits.every((h) => h.verdict === "PASS")) pass++;
    else { fail++; problems.push(`SMOKE ${key}: FAIL`); }
  }
  for (const [key, hits] of seen) problems.push(`unexpected step SMOKE ${key} (${hits.length} line(s)): not in scripts/golive-smoke/steps.mjs`);

  if (shas === null) problems.push("SHA check output missing");
  else if (!/^SHA check PASSED$/m.test(shas)) problems.push("SHA check did not pass");

  const tests = [];
  if (playwright !== undefined) {
    if (playwright === null) problems.push("Playwright report missing");
    else {
      try {
        const s = JSON.parse(playwright).stats ?? {};
        tests.push(`playwright: expected ${s.expected ?? 0}, unexpected ${s.unexpected ?? 0}, skipped ${s.skipped ?? 0}, flaky ${s.flaky ?? 0}`);
        if (!(s.expected > 0)) problems.push("Playwright: no test passed");
        if (s.unexpected || s.skipped || s.flaky) problems.push("Playwright: failed, skipped or flaky tests");
      } catch (e) { problems.push(`Playwright report unreadable: ${e.message}`); }
    }
  }
  if (vitest !== undefined) {
    if (vitest === null) problems.push("Vitest report missing");
    else {
      try {
        const r = JSON.parse(vitest);
        tests.push(`vitest: total ${r.numTotalTests}, passed ${r.numPassedTests}, failed ${r.numFailedTests}, pending ${r.numPendingTests}, todo ${r.numTodoTests ?? 0}`);
        if (!(r.numPassedTests > 0)) problems.push("Vitest: no test passed");
        if (r.numFailedTests || r.numPendingTests || r.numTodoTests || r.numPassedTests !== r.numTotalTests) problems.push("Vitest: failed, skipped or todo tests");
      } catch (e) { problems.push(`Vitest report unreadable: ${e.message}`); }
    }
  }
  return { problems, report, gaps, findings, counts: { steps: steps.length, pass, fail, missing }, tests };
}

function readOrNull(path) { return path && existsSync(path) ? readFileSync(path, "utf8") : null; }

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  const shas = readOrNull(args.shas);
  const out = evaluate({
    results: readOrNull(args.results),
    shas,
    playwright: "playwright" in args ? readOrNull(args.playwright) : undefined,
    vitest: "vitest" in args ? readOrNull(args.vitest) : undefined,
  });
  console.log("== SMOKE lines ==");
  for (const line of out.report) console.log(line);
  console.log("== KNOWN GAP lines (reported, not failures) ==");
  for (const line of out.gaps) console.log(line);
  if (!out.gaps.length) console.log("(none)");
  console.log("== FINDING lines (real defects seen on the way; reported, not failures of the smoke) ==");
  for (const line of out.findings) console.log(line);
  if (!out.findings.length) console.log("(none)");
  console.log("== SHAs ==");
  for (const line of (shas ?? "").split("\n").filter((l) => /^(candidate|branch head|tree |files added|PASS|FAIL|SHA check)/.test(l))) console.log(line);
  console.log("== test reports ==");
  for (const line of out.tests) console.log(line);
  const c = out.counts;
  console.log(`== counts: ${c.steps} steps, ${c.pass} PASS, ${c.fail} FAIL, ${c.missing} MISSING; ${out.gaps.length} KNOWN GAP, ${out.findings.length} FINDING ==`);
  if (out.problems.length) {
    console.log("== GATE FAILED ==");
    for (const p of out.problems) console.log(`FAIL ${p}`);
    return 1;
  }
  console.log(`== GATE PASSED: all ${c.steps} steps PASS, none missing, skipped or failed ==`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main(process.argv.slice(2)));
