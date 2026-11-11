/**
 * BOUNDARY: unit tests for the CI guardrail scripts/check-test-weakening.mjs (tests are not removed, skipped or loosened). Input: synthetic file changes, and a throwaway git repository in the OS temp directory. Output: pass / fail only.
 * Must not be changed: every case here describes a finding or a pass the guardrail promises; removing one needs Rhys's approval.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { analyse, caseTitles, isTestFile, markerCounts, run } from "../../scripts/check-test-weakening.mjs";

type Change = { status: "A" | "M" | "D" | "R"; oldPath: string; newPath: string; baseText: string; headText: string };
const modified = (file: string, baseText: string, headText: string): Change => ({ status: "M", oldPath: file, newPath: file, baseText, headText });
const real = (changes: Change[]) => changes.map((change) => ({ ...change, baseText: mk(change.baseText), headText: mk(change.headText) }));
const kinds = (changes: Change[]) => analyse(real(changes)).map((finding: { kind: string }) => finding.kind);

const TWO_CASES = 'describe("money", () => {\n  it("adds pennies", () => {});\n  it("rounds half up", () => {});\n});\n';
/**
 * Example test code in this file writes its markers with "@" ("it@skip", "x@it"): the guardrail reads this file too, and would count
 * real ones. mk() turns them into the real thing just before the guardrail sees them.
 */
const mk = (text: string) => text.replace(/@(skipIf|skip|only|todo|fixme)\b/g, (_all, word: string) => "." + word).replaceAll("x@it(", "x" + "it(");
const BUDGET = 'const C = {\n  "app/(dashboard)/jobs/page.tsx": 143_123,\n  "app/(dashboard)/quotes/page.tsx": 108_823,\n};\n';

describe("what counts as a test file", () => {
  it("vitest, Playwright and the SQL / shell proofs are test files; support code, fixtures and notes are not", () => {
    for (const file of ["tests/unit/money.test.ts", "tests/db/isolation.test.ts", "tests/e2e/reviewer/chase.spec.ts", "tests/live/m365.live.test.ts", "tests/scripts/audit-integrity-proof.proof.sql", "tests/scripts/backup-run.test.sh"]) {
      expect(isTestFile(file), file).toBe(true);
    }
    for (const file of ["tests/support/world.ts", "tests/fixtures/demo.json", "tests/MANUAL-CHECKS.md", "lib/money.test.ts", "tests/unit/money.ts"]) {
      expect(isTestFile(file), file).toBe(false);
    }
  });

  it("reads markers and titles, including it.each and chained modifiers", () => {
    expect(markerCounts(mk('it@skip("a", f); describe@only("b", f); test@fixme("c", f); it@skipIf(x)("d", f); x@it("e", f); it("skip this word", f);'))).toEqual({ skip: 1, only: 1, fixme: 1, skipIf: 1, "x-prefixed": 1 });
    expect(caseTitles(mk('it("one", f);\ntest(\'two\', f);\nit.each([[1, 2], [3, 4]])(`three %s`, f);\nit@only("four", f);\nedit("not a case");'))).toEqual(["one", "two", "three %s", "four"]);
  });
});

