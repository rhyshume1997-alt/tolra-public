#!/usr/bin/env node
// Claude Code SessionStart hook (startup | resume | clear | compact), configured in .claude/settings.json.
// Prints a short Tolra context block: branch, the agent's recorded task, the task-board rows that concern
// this branch or Claude Code, and Rhys's approved decisions. After compaction it also repeats the shared rules.
// Reads files only. The one exception: if the control records are not available locally, it makes one bounded
// `git fetch` of the branch that holds them (FETCH_BRANCH). Always exits 0 so a failure never blocks a session.
// Codex and humans can run the same summary by hand: node .claude/hooks/session-context.mjs --text
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_CHARS = 7000;
const CONTROL_DIR = "docs/agent-control";
// Where the control records are read from when they are not in the working tree (in order). FETCH_BRANCH is
// draft PR #393, which created them; once #393 is merged they are on main and this fallback is not reached.
const FETCH_BRANCH = "codex/agent-control-reconcile";
const FALLBACK_REFS = ["origin/main", `origin/${FETCH_BRANCH}`];
const TASK_FILE = ".claude/current-task.local.md";

const textMode = process.argv.includes("--text");
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function readStdin() {
  if (textMode || process.stdin.isTTY) return {};
  try {
    const raw = readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function git(args, timeout = 5000) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

// Returns { text, from } for a control record, or null when it cannot be found locally.
function readControl(name) {
  const local = join(root, CONTROL_DIR, name);
  if (existsSync(local)) return { text: readFileSync(local, "utf8"), from: "working tree" };
  for (const ref of FALLBACK_REFS) {
    const text = git(["show", `${ref}:${CONTROL_DIR}/${name}`]);
    if (text) return { text, from: ref };
  }
  return null;
}

function cells(row) {
  return row.split("|").slice(1, -1).map((c) => c.trim());
}

function decisionLines(md) {
  return md
    .split("\n")
    .filter((l) => l.startsWith("| ") && !/^\|\s*-+/.test(l) && !/^\|\s*Decision\s*\|/.test(l))
    .map((l) => {
      const [name, rule] = cells(l);
      return `- ${name}: ${rule}`;
    });
}

function taskLines(md, branch) {
  const out = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("| ") || /^\|\s*-+/.test(line) || /^\|\s*Task ID\s*\|/.test(line)) continue;
    const c = cells(line);
    if (c.length < 8) continue;
    const [id, objective, agent, , acceptance, , where, status] = c;
    const onBranch = branch && where.includes(branch);
    const claudeOpen = /claude/i.test(agent) && !/^(DONE|SUPERSEDED)/.test(status);
    if (onBranch || claudeOpen) {
      out.push(`- ${id} [${agent}] ${objective} | accept: ${acceptance} | ${where} | ${status}`);
    }
  }
  return out;
}

function sharedRules() {
  const p = join(root, "AGENTS.md");
  if (!existsSync(p)) return "";
  const m = readFileSync(p, "utf8").match(/<!-- BEGIN:shared-agent-rules -->([\s\S]*?)<!-- END:shared-agent-rules -->/);
  return m ? m[1].trim() : "";
}

function build(source) {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(["rev-parse", "--short", "HEAD"]);
  const dirty = git(["status", "--porcelain"]).split("\n").filter(Boolean).length;
  const parts = [];

  parts.push(`TOLRA SESSION CONTEXT (SessionStart:${source}, from .claude/hooks/session-context.mjs)`);
  parts.push("Target go-live Thu 12 Nov 2026; GO decision Mon 9 Nov 2026 (Rhys). Dates do not waive failed gates.");
  parts.push(`Branch: ${branch || "unknown"} @ ${head || "?"}; uncommitted files: ${dirty}.`);

  const taskPath = join(root, TASK_FILE);
  if (existsSync(taskPath)) {
    parts.push(`\nYOUR CURRENT TASK (${TASK_FILE}); resume it, do not re-plan:\n${readFileSync(taskPath, "utf8").trim().slice(0, 1500)}`);
  } else {
    parts.push(`\nNo ${TASK_FILE}. If you are mid-task (see the summary), write it now: Task ID, owner, branch, PR, acceptance criteria, next step.`);
  }

  let board = readControl("task-board.md");
  let decisions = readControl("decisions.md");
  if (!board && !decisions) {
    // Fresh cloud sessions clone only their own branch. Fetch the records' branch once (stored as a remote ref,
    // so later runs, e.g. after compaction, need no network).
    git(["fetch", "--quiet", "origin", `+refs/heads/${FETCH_BRANCH}:refs/remotes/origin/${FETCH_BRANCH}`], 8000);
    board = readControl("task-board.md");
    decisions = readControl("decisions.md");
  }
  if (!board && !decisions) {
    parts.push(
      `\nControl records (${CONTROL_DIR}/) are not available locally. They live in draft PR #393 until it merges. Read them, do not recreate them:\n` +
        `git fetch origin ${FETCH_BRANCH} && git show FETCH_HEAD:${CONTROL_DIR}/task-board.md`,
    );
  }
  if (board) {
    const rows = taskLines(board.text, branch);
    const ownership = board.text.split("\n").find((l) => l.startsWith("Existing Claude Code ownership")) || "";
    parts.push(`\nTASK BOARD rows for this branch or open Claude Code work (${CONTROL_DIR}/task-board.md, from ${board.from}):`);
    parts.push(rows.length ? rows.join("\n") : "- none: take no task that is not assigned to you on the board or by Rhys in chat.");
    if (ownership) parts.push(ownership);
  }
  if (decisions) {
    parts.push(`\nAPPROVED DECISIONS (${CONTROL_DIR}/decisions.md, from ${decisions.from}); do not reopen:`);
    parts.push(decisionLines(decisions.text).join("\n"));
  }

  if (source === "compact") {
    const rules = sharedRules();
    if (rules) parts.push(`\nSHARED RULES (AGENTS.md):\n${rules}`);
  }

  parts.push(
    `\nDetail only when needed: ${CONTROL_DIR}/handover.md, current-state.md, release-gates.md. ` +
      "Resume existing work; no master plans, unrelated audits or reopening DONE work without new evidence.",
  );

  const text = parts.join("\n");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[truncated: read the files named above]` : text;
}

try {
  const input = readStdin();
  const source = input.source || (textMode ? "manual" : "startup");
  const context = build(source);
  if (textMode) {
    process.stdout.write(`${context}\n`);
  } else {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
  }
} catch (err) {
  process.stderr.write(`session-context hook: ${err && err.message}\n`);
}
process.exit(0);
