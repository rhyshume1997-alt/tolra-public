#!/usr/bin/env node
/**
 * BOUNDARY (CI guardrail: tests are not removed, skipped or loosened without approval).
 *
 *   node scripts/check-test-weakening.mjs <base-sha> <head-sha>
 *
 * Input: two commits. Everything under tests/ that changed between their merge base and <head-sha> is read from git (nothing is
 * executed, the working tree is not read). Output: every finding printed, exit 1 when there is one and the change is not approved.
 *
 * A finding is:
 *   - a test file deleted, renamed to a name no suite collects, or moved to another suite's directory;
 *   - more .skip / .only / .todo / .fixme / .skipIf / .fails / xit markers in an existing test file than before (every new one is
 *     reviewed, conditional or not);
 *   - in a NEW test file: any .only, .todo, .fixme, .fails or xit, and any skip that is not conditional with its reason given. Only
 *     test.skip(<condition>, <reason>) (Playwright) and it.skipIf(<condition>) (vitest) pass there: test.skip("title", ...),
 *     describe.skip(...), test.skip() and test.skip(<condition>) with no reason are findings;
 *   - fewer titled it(...) / test(...) cases in a test file than before (a renamed title is not a finding; rows of an it.each table
 *     and deleted assertions are NOT detected: review still matters);
 *   - a ceiling raised, or a page dropped, in tests/unit/page-size-budget.test.ts.
 * Adding tests, renaming a file within its suite, renaming a title and lowering a ceiling all pass.
 *
 * Approval: TESTS_CHANGE_APPROVED=true (CI sets it from the pull request's `tests-change-approved` label). Findings are still
 * printed. Fails closed: a commit that cannot be resolved, a failed git command or missing arguments exit 1, approved or not.
 *
 * Must not be changed without Rhys's approval: the list of findings may grow, never shrink; the fail-closed exits stay.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Files a suite collects: vitest *.test.ts, Playwright *.spec.ts, and the SQL / shell proofs under tests/scripts. */
const TEST_FILE = /^tests\/.+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const PROOF_FILE = /^tests\/scripts\/.+\.(?:proof\.sql|test\.sh)$/;
export const isTestFile = (file) => TEST_FILE.test(file) || PROOF_FILE.test(file);

/** tests/unit, tests/db, tests/e2e, ...: each is collected by its own config, so moving a file between them changes what runs it. */
const suiteOf = (file) => file.split("/").slice(0, 2).join("/");

const MARKER = /\b(?:describe|suite|it|test)(?:\.[A-Za-z]+)*\.(skip|only|todo|fixme|skipIf|fails)\b|\bx(?:it|describe|test)\s*\(/g;
/** it("..."), test.only('...'), it.each([...])(`...`): the title literal on the call. */
const CASE = /\b(?:it|test)(?:\.[A-Za-z]+)*(?:\s*(?:<[^>\n]*>)?\s*\((?:[^()]|\([^()]*\))*\))?\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const CEILING_FILE = "tests/unit/page-size-budget.test.ts";
const CEILING = /"([^"\n]+)":\s*([0-9][0-9_]*)\s*,/g;