describe("weakening is found", () => {
  it("a deleted test file", () => {
    expect(kinds([{ status: "D", oldPath: "tests/unit/money.test.ts", newPath: "tests/unit/money.test.ts", baseText: TWO_CASES, headText: "" }])).toEqual(["deleted"]);
  });

  it("a test file renamed to a name no suite collects", () => {
    expect(kinds([{ status: "R", oldPath: "tests/unit/money.test.ts", newPath: "tests/unit/money.test.ts.off", baseText: TWO_CASES, headText: TWO_CASES }])).toEqual(["renamed-away"]);
  });

  it("a test file moved to another suite's directory", () => {
    expect(kinds([{ status: "R", oldPath: "tests/unit/money.test.ts", newPath: "tests/local/money.test.ts", baseText: TWO_CASES, headText: TWO_CASES }])).toEqual(["moved-suite"]);
  });

  it.each([
    ["it@skip", TWO_CASES.replace('it("rounds', 'it@skip("rounds')],
    ["it@only", TWO_CASES.replace('it("adds', 'it@only("adds')],
    ["describe@skip", TWO_CASES.replace('describe("money"', 'describe@skip("money"')],
    ["test@fixme", TWO_CASES.replace('it("rounds', 'test@fixme("rounds')],
    ["it@todo", TWO_CASES.replace('it("rounds half up", () => {});', 'it("rounds half up", () => {});\n  it@todo("later");')],
  ])("a new %s in an existing file", (_label, headText) => {
    expect(kinds([modified("tests/unit/money.test.ts", TWO_CASES, headText)])).toContain("skip-marker");
  });

  it("a removed test case, named in the finding", () => {
    const findings = analyse(real([modified("tests/unit/money.test.ts", TWO_CASES, TWO_CASES.replace('  it("rounds half up", () => {});\n', ""))]));
    expect(findings).toEqual([{ file: "tests/unit/money.test.ts", kind: "cases-removed", detail: '1 fewer test case (2 to 1); no longer present: "rounds half up"' }]);
  });

  it("an only marker in a brand-new test file", () => {
    expect(kinds([{ status: "A", oldPath: "tests/unit/new.test.ts", newPath: "tests/unit/new.test.ts", baseText: "", headText: 'it@only("x", () => {});' }])).toEqual(["skip-marker"]);
  });

  it.each([
    ["an unconditional skipped case", 'it@skip("x", () => {});'],
    ["a skipped block", 'describe@skip("block", () => { it("x", () => {}); });'],
    ["a bare skip inside a test", 'test("x", async () => { test@skip(); });'],
    ["a conditional skip with no reason", 'test("x", async () => { test@skip(!process.env.DB); });'],
    ["a todo", 'it@todo("later");'],
    ["a fixme", 'test@fixme("x", async () => {});'],
    ["an x-prefixed case", 'x@it("x", () => {});'],
  ])("%s in a brand-new test file", (_label, headText) => {
    expect(kinds([{ status: "A", oldPath: "tests/e2e/new.spec.ts", newPath: "tests/e2e/new.spec.ts", baseText: "", headText }])).toEqual(["skip-marker"]);
  });

  it("a conditional skip added to an EXISTING file is still a finding, so it is reviewed", () => {
    const before = 'test("x", async () => {});\n';
    const after = 'test("x", async () => { test@skip(!browserDatabaseConfigured(), NO_BROWSER_DATABASE); });\n';
    expect(kinds([modified("tests/e2e/old.spec.ts", before, after)])).toEqual(["skip-marker"]);
  });

  it("a raised page-size ceiling, and a page dropped from the list", () => {
    expect(kinds([modified("tests/unit/page-size-budget.test.ts", BUDGET, BUDGET.replace("143_123", "143_124"))])).toEqual(["ceiling-raised"]);
    expect(kinds([modified("tests/unit/page-size-budget.test.ts", BUDGET, BUDGET.replace('  "app/(dashboard)/quotes/page.tsx": 108_823,\n', ""))])).toEqual(["ceiling-dropped"]);
  });
});

