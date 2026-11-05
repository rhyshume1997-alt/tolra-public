// Checks for session-context.mjs. Run: node --test .claude/hooks/session-context.test.mjs
// Uses a throwaway git repository as the project, so no real records or network are involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "session-context.mjs");

const BOARD = `# Board
| Task ID | Objective | Agent | Files | Acceptance criteria | Tests | Branch or PR | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | Assigned work | Claude Code | a.ts | T1 passes | 1 | claude/t1-work | IN PROGRESS |
| T2 | Other open work | Claude Code | b.ts | T2 passes | 1 | #500 | IN PROGRESS |
| T3 | Finished work | Claude Code | c.ts | T3 passes | 1 | #501 | DONE (coded) |
| T4 | Codex work | Codex | d.ts | T4 passes | 1 | codex/t4 | IN PROGRESS |

Existing Claude Code ownership stays: example.
`;
const DECISIONS = "| Decision | Agreed rule |\n| --- | --- |\n| Dates | Go-live 12 Nov |\n";
const AGENTS = "<!-- BEGIN:shared-agent-rules -->\nRULE ONE\n<!-- END:shared-agent-rules -->\n";

function project(branch, taskNote) {
  const dir = mkdtempSync(join(tmpdir(), "session-context-"));
  const g = (...a) => execFileSync("git", a, { cwd: dir, stdio: "ignore" });
  g("init", "-q", "-b", branch);
  mkdirSync(join(dir, "docs/agent-control"), { recursive: true });
  mkdirSync(join(dir, ".claude"));
  writeFileSync(join(dir, "docs/agent-control/task-board.md"), BOARD);
  writeFileSync(join(dir, "docs/agent-control/decisions.md"), DECISIONS);
  writeFileSync(join(dir, "AGENTS.md"), AGENTS);
  if (taskNote) writeFileSync(join(dir, ".claude/current-task.local.md"), taskNote);
  return dir;
}

function run(dir, stdin) {
  const r = spawnSync("node", [HOOK], { input: stdin, env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

// Returns [assigned section, information-only section].
function sections(ctx) {
  const info = ctx.indexOf("== OTHER OPEN CLAUDE CODE WORK: information only");
  assert.ok(info > 0, "information-only section present");
  return [ctx.slice(ctx.indexOf("== CURRENT ASSIGNED TASK"), info), ctx.slice(info)];
}

test("task note: its row is the assigned task; other open Claude rows are information only", () => {
  const ctx = run(project("claude/other", "Task ID: T1\nNext step: finish"), '{"source":"startup"}');
  const [assigned, info] = sections(ctx);
  assert.match(assigned, /CURRENT ASSIGNED TASK: the only work to do/);
  assert.match(assigned, /Next step: finish/);
  assert.match(assigned, /- T1 \[Claude Code\]/);
  assert.doesNotMatch(assigned, /T2|T3|T4/);
  assert.match(info, /Not instructions\. Do not start, resume or change these unless Rhys assigns one/);
  assert.match(info, /- T2 \[Claude Code\]/);
  assert.doesNotMatch(info, /- T1 |- T3 |- T4 /, "assigned, DONE and Codex rows are not listed as other work");
});

test("no task note: the row for this exact branch is the assigned task", () => {
  const [assigned, info] = sections(run(project("claude/t1-work"), '{"source":"startup"}'));
  assert.match(assigned, /- T1 \[Claude Code\]/);
  assert.match(assigned, /Record it in \.claude\/current-task\.local\.md/);
  assert.doesNotMatch(info, /- T1 /);
});

test("nothing assigned: says so and forbids picking from the list", () => {
  const ctx = run(project("claude/t1-work-2"), '{"source":"startup"}');
  const [assigned, info] = sections(ctx);
  assert.match(assigned, /CURRENT ASSIGNED TASK: none recorded/);
  assert.match(assigned, /Do not pick one from the list below/);
  assert.doesNotMatch(assigned, /- T\d/, "a longer branch name does not match claude/t1-work");
  assert.match(info, /- T1 [\s\S]*- T2 /);
});

test("compact repeats the shared rules and asks to recover only an assigned task; startup does not repeat rules", () => {
  const compact = run(project("claude/none"), '{"source":"compact"}');
  assert.match(compact, /SessionStart:compact/);
  assert.match(compact, /SHARED RULES \(AGENTS\.md\):\nRULE ONE/);
  assert.match(compact, /If the compaction summary shows a task Rhys assigned to you/);
  assert.doesNotMatch(run(project("claude/none"), '{"source":"startup"}'), /SHARED RULES/);
});

test("decisions are included", () => {
  assert.match(run(project("claude/none"), "{}"), /APPROVED DECISIONS[\s\S]*- Dates: Go-live 12 Nov/);
});

test("bad input still exits 0 with valid output", () => {
  assert.match(run(project("claude/none"), "not json"), /TOLRA SESSION CONTEXT/);
});