/** After a `.skip`: an opening bracket, a first argument that is not a title string, a comma and then a reason. */
const CONDITION_AND_REASON = /^\(\s*(?!["'`])[^\s,)][^,\n]*,\s*[^\s)]/;
/** After a `.skipIf`: an opening bracket and a condition. */
const CONDITION = /^\(\s*[^\s)]/;

/** `explainedSkipsPass`: leave out test.skip(<condition>, <reason>) and it.skipIf(<condition>), the only skips a new file may carry. */
export function markerCounts(text, { explainedSkipsPass = false } = {}) {
  const counts = {};
  for (const match of text.matchAll(MARKER)) {
    const kind = match[1] ?? "x-prefixed";
    if (explainedSkipsPass) {
      const rest = text.slice(match.index + match[0].length);
      if ((kind === "skip" && CONDITION_AND_REASON.test(rest)) || (kind === "skipIf" && CONDITION.test(rest))) continue;
    }
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

export function caseTitles(text) {
  return [...text.matchAll(CASE)].map((match) => match[2]);
}

function ceilings(text) {
  return new Map([...text.matchAll(CEILING)].map((match) => [match[1], Number(match[2].replaceAll("_", ""))]));
}

/**
 * @param {{ status: "A" | "M" | "D" | "R", oldPath: string, newPath: string, baseText: string, headText: string }[]} changes
 * @returns {{ file: string, kind: string, detail: string }[]}
 */
export function analyse(changes) {
  const findings = [];
  for (const change of changes) {
    const { status, oldPath, newPath, baseText, headText } = change;
    const wasTest = status !== "A" && isTestFile(oldPath);
    const isTest = status !== "D" && isTestFile(newPath);

    if (status === "D") {
      if (wasTest) findings.push({ file: oldPath, kind: "deleted", detail: "test file deleted" });
      continue;
    }
    if (status === "R" && wasTest && !isTest) {
      findings.push({ file: oldPath, kind: "renamed-away", detail: `renamed to ${newPath}, which no suite collects` });
      continue;
    }
    if (status === "R" && wasTest && suiteOf(oldPath) !== suiteOf(newPath)) {
      findings.push({ file: oldPath, kind: "moved-suite", detail: `moved to ${newPath}: ${suiteOf(oldPath)} no longer runs it` });
    }
    if (!isTest) continue;

    const before = markerCounts(baseText);
    // A brand-new test file may carry a conditional skip with its reason (the browser specs' "no database configured" pattern); nothing else.
    const after = markerCounts(headText, { explainedSkipsPass: status === "A" });
    for (const kind of Object.keys(after).sort()) {
      const added = after[kind] - (before[kind] ?? 0);
      if (added > 0) findings.push({ file: newPath, kind: "skip-marker", detail: status === "A" ? `new file with ${added} ${kind} marker${added === 1 ? "" : "s"} that ${added === 1 ? "is" : "are"} not a conditional skip with a reason` : `${added} more ${kind} marker${added === 1 ? "" : "s"} than before` });
    }

    if (status !== "A") {
      const had = caseTitles(baseText);
      const has = caseTitles(headText);
      if (has.length < had.length) {
        const remaining = [...has];
        const gone = had.filter((title) => {
          const at = remaining.indexOf(title);
          if (at === -1) return true;
          remaining.splice(at, 1);
          return false;
        });
        const named = gone.slice(0, 5).map((title) => JSON.stringify(title)).join(", ");
        findings.push({ file: newPath, kind: "cases-removed", detail: `${had.length - has.length} fewer test case${had.length - has.length === 1 ? "" : "s"} (${had.length} to ${has.length}); no longer present: ${named}${gone.length > 5 ? ", ..." : ""}` });
      }
    }

    if (newPath === CEILING_FILE && status !== "A") {
      const was = ceilings(baseText);
      const now = ceilings(headText);
      for (const [page, bytes] of was) {
        if (!now.has(page)) findings.push({ file: newPath, kind: "ceiling-dropped", detail: `${page} is no longer held to a ceiling` });
        else if (now.get(page) > bytes) findings.push({ file: newPath, kind: "ceiling-raised", detail: `${page} ceiling raised from ${bytes} to ${now.get(page)}` });
      }
    }
  }
  return findings;
}

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/** Everything under tests/ that changed between the merge base of the two commits and `head`, with both versions' text. Throws when git can't answer. */
export function collectChanges(cwd, base, head) {
  for (const sha of [base, head]) git(cwd, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
  const from = git(cwd, ["merge-base", base, head]).trim();
  if (!from) throw new Error("no merge base");
  const fields = git(cwd, ["diff", "--name-status", "-M50%", "-z", from, head, "--", "tests"]).split("\0").filter(Boolean);
  const show = (sha, file) => git(cwd, ["show", `${sha}:${file}`]);
  const changes = [];
  for (let i = 0; i < fields.length; ) {
    const code = fields[i++];
    const status = code[0];
    if (status === "R" || status === "C") {
      const oldPath = fields[i++];
      const newPath = fields[i++];
      // A copy leaves the original in place: only the new file is looked at.
      if (status === "C") changes.push({ status: "A", oldPath: newPath, newPath, baseText: "", headText: show(head, newPath) });
      else changes.push({ status: "R", oldPath, newPath, baseText: show(from, oldPath), headText: show(head, newPath) });
    } else if (status === "A" || status === "M" || status === "D" || status === "T") {
      const file = fields[i++];
      changes.push({
        status: status === "T" ? "M" : status,
        oldPath: file,
        newPath: file,
        baseText: status === "A" ? "" : show(from, file),
        headText: status === "D" ? "" : show(head, file),
      });
    } else {
      throw new Error(`unexpected git status ${code}`);
    }
  }
  return changes;
}

/** Returns the process exit code. */
export function run({ cwd, base, head, approved, log = console.log }) {
  if (!base || !head) {
    log("check-test-weakening: usage: node scripts/check-test-weakening.mjs <base-sha> <head-sha>. Refusing (fail closed).");
    return 1;
  }
  let changes;
  try {
    changes = collectChanges(cwd, base, head);
  } catch (error) {
    log(`check-test-weakening: could not compare ${base} with ${head} (${error instanceof Error ? error.message.split("\n")[0] : "git failed"}). Refusing (fail closed).`);
    return 1;
  }
  const findings = analyse(changes);
  log(`check-test-weakening: ${changes.length} changed file${changes.length === 1 ? "" : "s"} under tests/, ${findings.length} finding${findings.length === 1 ? "" : "s"}.`);
  for (const finding of findings) log(`  ${finding.kind}: ${finding.file}: ${finding.detail}`);
  if (!findings.length) return 0;
  if (approved) {
    log("APPROVED: the pull request carries the tests-change-approved label, so these are allowed.");
    return 0;
  }
  log("FAIL: tests were removed, skipped or loosened. Restore them, or ask Rhys to add the tests-change-approved label to this pull request.");
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(run({ cwd: process.cwd(), base: process.argv[2], head: process.argv[3], approved: process.env.TESTS_CHANGE_APPROVED === "true" }));
}