describe("ordinary work passes", () => {
  it.each([
    ["Playwright, reason as a string", 'test("x", async () => { test@skip(!process.env.DB, "needs a database"); });'],
    ["the browser specs' pattern", "test.beforeEach(() => { test@skip(!browserDatabaseConfigured(), NO_BROWSER_DATABASE); });"],
    ["a reason built from a template", "test@skip(plainIp !== null, `the stack gives a plain request an address (${plainIp})`);"],
    ["vitest skipIf with its condition", 'it@skipIf(process.platform === "win32")("splits words", () => {});'],
  ])("a new test file with a conditional skip and its reason (%s)", (_label, headText) => {
    expect(kinds([{ status: "A", oldPath: "tests/e2e/new.spec.ts", newPath: "tests/e2e/new.spec.ts", baseText: "", headText }])).toEqual([]);
  });

  it("an added test case, a renamed title, and a moved skip that already existed", () => {
    expect(kinds([modified("tests/unit/money.test.ts", TWO_CASES, TWO_CASES.replace("});\n});", '});\n  it("never negative", () => {});\n});'))])).toEqual([]);
    expect(kinds([modified("tests/unit/money.test.ts", TWO_CASES, TWO_CASES.replace("rounds half up", "rounds a half penny up"))])).toEqual([]);
    const skipped = 'it@skip("a", f);\nit("b", f);\n';
    expect(kinds([modified("tests/unit/money.test.ts", skipped, 'it("b", f);\nit@skip("a", f);\n')])).toEqual([]);
  });

  it("a test file renamed inside its own suite with its cases intact", () => {
    expect(kinds([{ status: "R", oldPath: "tests/unit/money.test.ts", newPath: "tests/unit/money-rounding.test.ts", baseText: TWO_CASES, headText: TWO_CASES }])).toEqual([]);
  });

  it("a removed skip, a lowered ceiling, and changes to support files and notes", () => {
    expect(kinds([modified("tests/unit/money.test.ts", 'it@skip("a", f);', 'it("a", f);')])).toEqual([]);
    expect(kinds([modified("tests/unit/page-size-budget.test.ts", BUDGET, BUDGET.replace("143_123", "120_000"))])).toEqual([]);
    expect(kinds([{ status: "D", oldPath: "tests/support/world.ts", newPath: "tests/support/world.ts", baseText: 'it@skip("x")', headText: "" }, { status: "D", oldPath: "tests/MANUAL-CHECKS.md", newPath: "tests/MANUAL-CHECKS.md", baseText: "x", headText: "" }])).toEqual([]);
  });
});

describe("against a real git history (throwaway repository)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repo() {
    const dir = mkdtempSync(path.join(tmpdir(), "test-weakening-"));
    dirs.push(dir);
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
    const write = (file: string, text: string) => {
      mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      writeFileSync(path.join(dir, file), mk(text));
    };
    const commit = (message: string) => {
      git("add", "-A");
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    };
    git("init", "-q", "-b", "main");
    write("tests/unit/money.test.ts", TWO_CASES);
    write("tests/unit/vat.test.ts", TWO_CASES.replaceAll("pennies", "vat"));
    write("app/page.tsx", "export default 1;\n");
    return { dir, git, write, commit, base: commit("base") };
  }

  const check = (dir: string, base: string, head: string, extra: Record<string, unknown> = {}) => {
    const lines: string[] = [];
    const code = run({ cwd: dir, base, head, ...extra, log: (line: string) => lines.push(line) });
    return { code, text: lines.join("\n") };
  };

  it("passes a change that only adds a test and edits the app", () => {
    const r = repo();
    r.write("tests/unit/new.test.ts", 'it("x", () => {});\n');
    r.write("app/page.tsx", "export default 2;\n");
    expect(check(r.dir, r.base, r.commit("add"))).toMatchObject({ code: 0 });
  });

  it("fails a deleted test, a rename out of the suite and an added skip, and names each", () => {
    const r = repo();
    r.git("rm", "-q", "tests/unit/vat.test.ts");
    r.git("mv", "tests/unit/money.test.ts", "tests/unit/money.test.ts.off");
    const deleted = check(r.dir, r.base, r.commit("weaken"));
    expect(deleted.code).toBe(1);
    expect(deleted.text).toContain("deleted: tests/unit/vat.test.ts");
    expect(deleted.text).toContain("renamed-away: tests/unit/money.test.ts");

    const s = repo();
    s.write("tests/unit/money.test.ts", TWO_CASES.replace('it("rounds', 'it@skip("rounds'));
    const skipped = check(s.dir, s.base, s.commit("skip"));
    expect(skipped.code).toBe(1);
    expect(skipped.text).toContain("skip-marker: tests/unit/money.test.ts: 1 more skip marker than before");
  });

  it("compares with the merge base, so tests added on main since the branch started are not read as deleted", () => {
    const r = repo();
    r.git("checkout", "-q", "-b", "feature");
    r.write("app/page.tsx", "export default 3;\n");
    const head = r.commit("feature work");
    r.git("checkout", "-q", "main");
    r.write("tests/unit/later.test.ts", 'it("later", () => {});\n');
    const newBase = r.commit("main moves on");
    expect(check(r.dir, newBase, head)).toMatchObject({ code: 0 });
  });

  it("nothing lets a finding through: no approved flag, no label-style setting, no extra argument", () => {
    const r = repo();
    r.git("rm", "-q", "tests/unit/vat.test.ts");
    const head = r.commit("removal");
    for (const extra of [{}, { approved: true }, { approved: "true" }, { label: "tests-change-approved" }, { labels: ["tests-change-approved"] }]) {
      const result = check(r.dir, r.base, head, extra);
      expect({ extra, code: result.code }).toEqual({ extra, code: 1 });
      expect(result.text).toContain("deleted: tests/unit/vat.test.ts");
      expect(result.text).not.toContain("APPROVED");
    }
  });

  it("fails closed: a commit that can't be found, or missing arguments, fail", () => {
    const r = repo();
    expect(check(r.dir, "0123456789012345678901234567890123456789", r.base).code).toBe(1);
    expect(check(r.dir, "", r.base).code).toBe(1);
    expect(check(r.dir, r.base, "").code).toBe(1);
  });

  it("the command line exits 1 on a finding whatever the environment or extra arguments say, and 0 on a clean change", () => {
    const r = repo();
    r.git("rm", "-q", "tests/unit/vat.test.ts");
    const head = r.commit("removal");
    const script = path.resolve(__dirname, "../../scripts/check-test-weakening.mjs");
    const cli = (env: Record<string, string>, from = r.base, extraArgs: string[] = []) => {
      try {
        execFileSync(process.execPath, [script, from, head, ...extraArgs], { cwd: r.dir, env: { ...process.env, ...env }, stdio: "pipe" });
        return 0;
      } catch (error) {
        return (error as { status: number }).status;
      }
    };
    expect(cli({})).toBe(1);
    expect(cli({ TESTS_CHANGE_APPROVED: "true", APPROVED: "true", CI: "false" })).toBe(1);
    expect(cli({}, r.base, ["--approved", "true"])).toBe(1);
    expect(cli({}, head)).toBe(0);
  });
});

describe("ci.yml runs it on every pull request and the gate requires it", () => {
  const ci = readFileSync(path.resolve(__dirname, "../../.github/workflows/ci.yml"), "utf8").replace(/\r\n/g, "\n");

  it("the guardrails job passes the pull request's base and head through the environment, with full history", () => {
    const job = ci.split("\n  guardrails:\n")[1]?.split("\n  # The one check to require")[0] ?? "";
    expect(job).toContain("if: ${{ github.event_name == 'pull_request' }}");
    expect(job).toContain("fetch-depth: 0");
    // No label, input or variable reaches the script: only the two commits.
    expect(job).not.toMatch(/labels|APPROVED|inputs\.|vars\.|secrets\./);
    expect(job).toContain('run: node scripts/check-test-weakening.mjs "$PR_BASE_SHA" "$PR_HEAD_SHA"');
    expect(job).not.toContain("continue-on-error");
  });

  it("ci-gate needs guardrails and fails a pull request unless it succeeded", () => {
    const gate = ci.split("\n  ci-gate:\n")[1] ?? "";
    expect(gate).toContain("needs: [changes, web, integration, guardrails]");
    expect(gate).toContain("GUARDRAILS: ${{ needs.guardrails.result }}");
    expect(gate).toContain('if [ "$GUARDRAILS" = success ] || { [ "$GUARDRAILS" = skipped ] && [ "$EVENT" != pull_request ]; }; then');
    expect(gate).toContain('echo "FAIL: guardrails $GUARDRAILS"; fail=1');
  });
});
